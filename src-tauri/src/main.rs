// Release builds have no console window; job workers run windowless as well.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use naru_core::{onboarding, server, state, worker};
use std::path::PathBuf;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PORT: u16 = 49170;

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

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let url = format!("http://127.0.0.1:{PORT}").parse().expect("server url");
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Naru")
        .inner_size(1360.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .build();
    if let Ok(window) = built {
        let hide = window.clone();
        // Closing the window keeps Naru running in the tray: port forwarding and the Docker pipe stay up.
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide.hide();
            }
        });
    }
}

async fn wait_for_server() {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", PORT)).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    state::init_root(resources());
    match argv.get(1).map(String::as_str) {
        Some("--worker") => {
            let id = argv.get(2).cloned().unwrap_or_default();
            std::process::exit(runtime().block_on(worker::run_worker(&id)));
        }
        // A windowless server for development and tests.
        Some("--serve") => {
            if let Err(e) = runtime().block_on(server::run(PORT)) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return;
        }
        _ => {}
    }
    let background = argv.iter().any(|a| a == "--background");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let restart = handle.clone();
            onboarding::attach_shell(onboarding::Shell {
                restart: Box::new(move || restart.restart()),
                executable: std::env::current_exe()?,
            });
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::run(PORT).await {
                    eprintln!("Naru 서버: {e}");
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
                tauri::async_runtime::spawn(async move {
                    wait_for_server().await;
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || show(&app));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Naru 앱을 시작할 수 없습니다")
        .run(|_, event| {
            // The window only hides; Naru ends from the tray menu.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
