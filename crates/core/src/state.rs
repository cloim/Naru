//! Locations, settings and small JSON file helpers shared by the server and job workers.
use crate::context::remote_target;
use anyhow::{bail, Context, Result};
use regex::Regex;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};

pub const DISTRO: &str = "naru";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Sets the folder holding `scripts/` and `dist/`: the repository in development, the app resources once packaged.
pub fn init_root(root: PathBuf) {
    let _ = ROOT.set(root);
}

pub fn root() -> &'static Path {
    ROOT.get_or_init(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        exe.parent().map(Path::to_path_buf).unwrap_or_default()
    })
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_default()
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// Every setting a user chooses lives in ~/.config/Naru; the data folder holds disks, caches and state.
pub fn config_dir() -> PathBuf {
    home().join(".config").join("Naru")
}

/// The fixed app file. It records where the data folder is, so it never moves itself.
pub fn app_file() -> PathBuf {
    config_dir().join("app.json")
}

pub fn settings_file() -> PathBuf {
    config_dir().join("settings.json")
}

/// Earlier versions kept settings beside the data. They are copied, not moved, so an older Naru
/// still running from the same folder keeps working until it is replaced.
pub fn migrate_legacy_config() {
    let dir = config_dir();
    let copy = |from: PathBuf, name: &str| {
        let to = dir.join(name);
        if !to.exists() && from.is_file() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::copy(&from, &to);
        }
    };
    let legacy = local_app_data().join("Naru");
    // app.json first: it may point the data folder somewhere else.
    copy(legacy.join("app.json"), "app.json");
    let data_dir = std::env::var_os("NARU_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app_config().data_dir.map(PathBuf::from))
        .unwrap_or(legacy);
    for name in ["settings.json", "engines.json", "remote.json"] {
        copy(data_dir.join(name), name);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub data_dir: Option<String>,
    /// The screen and API port; the next port serves extension screens.
    pub port: Option<u16>,
    pub onboarded: bool,
    pub launch_at_login: bool,
}

pub const DEFAULT_PORT: u16 = 49170;

pub fn app_port() -> u16 {
    app_config().port.unwrap_or(DEFAULT_PORT)
}

pub fn app_config() -> AppConfig {
    std::fs::read_to_string(app_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn default_data() -> PathBuf {
    local_app_data().join("Naru")
}

/// NARU_DATA_DIR stays as a development override; users choose the folder during onboarding.
pub static DATA: LazyLock<PathBuf> = LazyLock::new(|| {
    if let Some(dir) = std::env::var_os("NARU_DATA_DIR") {
        return PathBuf::from(dir);
    }
    app_config().data_dir.map(PathBuf::from).unwrap_or_else(default_data)
});

pub fn data() -> &'static Path {
    &DATA
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Kubernetes {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_k3s")]
    pub version: String,
    #[serde(default = "default_k8s_port")]
    pub port: u16,
    #[serde(default = "yes")]
    pub traefik: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proxy {
    #[serde(default)]
    pub http: String,
    #[serde(default)]
    pub https: String,
    #[serde(default = "default_no_proxy")]
    pub no_proxy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default = "managed")]
    pub connection: String,
    #[serde(default = "moby")]
    pub engine: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
    #[serde(default = "yes")]
    pub auto_start: bool,
    #[serde(default)]
    pub kubernetes: Kubernetes,
    #[serde(default)]
    pub proxy: Proxy,
    #[serde(default = "default_poll")]
    pub poll_seconds: u32,
}

fn managed() -> String {
    "managed".into()
}
fn moby() -> String {
    "moby".into()
}
fn default_namespace() -> String {
    "default".into()
}
fn default_k3s() -> String {
    "v1.34.1+k3s1".into()
}
fn default_k8s_port() -> u16 {
    6445
}
fn default_no_proxy() -> String {
    "localhost,127.0.0.1,::1,.svc,.cluster.local".into()
}
fn default_poll() -> u32 {
    5
}
fn yes() -> bool {
    true
}

impl Default for Kubernetes {
    fn default() -> Self {
        serde_json::from_str("{}").expect("kubernetes defaults")
    }
}
impl Default for Proxy {
    fn default() -> Self {
        serde_json::from_str("{}").expect("proxy defaults")
    }
}
impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").expect("settings defaults")
    }
}

static NAMESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_.-]{1,64}$").unwrap());
static K3S_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^v1\.\d+\.\d+\+k3s\d+$").unwrap());

impl Settings {
    /// Parses and validates like the stored schema: unknown keys and out-of-range values fail.
    pub fn parse(value: serde_json::Value) -> Result<Settings> {
        let mut settings: Settings = serde_json::from_value(value).context("설정 형식을 확인해 주세요.")?;
        settings.connection = managed();
        if !["moby", "containerd"].contains(&settings.engine.as_str()) {
            bail!("엔진은 moby 또는 containerd만 선택할 수 있습니다.");
        }
        if !NAMESPACE.is_match(&settings.namespace) {
            bail!("containerd 네임스페이스 형식이 잘못되었습니다.");
        }
        if !K3S_VERSION.is_match(&settings.kubernetes.version) {
            bail!("k3s 버전 형식을 확인해 주세요.");
        }
        if settings.kubernetes.port < 1024 {
            bail!("Kubernetes API 포트는 1024 이상이어야 합니다.");
        }
        if settings.proxy.http.len() > 2048 || settings.proxy.https.len() > 2048 || settings.proxy.no_proxy.len() > 4096 {
            bail!("프록시 설정이 너무 깁니다.");
        }
        if !(3..=60).contains(&settings.poll_seconds) {
            bail!("자동 갱신 간격은 3초에서 60초 사이여야 합니다.");
        }
        Ok(settings)
    }

