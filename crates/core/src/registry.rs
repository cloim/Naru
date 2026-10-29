//! Registry credentials go to Docker's dedicated Windows Credential Manager helper.
//! Passwords travel only on stdin from the login job, never in argv or logs.
use crate::runner::{args, wsl, wsl_sh, Log, Opts};
use crate::state::{atomic_json, data};
use crate::tools::ensure_windows_tool;
use anyhow::Result;
use serde_json::{json, Value};

pub async fn ensure_credential_helper(log: &Log) -> Result<()> {
    let bin = data().join("bin");
    tokio::fs::create_dir_all(&bin).await?;
    let dest = ensure_windows_tool("wincred", log).await?;
    let linux = wsl(&args(["wslpath", "-a", &dest.to_string_lossy()]), Opts::default()).await?;
    let script = format!("#!/bin/sh\nexec '{}' \"$@\"\n", linux.replace('\'', "'\\''"));
    wsl_sh(
        "cat > /usr/local/bin/docker-credential-naru; chmod 755 /usr/local/bin/docker-credential-naru; mkdir -p /etc/naru/docker",
        Opts::default().input(script),
    )
    .await?;
    let mut config: Value = wsl(&args(["cat", "/etc/naru/docker/config.json"]), Opts::default())
        .await
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    config["credsStore"] = "naru".into();
    if !config["auths"].is_object() {
        config["auths"] = json!({});
    }
    wsl_sh("umask 077; cat > /etc/naru/docker/config.json", Opts::default().input(config.to_string())).await?;
    atomic_json(
        &bin.join("credential-helper.json"),
        &json!({ "helper": "docker-credential-wincred", "copiedAt": crate::jobs::now() }),
    )
    .await?;
    log("Naru 전용 Docker 설정에 Windows 자격 증명 도우미를 연결했습니다.\n");
    Ok(())
}
