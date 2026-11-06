//! Container protection and lock state management.
use crate::context::{engine_key, remote_target};
use crate::state::{atomic_json, data, read_json};
use anyhow::Result;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Path to the container locks registry for the current engine target.
pub fn locks_file() -> PathBuf {
    if remote_target() {
        data()
            .join("engines")
            .join(engine_key())
            .join("container_locks.json")
    } else {
        data().join("container_locks.json")
    }
}

/// Reads the set of protected container identifiers (full ID, short ID, or name).
pub async fn load_container_locks() -> Result<BTreeSet<String>> {
    let file = locks_file();
    read_json(&file, Some(BTreeSet::new())).await
}

/// Saves the set of protected container identifiers.
pub async fn save_container_locks(locks: &BTreeSet<String>) -> Result<()> {
    let file = locks_file();
    atomic_json(&file, locks).await
}

/// Updates the lock status of a single container.
pub async fn set_container_lock(id: &str, locked: bool) -> Result<BTreeSet<String>> {
    let mut locks = load_container_locks().await?;
    let trimmed = id.trim_start_matches('/');
    if locked {
        locks.insert(id.to_string());
        if trimmed != id {
            locks.insert(trimmed.to_string());
        }
    } else {
        locks.remove(id);
        locks.remove(trimmed);
        if id.len() >= 12 {
            locks.remove(&id[..12]);
        }
    }
    save_container_locks(&locks).await?;
    Ok(locks)
}

/// Updates the lock status of multiple containers at once.
pub async fn batch_set_container_locks(ids: &[String], locked: bool) -> Result<BTreeSet<String>> {
    let mut locks = load_container_locks().await?;
    for id in ids {
        let trimmed = id.trim_start_matches('/');
        if locked {
            locks.insert(id.to_string());
            if trimmed != id {
                locks.insert(trimmed.to_string());
            }
        } else {
            locks.remove(id);
            locks.remove(trimmed);
            if id.len() >= 12 {
                locks.remove(&id[..12]);
            }
        }
    }
    save_container_locks(&locks).await?;
    Ok(locks)
}

/// Checks whether a container is locked against pruning.
pub fn is_container_locked(locks: &BTreeSet<String>, container: &Value) -> bool {
    let id = container["Id"].as_str().unwrap_or_default();
    if !id.is_empty() && (locks.contains(id) || (id.len() >= 12 && locks.contains(&id[..12]))) {
        return true;
    }
    if let Some(names) = container["Names"].as_array() {
        for n in names {
            if let Some(s) = n.as_str() {
                if locks.contains(s) || locks.contains(s.trim_start_matches('/')) {
                    return true;
                }
            }
        }
    }
    if let Some(proj) = container["Labels"][crate::projects::LABEL_PROJECT].as_str() {
        if locks.contains(proj) || locks.contains(&format!("project:{proj}")) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_id_short_id_and_names() {
        let mut locks = BTreeSet::new();
        locks.insert("c1234567890abcdef".to_string());
        locks.insert("web-nginx".to_string());

        let c1 = json!({
            "Id": "c1234567890abcdef1234567890",
            "Names": ["/my-app"]
        });
        // c1 matches short ID prefix if inserted or full ID
        assert!(!is_container_locked(&locks, &c1));

        let c2 = json!({
            "Id": "c1234567890abcdef",
            "Names": ["/another"]
        });
        assert!(is_container_locked(&locks, &c2));

        let c3 = json!({
            "Id": "99999999999999999",
            "Names": ["/web-nginx"]
        });
        assert!(is_container_locked(&locks, &c3));

        locks.insert("project:demo".to_string());
        let c4 = json!({
            "Id": "88888888888888888",
            "Names": ["/demo_svc_1"],
            "Labels": { "com.docker.compose.project": "demo" }
        });
        assert!(is_container_locked(&locks, &c4));
    }
}
