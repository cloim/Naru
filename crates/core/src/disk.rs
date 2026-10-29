//! The WSL virtual disk: usage and compaction with diskpart.
use crate::runner::{args, command, distributions, maintenance_file, wsl, Log, Opts};
use crate::runtime;
use crate::state::{atomic_json, data, DISTRO};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const GB: u64 = 1024 * 1024 * 1024;
/// Reclaiming less than this is not worth stopping the engine.
pub const MIN_RECLAIM: u64 = GB;
const UAC_TIMEOUT: Duration = Duration::from_secs(120);
const COMPACT_TIMEOUT: Duration = Duration::from_secs(3600);

fn vhdx() -> PathBuf {
    data().join("wsl").join("ext4.vhdx")
}
fn work() -> PathBuf {
    data().join("maintenance")
}
fn gb(bytes: u64) -> String {
    format!("{:.1}GB", bytes as f64 / GB as f64)
}

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

/// diskpart needs administrator rights. The batch run after UAC approval leaves a start marker; if approval
/// comes too late the script is deleted first, so a later approval does nothing.
async fn elevated_compact(log: &Log) -> Result<(), (anyhow::Error, Option<DiskBusy>)> {
    let fail = |e: anyhow::Error| (e, None);
    let dir = work();
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| fail(e.into()))?;
    let (script, batch, started, done, output) =
        (dir.join("compact.txt"), dir.join("compact.cmd"), dir.join("started"), dir.join("done"), dir.join("diskpart.log"));
    let vhdx = vhdx();
    tokio::fs::write(&script, format!("select vdisk file=\"{}\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\n", vhdx.display()))
        .await
        .map_err(|e| fail(e.into()))?;
    let lines = [
        "@echo off".to_string(),
        "chcp 65001 >nul".into(),
        format!("if not exist \"{}\" exit /b 1", script.display()),
        format!("echo started> \"{}\"", started.display()),
        format!("diskpart /s \"{}\" > \"{}\" 2>&1", script.display(), output.display()),
        format!("echo %errorlevel%> \"{}\"", done.display()),
        String::new(),
    ];
    tokio::fs::write(&batch, lines.join("\r\n")).await.map_err(|e| fail(e.into()))?;
    log("관리자 권한 승인 창(UAC)이 PC 화면에 뜹니다. 2분 안에 승인해 주세요.\n");
    let start = format!(
        "Start-Process -FilePath cmd.exe -ArgumentList '/d','/c','\"{}\"' -Verb RunAs -WindowStyle Hidden",
        batch.display()
    );
    command("powershell.exe", &args(["-NoProfile", "-NonInteractive", "-Command", &start]), Opts::default())
        .await
        .map_err(|e| fail(anyhow!("관리자 권한을 받지 못했습니다: {e}")))?;
    let until = Instant::now() + UAC_TIMEOUT;
    while !started.exists() {
        if Instant::now() > until {
            let _ = tokio::fs::remove_file(&script).await;
            // If approval came right before the delete, it already started; wait for it.
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !started.exists() {
                return Err(fail(anyhow!("관리자 권한 승인 시간이 지났습니다.")));
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    log("압축을 시작했습니다. 디스크 크기에 따라 몇 분 걸립니다.\n");
    let until = Instant::now() + COMPACT_TIMEOUT;
    while !done.exists() {
        if Instant::now() > until {
            return Err((anyhow!("압축 제한 시간을 넘었습니다. diskpart가 끝난 뒤 설정에서 엔진을 직접 시작해 주세요."), Some(DiskBusy)));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let code = tokio::fs::read_to_string(&done).await.unwrap_or_default().trim().to_string();
    log(&format!("{}\n", tokio::fs::read_to_string(&output).await.unwrap_or_default().trim()));
    if code != "0" {
        return Err(fail(anyhow!("diskpart가 실패했습니다 (종료 코드 {code}).")));
    }
    Ok(())
}

pub async fn compact_disk(log: &Log) -> Result<()> {
    let before = disk_usage().await?;
    let (Some(file), Some(used), Some(reclaimable)) = (before["file"].as_u64(), before["used"].as_u64(), before["reclaimable"].as_u64())
    else {
        bail!("엔진을 켠 상태에서 압축해 주세요.");
    };
    if reclaimable < MIN_RECLAIM {
        bail!("돌려받을 공간이 {}뿐이라 압축하지 않습니다.", gb(reclaimable));
    }
    log(&format!("디스크 파일 {}, 사용 {}\n", gb(file), gb(used)));
    log(&format!("{}\n", wsl(&args(["fstrim", "-v", "/"]), Opts::timeout(600)).await?));
    // While this marker exists the server never wakes the distribution (runner::assert_distro_available).
    atomic_json(&maintenance_file(), &json!({ "pid": std::process::id(), "since": crate::jobs::now() })).await?;
    let result: Result<(), (anyhow::Error, Option<DiskBusy>)> = async {
        runtime::stop(log).await.map_err(|e| (e, None))?;
        if !released(Duration::from_secs(20)).await.map_err(|e| (e, None))? {
            log("Naru 배포판만 종료해서는 디스크가 풀리지 않아 WSL 전체를 종료합니다.\n");
            command("wsl.exe", &args(["--shutdown"]), Opts::timeout(60)).await.map_err(|e| (e, None))?;
            if !released(Duration::from_secs(30)).await.map_err(|e| (e, None))? {
                return Err((anyhow!("다른 프로세스가 디스크 파일을 쓰고 있어 압축하지 않았습니다."), None));
            }
        }
        elevated_compact(log).await
    }
    .await;
    let _ = tokio::fs::remove_file(maintenance_file()).await;
    let busy = matches!(result, Err((_, Some(DiskBusy))));
    // While diskpart still holds the disk, the engine stays off and the work folder stays for its log.
    if !busy {
        let _ = tokio::fs::remove_dir_all(work()).await;
        log("엔진을 다시 시작합니다.\n");
        runtime::start(log).await?;
    }
    result.map_err(|(e, _)| e)?;
    let after = tokio::fs::metadata(vhdx()).await?.len();
    log(&format!("압축 완료: {} → {} ({} 회수)\n", gb(file), gb(after), gb(file.saturating_sub(after))));
    Ok(())
}
