//! Docker Hub image search (via engine `/images/search`) and tag suggestions (via Hub v2 API),
//! cached on disk for 24 hours so recent suggestions remain available offline.
use crate::engine::{docker, encode};
use crate::runtime::http_client;
use crate::state::{atomic_json, data, read_json};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL_SECS: u64 = 24 * 60 * 60;
const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    at: u64,
    value: Value,
}

type CacheMap = HashMap<String, CacheEntry>;

static CACHE: LazyLock<Mutex<Option<CacheMap>>> = LazyLock::new(Default::default);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_file() -> PathBuf {
    data().join("cache").join("hub.json")
}

async fn load_cache() -> CacheMap {
    if let Some(map) = CACHE.lock().unwrap().as_ref() {
        return map.clone();
    }
    let loaded: CacheMap = read_json(&cache_file(), Some(HashMap::new())).await.unwrap_or_default();
    let mut guard = CACHE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(loaded.clone());
    }
    guard.clone().unwrap_or_default()
}

fn cache_lookup(map: &CacheMap, key: &str, now: u64) -> (Option<Value>, Option<Value>) {
    match map.get(key) {
        Some(entry) if now.saturating_sub(entry.at) < TTL_SECS => (Some(entry.value.clone()), None),
        Some(entry) => (None, Some(entry.value.clone())),
        None => (None, None),
    }
}

async fn cache_store(key: String, value: Value) {
    let mut map = load_cache().await;
    let now = now_secs();
    map.insert(key, CacheEntry { at: now, value });
    if map.len() > MAX_ENTRIES {
        let mut keys: Vec<(u64, String)> = map.iter().map(|(k, v)| (v.at, k.clone())).collect();
        keys.sort_by_key(|(at, _)| *at);
        for (_, old) in keys.into_iter().take(map.len().saturating_sub(MAX_ENTRIES)) {
            map.remove(&old);
        }
    }
    *CACHE.lock().unwrap() = Some(map.clone());
    let _ = atomic_json(&cache_file(), &map).await;
}

/// Converts a Docker Hub repo reference into `(namespace, name)`. Returns `None` for custom registries.
pub fn hub_repo_path(repo: &str) -> Option<(String, String)> {
    let trimmed = repo.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed.contains(['?', '#', '@', ' ', '\\']) {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    match parts.as_slice() {
        [name] if !name.contains('.') && !name.contains(':') => Some(("library".into(), (*name).to_string())),
        [ns, name] if !ns.contains('.') && !ns.contains(':') && !ns.is_empty() && !name.is_empty() => {
            Some(((*ns).to_string(), (*name).to_string()))
        }
        _ => None,
    }
}

/// Filters and ranks tag names: exact/prefix matches come first, then substring matches.
pub fn filter_tags(tags: &[String], query: &str) -> Vec<String> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return tags.iter().take(20).cloned().collect();
    }
    let mut prefix: Vec<String> = Vec::new();
    let mut contains: Vec<String> = Vec::new();
    for tag in tags {
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with(&q) {
            prefix.push(tag.clone());
        } else if lower.contains(&q) {
            contains.push(tag.clone());
        }
    }
    prefix.extend(contains);
    prefix.truncate(20);
    prefix
}

pub async fn search(term: &str) -> Result<Value> {
    let q = term.trim();
    if q.len() < 2 {
        return Ok(json!([]));
    }
    let key = format!("search:{}", q.to_ascii_lowercase());
    let map = load_cache().await;
    let (fresh, stale) = cache_lookup(&map, &key, now_secs());
    if let Some(hit) = fresh {
        return Ok(hit);
    }
    match docker("GET", &format!("/images/search?term={}&limit=15", encode(q)), None).await {
        Ok(raw) => {
            let items: Vec<Value> = raw
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let name = item["name"].as_str()?;
                    Some(json!({
                        "name": name,
                        "description": item["description"].as_str().unwrap_or_default(),
                        "starCount": item["star_count"].as_u64().unwrap_or(0),
                        "isOfficial": item["is_official"].as_bool().unwrap_or(false),
                    }))
                })
                .collect();
            let val = Value::Array(items);
            cache_store(key, val.clone()).await;
            Ok(val)
        }
        Err(_) if stale.is_some() => Ok(stale.unwrap()),
        Err(_) => Ok(json!([])),
    }
}

pub async fn tags(repo: &str, filter: &str) -> Result<Value> {
    let Some((ns, name)) = hub_repo_path(repo) else {
        return Ok(json!([]));
    };
    let key = format!("tags:{ns}/{name}");
    let map = load_cache().await;
    let (fresh, stale) = cache_lookup(&map, &key, now_secs());
    let all_tags: Vec<String> = if let Some(hit) = fresh {
        hit.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
    } else {
        let url = format!(
            "https://hub.docker.com/v2/repositories/{}/{}/tags?page_size=50&ordering=last_updated",
            encode(&ns),
            encode(&name)
        );
        let fetched = async {
            let client = http_client(Duration::from_secs(8)).await?;
            let resp = client.get(&url).send().await?;
            if !resp.status().is_success() {
                return Ok::<Vec<String>, anyhow::Error>(Vec::new());
            }
            let body: Value = resp.json().await?;
            let list: Vec<String> = body["results"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["name"].as_str().map(String::from))
                .collect();
            Ok(list)
        }
        .await;
        match fetched {
            Ok(list) if !list.is_empty() => {
                cache_store(key, json!(list)).await;
                list
            }
            _ => stale
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
        }
    };
    Ok(json!(filter_tags(&all_tags, filter)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hub_repo_paths_and_skips_custom_registries() {
        assert_eq!(hub_repo_path("nginx"), Some(("library".into(), "nginx".into())));
        assert_eq!(hub_repo_path("bitnami/redis"), Some(("bitnami".into(), "redis".into())));
        assert_eq!(hub_repo_path("ghcr.io/org/app"), None);
        assert_eq!(hub_repo_path("localhost:5000/app"), None);
        assert_eq!(hub_repo_path(""), None);
    }

    #[test]
    fn filters_tags_with_prefix_matches_first() {
        let tags: Vec<String> = ["1.27-alpine", "alpine", "latest", "alpine-slim"].into_iter().map(String::from).collect();
        assert_eq!(filter_tags(&tags, "alp"), vec!["alpine", "alpine-slim", "1.27-alpine"]);
        assert_eq!(filter_tags(&tags, "").len(), 4);
    }

    #[test]
    fn cache_lookup_distinguishes_fresh_and_stale() {
        let mut map = CacheMap::new();
        map.insert("k".into(), CacheEntry { at: 1000, value: json!(["latest"]) });
        assert_eq!(cache_lookup(&map, "k", 1000 + TTL_SECS - 1), (Some(json!(["latest"])), None));
        assert_eq!(cache_lookup(&map, "k", 1000 + TTL_SECS + 1), (None, Some(json!(["latest"]))));
    }
}
