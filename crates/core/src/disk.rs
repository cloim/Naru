//! The WSL virtual disk: usage and compaction with diskpart.
use crate::engine;
use crate::runner::{args, command, distributions, maintenance_file, wsl, Log, Opts};
use crate::runtime;
use crate::state::{atomic_json, data, read_json, DISTRO};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const GB: u64 = 1024 * 1024 * 1024;
/// Reclaiming less than this is not worth stopping the engine.
pub const MIN_RECLAIM: u64 = GB;
const UAC_TIMEOUT: Duration = Duration::from_secs(120);
const COMPACT_TIMEOUT: Duration = Duration::from_secs(3600);
/// How long the approved batch waits for the engine to stop, in seconds.
const GO_TIMEOUT: u32 = 300;

fn vhdx() -> PathBuf {
    data().join("wsl").join("ext4.vhdx")
}
fn work() -> PathBuf {
    data().join("maintenance")
}
/// Containers running before a compaction. It outlives the job so an interrupted compaction recovers on the next start.
fn restore_file() -> PathBuf {
    data().join("restore.json")
}
fn record_file() -> PathBuf {
    data().join("compaction.json")
}
fn gb(bytes: u64) -> String {
    format!("{:.1}GB", bytes as f64 / GB as f64)
}

/// A compaction that cannot help right now: recorded as skipped, not failed.
#[derive(Debug)]
struct Skipped(String);

impl std::fmt::Display for Skipped {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Skipped {}

/// The virtual disk file size and the space used inside it. Usage needs the engine running.
pub async fn disk_usage() -> Result<Value> {
    let file = tokio::fs::metadata(vhdx()).await?.len();
    if !distributions(true).await?.iter().any(|d| d == DISTRO) {
        return Ok(json!({ "file": file, "used": null, "reclaimable": null }));
    }
    let df = wsl(&args(["df", "-k", "/"]), Opts::default()).await?;
    let used: u64 = df
        .lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(2))
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| anyhow!("디스크 사용량을 읽을 수 없습니다."))?;
    let used = used * 1024;
    Ok(json!({ "file": file, "used": used, "reclaimable": file.saturating_sub(used) }))
}

/// The last compaction attempt, for the settings screen.
pub async fn last_compaction() -> Option<Value> {
    read_json(&record_file(), None).await.ok()
}

/// Whether the distribution let go of the disk. While attached, opening it for writing fails.
async fn released(wait: Duration) -> Result<bool> {
    let until = Instant::now() + wait;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(vhdx()) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) => {
                if Instant::now() > until {
                    return Ok(false);
                }
            }
            Err(e) => return Err(e.into()),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

struct DiskBusy;

/// The approved batch, waiting for go or cancel. Nothing has stopped yet.
struct Elevated {
    go: PathBuf,
    cancel: PathBuf,
    done: PathBuf,
    output: PathBuf,
}