    /// Only these change the screen or the next server start, so they can change while the engine runs.
    pub fn engine_changed(&self, next: &Settings) -> bool {
        let strip = |s: &Settings| Settings { poll_seconds: 0, auto_start: false, ..s.clone() };
        strip(self) != strip(next)
    }
}

pub async fn settings() -> Result<Settings> {
    let raw = read_json(&settings_file(), Some(serde_json::json!({}))).await?;
    let mut cfg = Settings::parse(raw)?;
    if remote_target() {
        cfg.engine = moby();
        cfg.connection = "ssh".into();
    }
    Ok(cfg)
}

pub async fn save_settings(input: serde_json::Value) -> Result<Settings> {
    let value = Settings::parse(input)?;
    atomic_json(&settings_file(), &value).await?;
    Ok(value)
}

/// Proxy settings for containers in Docker CLI config form, or None when no proxy is set.
/// Containers reach a proxy on Windows localhost only through host.docker.internal.
pub fn container_proxy_config(proxy: &Proxy) -> Option<serde_json::Value> {
    static LOCAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^((?:[a-z][a-z0-9+.-]*://)?(?:[^@/]*@)?)(?:localhost|127\.0\.0\.1|\[::1\])([:/]|$)").unwrap()
    });
    let reach = |url: &str| LOCAL.replace(url, "${1}host.docker.internal${2}").into_owned();
    if proxy.http.is_empty() && proxy.https.is_empty() {
        return None;
    }
    let mut out = serde_json::Map::new();
    if !proxy.http.is_empty() {
        out.insert("httpProxy".into(), reach(&proxy.http).into());
    }
    if !proxy.https.is_empty() {
        out.insert("httpsProxy".into(), reach(&proxy.https).into());
    }
    if !proxy.no_proxy.is_empty() {
        out.insert("noProxy".into(), proxy.no_proxy.clone().into());
    }
    Some(out.into())
}

pub async fn atomic_json<T: Serialize + ?Sized>(file: &Path, value: &T) -> Result<()> {
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let temp = file.with_extension(format!("{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, serde_json::to_vec_pretty(value)?).await?;
    tokio::fs::rename(&temp, file).await?;
    Ok(())
}

/// Reads JSON; a missing file returns `fallback` when given, any other failure is an error.
pub async fn read_json<T: DeserializeOwned>(file: &Path, fallback: Option<T>) -> Result<T> {
    match tokio::fs::read(file).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).with_context(|| format!("{} 형식 오류", file.display()))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && fallback.is_some() => Ok(fallback.unwrap()),
        Err(e) => Err(e).with_context(|| file.display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_defaults_and_validation() {
        let s = Settings::parse(json!({})).unwrap();
        assert_eq!(s.connection, "managed");
        assert!(s.auto_start);
        assert_eq!(s.engine, "moby");
        assert_eq!(s.kubernetes.port, 6445);
        assert!(Settings::parse(json!({ "unknown": 1 })).is_err());
        assert!(Settings::parse(json!({ "engine": "podman" })).is_err());
        assert!(Settings::parse(json!({ "pollSeconds": 2 })).is_err());
        assert!(Settings::parse(json!({ "kubernetes": { "version": "1.30" } })).is_err());
        assert_eq!(Settings::parse(json!({ "connection": "x" })).unwrap().connection, "managed");
    }

    #[test]
    fn live_settings_do_not_count_as_engine_changes() {
        let a = Settings::default();
        let b = Settings { poll_seconds: 30, auto_start: false, ..a.clone() };
        assert!(!a.engine_changed(&b));
        let c = Settings { engine: "containerd".into(), ..a.clone() };
        assert!(a.engine_changed(&c));
    }

    #[test]
    fn localhost_proxies_reach_through_host_docker_internal() {
        assert!(container_proxy_config(&Proxy { http: "".into(), https: "".into(), no_proxy: "localhost".into() }).is_none());
        assert_eq!(
            container_proxy_config(&Proxy {
                http: "http://user:pw@127.0.0.1:3128".into(),
                https: "localhost:3129".into(),
                no_proxy: "localhost,.svc".into(),
            })
            .unwrap(),
            json!({
                "httpProxy": "http://user:pw@host.docker.internal:3128",
                "httpsProxy": "host.docker.internal:3129",
                "noProxy": "localhost,.svc",
            })
        );
        let remote = Proxy { http: "http://proxy.example.com:8080".into(), https: "".into(), no_proxy: "".into() };
        assert_eq!(container_proxy_config(&remote).unwrap()["httpProxy"], "http://proxy.example.com:8080");
    }
}
