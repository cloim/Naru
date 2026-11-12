//! Checks GitHub releases for Naru updates, downloads the setup executable, and triggers installation.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const GITHUB_REPO: &str = "cloim/Naru";
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub release_url: String,
    pub download_url: Option<String>,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
}

/// Parses semver version into (major, minor, patch).
pub fn parse_semver(s: &str) -> (u32, u32, u32) {
    let clean = s.trim().trim_start_matches('v');
    let mut parts = clean.split('.');
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|p| p.split('-').next())
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    (major, minor, patch)
}

/// Compares two semver strings: returns true if latest > current.
pub fn is_newer(latest: &str, current: &str) -> bool {
    parse_semver(latest) > parse_semver(current)
}

/// Checks the latest GitHub release.
pub async fn check_for_updates() -> Result<ReleaseInfo> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let client = reqwest::Client::builder()
        .user_agent("Naru-App")
        .timeout(Duration::from_secs(10))
        .build()
        .context("HTTP 클라이언트 생성 실패")?;

    let resp = client.get(&url).send().await.context("GitHub API 요청 실패")?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub 릴리스 조회 실패: HTTP {}", resp.status());
    }

    let json: serde_json::Value = resp.json().await.context("GitHub 응답 파싱 실패")?;
    let tag = json["tag_name"].as_str().unwrap_or_default();
    let latest_version = tag.trim().trim_start_matches('v').to_string();
    let update_available = is_newer(&latest_version, CURRENT_VERSION);

    let release_name = json["name"].as_str().unwrap_or(&latest_version).to_string();
    let release_notes = json["body"].as_str().unwrap_or_default().to_string();
    let release_url = json["html_url"].as_str().unwrap_or_default().to_string();

    let mut download_url = None;
    let mut file_name = None;
    let mut file_size = None;

    if let Some(assets) = json["assets"].as_array() {
        for a in assets {
            let name = a["name"].as_str().unwrap_or_default();
            if name.ends_with(".exe") {
                download_url = a["browser_download_url"].as_str().map(String::from);
                file_name = Some(name.to_string());
                file_size = a["size"].as_u64();
                break;
            }
        }
    }

    Ok(ReleaseInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version,
        update_available,
        release_name,
        release_notes,
        release_url,
        download_url,
        file_name,
        file_size,
    })
}

/// Downloads the setup executable to the temporary folder.
pub async fn download_update(download_url: &str, file_name: &str) -> Result<PathBuf> {
    let client = reqwest::Client::builder()
        .user_agent("Naru-App")
        .timeout(Duration::from_secs(120))
        .build()
        .context("다운로드 클라이언트 생성 실패")?;

    let resp = client.get(download_url).send().await.context("설치 파일 다운로드 연결 실패")?;
    if !resp.status().is_success() {
        anyhow::bail!("다운로드 실패: HTTP {}", resp.status());
    }

    let bytes = resp.bytes().await.context("설치 파일 수신 실패")?;
    let temp_path = std::env::temp_dir().join(file_name);
    tokio::fs::write(&temp_path, &bytes)
        .await
        .with_context(|| format!("임시 파일 저장 실패: {}", temp_path.display()))?;

    Ok(temp_path)
}

/// Launches the downloaded installer detached from this process.
pub fn launch_installer(installer_path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP (0x200) | DETACHED_PROCESS (0x08)
        std::process::Command::new(installer_path)
            .creation_flags(0x00000200 | 0x00000008)
            .spawn()
            .with_context(|| format!("설치 파일 실행 실패: {}", installer_path.display()))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(installer_path)
            .spawn()
            .with_context(|| format!("설치 파일 실행 실패: {}", installer_path.display()))?;
        Ok(())
    }
}

/// Opens a URL in the user's default browser.
pub fn open_browser(url: &str) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x00000200 | 0x00000008)
            .spawn()
            .context("브라우저 열기 실패")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .context("브라우저 열기 실패")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison() {
        assert!(is_newer("0.2.3", "0.2.2"));
        assert!(is_newer("v0.2.3", "0.2.2"));
        assert!(is_newer("0.3.0", "0.2.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.2.2", "0.2.2"));
        assert!(!is_newer("v0.2.2", "0.2.2"));
        assert!(!is_newer("0.2.1", "0.2.2"));
    }
}
