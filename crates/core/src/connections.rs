//! Remote engine profiles reached over SSH, stored in engines.json.
use crate::context::{target, Target};
use crate::runner::{command, Opts};
use crate::state::{atomic_json, read_json};
use anyhow::{bail, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: String,
}

static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$").unwrap());
static USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$").unwrap());

impl Profile {
    pub fn parse(value: serde_json::Value) -> Result<Profile> {
        let mut p: Profile = serde_json::from_value(value)?;
        p.name = p.name.trim().to_string();
        if p.name.is_empty() || p.name.chars().count() > 80 {
            bail!("프로필 이름은 1자 이상 80자 이하로 입력해 주세요.");
        }
        if !HOST.is_match(&p.host) {
            bail!("호스트 형식을 확인해 주세요.");
        }
        if !p.user.is_empty() && !USER.is_match(&p.user) {
            bail!("사용자 이름 형식을 확인해 주세요.");
        }
        if p.port == Some(0) {
            bail!("포트를 확인해 주세요.");
        }
        if p.identity_file.len() > 1024 || p.identity_file.contains(['\r', '\n', '\0']) {
            bail!("키 파일 경로를 확인해 주세요.");
        }
        Ok(p)
    }

    pub fn same_endpoint(&self, other: &Target) -> bool {
        self.host == other.host && self.user == other.user && self.port == other.port && self.identity_file == other.identity_file
    }

    pub fn into_target(self, id: String, scope_id: String, revision: String) -> Target {
        Target {
            id,
            name: self.name,
            host: self.host,
            user: self.user,
            port: self.port,
            identity_file: self.identity_file,
            scope_id: Some(scope_id),
            revision: Some(revision),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connections {
    pub selected: String,
    pub profiles: Vec<Target>,
}

fn file() -> std::path::PathBuf {
    crate::state::config_dir().join("engines.json")
}

pub async fn connections() -> Result<Connections> {
    read_json(&file(), Some(Connections { selected: "local".into(), profiles: vec![] })).await
}

static WRITING: AtomicBool = AtomicBool::new(false);

pub async fn change_connections(change: impl FnOnce(&mut Connections) -> Result<()>) -> Result<Connections> {
    if WRITING.swap(true, Ordering::SeqCst) {
        bail!("연결 설정 저장 중입니다. 다시 시도해 주세요.");
    }
    let result = async {
        let mut cfg = connections().await?;
        change(&mut cfg)?;
        atomic_json(&file(), &cfg).await?;
        Ok(cfg)
    }
    .await;
    WRITING.store(false, Ordering::SeqCst);
    result
}

pub async fn resolve_target(id: &str) -> Result<Target> {
    if id == "local" {
        return Ok(Target::local());
    }
    let cfg = connections().await?;
    match cfg.profiles.into_iter().find(|p| p.id == id) {
        Some(profile) => Ok(profile),
        None => bail!("엔진 프로필을 찾을 수 없습니다. 연결 대상을 다시 선택해 주세요."),
    }
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn ssh_args(profile: &Target, remote: &[String]) -> Result<Vec<String>> {
    let p = Profile::parse(serde_json::json!({
        "name": if profile.name.is_empty() { "engine" } else { &profile.name },
        "host": profile.host,
        "user": profile.user,
        "port": profile.port,
        "identityFile": profile.identity_file,
    }))?;
    let mut out: Vec<String> = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8"]
        .map(String::from)
        .to_vec();
    if !p.user.is_empty() {
        out.extend(["-l".into(), p.user]);
    }
    if let Some(port) = p.port {
        out.extend(["-p".into(), port.to_string()]);
    }
    if !p.identity_file.is_empty() {
        out.extend(["-i".into(), p.identity_file]);
    }
    out.extend(["--".into(), p.host, remote.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")]);
    Ok(out)
}

pub async fn remote_command(cmd: &[String], opts: Opts) -> Result<String> {
    command("ssh.exe", &ssh_args(&target(), cmd)?, opts).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_arguments_quote_the_remote_command() {
        let mut t = Target::local();
        t.id = "x".into();
        t.host = "box.example.com".into();
        t.user = "dev".into();
        t.port = Some(2222);
        let a = ssh_args(&t, &["docker".into(), "ps".into(), "it's".into()]).unwrap();
        assert_eq!(&a[a.len() - 2..], ["box.example.com", "'docker' 'ps' 'it'\\''s'"]);
        assert!(a.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(a.windows(2).any(|w| w == ["-l", "dev"]));
    }

    #[test]
    fn profiles_reject_bad_values() {
        assert!(Profile::parse(serde_json::json!({ "name": "a", "host": "-bad" })).is_err());
        assert!(Profile::parse(serde_json::json!({ "name": " ", "host": "ok" })).is_err());
        assert!(Profile::parse(serde_json::json!({ "name": "a", "host": "ok", "extra": 1 })).is_err());
        assert!(Profile::parse(serde_json::json!({ "name": "a", "host": "ok", "identityFile": "a\nb" })).is_err());
    }
}
