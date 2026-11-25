//! Whether the WSL disk the `naru` distribution boots from is the one in Naru's data folder.
//!
//! WSL records each distribution's disk folder (`BasePath`) and file (`VhdFileName`) under
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss. The data folder cannot move once the runtime is
//! installed (onboarding refuses it), so a disk outside `<data>\wsl` or a data folder that is gone means a
//! drive was unplugged, its letter changed, or the folder was moved by hand. The engine then does not start
//! and the message says what to check, rather than WSL failing with a bare path error or Naru writing jobs
//! and Compose files into a fresh folder on whatever volume now has that letter.
use crate::state::{data, DISTRO};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum Storage {
    /// No `naru` distribution is registered yet: installing creates it in the data folder.
    Fresh,
    Ready,
    Problem(String),
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.trim_end_matches('\\').to_lowercase()
}

/// `disk` is the registered disk file, `None` when the distribution is not registered.
pub fn assess(disk: Option<&Path>, data_dir: &Path, exists: impl Fn(&Path) -> bool) -> Storage {
    let Some(disk) = disk else { return Storage::Fresh };
    if !exists(data_dir) {
        return Storage::Problem(format!(
            "Naru 데이터 폴더 {}를 찾을 수 없어 엔진을 시작하지 않았습니다. 드라이브가 연결되어 있는지, 드라이브 문자가 바뀌지 않았는지 확인해 주세요.",
            data_dir.display()
        ));
    }
    let expected = data_dir.join("wsl");
    if disk.parent().map(normalized) != Some(normalized(&expected)) {
        return Storage::Problem(format!(
            "WSL에 등록된 Naru 디스크 {}가 데이터 폴더 {} 밖에 있어 엔진을 시작하지 않았습니다. 데이터 폴더를 직접 옮겼거나 드라이브 문자가 바뀌었는지 확인해 주세요.",
            disk.display(),
            expected.display()
        ));
    }
    if !exists(disk) {
        return Storage::Problem(format!(
            "Naru 디스크 파일 {}를 찾을 수 없어 엔진을 시작하지 않았습니다. 데이터 폴더의 wsl 폴더가 그대로 있는지 확인해 주세요.",
            disk.display()
        ));
    }
    Storage::Ready
}

pub fn check() -> Storage {
    // A development data folder (NARU_DATA_DIR) shares the one registered distribution on purpose.
    if std::env::var_os("NARU_DATA_DIR").is_some() {
        return Storage::Ready;
    }
    match registered_disk(DISTRO) {
        // An unreadable registry is no reason to keep the engine off; WSL reports a real problem itself.
        Err(_) => Storage::Ready,
        Ok(disk) => assess(disk.as_deref(), data(), Path::exists),
    }
}

/// Fails with what to check when the engine's disk is not where Naru keeps it.
pub fn require_ready() -> Result<()> {
    match check() {
        Storage::Problem(message) => bail!(message),
        Storage::Fresh | Storage::Ready => Ok(()),
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A string value of `sub` under `key`, or `None` when it is missing.
#[cfg(windows)]
fn reg_string(key: windows_sys::Win32::System::Registry::HKEY, sub: &[u16], name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
    let name = wide(name);
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut bytes = 0u32;
    // SAFETY: a null buffer asks only for the size; every pointer is valid for the call.
    let status = unsafe { RegGetValueW(key, sub.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes) };
    if status != 0 || bytes == 0 {
        return None;
    }
    let mut buf = vec![0u16; (bytes as usize).div_ceil(2)];
    // SAFETY: `buf` holds `bytes` bytes, as the size query reported.
    let status = unsafe {
        RegGetValueW(key, sub.as_ptr(), name.as_ptr(), flags, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut bytes)
    };
    if status != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// The disk file WSL boots `name` from; `Ok(None)` when no such distribution is registered.
#[cfg(windows)]
fn registered_disk(name: &str) -> Result<Option<PathBuf>> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ};
    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const ERROR_NO_MORE_ITEMS: u32 = 259;
    let path = wide(r"Software\Microsoft\Windows\CurrentVersion\Lxss");
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: valid null-terminated path and out pointer.
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != 0 {
        bail!("WSL 배포판 등록 정보를 읽지 못했습니다({status}).");
    }
    let mut found = None;
    for index in 0.. {
        let mut sub = [0u16; 256];
        let mut len = sub.len() as u32;
        // SAFETY: `sub` holds `len` characters; the optional outputs are null.
        let status = unsafe {
            RegEnumKeyExW(key, index, sub.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != 0 {
            continue;
        }
        let sub = &sub[..=len as usize];
        if reg_string(key, sub, "DistributionName").is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            found = reg_string(key, sub, "BasePath").map(|base| {
                let file = reg_string(key, sub, "VhdFileName").unwrap_or_else(|| "ext4.vhdx".into());
                PathBuf::from(base).join(file)
            });
            break;
        }
    }
    // SAFETY: `key` was opened above.
    unsafe { RegCloseKey(key) };
    Ok(found)
}

#[cfg(not(windows))]
fn registered_disk(_name: &str) -> Result<Option<PathBuf>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_disk_must_be_in_the_data_folder() {
        let data_dir = Path::new(r"E:\Naru");
        let all = |_: &Path| true;
        assert_eq!(assess(None, data_dir, all), Storage::Fresh);
        assert_eq!(assess(Some(Path::new(r"E:\Naru\wsl\ext4.vhdx")), data_dir, all), Storage::Ready);
        // WSL's own spelling: another case, a long-path prefix, a trailing separator.
        assert_eq!(assess(Some(Path::new(r"\\?\e:\naru\WSL\\ext4.vhdx")), data_dir, all), Storage::Ready);
        let moved = assess(Some(Path::new(r"F:\Naru\wsl\ext4.vhdx")), data_dir, all);
        assert!(matches!(moved, Storage::Problem(m) if m.contains(r"F:\Naru\wsl\ext4.vhdx") && m.contains("드라이브 문자")));
        let gone = assess(Some(Path::new(r"E:\Naru\wsl\ext4.vhdx")), data_dir, |p: &Path| p != data_dir);
        assert!(matches!(gone, Storage::Problem(m) if m.contains("데이터 폴더")));
        let no_disk = assess(Some(Path::new(r"E:\Naru\wsl\ext4.vhdx")), data_dir, |p: &Path| p == data_dir);
        assert!(matches!(no_disk, Storage::Problem(m) if m.contains("디스크 파일")));
    }

    /// On a PC with Naru installed: `cargo test -p naru-core installed_naru -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn installed_naru_storage_is_ready() {
        let disk = registered_disk(DISTRO).unwrap();
        println!("registered disk: {disk:?}, data folder: {}", data().display());
        assert_eq!(check(), Storage::Ready);
    }

    #[cfg(windows)]
    #[test]
    fn registry_lookup_finds_nothing_for_an_unknown_name() {
        assert_eq!(registered_disk("naru-no-such-distribution").unwrap(), None);
    }
}
