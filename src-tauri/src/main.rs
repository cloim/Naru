// Release builds have no console window; job workers run windowless as well.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod preflight;

use naru_core::{onboarding, server, state, worker};
use std::path::PathBuf;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
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
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Naru")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show(app),
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
