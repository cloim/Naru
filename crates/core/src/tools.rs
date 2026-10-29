//! Windows CLI tools from official releases, verified before use, and the Docker CLI settings Naru owns.
use crate::runner::{args, command, wsl, Log, Opts};
use crate::runtime::{download, sha256};
use crate::state::{atomic_json, container_proxy_config, data, read_json, settings};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub struct Tool {
    pub file: &'static str,
    pub url: String,
    pub sha256: String,
    /// The file inside an archive; None when the download is the executable itself.
    pub entry: Option<&'static str>,
}

fn known(name: &str) -> Option<Tool> {
    let tool = |file, url: &str, sha: &str, entry| Tool { file, url: url.into(), sha256: sha.into(), entry };
    Some(match name {
        "docker" => tool(
            "docker.exe",
            "https://download.docker.com/win/static/stable/x86_64/docker-29.9.2.zip",
            "b2be959bfed1281ddaf665c0972cba9a62ce30c542b6bcce82f055bf8886bc7d",
            Some("docker/docker.exe"),
        ),
        "compose" => tool(
            "cli-plugins/docker-compose.exe",
            "https://github.com/docker/compose/releases/download/v5.3.1/docker-compose-windows-x86_64.exe",
            "6d36cc701393c066d67ebc77773b718d8c738bc4ccb350fbf1dc0e6a09f44cb9",
            None,
        ),
        "buildx" => tool(
            "cli-plugins/docker-buildx.exe",
            "https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.windows-amd64.exe",
            "8076395009787cd1d30c94edeb5d7ac3945273374fc162c00e9810c3e9325ebe",
            None,
        ),
        "wincred" => tool(
            "docker-credential-wincred.exe",
            "https://github.com/docker/docker-credential-helpers/releases/download/v0.9.8/docker-credential-wincred-v0.9.8.windows-amd64.exe",
            "fec0aa06335bbefc7f515630c9368afaa1423fa9fa585112f123b6625f72d560",
            None,
        ),
        "helm" => tool(
            "helm.exe",
            "https://get.helm.sh/helm-v4.2.3-windows-amd64.tar.gz",
            "02c6137bb5f050479193afad5a28804e9edc3beeab7e7b53a6e1499c9ba387ef",
            Some("windows-amd64/helm.exe"),
        ),
        _ => return None,
    })
}

fn provenance(dest: &std::path::Path) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(".provenance.json");
    p.into()
}

pub async fn ensure_windows_tool(name: &str, log: &Log) -> Result<PathBuf> {
    let spec = if name == "kubectl" {
        let version = settings().await?.kubernetes.version.split('+').next().unwrap_or_default().to_string();
        let url = format!("https://dl.k8s.io/release/{version}/bin/windows/amd64/kubectl.exe");
        let existing = data().join("bin").join("kubectl.exe");
        if let Ok(record) = read_json::<Value>(&provenance(&existing), None).await {
            if record["url"] == url.as_str() && sha256(&existing).await.ok().as_deref() == record["sha256"].as_str() {
                return Ok(existing);
            }
        }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?;
        let response = client.get(format!("{url}.sha256")).send().await?;
        if !response.status().is_success() {
            bail!("kubectl 체크섬 다운로드 실패.");
        }
        let digest = response.text().await?.trim().to_string();
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            bail!("kubectl 체크섬 형식 오류.");
        }
        Tool { file: "kubectl.exe", url, sha256: digest, entry: None }
    } else {
        known(name).ok_or_else(|| anyhow!("알 수 없는 도구: {name}"))?
    };
    let dest = data().join("bin").join(spec.file);
    tokio::fs::create_dir_all(dest.parent().unwrap()).await?;
    let cache = data().join("cache").join("tools").join(spec.url.rsplit('/').next().unwrap());
    tokio::fs::create_dir_all(cache.parent().unwrap()).await?;
    match spec.entry {
        None => {
            if sha256(&dest).await.ok().as_deref() == Some(spec.sha256.as_str()) {
                return Ok(dest);
            }
        }
        Some(_) => {
            if let Ok(record) = read_json::<Value>(&provenance(&dest), None).await {
                if record["archiveSha256"] == spec.sha256.as_str() && sha256(&dest).await.ok().as_deref() == record["sha256"].as_str() {
                    return Ok(dest);
                }
            }
        }
    }
    if cache.exists() && sha256(&cache).await? != spec.sha256 {
        tokio::fs::remove_file(&cache).await?;
    }
    if !cache.exists() {
        log(&format!("공식 도구 다운로드: {name}\n"));
        download(&spec.url, &cache, Some(log)).await?;
    }
    if sha256(&cache).await? != spec.sha256 {
        bail!("{name} SHA256 검증 실패.");
    }
    // Previously copied installers can keep the source file's read-only attribute.
    if let Ok(meta) = tokio::fs::metadata(&dest).await {
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        tokio::fs::set_permissions(&dest, perms).await?;
    }
    match spec.entry {
        Some(entry) => {
            let stage = data().join("cache").join("tools").join(format!("extract-{name}"));
            tokio::fs::create_dir_all(&stage).await?;
            command("tar.exe", &args(["-xf", &cache.to_string_lossy(), "-C", &stage.to_string_lossy(), entry]), Opts::default()).await?;
            tokio::fs::copy(stage.join(entry), &dest).await?;
        }
        None => {
            tokio::fs::copy(&cache, &dest).await?;
        }
    }
    atomic_json(&provenance(&dest), &json!({ "url": spec.url, "archiveSha256": spec.sha256, "sha256": sha256(&dest).await? })).await?;
    Ok(dest)
}

/// The Compose plugin inside naru, used by extensions with a VM service. It comes from the Alpine package.
pub async fn ensure_compose(log: &Log) -> Result<()> {
    if wsl(&args(["test", "-x", "/usr/libexec/docker/cli-plugins/docker-compose"]), Opts::default()).await.is_ok() {
        return Ok(());
    }
    wsl(&args(["apk", "add", "--no-cache", "docker-cli-compose"]), Opts::timeout(600).log(log)).await?;
    Ok(())
}

pub fn user_docker_config() -> PathBuf {
    std::env::var_os("DOCKER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".docker"))
}

/// The Windows Docker CLI and buildx pass these proxies to containers and BuildKit builds.
/// A proxy the user configured there stays; Naru only replaces or removes the value it wrote.
pub async fn sync_cli_proxies() -> Result<()> {
    let proxies = container_proxy_config(&settings().await?.proxy);
    let file = user_docker_config().join("config.json");
    let record = data().join("docker").join("cli-proxies.json");
    let mut config: Value = read_json(&file, Some(json!({}))).await?;
    let current = config["proxies"]["default"].clone();
    let wanted = proxies.clone().unwrap_or(Value::Null);
    if current == wanted {
        return Ok(());
    }
    if !current.is_null() && current != read_json::<Value>(&record, Some(Value::Null)).await? {
        return Ok(());
    }
    match proxies {
        Some(p) => {
            if !config["proxies"].is_object() {
                config["proxies"] = json!({});
            }
            config["proxies"]["default"] = p;
        }
        None => {
            if let Some(map) = config["proxies"].as_object_mut() {
                map.remove("default");
                if map.is_empty() {
                    config.as_object_mut().unwrap().remove("proxies");
                }
            }
        }
    }
    atomic_json(&file, &config).await?;
    atomic_json(&record, &wanted).await
}
