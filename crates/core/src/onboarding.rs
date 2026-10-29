//! First-run setup the screens walk through: WSL readiness, where data lives and Windows integration.
//! Everything is stored in app.json and settings.json; nothing depends on environment files.
use crate::runner::{args, command, run, Opts};
use crate::state::{app_config, app_file, atomic_json, data, default_data, AppConfig, DISTRO};
use crate::web::{invalid, ok, ApiResult};
use anyhow::{anyhow, Result};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Set by the desktop shell: how to restart the app, and that a packaged executable exists for login start.
pub struct Shell {
    pub restart: Box<dyn Fn() + Send + Sync>,
    pub quit: Box<dyn Fn() + Send + Sync>,
    pub executable: PathBuf,
}

/// The runtime image, its packages and the Windows tools all download during setup.
const MIN_FREE: u64 = 10 * 1024 * 1024 * 1024;

static SHELL: OnceLock<Shell> = OnceLock::new();

pub fn attach_shell(shell: Shell) {
    let _ = SHELL.set(shell);
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

async fn wsl_state() -> Value {
    // `wsl --version` only succeeds with the Store WSL installed; older inbox WSL prints usage instead.
    match run("wsl.exe", &args(["--version"]), Opts::timeout(20)).await {
        Ok(out) if out.code == Some(0) => {
            let version = out.stdout.lines().next().and_then(|l| l.split(':').nth(1)).map(|v| v.trim().to_string());
            json!({ "installed": true, "version": version })
        }
        Ok(out) => json!({ "installed": false, "detail": if out.stdout.is_empty() { out.stderr } else { out.stdout } }),
        Err(e) => json!({ "installed": false, "detail": e.to_string() }),
    }
}

async fn virtualization() -> Value {
    let script = "$c=Get-CimInstance Win32_ComputerSystem;$p=Get-CimInstance Win32_Processor|Select-Object -First 1;\
                  [pscustomobject]@{hypervisor=[bool]$c.HypervisorPresent;firmware=[bool]$p.VirtualizationFirmwareEnabled}|ConvertTo-Json -Compress";
    let out = command("powershell.exe", &args(["-NoProfile", "-NonInteractive", "-Command", script]), Opts::timeout(30)).await;
    let v: Value = out.ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    // A running hypervisor hides the firmware flag, so either one means WSL 2 can start.
    let ready = v["hypervisor"] == true || v["firmware"] == true;
    json!({ "ready": ready, "hypervisor": v["hypervisor"], "firmware": v["firmware"] })
}

fn free_space(dir: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let dir = dir.to_string_lossy().to_lowercase();
    disks
        .list()
        .iter()
        .filter(|d| dir.starts_with(&d.mount_point().to_string_lossy().to_lowercase()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

async fn distro_installed() -> bool {
    crate::runner::distributions(false).await.is_ok_and(|list| list.iter().any(|d| d == DISTRO))
}

async fn launch_registered() -> bool {
    run("reg.exe", &args(["query", RUN_KEY, "/v", "Naru"]), Opts::timeout(10)).await.is_ok_and(|o| o.code == Some(0))
}

async fn status() -> ApiResult {
    let config = app_config();
    let (wsl, virt) = tokio::join!(wsl_state(), virtualization());
    let installed = wsl["installed"] == true && distro_installed().await;
    let current = data().to_path_buf();
    Ok(Json(json!({
        "onboarded": config.onboarded,
        "packaged": SHELL.get().is_some(),
        "launchAtLogin": SHELL.get().is_some() && launch_registered().await,
        "dataDir": current,
        "defaultDataDir": default_data(),
        // The WSL disk lives in the data folder, so it can only move before the runtime is installed.
        "dataDirLocked": installed,
        "freeBytes": free_space(&current),
        "wsl": wsl,
        "virtualization": virt,
        "runtimeInstalled": installed,
    })))
}

fn validate_dir(raw: &str) -> Result<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || raw.len() > 1024 || raw.contains(['\0', '\r', '\n']) {
        return Err(invalid("데이터 폴더는 드라이브부터 시작하는 전체 경로로 입력해 주세요."));
    }
    std::fs::create_dir_all(&path).map_err(|e| invalid(format!("폴더를 만들 수 없습니다: {e}")))?;
    let probe = path.join(format!(".naru-write-test-{}", std::process::id()));
    std::fs::write(&probe, b"ok").map_err(|e| invalid(format!("폴더에 쓸 수 없습니다: {e}")))?;
    let _ = std::fs::remove_file(probe);
    Ok(path)
}

async fn set_launch(enabled: bool) -> Result<()> {
    let shell = SHELL.get().ok_or_else(|| invalid("설치된 Naru 앱에서만 로그인 시 자동 시작을 설정할 수 있습니다."))?;
    if enabled {
        let value = format!("\"{}\" --background", shell.executable.display());
        command("reg.exe", &args(["add", RUN_KEY, "/v", "Naru", "/t", "REG_SZ", "/d", &value, "/f"]), Opts::timeout(10)).await?;
    } else if launch_registered().await {
        command("reg.exe", &args(["delete", RUN_KEY, "/v", "Naru", "/f"]), Opts::timeout(10)).await?;
    }
    Ok(())
}

async fn save(Json(body): Json<Value>) -> ApiResult {
    let known = body.as_object().is_some_and(|o| o.keys().all(|k| k == "dataDir" || k == "launchAtLogin"));
    if !known {
        return Err(invalid("온보딩 설정 항목을 확인해 주세요.").into());
    }
    let mut config: AppConfig = app_config();
    let mut restart = false;
    if let Some(raw) = body.get("dataDir").filter(|v| !v.is_null()) {
        let raw = raw.as_str().ok_or_else(|| invalid("데이터 폴더 경로를 확인해 주세요."))?;
        let wanted = validate_dir(raw)?;
        if !distro_installed().await && free_space(&wanted).is_some_and(|free| free < MIN_FREE) {
            return Err(invalid("이 드라이브는 여유 공간이 10GB보다 적습니다. 공간이 넉넉한 드라이브의 폴더를 골라 주세요.").into());
        }
        if wanted != data() {
            if distro_installed().await {
                return Err(invalid("런타임을 설치한 뒤에는 데이터 폴더를 옮길 수 없습니다.").into());
            }
            if std::env::var_os("NARU_DATA_DIR").is_some() {
                return Err(invalid("NARU_DATA_DIR 개발 설정이 데이터 폴더를 고정하고 있습니다.").into());
            }
            restart = true;
        }
        config.data_dir = (wanted != default_data()).then(|| wanted.to_string_lossy().into_owned());
    }
    if let Some(enabled) = body.get("launchAtLogin").and_then(Value::as_bool) {
        set_launch(enabled).await?;
        config.launch_at_login = enabled;
    }
    atomic_json(&app_file(), &config).await?;
    // The data folder is fixed for the life of the process. The desktop app restarts itself;
    // a development server has to be restarted by hand.
    let automatic = restart && SHELL.get().is_some();
    if automatic {
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            (SHELL.get().unwrap().restart)();
        });
    }
    Ok(Json(json!({ "ok": true, "restart": restart, "manualRestart": restart && !automatic })))
}

/// Installs WSL with administrator rights. Windows asks for consent and usually needs a reboot afterwards.
async fn install_wsl() -> ApiResult {
    // The reboot comes before the storage step, so start at login now; setup then reopens by itself.
    // The storage step can still turn it off.
    if SHELL.get().is_some() && !launch_registered().await {
        set_launch(true).await?;
        let mut config = app_config();
        config.launch_at_login = true;
        atomic_json(&app_file(), &config).await?;
    }
    let script = "$p=Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru;$p.ExitCode";
    let out = command("powershell.exe", &args(["-NoProfile", "-NonInteractive", "-Command", script]), Opts::timeout(30 * 60))
        .await
        .map_err(|e| anyhow!("WSL 설치를 시작하지 못했습니다. 관리자 승인 창을 확인해 주세요. ({e})"))?;
    let code: i64 = out.trim().parse().unwrap_or(-1);
    let wsl = wsl_state().await;
    Ok(Json(json!({ "exitCode": code, "wsl": wsl, "restartRequired": wsl["installed"] != true || code == 3010 })))
}

async fn mark_onboarded() -> Result<()> {
    let mut config = app_config();
    config.onboarded = true;
    atomic_json(&app_file(), &config).await
}

async fn complete() -> ApiResult {
    mark_onboarded().await?;
    ok()
}

/// Whether setup is done. An install from before onboarding existed (runtime present, no app.json) counts as done.
pub async fn onboarded() -> bool {
    if app_config().onboarded {
        return true;
    }
    if !app_file().exists() && distro_installed().await {
        return mark_onboarded().await.is_ok();
    }
    false
}

/// The quick check the screens make on every start; the full status runs slower system probes.
async fn state() -> ApiResult {
    Ok(Json(json!({ "onboarded": onboarded().await, "packaged": SHELL.get().is_some() })))
}

/// Checks, through the proxy being set up, that every server the chosen setup downloads from answers.
async fn network(Json(body): Json<Value>) -> ApiResult {
    let proxy: crate::state::Proxy = serde_json::from_value(body["proxy"].clone()).map_err(|e| invalid(e.to_string()))?;
    let client = crate::runtime::proxied_client(&proxy, std::time::Duration::from_secs(20)).map_err(|e| invalid(e.to_string()))?;
    let mut targets = vec![("Alpine Linux", crate::runtime::BASE_URL.to_string())];
    if body["installCli"] == true {
        targets.push(("Docker", "https://download.docker.com/win/static/stable/x86_64/".into()));
        targets.push(("GitHub", "https://github.com/docker/compose/releases".into()));
        targets.push(("Kubernetes", "https://dl.k8s.io/release/stable.txt".into()));
    }
    if body["kubernetes"] == true {
        targets.push(("GitHub", "https://github.com/k3s-io/k3s/releases".into()));
    }
    let mut seen = std::collections::HashSet::new();
    targets.retain(|(name, _)| seen.insert(*name));
    let mut results = vec![];
    for (name, url) in targets {
        let outcome = client.head(&url).send().await;
        let (ok, detail) = match outcome {
            Ok(r) if r.status().is_success() || r.status().is_redirection() => (true, Value::Null),
            Ok(r) => (false, format!("HTTP {}", r.status().as_u16()).into()),
            Err(e) => (false, crate::runtime::download_error(e).to_string().into()),
        };
        results.push(json!({ "name": name, "url": url, "ok": ok, "detail": detail }));
    }
    let ok = results.iter().all(|r| r["ok"] == true);
    Ok(Json(json!({ "ok": ok, "results": results })))
}

/// Ends the app when setup cannot continue on this PC.
async fn quit() -> ApiResult {
    if SHELL.get().is_none() {
        return Err(invalid("개발 서버는 직접 종료해 주세요.").into());
    }
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        (SHELL.get().unwrap().quit)();
    });
    ok()
}

pub fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/onboarding/state", get(state))
        .route("/api/onboarding/network", post(network))
        .route("/api/app/quit", post(quit))
        .route("/api/onboarding", get(status).put(save))
        .route("/api/onboarding/wsl", post(install_wsl))
        .route("/api/onboarding/complete", post(complete))
}
