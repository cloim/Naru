//! Reads and updates `%USERPROFILE%\.wslconfig` (`[wsl2]` processors, memory, autoMemoryReclaim)
//! while preserving every other section, key and comment in the file.
use crate::runner::{args, command, Opts};
use crate::web::invalid;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConfig {
    pub processors: Option<u32>,
    pub memory_gb: Option<u32>,
    pub auto_memory_reclaim: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConfigView {
    pub path: String,
    pub host_cpus: usize,
    #[serde(flatten)]
    pub config: WslConfig,
}

pub fn config_path() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".wslconfig")
}

fn parse_memory_gb(raw: &str) -> Option<u32> {
    let s = raw.trim().to_ascii_lowercase();
    if let Some(num) = s.strip_suffix("gb").or_else(|| s.strip_suffix('g')) {
        num.trim().parse::<u32>().ok().filter(|v| *v > 0)
    } else if let Some(num) = s.strip_suffix("mb").or_else(|| s.strip_suffix('m')) {
        num.trim().parse::<u32>().ok().map(|mb| (mb / 1024).max(1))
    } else {
        None
    }
}

pub fn parse(text: &str) -> WslConfig {
    let mut cfg = WslConfig::default();
    let mut in_wsl2 = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_wsl2 = line[1..line.len() - 1].trim().eq_ignore_ascii_case("wsl2");
            continue;
        }
        if !in_wsl2 {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim();
        match key.as_str() {
            "processors" => cfg.processors = val.parse::<u32>().ok().filter(|n| *n > 0),
            "memory" => cfg.memory_gb = parse_memory_gb(val),
            "automemoryreclaim" => {
                let lower = val.to_ascii_lowercase();
                if matches!(lower.as_str(), "gradual" | "dropcache" | "disabled") {
                    cfg.auto_memory_reclaim = Some(lower);
                }
            }
            _ => {}
        }
    }
    cfg
}

pub fn validate(cfg: &WslConfig) -> Result<()> {
    let max_cpus = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(64).max(64);
    if let Some(p) = cfg.processors {
        if p == 0 || p > max_cpus {
            return Err(invalid(&format!("CPU 코어 수는 1~{max_cpus} 사이로 입력해 주세요.")));
        }
    }
    if let Some(m) = cfg.memory_gb {
        if m == 0 || m > 512 {
            return Err(invalid("메모리 크기는 1~512 GB 사이로 입력해 주세요."));
        }
    }
    if let Some(reclaim) = cfg.auto_memory_reclaim.as_deref().filter(|s| !s.is_empty()) {
        if !matches!(reclaim, "gradual" | "dropcache" | "disabled") {
            return Err(invalid("메모리 회수 방식은 gradual, dropcache, disabled 중 하나여야 합니다."));
        }
    }
    Ok(())
}

/// Updates only `processors`, `memory`, and `autoMemoryReclaim` under `[wsl2]`.
/// All other sections, keys, and comments are preserved verbatim.
pub fn update_text(existing: &str, cfg: &WslConfig) -> String {
    let wanted: [(&str, Option<String>); 3] = [
        ("processors", cfg.processors.map(|n| n.to_string())),
        ("memory", cfg.memory_gb.map(|n| format!("{n}GB"))),
        (
            "autoMemoryReclaim",
            cfg.auto_memory_reclaim.as_deref().filter(|s| !s.is_empty()).map(str::to_string),
        ),
    ];

    let mut out: Vec<String> = Vec::new();
    let mut in_wsl2 = false;
    let mut saw_wsl2 = false;
    let mut written = [false; 3];

    let flush_missing = |out: &mut Vec<String>, written: &mut [bool; 3]| {
        for (i, (key, val)) in wanted.iter().enumerate() {
            if !written[i] {
                if let Some(v) = val {
                    out.push(format!("{key}={v}"));
                }
                written[i] = true;
            }
        }
    };

    for raw_line in existing.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_wsl2 {
                flush_missing(&mut out, &mut written);
            }
            in_wsl2 = trimmed[1..trimmed.len() - 1].trim().eq_ignore_ascii_case("wsl2");
            if in_wsl2 {
                saw_wsl2 = true;
            }
            out.push(raw_line.to_string());
            continue;
        }
        if in_wsl2 && !trimmed.starts_with('#') && !trimmed.starts_with(';') {
            if let Some((k, _)) = trimmed.split_once('=') {
                let key_lower = k.trim().to_ascii_lowercase();
                if let Some(idx) = wanted.iter().position(|(name, _)| name.eq_ignore_ascii_case(&key_lower)) {
                    if let Some(v) = &wanted[idx].1 {
                        out.push(format!("{}={v}", wanted[idx].0));
                    }
                    written[idx] = true;
                    continue;
                }
            }
        }
        out.push(raw_line.to_string());
    }

    if in_wsl2 {
        flush_missing(&mut out, &mut written);
    } else if !saw_wsl2 && wanted.iter().any(|(_, v)| v.is_some()) {
        if !out.is_empty() && !out.last().unwrap().is_empty() {
            out.push(String::new());
        }
        out.push("[wsl2]".to_string());
        flush_missing(&mut out, &mut written);
    }

    if out.is_empty() {
        String::new()
    } else {
        format!("{}\r\n", out.join("\r\n"))
    }
}

pub async fn load() -> Result<WslConfigView> {
    let path = config_path();
    let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let host_cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    Ok(WslConfigView { path: path.to_string_lossy().into_owned(), host_cpus, config: parse(&text) })
}

pub async fn save(cfg: WslConfig) -> Result<WslConfigView> {
    validate(&cfg)?;
    let path = config_path();
    save_to(&path, &cfg).await?;
    load().await
}

async fn save_to(path: &Path, cfg: &WslConfig) -> Result<()> {
    let existing = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let updated = update_text(&existing, cfg);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("wslconfig.{}.tmp", std::process::id()));
    tokio::fs::write(&tmp, updated).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

/// Shuts down the WSL 2 VM so new `.wslconfig` settings take effect on next start.
pub async fn shutdown_wsl() -> Result<()> {
    command("wsl.exe", &args(["--shutdown"]), Opts::timeout(30)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_update_preserves_other_sections_and_comments() {
        let initial = "# user comment\n[wsl2]\nnetworkingMode=nat\nmemory=8192MB\nprocessors=4\n\n[experimental]\nsparseVhd=true\n";
        let parsed = parse(initial);
        assert_eq!(parsed, WslConfig { processors: Some(4), memory_gb: Some(8), auto_memory_reclaim: None });

        let next = WslConfig { processors: Some(6), memory_gb: None, auto_memory_reclaim: Some("gradual".into()) };
        let updated = update_text(initial, &next);
        assert!(updated.contains("# user comment"));
        assert!(updated.contains("networkingMode=nat"));
        assert!(updated.contains("processors=6"));
        assert!(!updated.contains("memory="));
        assert!(updated.contains("autoMemoryReclaim=gradual"));
        assert!(updated.contains("[experimental]"));
        assert!(updated.contains("sparseVhd=true"));
        assert_eq!(parse(&updated), next);
    }

    #[test]
    fn creates_wsl2_section_when_missing() {
        let cfg = WslConfig { processors: Some(4), memory_gb: Some(12), auto_memory_reclaim: Some("dropcache".into()) };
        let updated = update_text("", &cfg);
        assert!(updated.starts_with("[wsl2]\r\n"));
        assert_eq!(parse(&updated), cfg);
    }
}
