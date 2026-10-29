//! Conditions Naru needs before it can open at all. When one is missing, the user gets a message box
//! that says what to do, and the app ends instead of failing silently later.

/// WSL 2 arrived in Windows 10 version 2004 (build 19041).
const MIN_BUILD: u32 = 19041;

/// Returns the guidance to show, or None when this PC can run Naru.
pub fn system() -> Option<String> {
    let build = windows_build();
    if build < MIN_BUILD {
        return Some(format!(
            "이 Windows(빌드 {build})에서는 WSL 2를 사용할 수 없습니다.\n\nWindows 10 버전 2004(빌드 19041) 이상 또는 Windows 11로 업데이트한 뒤 다시 실행해 주세요."
        ));
    }
    if !native_x64() {
        return Some(
            "Naru는 x64 PC에서만 실행할 수 있습니다.\n\n이 PC는 ARM 프로세서를 사용하므로 엔진을 설치할 수 없습니다."
                .into(),
        );
    }
    if tauri::webview_version().is_err() {
        return Some(
            "화면을 표시할 Microsoft Edge WebView2 런타임이 없습니다.\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/ 에서 Evergreen 런타임을 설치한 뒤 다시 실행해 주세요."
                .into(),
        );
    }
    None
}

/// Checked after single-instance handling, so a second launch of Naru never reaches it.
pub fn port(port: u16) -> Option<String> {
    std::net::TcpListener::bind(("127.0.0.1", port)).err().map(|_| {
        format!(
            "다른 프로그램이 Naru가 쓰는 포트 {port}를 사용하고 있습니다.\n\n그 프로그램을 종료하거나, 이전에 실행한 Naru 서버가 남아 있다면 종료한 뒤 다시 실행해 주세요."
        )
    })
}

pub fn fail(message: &str) -> ! {
    show_error(message);
    std::process::exit(1);
}

#[cfg(windows)]
pub fn show_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(message), wide("Naru"));
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
pub fn show_error(message: &str) {
    eprintln!("{message}");
}

/// The real build number; GetVersionEx would report an older one to an unmanifested process.
#[cfg(windows)]
fn windows_build() -> u32 {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    unsafe { RtlGetVersion(&mut info) };
    info.dwBuildNumber
}

#[cfg(not(windows))]
fn windows_build() -> u32 {
    u32::MAX
}

/// An x64 build also runs on ARM64 Windows through emulation, but the engine needs an x64 kernel.
#[cfg(windows)]
fn native_x64() -> bool {
    use windows_sys::Win32::System::SystemInformation::IMAGE_FILE_MACHINE_AMD64;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
    let (mut process, mut native) = (0u16, 0u16);
    let ok = unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, &mut native) } != 0;
    !ok || native == IMAGE_FILE_MACHINE_AMD64
}

#[cfg(not(windows))]
fn native_x64() -> bool {
    true
}
