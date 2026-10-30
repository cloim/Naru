//! Kubernetes port forwards: kubectl port-forward inside the engine namespace, opened on Windows by naru-agent.
use crate::runner::{args, detached, distributions, wsl, wsl_sh, Log, Opts};
use crate::runtime::require_ready;
use crate::state::{atomic_json, data, read_json, root, DISTRO};
use anyhow::{bail, Result};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

fn dir() -> PathBuf {
    data().join("forwards")
}

async fn alive(meta: &Value) -> bool {
    let (Some(pid), Some(ticks)) = (meta["linuxPid"].as_u64(), meta["startTicks"].as_str()) else { return false };
    if ticks.is_empty() || !ticks.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    wsl_sh(&format!("awk '{{print $22}}' /proc/{pid}/stat"), Opts::default()).await.is_ok_and(|t| t == ticks)
}

pub async fn list_forwards() -> Result<Vec<Value>> {
    let dir = dir();
    tokio::fs::create_dir_all(&dir).await?;
    let active = distributions(true).await?.iter().any(|d| d == DISTRO);
    let mut rows = vec![];
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let mut row: Value = read_json(&entry.path(), None).await?;
        if row["state"] == "running" && !(active && alive(&row).await) {
            row["state"] = "stopped".into();
            atomic_json(&entry.path(), &row).await?;
        }
        rows.push(row);
    }
    Ok(rows)
}

pub async fn create_forward(p: &Value, log: &Log) -> Result<()> {
    require_ready().await?;
    let local_port = p["localPort"].as_u64().unwrap_or_default() as u16;
    // Reserve the host port as a preflight. Never seize another application's listener.
    std::net::TcpListener::bind(("127.0.0.1", local_port))?;
    let text = tokio::fs::read_to_string(root().join("scripts").join("naru-forward.sh")).await?.replace('\r', "");
    wsl_sh("cat > /usr/local/bin/naru-forward; chmod 755 /usr/local/bin/naru-forward", Opts::default().input(text)).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let ports = format!("{}:{}", local_port, p["remotePort"]);
    let pid = detached(
        "wsl.exe",
        &args([
            "-d",
            DISTRO,
            "-u",
            "root",
            "--exec",
            "/usr/local/bin/naru-forward",
            &id,
            p["namespace"].as_str().unwrap_or("default"),
            p["resource"].as_str().unwrap_or_default(),
            &ports,
        ]),
        None,
    )
    .await?;
    let mut meta = p.clone();
    meta["id"] = id.clone().into();
    meta["pid"] = pid.into();
    meta["state"] = "starting".into();
    meta["createdAt"] = crate::jobs::now().into();
    let file = dir().join(format!("{id}.json"));
    atomic_json(&file, &meta).await?;
    for _ in 0..30 {
        let output = wsl_sh(&format!("cat /var/log/naru/forward-{id}.log 2>/dev/null || true"), Opts::default()).await?;
        if output.contains("Forwarding from") {
            let identity = wsl_sh(
                &format!("pid=$(cat /run/naru/forwards/{id}.pid); printf '%s ' \"$pid\"; awk '{{print $22}}' /proc/$pid/stat"),
                Opts::default(),
            )
            .await?;
            let mut parts = identity.split(' ');
            let linux_pid: u64 = parts.next().unwrap_or_default().parse().unwrap_or_default();
            meta["state"] = "running".into();
            meta["linuxPid"] = linux_pid.into();
            meta["startTicks"] = parts.next().unwrap_or_default().into();
            atomic_json(&file, &meta).await?;
            log(&output);
            return Ok(());
        }
        if output.contains("error:") || output.contains("Error") {
            meta["state"] = "failed".into();
            meta["error"] = output.clone().into();
            atomic_json(&file, &meta).await?;
            bail!(output);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    meta["state"] = "failed".into();
    meta["error"] = "포트 전달 시작 시간 초과".into();
    atomic_json(&file, &meta).await?;
    bail!("포트 전달 시작 시간 초과.")
}

pub async fn stop_forward(id: &str, log: &Log) -> Result<()> {
    require_ready().await?;
    let file = dir().join(format!("{id}.json"));
    let mut meta: Value = read_json(&file, None).await?;
    if alive(&meta).await {
        wsl(&args(["kill", &meta["linuxPid"].to_string()]), Opts::default()).await?;
    }
    meta["state"] = "stopped".into();
    atomic_json(&file, &meta).await?;
    log("포트 전달을 종료했습니다.\n");
    Ok(())
}

/// Removes a stopped forward record. Works with the engine off too.
pub async fn remove_forward(id: &str, log: &Log) -> Result<()> {
    let file = dir().join(format!("{id}.json"));
    let meta: Value = read_json(&file, None).await?;
    let active = distributions(true).await?.iter().any(|d| d == DISTRO);
    if active && alive(&meta).await {
        bail!("실행 중인 포트 전달은 먼저 종료해 주세요.");
    }
    if active {
        wsl(&args(["rm", "-f", &format!("/var/log/naru/forward-{id}.log"), &format!("/run/naru/forwards/{id}.pid")]), Opts::default())
            .await?;
    }
    tokio::fs::remove_file(&file).await?;
    log("포트 전달 기록을 삭제했습니다.\n");
    Ok(())
}
