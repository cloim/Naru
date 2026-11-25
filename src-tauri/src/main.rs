// Release builds have no console window; job workers run windowless as well.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod preflight;

use naru_core::{onboarding, server, state, worker};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

/// How often the tray checks GitHub for a new release while Naru keeps running.
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// A result older than this is refreshed when the tray menu is opened.
const UPDATE_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Read once: the server, the window and the checks all use the port the app started with.
fn port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(state::app_port)
}

/// The folder holding `dist/` and `scripts/`: next to the installed executable,
/// or the repository when running a development build from target/.
fn resources() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)).unwrap_or_default();
    if exe_dir.join("dist").exists() || !cfg!(debug_assertions) {
        return exe_dir;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime")
}

/// Shown the moment the window opens, while WebView2 starts and the server comes up; index.html repeats it
/// until the screens load, so the window never sits blank.
const SPLASH: &str = include_str!("splash.html");

fn splash_url() -> tauri::Url {
    let encoded: String = SPLASH
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("data:text/html;charset=utf-8,{encoded}").parse().expect("splash url")
}

/// Tells the page whether the window can be seen. WebView2 keeps `document.visibilityState` visible when the
/// window is minimized or hidden in the tray, so without this the screens would keep polling the engine.
fn tell_page_hidden(window: &tauri::WebviewWindow, hidden: bool) {
    static HIDDEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if HIDDEN.swap(hidden, std::sync::atomic::Ordering::SeqCst) == hidden {
        return;
    }
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('naru-window', {{ detail: {{ hidden: {hidden} }} }}))"));
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        tell_page_hidden(&window, false);
        return;
    }
    // Setup opens maximized so every step has room; afterwards the window opens centered.
    let setup = !state::app_config().onboarded;
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash_url()))
        .title("Naru")
        .inner_size(1460.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .maximized(setup)
        .background_color(tauri::window::Color(22, 61, 53, 255))
        .build();
    // Without a window there is nothing to show the user, so say why and end instead of idling in the tray.
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            preflight::show_error(&format!("Naru 창을 열지 못했습니다.

{e}"));
            app.exit(1);
            return;
        }
    };
    {
        let target = window.clone();
        tauri::async_runtime::spawn(async move {
            wait_for_server().await;
            let url = format!("http://127.0.0.1:{}", port()).parse().expect("server url");
            let _ = target.navigate(url);
        });
        let hide = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Closing during setup ends the app: nothing runs yet that the tray would keep alive.
                if !state::app_config().onboarded {
                    hide.app_handle().exit(0);
                    return;
                }
                // Afterwards Naru stays in the tray: port forwarding and the Docker pipe stay up.
                api.prevent_close();
                let _ = hide.hide();
                tell_page_hidden(&hide, true);
            }
            // Minimizing and restoring both resize the window.
            WindowEvent::Resized(_) => tell_page_hidden(&hide, hide.is_minimized().unwrap_or(false)),
            _ => {}
        });
    }
}

async fn wait_for_server() {
    for _ in 0..600 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port())).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// DLLs loaded at run time come from System32 only, never from Naru's folder or the working folder, where a
/// planted copy would load in their place. The WebView2 loader is linked statically and loads the runtime by
/// its full path, so nothing Naru needs comes from anywhere else.
#[cfg(windows)]
fn pin_dll_search() {
    use windows_sys::Win32::System::LibraryLoader::{SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32};
    // SAFETY: plain flag argument; it only changes this process's search order for later loads.
    unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) };
}

