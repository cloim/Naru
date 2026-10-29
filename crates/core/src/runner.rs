//! Child processes: one-shot commands, WSL calls into the naru distribution and detached workers.
use crate::context::local_only;
use crate::state::{data, DISTRO};
use anyhow::{anyhow, bail, Result};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
/// Receives each output chunk; `true` marks stderr.
pub type OnOutput = Arc<dyn Fn(bool, &str) + Send + Sync>;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
pub struct Opts {
    pub timeout: Duration,
    pub input: Option<Vec<u8>>,
    pub log: Option<Log>,
    pub on_output: Option<OnOutput>,
    /// Receives the child pid so a caller can stop it early.
    pub on_spawn: Option<Arc<dyn Fn(u32) + Send + Sync>>,
    /// Also appends stderr to stdout, in arrival order.
    pub combine: bool,
    pub max_bytes: usize,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            timeout: Duration::from_secs(30),
            input: None,
            log: None,
            on_output: None,
            on_spawn: None,
            combine: false,
            max_bytes: 16 * 1024 * 1024,
            cwd: None,
            env: Vec::new(),
        }
    }
}

impl Opts {
    pub fn timeout(secs: u64) -> Opts {
        Opts { timeout: Duration::from_secs(secs), ..Opts::default() }
    }
    pub fn input(mut self, input: impl Into<Vec<u8>>) -> Opts {
        self.input = Some(input.into());
        self
    }
    pub fn log(mut self, log: &Log) -> Opts {
        self.log = Some(log.clone());
        self
    }
}

#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn clean(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "").trim().to_string()
}

pub fn tool_name(exe: &str) -> String {
    std::path::Path::new(exe)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| exe.to_string())
}

/// Stops a process and its children. Windows needs taskkill for the tree; wsl.exe leaves no orphans then.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags_no_window()
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).spawn();
    }
}

trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

pub fn hidden(exe: &str) -> Command {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Runs a command to completion and returns its exit code and output, whatever the code.
pub async fn run(exe: &str, args: &[String], opts: Opts) -> Result<Output> {
    let mut cmd = hidden(exe);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("WSL_UTF8", "1")
        .kill_on_drop(true);
    cmd.current_dir(opts.cwd.clone().unwrap_or_else(|| crate::state::root().to_path_buf()));
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| anyhow!("{} 실행 실패: {e}", tool_name(exe)))?;
    let pid = child.id().unwrap_or(0);
    if let Some(on_spawn) = &opts.on_spawn {
        on_spawn(pid);
    }
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = opts.input.clone();
    tokio::spawn(async move {
        if let Some(input) = input {
            let _ = stdin.write_all(&input).await;
        }
        let _ = stdin.shutdown().await;
    });
    let shared = Arc::new(std::sync::Mutex::new((Vec::<u8>::new(), Vec::<u8>::new(), 0usize, false)));
    let pump = |stream: Box<dyn AsyncRead + Unpin + Send>, is_err: bool| {
        let shared = shared.clone();
        let opts = opts.clone();
        async move {
            let mut stream = stream;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let chunk = &buf[..n];
                {
                    let mut s = shared.lock().unwrap();
                    s.2 += n;
                    if s.2 > opts.max_bytes {
                        s.3 = true;
                        break;
                    }
                    if is_err {
                        s.1.extend_from_slice(chunk);
                        if opts.combine {
                            s.0.extend_from_slice(chunk);
                        }
                    } else {
                        s.0.extend_from_slice(chunk);
                    }
                }
                let text = String::from_utf8_lossy(chunk);
                if let Some(log) = &opts.log {
                    log(&text);
                }
                if let Some(on_output) = &opts.on_output {
                    on_output(is_err, &text);
                }
            }
        }
    };
    let out = pump(Box::new(child.stdout.take().expect("piped stdout")), false);
    let err = pump(Box::new(child.stderr.take().expect("piped stderr")), true);
    let finished = tokio::time::timeout(opts.timeout, async {
        tokio::join!(out, err);
        child.wait().await
    })
    .await;
    let status = match finished {
        Ok(status) => status?,
        Err(_) => {
            kill_tree(pid);
            bail!("명령 제한 시간 {}초 초과: {}", opts.timeout.as_secs(), tool_name(exe));
        }
    };
    let s = shared.lock().unwrap();
    if s.3 {
        kill_tree(pid);
        bail!("출력 크기 제한을 초과했습니다.");
    }
    Ok(Output { code: status.code(), stdout: clean(&s.0), stderr: clean(&s.1) })
}

/// Runs a command and returns trimmed stdout; a non-zero exit becomes an error carrying its output.
pub async fn command(exe: &str, args: &[String], opts: Opts) -> Result<String> {
    let output = run(exe, args, opts).await?;
    if output.code == Some(0) {
        return Ok(output.stdout);
    }
    let message = if !output.stderr.is_empty() {
        output.stderr
    } else if !output.stdout.is_empty() {
        output.stdout
    } else {
        format!("명령 실패 ({}): {exe}", output.code.map_or("signal".into(), |c| c.to_string()))
    };
    bail!(message)
}

pub fn args<I: IntoIterator<Item = S>, S: Into<String>>(items: I) -> Vec<String> {
    items.into_iter().map(Into::into).collect()
}

