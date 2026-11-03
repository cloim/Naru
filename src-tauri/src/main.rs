// Release builds have no console window; job workers run windowless as well.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod preflight;

use naru_core::{onboarding, server, state, worker};
use std::path::PathBuf;
use std::time::Duration;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
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

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    // Setup opens maximized so every step has room; afterwards the window opens centered.
    let setup = !state::app_config().onboarded;
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(splash_url()))
        .title("Naru")
        .inner_size(1360.0, 860.0)
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
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing during setup ends the app: nothing runs yet that the tray would keep alive.
                if !state::app_config().onboarded {
                    hide.app_handle().exit(0);
                    return;
                }
                // Afterwards Naru stays in the tray: port forwarding and the Docker pipe stay up.
                api.prevent_close();
                let _ = hide.hide();
            }
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

fn main() {
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
            let open = MenuItem::with_id(app, "open", "Naru 열기", true, None::<&str>)?;
            let update = MenuItem::with_id(app, "update", "업데이트 확인", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &update, &sep, &quit])?;

            let update_state: Arc<tokio::sync::Mutex<Option<naru_core::updater::ReleaseInfo>>> =
                Arc::new(tokio::sync::Mutex::new(None));

            let update_item_bg = update.clone();
            let update_state_bg = update_state.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                if let Ok(info) = naru_core::updater::check_for_updates().await {
                    if info.update_available {
                        let _ = update_item_bg.set_text(format!("새 버전 업데이트 (v{})", info.latest_version));
                    }
                    *update_state_bg.lock().await = Some(info);
                }
            });

            let update_item_click = update.clone();
            let update_state_click = update_state.clone();

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
                        let state = update_state_click.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_update_event(&app_handle, &update_item, state).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                        show(tray.app_handle());
                    }
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


async fn handle_update_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    item: &tauri::menu::MenuItem<R>,
    state: Arc<tokio::sync::Mutex<Option<naru_core::updater::ReleaseInfo>>>,
) {
    let _ = item.set_text("업데이트 확인 중...");

    let info_result = naru_core::updater::check_for_updates().await;
    let info = match info_result {
        Ok(info) => {
            *state.lock().await = Some(info.clone());
            info
        }
        Err(e) => {
            let _ = item.set_text("업데이트 확인");
            preflight::show_error(&format!("업데이트 정보를 확인하지 못했습니다.\n\n{e}"));
            return;
        }
    };

    if !info.update_available {
        let _ = item.set_text("업데이트 확인");
        preflight::show_info(&format!(
            "현재 최신 버전(v{})을 사용하고 있습니다.",
            info.current_version
        ));
        return;
    }

    let menu_title = format!("새 버전 업데이트 (v{})", info.latest_version);
    let _ = item.set_text(&menu_title);

    let prompt = format!(
        "Naru v{} 새 버전이 출시되었습니다.\n\n지금 다운로드하여 설치하시겠습니까?\n(확인을 누르면 설치 파일을 다운로드한 뒤 실행하고 Naru를 종료합니다.)",
        info.latest_version
    );

    if !preflight::ask_yes_no(&prompt, "Naru 업데이트") {
        return;
    }

    let Some(download_url) = &info.download_url else {
        preflight::show_error("다운로드 가능한 설치 파일 주소를 찾지 못했습니다.");
        return;
    };

    let file_name = info.file_name.as_deref().unwrap_or("Naru_setup.exe");
    let _ = item.set_text("업데이트 다운로드 중...");

    match naru_core::updater::download_update(download_url, file_name).await {
        Ok(path) => {
            let _ = item.set_text("업데이트 설치 시작...");
            if let Err(e) = naru_core::updater::launch_installer(&path) {
                let _ = item.set_text(&menu_title);
                preflight::show_error(&format!("설치 파일을 실행하지 못했습니다.\n\n{e}"));
                return;
            }
            app.exit(0);
        }
        Err(e) => {
            let _ = item.set_text(&menu_title);
            let fail_msg = format!(
                "설치 파일 다운로드에 실패했습니다.\n\n{e}\n\nGitHub 릴리스 페이지를 브라우저로 여시겠습니까?"
            );
            if preflight::ask_yes_no(&fail_msg, "Naru 업데이트") {
                let _ = naru_core::updater::open_browser(&info.release_url);
            }
        }
    }
}