fn main() {
    #[cfg(windows)]
    pin_dll_search();
    let argv: Vec<String> = std::env::args().collect();
    state::init_root(resources());
    state::migrate_legacy_config();
    match argv.get(1).map(String::as_str) {
        Some("--worker") => {
            let id = argv.get(2).cloned().unwrap_or_default();
            std::process::exit(runtime().block_on(worker::run_worker(&id)));
        }
        // A windowless server for development and tests.
        Some("--serve") => {
            if let Err(e) = runtime().block_on(server::run(port())) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return;
        }
        _ => {}
    }
    if let Some(message) = preflight::system() {
        preflight::fail(&message);
    }
    // A login start stays in the tray, except while setup is unfinished (after the WSL reboot, say).
    let background = argv.iter().any(|a| a == "--background") && state::app_config().onboarded;
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app)))
        .setup(move |app| {
            // Only the first instance gets here; a second launch was handed to it above.
            // This runs before anything reads port(), so an accepted switch applies right away.
            match preflight::port(state::app_port()) {
                preflight::PortCheck::Free => {}
                preflight::PortCheck::Switch(free) => {
                    let mut config = state::app_config();
                    config.port = Some(free);
                    let text = serde_json::to_vec_pretty(&config)?;
                    std::fs::create_dir_all(state::app_file().parent().unwrap())?;
                    std::fs::write(state::app_file(), text)?;
                }
                preflight::PortCheck::Declined(message) => preflight::fail(&message),
            }
            let handle = app.handle().clone();
            let (restart, quit) = (handle.clone(), handle.clone());
            onboarding::attach_shell(onboarding::Shell {
                restart: Box::new(move || restart.restart()),
                quit: Box::new(move || quit.exit(0)),
                executable: std::env::current_exe()?,
            });
            let failed = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::run(port()).await {
                    preflight::show_error(&format!("Naru를 시작하지 못했습니다.\n\n{e}"));
                    failed.exit(1);
                }
            });
            let update = MenuItem::with_id(app, "update", "업데이트 확인", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&update, &sep, &open, &quit])?;

            let update_status: Arc<tokio::sync::Mutex<UpdateStatus>> =
                Arc::new(tokio::sync::Mutex::new(UpdateStatus::Idle));

            let last_update_check: Arc<std::sync::Mutex<Option<Instant>>> =
                Arc::new(std::sync::Mutex::new(None));

            // Naru stays in the tray for days, so a release published after startup must still show up.
            let update_item_bg = update.clone();
            let update_status_bg = update_status.clone();
            let last_check_bg = last_update_check.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                loop {
                    refresh_update_status(&update_item_bg, &update_status_bg, &last_check_bg).await;
                    tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
                }
            });

            let update_item_click = update.clone();
            let update_status_click = update_status.clone();
            let update_item_tray = update.clone();
            let update_status_tray = update_status.clone();
            let last_check_tray = last_update_check.clone();

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Naru")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show(app),
                    "update" => {
                        let app_handle = app.clone();
                        let update_item = update_item_click.clone();
                        let status_lock = update_status_click.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_update_action(&app_handle, &update_item, status_lock).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| match event {
                    TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                        show(tray.app_handle());
                    }
                    // Opening the menu refreshes a stale result so the next look shows a new release.
                    TrayIconEvent::Click {
                        button: MouseButton::Right,
                        button_state: MouseButtonState::Down,
                        ..
                    } => {
                        let stale = last_check_tray
                            .lock()
                            .map(|last| last.map_or(true, |at| at.elapsed() >= UPDATE_STALE_AFTER))
                            .unwrap_or(true);
                        if stale {
                            let item = update_item_tray.clone();
                            let status = update_status_tray.clone();
                            let last_check = last_check_tray.clone();
                            tauri::async_runtime::spawn(async move {
                                refresh_update_status(&item, &status, &last_check).await;
                            });
                        }
                    }
                    _ => {}
                })
                .build(app)?;
            if !background {
                show(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| preflight::fail(&format!("Naru 창을 열지 못했습니다.\n\n{e}")))
        .run(|_, event| {
            // The window only hides; Naru ends from the tray menu.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[derive(Clone, Debug)]
enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Failed,
    Available(naru_core::updater::ReleaseInfo),
    Downloading { version: String },
    Installing { version: String },
}

impl UpdateStatus {
    fn menu_text_and_enabled(&self, current_version: &str) -> (String, bool) {
        match self {
            UpdateStatus::Idle => ("업데이트 확인".to_string(), true),
            UpdateStatus::Checking => ("업데이트 확인 중...".to_string(), false),
            // Stays clickable so the user can check again on demand.
            UpdateStatus::UpToDate => (format!("최신 버전 (v{current_version})"), true),
            UpdateStatus::Failed => (format!("업데이트 확인 실패 (v{current_version})"), true),
            UpdateStatus::Available(info) => {
                (format!("업데이트 하기 (v{})", info.latest_version), true)
            }
            UpdateStatus::Downloading { version } => {
                (format!("업데이트 다운로드 중 (v{version})"), false)
            }
            UpdateStatus::Installing { version } => {
                (format!("업데이트 설치 중 (v{version})"), false)
            }
        }
    }
}

fn apply_update_status<R: tauri::Runtime>(
    item: &tauri::menu::MenuItem<R>,
    status: &UpdateStatus,
    current_version: &str,
) {
    let (text, enabled) = status.menu_text_and_enabled(current_version);
    let _ = item.set_text(text);
    let _ = item.set_enabled(enabled);
}

/// Checks quietly in the background. It never interrupts a check, download or install in progress,
/// and a failed check keeps the last good result instead of replacing it.
async fn refresh_update_status<R: tauri::Runtime>(
    item: &tauri::menu::MenuItem<R>,
    status_lock: &tokio::sync::Mutex<UpdateStatus>,
    last_check: &std::sync::Mutex<Option<Instant>>,
) {
    let refreshable = |status: &UpdateStatus| {
        matches!(
            status,
            UpdateStatus::Idle | UpdateStatus::UpToDate | UpdateStatus::Failed | UpdateStatus::Available(_)
        )
    };
    if !refreshable(&*status_lock.lock().await) {
        return;
    }
    if let Ok(mut last) = last_check.lock() {
        *last = Some(Instant::now());
    }
    let result = naru_core::updater::check_for_updates().await;
    let mut st = status_lock.lock().await;
    if !refreshable(&st) {
        return;
    }
    *st = match result {
        Ok(info) if info.update_available => UpdateStatus::Available(info),
        Ok(_) => UpdateStatus::UpToDate,
        Err(_) if matches!(*st, UpdateStatus::Idle) => UpdateStatus::Failed,
        Err(_) => return,
    };
    apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
}

async fn handle_update_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    item: &tauri::menu::MenuItem<R>,
    status_lock: Arc<tokio::sync::Mutex<UpdateStatus>>,
) {
    let current = {
        let st = status_lock.lock().await;
        st.clone()
    };

    match current {
        UpdateStatus::Idle | UpdateStatus::Failed | UpdateStatus::UpToDate => {
            {
                let mut st = status_lock.lock().await;
                *st = UpdateStatus::Checking;
                apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
            }
            let result = naru_core::updater::check_for_updates().await;
            let mut st = status_lock.lock().await;
            match result {
                Ok(info) => {
                    if info.update_available {
                        *st = UpdateStatus::Available(info);
                    } else {
                        *st = UpdateStatus::UpToDate;
                    }
                }
                Err(e) => {
                    *st = UpdateStatus::Failed;
                    preflight::show_error(&format!("업데이트 정보를 확인하지 못했습니다.\n\n{e}"));
                }
            }
            apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
        }
        UpdateStatus::Available(info) => {
            let version = info.latest_version.clone();
            {
                let mut st = status_lock.lock().await;
                *st = UpdateStatus::Downloading {
                    version: version.clone(),
                };
                apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
            }

            match naru_core::updater::download_update(&info).await {
                Ok(installer_path) => {
                    {
                        let mut st = status_lock.lock().await;
                        *st = UpdateStatus::Installing {
                            version: version.clone(),
                        };
                        apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
                    }

                    if let Err(e) = naru_core::updater::launch_installer(&installer_path) {
                        let mut st = status_lock.lock().await;
                        *st = UpdateStatus::Available(info);
                        apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);
                        preflight::show_error(&format!("설치 파일을 실행하지 못했습니다.\n\n{e}"));
                        return;
                    }
                    app.exit(0);
                }
                Err(e) => {
                    let mut st = status_lock.lock().await;
                    *st = UpdateStatus::Available(info.clone());
                    apply_update_status(item, &st, naru_core::updater::CURRENT_VERSION);

                    let fail_msg = format!(
                        "설치 파일 다운로드에 실패했습니다.\n\n{e}\n\nGitHub 릴리스 페이지를 브라우저로 여시겠습니까?"
                    );
                    if preflight::ask_yes_no(&fail_msg, "Naru 업데이트") {
                        let _ = naru_core::updater::open_browser(&info.release_url);
                    }
                }
            }
        }
        _ => {}
    }
}
