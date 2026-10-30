//! The engine a request or job works on: the local WSL engine or a remote SSH profile.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::future::Future;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

impl Target {
    pub fn local() -> Target {
        Target {
            id: "local".into(),
            name: "로컬 WSL".into(),
            host: String::new(),
            user: String::new(),
            port: None,
            identity_file: String::new(),
            scope_id: None,
            revision: None,
        }
    }
}

tokio::task_local! {
    static TARGET: Target;
}

/// Runs `work` with `target` as the current engine; every call inside sees the same immutable snapshot.
pub async fn with_target<F: Future>(target: Target, work: F) -> F::Output {
    TARGET.scope(target, work).await
}

pub fn target() -> Target {
    TARGET.try_with(Clone::clone).unwrap_or_else(|_| Target::local())
}

pub fn engine_key() -> String {
    let t = target();
    t.scope_id.unwrap_or(t.id)
}

pub fn remote_target() -> bool {
    target().id != "local"
}

pub fn local_only() -> Result<()> {
    if remote_target() {
        bail!("로컬 WSL 전용 기능입니다. 로컬 엔진을 선택해 주세요.");
    }
    Ok(())
}