/// While the disk is compacted, only the compaction job may touch the distribution: any wsl call would boot it.
pub fn maintenance_file() -> PathBuf {
    data().join("maintenance.json")
}

pub fn assert_distro_available() -> Result<()> {
    let Ok(text) = std::fs::read_to_string(maintenance_file()) else { return Ok(()) };
    let Some(pid) = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["pid"].as_u64()) else {
        return Ok(());
    };
    if pid as u32 != std::process::id() && process_alive(pid as u32) {
        bail!("디스크를 압축하는 중입니다. 끝나면 엔진이 다시 시작됩니다.");
    }
    Ok(())
}

pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// Runs a command as root inside the naru distribution.
pub async fn wsl(cmd: &[String], opts: Opts) -> Result<String> {
    local_only()?;
    assert_distro_available()?;
    let mut all = args(["--distribution", DISTRO, "--user", "root", "--exec"]);
    all.extend_from_slice(cmd);
    command("wsl.exe", &all, opts).await
}

pub async fn wsl_sh(script: &str, opts: Opts) -> Result<String> {
    wsl(&args(["sh", "-c", script]), opts).await
}

/// Installed (or only running) WSL distributions. Listing never boots a distribution.
pub async fn distributions(running: bool) -> Result<Vec<String>> {
    let mut a = args(["--list", "--quiet"]);
    if running {
        a.push("--running".into());
    }
    let out = run("wsl.exe", &a, Opts::timeout(10)).await?;
    parse_distributions(&out)
}

/// A WSL with no distributions yet (a fresh install) exits with an error; that is an empty list.
/// The message is in the Windows display language, so only the error code identifies the case.
fn parse_distributions(out: &Output) -> Result<Vec<String>> {
    if out.code != Some(0) {
        let text = format!("{}\n{}", out.stdout, out.stderr);
        if text.contains("WSL_E_DEFAULT_DISTRO_NOT_FOUND") {
            return Ok(vec![]);
        }
        let message = if text.trim().is_empty() { "WSL 배포판 목록을 확인할 수 없습니다.".to_string() } else { text.trim().to_string() };
        bail!(message);
    }
    Ok(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

pub async fn distro_running() -> Result<bool> {
    Ok(distributions(true).await?.iter().any(|d| d == DISTRO))
}

/// Starts a process that outlives this one and any job object it belongs to.
/// WMI creates it outside our process tree, the same way the engine supervisor must survive a server restart.
pub async fn detached(exe: &str, cmd_args: &[String], cwd: Option<PathBuf>) -> Result<u32> {
    // Windows CommandLineToArgvW quoting. Never route user data through cmd.exe.
    let quote = |value: &str| -> String {
        if !value.is_empty() && !value.contains(|c: char| c.is_whitespace() || c == '"') {
            return value.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0;
        for c in value.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.push_str(&"\\".repeat(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.push_str(&"\\".repeat(backslashes));
                    out.push(c);
                    backslashes = 0;
                }
            }
        }
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    };
    let line = std::iter::once(exe)
        .chain(cmd_args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let dir = cwd.unwrap_or_else(|| crate::state::root().to_path_buf());
    // Values travel as base64 so no PowerShell quoting applies to them.
    use base64::Engine;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    let script = format!(
        "$d=[Text.Encoding]::UTF8;$line=$d.GetString([Convert]::FromBase64String('{}'));$dir=$d.GetString([Convert]::FromBase64String('{}'));\
         $s=New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -Property @{{ShowWindow=[uint16]0}} -ClientOnly;\
         $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine=$line;CurrentDirectory=$dir;ProcessStartupInformation=$s}};\
         if($r.ReturnValue -ne 0){{throw \"WMI process creation failed: $($r.ReturnValue)\"}};$r.ProcessId",
        b64(&line),
        b64(&dir.to_string_lossy())
    );
    let out = command(
        "powershell.exe",
        &args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]),
        Opts::timeout(20),
    )
    .await?;
    out.trim().parse().map_err(|_| anyhow!("분리 실행 결과를 확인할 수 없습니다: {out}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn command_returns_stdout_and_errors_carry_stderr() {
        let ok = command("cmd.exe", &args(["/d", "/c", "echo hello"]), Opts::default()).await.unwrap();
        assert_eq!(ok, "hello");
        let err = command("cmd.exe", &args(["/d", "/c", "echo broken 1>&2 & exit 3"]), Opts::default())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "broken");
    }

    #[test]
    fn fresh_wsl_without_distributions_lists_nothing() {
        let out = |code, stdout: &str| Output { code: Some(code), stdout: stdout.into(), stderr: String::new() };
        assert_eq!(parse_distributions(&out(0, "naru\nUbuntu\n")).unwrap(), ["naru", "Ubuntu"]);
        let empty = "Linux용 Windows 하위 시스템에 설치된 배포가 없습니다.\n오류 코드: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND";
        assert!(parse_distributions(&out(-1, empty)).unwrap().is_empty());
        assert!(parse_distributions(&out(1, "something else failed")).is_err());
    }

    #[tokio::test]
    async fn command_times_out() {
        let err = command("powershell.exe", &args(["-NoProfile", "-Command", "Start-Sleep 5"]), Opts::timeout(1))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("제한 시간"), "{err}");
    }
}