impl Elevated {
    async fn cancel(&self) {
        if tokio::fs::write(&self.cancel, "").await.is_ok() {
            // Let the batch see it before the work folder goes.
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn run(&self, log: &Log) -> Result<(), (anyhow::Error, Option<DiskBusy>)> {
        tokio::fs::write(&self.go, "").await.map_err(|e| (e.into(), None))?;
        log("압축을 시작했습니다. 디스크 크기에 따라 몇 분 걸립니다.\n");
        let until = Instant::now() + COMPACT_TIMEOUT;
        while !self.done.exists() {
            if Instant::now() > until {
                return Err((anyhow!("압축 제한 시간을 넘었습니다. diskpart가 끝난 뒤 설정에서 엔진을 직접 시작해 주세요."), Some(DiskBusy)));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let code = tokio::fs::read_to_string(&self.done).await.unwrap_or_default().trim().to_string();
        if code == "expired" {
            return Err((anyhow!("엔진 종료가 늦어져 관리자 권한 작업이 끝났습니다. 다시 시도해 주세요."), None));
        }
        log(&format!("{}\n", tokio::fs::read_to_string(&self.output).await.unwrap_or_default().trim()));
        if code != "0" {
            return Err((anyhow!("diskpart가 실패했습니다 (종료 코드 {code})."), None));
        }
        Ok(())
    }
}

/// Labels instead of parenthesized blocks: a `)` in the data folder path would end a block early.
fn batch_script(script: &Path, started: &Path, e: &Elevated, wait: u32) -> String {
    let lines = [
        "@echo off".to_string(),
        "chcp 65001 >nul".into(),
        format!("if not exist \"{}\" exit /b 1", script.display()),
        format!("echo started> \"{}\"", started.display()),
        "set n=0".into(),
        ":wait".into(),
        format!("if exist \"{}\" goto run", e.go.display()),
        format!("if exist \"{}\" exit /b 2", e.cancel.display()),
        "set /a n+=1".into(),
        format!("if %n% geq {wait} goto expired"),
        "ping -n 2 127.0.0.1 >nul".into(),
        "goto wait".into(),
        ":run".into(),
        format!("diskpart /s \"{}\" > \"{}\" 2>&1", script.display(), e.output.display()),
        format!("echo %errorlevel%> \"{}\"", e.done.display()),
        "exit /b 0".into(),
        ":expired".into(),
        format!("echo expired> \"{}\"", e.done.display()),
        "exit /b 3".into(),
        String::new(),
    ];
    lines.join("\r\n")
}

/// diskpart needs administrator rights, so approval comes before the engine stops: a refusal or a late approval
/// leaves the containers running. The approved batch leaves a start marker and waits for go or cancel. If approval
/// comes too late the script is deleted first, so a later approval does nothing.
async fn elevate(log: &Log) -> Result<Elevated> {
    let dir = work();
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await?;
    let (script, batch, started) = (dir.join("compact.txt"), dir.join("compact.cmd"), dir.join("started"));
    let elevated = Elevated { go: dir.join("go"), cancel: dir.join("cancel"), done: dir.join("done"), output: dir.join("diskpart.log") };
    tokio::fs::write(&script, format!("select vdisk file=\"{}\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\n", vhdx().display()))
        .await?;
    tokio::fs::write(&batch, batch_script(&script, &started, &elevated, GO_TIMEOUT)).await?;
    log("관리자 권한 승인 창(UAC)이 PC 화면에 뜹니다. 2분 안에 승인해 주세요. 승인 전에는 엔진을 멈추지 않습니다.\n");
    let mut opts = Opts::default();
    opts.env = vec![("NARU_BATCH".into(), batch.to_string_lossy().into_owned())];
    crate::runner::powershell("naru-elevate.ps1", opts)
        .await
        .map_err(|e| anyhow!("관리자 권한을 받지 못했습니다: {e}"))?;
    let until = Instant::now() + UAC_TIMEOUT;
    while !started.exists() {
        if Instant::now() > until {
            let _ = tokio::fs::remove_file(&script).await;
            // If approval came right before the delete, it already started; it waits for go.
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !started.exists() {
                return Err(anyhow!("관리자 권한 승인 시간이 지났습니다. 엔진은 그대로 실행 중입니다."));
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    log("관리자 권한을 받았습니다. 엔진을 멈춥니다.\n");
    Ok(elevated)
}

async fn save_running() -> Result<usize> {
    let list = engine::list("containers").await?;
    let running: Vec<Value> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["State"] == "running")
        .map(|c| json!({ "id": c["Id"], "name": c["Names"][0] }))
        .collect();
    atomic_json(&restore_file(), &json!({ "since": crate::jobs::now(), "containers": running })).await?;
    Ok(running.len())
}

/// Starts the containers that ran before a compaction; restart policies only bring back some of them.
/// The engine start calls it, so a compaction that ended without restarting recovers on the next start too.
pub async fn restore_running(log: &Log) {
    let Ok(saved) = read_json::<Value>(&restore_file(), None).await else { return };
    let current = match engine::list("containers").await {
        Ok(current) => current,
        Err(e) => {
            log(&format!("압축 전에 실행 중이던 컨테이너를 확인하지 못했습니다: {e}\n"));
            return;
        }
    };
    for c in saved["containers"].as_array().into_iter().flatten() {
        let Some(id) = c["id"].as_str() else { continue };
        let name = c["name"].as_str().unwrap_or(id).trim_start_matches('/');
        let Some(state) = current.as_array().into_iter().flatten().find(|x| x["Id"] == id).map(|x| &x["State"]) else {
            log(&format!("{name}: 삭제되어 다시 시작하지 않습니다.\n"));
            continue;
        };
        if state == "running" {
            continue;
        }
        match engine::container_action(id, "start", log).await {
            Ok(_) => log(&format!("{name}: 다시 시작했습니다.\n")),
            Err(e) => log(&format!("{name}: 다시 시작하지 못했습니다: {e}\n")),
        }
    }
    let _ = tokio::fs::remove_file(restore_file()).await;
}

async fn compact(log: &Log) -> Result<(u64, u64)> {
    let before = disk_usage().await?;
    let (Some(file), Some(used), Some(reclaimable)) = (before["file"].as_u64(), before["used"].as_u64(), before["reclaimable"].as_u64())
    else {
        return Err(Skipped("엔진을 켠 상태에서 압축해 주세요.".into()).into());
    };
    if reclaimable < MIN_RECLAIM {
        return Err(Skipped(format!("돌려받을 공간이 {}뿐이라 압축하지 않습니다.", gb(reclaimable))).into());
    }
    log(&format!("디스크 파일 {}, 사용 {}\n", gb(file), gb(used)));
    log(&format!("{}\n", wsl(&args(["fstrim", "-v", "/"]), Opts::timeout(600)).await?));
    let elevated = match elevate(log).await {
        Ok(elevated) => elevated,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(work()).await;
            return Err(e);
        }
    };
    let result: Result<(), (anyhow::Error, Option<DiskBusy>)> = async {
        let count = save_running().await.map_err(|e| (e, None))?;
        log(&format!("실행 중인 컨테이너 {count}개를 기록했습니다. 압축 뒤 다시 시작합니다.\n"));
        // While this marker exists the server never wakes the distribution (runner::assert_distro_available).
        atomic_json(&maintenance_file(), &json!({ "pid": std::process::id(), "since": crate::jobs::now() }))
            .await
            .map_err(|e| (e, None))?;
        runtime::stop(log).await.map_err(|e| (e, None))?;
        if !released(Duration::from_secs(20)).await.map_err(|e| (e, None))? {
            log("Naru 배포판만 종료해서는 디스크가 풀리지 않아 WSL 전체를 종료합니다.\n");
            command("wsl.exe", &args(["--shutdown"]), Opts::timeout(60)).await.map_err(|e| (e, None))?;
            if !released(Duration::from_secs(30)).await.map_err(|e| (e, None))? {
                return Err((anyhow!("다른 프로세스가 디스크 파일을 쓰고 있어 압축하지 않았습니다."), None));
            }
        }
        elevated.run(log).await
    }
    .await;
    let _ = tokio::fs::remove_file(maintenance_file()).await;
    let busy = matches!(result, Err((_, Some(DiskBusy))));
    // While diskpart still holds the disk, the engine stays off and the work folder stays for its log.
    if !busy {
        if result.is_err() {
            elevated.cancel().await;
        }
        let _ = tokio::fs::remove_dir_all(work()).await;
        log("엔진을 다시 시작합니다.\n");
        runtime::start(log).await?;
    }
    result.map_err(|(e, _)| e)?;
    let after = tokio::fs::metadata(vhdx()).await?.len();
    log(&format!("압축 완료: {} → {} ({} 회수)\n", gb(file), gb(after), gb(file.saturating_sub(after))));
    Ok((file, after))
}

pub async fn compact_disk(log: &Log) -> Result<()> {
    let at = crate::jobs::now();
    let outcome = compact(log).await;
    let record = match &outcome {
        Ok((before, after)) => json!({ "at": at, "trigger": "manual", "result": "done", "before": before, "after": after }),
        Err(e) => json!({
            "at": at,
            "trigger": "manual",
            "result": if e.downcast_ref::<Skipped>().is_some() { "skipped" } else { "failed" },
            "reason": e.to_string(),
        }),
    };
    let _ = atomic_json(&record_file(), &record).await;
    outcome.map(|_| ())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Runs the batch as the current user. Only the waiting paths run: diskpart is never reached.
    fn run(name: &str, wait: u32, prepare: impl FnOnce(&Elevated, &Path)) -> (Option<i32>, Elevated, PathBuf) {
        let dir = std::env::temp_dir().join(format!("naru-compact-{name}-{}", std::process::id())).join("a (b)");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (script, batch, started) = (dir.join("compact.txt"), dir.join("compact.cmd"), dir.join("started"));
        let e = Elevated { go: dir.join("go"), cancel: dir.join("cancel"), done: dir.join("done"), output: dir.join("diskpart.log") };
        prepare(&e, &script);
        std::fs::write(&batch, batch_script(&script, &started, &e, wait)).unwrap();
        let status = std::process::Command::new("cmd.exe").args(["/d", "/c"]).arg(&batch).status().unwrap();
        (status.code(), e, started)
    }

    #[test]
    fn missing_script_does_nothing() {
        let (code, e, started) = run("missing", 2, |_, _| {});
        assert_eq!(code, Some(1));
        assert!(!started.exists() && !e.done.exists());
    }

    #[test]
    fn cancel_ends_without_diskpart() {
        let (code, e, started) = run("cancel", 30, |e, script| {
            std::fs::write(script, "").unwrap();
            std::fs::write(&e.cancel, "").unwrap();
        });
        assert_eq!(code, Some(2));
        assert!(started.exists());
        assert!(!e.done.exists() && !e.output.exists());
    }

    #[test]
    fn waiting_too_long_reports_expired() {
        let (code, e, _) = run("expired", 2, |_, script| std::fs::write(script, "").unwrap());
        assert_eq!(code, Some(3));
        assert_eq!(std::fs::read_to_string(&e.done).unwrap().trim(), "expired");
        assert!(!e.output.exists());
    }
}
