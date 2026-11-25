//! Checks GitHub releases for Naru updates, downloads the setup executable, and triggers installation.
//!
//! The installer runs only after it matches the release: its asset is the one named for the release's own
//! version (`Naru_<version>_x64-setup.exe`), newer than this build, and the downloaded bytes match the size and
//! the SHA-256 digest GitHub records for that asset. A release without a digest is not installed automatically.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    /// Lowercase hex SHA-256 of the installer, from the asset's `digest`.
    pub sha256: Option<String>,
}

/// The release asset that installs `version`, and what GitHub records about it.
#[derive(Debug, PartialEq)]
struct Installer {
    url: String,
    name: String,
    size: Option<u64>,
    sha256: Option<String>,
}

pub fn installer_name(version: &str) -> String {
    format!("Naru_{version}_x64-setup.exe")
}

/// Only the asset named for this release's version counts, so a stray `.exe` or one built for another
/// version is never run. The digest is kept only in GitHub's `sha256:<64 hex>` form.
fn pick_installer(assets: &[serde_json::Value], version: &str) -> Option<Installer> {
    let name = installer_name(version);
    let asset = assets.iter().find(|a| a["name"].as_str() == Some(name.as_str()))?;
    let sha256 = asset["digest"]
        .as_str()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    Some(Installer { url: asset["browser_download_url"].as_str()?.to_string(), name, size: asset["size"].as_u64(), sha256 })
}

/// Checks downloaded bytes against the size and digest the release recorded.
fn verify(bytes: &[u8], sha256: &str, size: Option<u64>) -> Result<()> {
    if let Some(size) = size {
        if bytes.len() as u64 != size {
            bail!("설치 파일 크기가 릴리스 정보와 다릅니다({}바이트, 예상 {size}바이트). 설치하지 않았습니다.", bytes.len());
        }
    }
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(sha256) {
        bail!("설치 파일의 SHA-256이 릴리스 정보와 다릅니다. 설치하지 않았습니다.\n받은 파일: {actual}\n릴리스: {sha256}");
    }
    Ok(())
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

    let installer = json["assets"].as_array().and_then(|assets| pick_installer(assets, &latest_version));
    let (download_url, file_name, file_size, sha256) = match installer {
        Some(i) => (Some(i.url), Some(i.name), i.size, i.sha256),
        None => (None, None, None, None),
    };

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
        sha256,
    })
}

/// Downloads the release's installer to `%TEMP%\naru-update` and returns its path once it is verified.
/// A file that fails a check is never written.
pub async fn download_update(info: &ReleaseInfo) -> Result<PathBuf> {
    if !is_newer(&info.latest_version, CURRENT_VERSION) {
        bail!("v{}은(는) 현재 버전 v{CURRENT_VERSION}보다 새 버전이 아닙니다.", info.latest_version);
    }
    let (Some(download_url), Some(file_name)) = (info.download_url.as_deref(), info.file_name.as_deref()) else {
        bail!("릴리스에서 {} 파일을 찾지 못했습니다.", installer_name(&info.latest_version));
    };
    let Some(sha256) = info.sha256.as_deref() else {
        bail!("릴리스에 설치 파일의 SHA-256 정보가 없어 자동 설치를 중단했습니다.");
    };
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
    verify(&bytes, sha256, info.file_size)?;
    // The name is the one installer_name built, so it carries no path of its own.
    let dir = std::env::temp_dir().join("naru-update");
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await.with_context(|| format!("임시 폴더 생성 실패: {}", dir.display()))?;
    let temp_path = dir.join(file_name);
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
        crate::runner::system_command("rundll32.exe")
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

    const DIGEST: &str = "a6c71ca95b9c9efa390248cdf94c72d8fc9b5e1a47e7e1dd049c48b82b1fa6b1";

    fn asset(name: &str, digest: Option<&str>) -> serde_json::Value {
        serde_json::json!({ "name": name, "size": 10, "browser_download_url": format!("https://example.test/{name}"), "digest": digest })
    }

    #[test]
    fn only_the_installer_for_the_release_version_is_picked() {
        let digest = format!("sha256:{}", DIGEST.to_uppercase());
        let assets = [asset("helper.exe", Some(&digest)), asset("Naru_0.2.12_x64-setup.exe", Some(&digest)), asset("Naru_0.2.13_x64-setup.exe", Some(&digest))];
        let picked = pick_installer(&assets, "0.2.13").unwrap();
        assert_eq!(picked.name, "Naru_0.2.13_x64-setup.exe");
        assert_eq!(picked.size, Some(10));
        assert_eq!(picked.sha256.as_deref(), Some(DIGEST));
        assert_eq!(pick_installer(&assets[..2], "0.2.13"), None);
    }

    #[test]
    fn malformed_or_missing_digests_are_dropped() {
        let name = "Naru_0.2.13_x64-setup.exe";
        for digest in [None, Some("sha512:abc"), Some("sha256:1234"), Some(&*format!("sha256:{}", "g".repeat(64))), Some(DIGEST)] {
            assert_eq!(pick_installer(&[asset(name, digest)], "0.2.13").unwrap().sha256, None, "{digest:?}");
        }
    }

    #[test]
    fn downloads_must_match_size_and_digest() {
        let bytes = b"naru installer";
        let good = hex::encode(Sha256::digest(bytes));
        verify(bytes, &good, Some(bytes.len() as u64)).unwrap();
        verify(bytes, &good.to_uppercase(), None).unwrap();
        assert!(verify(bytes, &good, Some(3)).unwrap_err().to_string().contains("크기"));
        assert!(verify(b"tampered installer", &good, None).unwrap_err().to_string().contains("SHA-256"));
    }

    #[tokio::test]
    async fn releases_without_a_digest_or_not_newer_are_refused() {
        let info = |version: &str, sha256: Option<&str>| ReleaseInfo {
            current_version: CURRENT_VERSION.into(),
            latest_version: version.into(),
            update_available: true,
            release_name: String::new(),
            release_notes: String::new(),
            release_url: String::new(),
            download_url: Some("https://example.test/x".into()),
            file_name: Some(installer_name(version)),
            file_size: None,
            sha256: sha256.map(String::from),
        };
        let err = download_update(&info("999.0.0", None)).await.unwrap_err();
        assert!(err.to_string().contains("SHA-256"), "{err}");
        let err = download_update(&info(CURRENT_VERSION, Some(DIGEST))).await.unwrap_err();
        assert!(err.to_string().contains("새 버전이 아닙니다"), "{err}");
    }
}
