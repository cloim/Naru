//! Talking to the container engine: a byte stream to the Docker socket, Docker API requests and CLI calls.
//! The engine socket stays inside WSL; no unauthenticated Docker TCP port is exposed.
//!
//! A remote engine is reached over SSH, and Windows OpenSSH has no ControlMaster: every ssh.exe is a full
//! login. So Docker API calls share a few long-lived `docker system dial-stdio` connections with HTTP
//! keep-alive, at most REMOTE_CONNECTIONS per endpoint; further requests wait for one instead of logging in.
use crate::connections::{endpoint_key, endpoint_label, remote_command, ssh_args, ssh_output};
use crate::context::{remote_target, target, Target};
use crate::runner::{args, assert_distro_available, hidden, kill_tree, wsl, Opts};
use crate::runtime::require_ready;
use crate::ssh_gate::{self, Login};
use crate::state::{settings, DISTRO};
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::SendRequest;
use hyper::StatusCode;
use hyper_util::rt::TokioIo;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// What ssh.exe printed to stderr (the first few KB), so a failed login can say why.
#[derive(Default)]
pub struct Stderr {
    text: Mutex<String>,
    done: AtomicBool,
}

impl Stderr {
    /// The last line written, once the stream ended or after a short wait for it.
    async fn last_line(&self) -> Option<String> {
        for _ in 0..30 {
            if self.done.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let text = self.text.lock().unwrap();
        text.lines().map(str::trim).rfind(|l| !l.is_empty()).map(String::from)
    }
}

/// A socket-like stream to the engine: socat to the Docker socket inside naru, or `docker system dial-stdio` over SSH.
pub struct EngineStream {
    child: Child,
    stdout: ChildStdout,
    /// Taken on shutdown: closing the handle is how the engine learns our input ended (exec -i).
    stdin: Option<ChildStdin>,
    stderr: Option<Arc<Stderr>>,
    _login: Option<Login>,
}

fn closed() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::BrokenPipe, "engine input already closed")
}

impl Drop for EngineStream {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            kill_tree(pid);
        }
    }
}

impl AsyncRead for EngineStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for EngineStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.stdin.as_mut() {
            Some(stdin) => Pin::new(stdin).poll_write(cx, buf),
            None => Poll::Ready(Err(closed())),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.stdin.as_mut() {
            Some(stdin) => Pin::new(stdin).poll_flush(cx),
            None => Poll::Ready(Ok(())),
        }
    }
    /// ChildStdin's own shutdown only flushes; dropping the handle is what closes the pipe.
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if let Some(stdin) = self.stdin.as_mut() {
            std::task::ready!(Pin::new(stdin).poll_flush(cx))?;
        }
        self.stdin = None;
        Poll::Ready(Ok(()))
    }
}

/// Opens a stream to the engine. A remote one is an SSH login, so it passes the endpoint's gate:
/// refused while the gate backs off after failures, and counted while it runs.
pub fn engine_stream(profile: &Target) -> Result<EngineStream> {
    if profile.id == "local" {
        assert_distro_available()?;
        // dial-stdio half-closes toward the engine when our input ends (exec -i) and exits as soon as the
        // engine closes. socat cannot do both: its -t wait applies to whichever side ends first.
        let cmd = args([
            "-d",
            DISTRO,
            "-u",
            "root",
            "--exec",
            "env",
            "DOCKER_HOST=unix:///run/naru/docker.sock",
            "docker",
            "system",
            "dial-stdio",
        ]);
        let mut child = hidden("wsl.exe")
            .args(&cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("엔진 연결 실패: {e}"))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = child.stdin.take().expect("piped stdin");
        return Ok(EngineStream { child, stdout, stdin: Some(stdin), stderr: None, _login: None });
    }
    let gate = ssh_gate::endpoint(&endpoint_key(profile), &endpoint_label(profile));
    gate.admit()?;
    let mut child = hidden("ssh.exe")
        .args(ssh_args(profile, &args(["docker", "system", "dial-stdio"]))?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("엔진 연결 실패: {e}"))?;
    let login = gate.started();
    let stderr = Arc::new(Stderr::default());
    let mut pipe = child.stderr.take().expect("piped stderr");
    let sink = stderr.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        while let Ok(n @ 1..) = pipe.read(&mut buf).await {
            let mut text = sink.text.lock().unwrap();
            if text.len() < 4096 {
                text.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
        sink.done.store(true, Ordering::SeqCst);
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let stdin = child.stdin.take().expect("piped stdin");
    Ok(EngineStream { child, stdout, stdin: Some(stdin), stderr: Some(stderr), _login: Some(login) })
}

type Sender = SendRequest<Full<Bytes>>;

/// Docker API connections busy at once per remote endpoint, each one ssh.exe kept open with keep-alive.
pub const REMOTE_CONNECTIONS: usize = 3;
/// Local connections are cheap processes inside WSL: practically unbounded, two kept idle as before.
const LOCAL_CONNECTIONS: usize = 64;
const LOCAL_IDLE: usize = 2;
/// An idle connection unused this long is closed, so a hidden window leaves no SSH session behind.
const IDLE_TTL: Duration = Duration::from_secs(90);
const SWEEP_EVERY: Duration = Duration::from_secs(15);

/// Something that opens a byte stream to the engine; tests swap the SSH process for an in-memory one.
pub trait Dial: Send + Sync {
    fn dial(&self, profile: &Target) -> Result<Dialed>;
}
/// An opened stream and, for ssh.exe, what it prints to stderr.
pub type Dialed = (Box<dyn Io>, Option<Arc<Stderr>>);
pub trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

struct Spawn;
impl Dial for Spawn {
    fn dial(&self, profile: &Target) -> Result<Dialed> {
        let stream = engine_stream(profile)?;
        let stderr = stream.stderr.clone();
        Ok((Box::new(stream), stderr))
    }
}

/// One HTTP/1.1 keep-alive connection. Dropping it aborts the connection task, which drops the stream and
/// stops its process, also when the engine or the SSH link never answers.
struct Conn {
    sender: Sender,
    task: JoinHandle<()>,
    stderr: Option<Arc<Stderr>>,
    generation: u64,
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Conn {
    fn usable(&self) -> bool {
        !self.sender.is_closed() && self.sender.is_ready()
    }
    /// The SSH error when there is one, which says more than hyper's "connection closed".
    async fn reason(&self, fallback: String) -> String {
        match &self.stderr {
            Some(stderr) => match stderr.last_line().await {
                Some(line) => format!("엔진 연결 실패: {line}"),
                None => fallback,
            },
            None => fallback,
        }
    }
}

struct Slot {
    busy: Arc<Semaphore>,
    idle: Mutex<Vec<(Conn, Instant)>>,
    max_idle: usize,
    generation: AtomicU64,
    remote: bool,
}

impl Slot {
    fn take_idle(&self) -> Option<Conn> {
        let mut idle = self.idle.lock().unwrap();
        while let Some((conn, since)) = idle.pop() {
            if conn.usable() && since.elapsed() < IDLE_TTL {
                return Some(conn);
            }
        }
        None
    }
    fn put_idle(&self, conn: Conn) {
        if conn.generation != self.generation.load(Ordering::SeqCst) || !conn.usable() {
            return;
        }
        let mut idle = self.idle.lock().unwrap();
        if idle.len() < self.max_idle {
            idle.push((conn, Instant::now()));
        }
    }
    fn expire(&self) {
        let stale: Vec<Conn> = {
            let mut idle = self.idle.lock().unwrap();
            let (keep, stale): (Vec<_>, Vec<_>) = idle.drain(..).partition(|(c, since)| c.usable() && since.elapsed() < IDLE_TTL);
            *idle = keep;
            stale.into_iter().map(|(c, _)| c).collect()
        };
        drop(stale);
    }
    fn close(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let idle: Vec<_> = self.idle.lock().unwrap().drain(..).collect();
        drop(idle);
    }
}

/// Keep-alive connections per physical endpoint.
pub struct Pool {
    dial: Box<dyn Dial>,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    sweeper: Mutex<Option<JoinHandle<()>>>,
}

static POOL: LazyLock<Pool> = LazyLock::new(|| Pool::new(Box::new(Spawn)));

pub fn close_remote_connections() {
    POOL.close_remote();
    ssh_gate::reset_backoff();
}

impl Pool {
    pub fn new(dial: Box<dyn Dial>) -> Pool {
        Pool { dial, slots: Mutex::default(), sweeper: Mutex::default() }
    }

    fn slot(&self, profile: &Target) -> Arc<Slot> {
        let remote = profile.id != "local";
        self.slots
            .lock()
            .unwrap()
            .entry(endpoint_key(profile))
            .or_insert_with(|| {
                let (busy, max_idle) = if remote { (REMOTE_CONNECTIONS, REMOTE_CONNECTIONS) } else { (LOCAL_CONNECTIONS, LOCAL_IDLE) };
                Arc::new(Slot { busy: Arc::new(Semaphore::new(busy)), idle: Mutex::default(), max_idle, generation: AtomicU64::new(0), remote })
            })
            .clone()
    }

    pub fn close_remote(&self) {
        let slots: Vec<Arc<Slot>> = self.slots.lock().unwrap().values().filter(|s| s.remote).cloned().collect();
        for slot in slots {
            slot.close();
        }
    }

    /// Closes idle connections past IDLE_TTL now and then; restarted if its runtime went away.
    fn ensure_sweeper(&'static self) {
        let mut sweeper = self.sweeper.lock().unwrap();
        if sweeper.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        *sweeper = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_EVERY).await;
                let slots: Vec<Arc<Slot>> = self.slots.lock().unwrap().values().cloned().collect();
                for slot in slots {
                    slot.expire();
                }
            }
        }));
    }

    async fn connect(&self, profile: &Target, generation: u64) -> Result<Conn> {
        let (io, stderr) = self.dial.dial(profile)?;
        let (sender, conn) = hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(io)).await?;
        let task = tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(Conn { sender, task, stderr, generation })
    }

    /// Sends one request on a pooled connection and returns the status and the whole body.
    /// Waiting for a free connection counts toward `timeout`. A request that fails on a reused connection
    /// is retried once on a new one if it is a read, since keep-alive links can go stale; a new connection
    /// that fails is never retried here and makes the endpoint's gate back off.
    pub async fn fetch(&'static self, profile: &Target, method: &str, route: &str, body: Option<&Value>, timeout: Duration) -> Result<(StatusCode, Bytes)> {
        let deadline = Instant::now() + timeout;
        let expired = || anyhow!("Docker API 응답 시간 초과");
        let slot = self.slot(profile);
        let gate = slot.remote.then(|| ssh_gate::endpoint(&endpoint_key(profile), &endpoint_label(profile)));
        let _busy = tokio::time::timeout_at(deadline, slot.busy.clone().acquire_owned())
            .await
            .map_err(|_| expired())?
            .expect("pool semaphore is never closed");
        let mut reuse = true;
        loop {
            let (mut conn, fresh) = match reuse.then(|| slot.take_idle()).flatten() {
                Some(conn) => (conn, false),
                None => {
                    if let Some(gate) = &gate {
                        gate.admit()?;
                    }
                    (self.connect(profile, slot.generation.load(Ordering::SeqCst)).await?, true)
                }
            };
            let outcome = tokio::time::timeout_at(deadline, exchange(&mut conn.sender, request(method, route, body)?)).await;
            let timed_out = outcome.is_err();
            let error = match outcome {
                Ok(Ok(reply)) => {
                    if let (true, Some(gate)) = (fresh, &gate) {
                        gate.succeeded();
                    }
                    slot.put_idle(conn);
                    self.ensure_sweeper();
                    return Ok(reply);
                }
                Ok(Err(e)) => conn.reason(e.to_string()).await,
                Err(_) => match conn.reason(String::new()).await {
                    reason if reason.is_empty() => expired().to_string(),
                    reason => format!("{} ({reason})", expired()),
                },
            };
            drop(conn);
            if !fresh && !timed_out && method == "GET" && reuse {
                reuse = false;
                continue;
            }
            if let (true, Some(gate)) = (fresh, &gate) {
                gate.failed(&error);
            }
            return Err(anyhow!(error));
        }
    }
}

async fn exchange(sender: &mut Sender, request: hyper::Request<Full<Bytes>>) -> Result<(StatusCode, Bytes)> {
    sender.ready().await?;
    let response = sender.send_request(request).await?;
    let status = response.status();
    let data = response.into_body().collect().await?.to_bytes();
    Ok((status, data))
}

fn request(method: &str, route: &str, body: Option<&Value>) -> Result<hyper::Request<Full<Bytes>>> {
    let mut builder = hyper::Request::builder().method(method).uri(route).header("Host", "localhost");
    let payload = match body {
        Some(value) => {
            builder = builder.header("Content-Type", "application/json");
            Bytes::from(serde_json::to_vec(value)?)
        }
        None => Bytes::new(),
    };
    Ok(builder.body(Full::new(payload))?)
}

fn error_message(status: StatusCode, data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data).into_owned();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["message"].as_str().map(String::from))
        .unwrap_or(if text.is_empty() { format!("Docker HTTP {}", status.as_u16()) } else { text })
}

/// A Docker API call returning the raw body, e.g. multiplexed logs.
pub async fn docker_bytes(method: &str, route: &str, timeout: Duration) -> Result<Bytes> {
    let (status, data) = POOL.fetch(&target(), method, route, None, timeout).await?;
    if data.len() > 16 * 1024 * 1024 {
        bail!("응답 크기 제한 초과");
    }
    if status.as_u16() >= 400 {
        bail!(error_message(status, &data));
    }
    Ok(data)
}

/// A Docker API call returning parsed JSON (Null for an empty body, a string for non-JSON text).
pub async fn docker(method: &str, route: &str, body: Option<&Value>) -> Result<Value> {
    docker_with(method, route, body, Duration::from_secs(30)).await
}

pub async fn docker_with(method: &str, route: &str, body: Option<&Value>, timeout: Duration) -> Result<Value> {
    let (status, data) = POOL.fetch(&target(), method, route, body, timeout).await?;
    if data.len() > 16 * 1024 * 1024 {
        bail!("응답 크기 제한 초과");
    }
    if status.as_u16() >= 400 {
        bail!(error_message(status, &data));
    }
    Ok(if data.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&data).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&data).into_owned()))
    })
}

/// A streaming Docker API call, e.g. events or logs --follow. The connection is never pooled.
pub async fn docker_stream(method: &str, route: &str, body: Option<&Value>) -> Result<hyper::Response<hyper::body::Incoming>> {
    let stream = engine_stream(&target())?;
    let (mut sender, conn) = hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let response = sender.send_request(request(method, route, body)?).await?;
    if response.status().as_u16() >= 400 {
        let status = response.status();
        let data = response.into_body().collect().await?.to_bytes();
        bail!(error_message(status, &data));
    }
    Ok(response)
}

/// Runs the engine CLI: docker or nerdctl inside naru, or docker over SSH for a remote engine.
pub async fn cli(cmd: &[String], opts: Opts) -> Result<String> {
    cli_in(cmd, opts, None).await
}

pub async fn cli_in(cmd: &[String], opts: Opts, namespace: Option<&str>) -> Result<String> {
    if remote_target() {
        let mut all = args(["docker"]);
        all.extend_from_slice(cmd);
        return remote_command(&all, opts).await;
    }
    wsl(&cli_argv(cmd, namespace).await?, opts).await
}

/// Like `cli_in`, but returns the exit code and both streams whatever the code.
pub async fn cli_output(cmd: &[String], opts: Opts, namespace: Option<&str>) -> Result<crate::runner::Output> {
    if remote_target() {
        let mut remote = args(["docker"]);
        remote.extend_from_slice(cmd);
        return ssh_output(&target(), &remote, opts).await;
    }
    crate::context::local_only()?;
    assert_distro_available()?;
    let mut all = args(["--distribution", DISTRO, "--user", "root", "--exec"]);
    all.extend(cli_argv(cmd, namespace).await?);
    crate::runner::run("wsl.exe", &all, opts).await
}

/// The command line inside naru for the configured engine.
async fn cli_argv(cmd: &[String], namespace: Option<&str>) -> Result<Vec<String>> {
    require_ready().await?;
    let cfg = settings().await?;
    let namespace = namespace.map(String::from).unwrap_or(cfg.namespace.clone());
    if !Regex::new(r"^[a-zA-Z0-9_.-]{1,64}$").unwrap().is_match(&namespace) {
        bail!("containerd 네임스페이스 형식이 잘못되었습니다.");
    }
    let mut all = if cfg.engine == "moby" {
        args(["env", "DOCKER_CONFIG=/etc/naru/docker", "DOCKER_HOST=unix:///run/naru/docker.sock", "docker"])
    } else {
        // nerdctl sets up CNI networking itself, so it must run beside containerd.
        args([
            "/usr/local/bin/naru-netns",
            "env",
            "DOCKER_CONFIG=/etc/naru/docker",
            "CNI_PATH=/usr/libexec/cni",
            "BUILDKIT_HOST=unix:///run/naru/buildkitd.sock",
            "/usr/bin/nerdctl",
            "--address",
            "/run/naru/containerd.sock",
            "--namespace",
            &namespace,
            "--cni-netconfpath",
            "/etc/naru/cni/net.d",
        ])
    };
    all.extend_from_slice(cmd);
    Ok(all)
}

/// Parses `--format '{{json .}}'` output: one JSON object per line.
pub fn lines(text: &str) -> Result<Vec<Value>> {
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| Ok(serde_json::from_str(l)?)).collect()
}

fn parse_labels(raw: &Value) -> Value {
    match raw {
        Value::Object(_) => raw.clone(),
        Value::String(s) if !s.is_empty() => {
            let mut labels = serde_json::Map::new();
            for part in s.split(',') {
                if let Some((k, v)) = part.split_once('=') {
                    labels.insert(k.trim().into(), v.trim().into());
                }
            }
            labels.into()
        }
        _ => json!({}),
    }
}

pub async fn list(kind: &str) -> Result<Value> {
    require_ready().await?;
    let cfg = settings().await?;
    if cfg.engine == "moby" {
        let route = match kind {
            "containers" => "/containers/json?all=true",
            "images" => "/images/json",
            "volumes" => "/volumes",
            "networks" => "/networks",
            _ => bail!("지원하지 않는 리소스 종류입니다."),
        };
        let result = docker("GET", route, None).await?;
        return Ok(if kind == "volumes" { result.get("Volumes").cloned().filter(|v| !v.is_null()).unwrap_or(json!([])) } else { result });
    }
    let rows = match kind {
        "containers" => lines(&cli(&args(["ps", "-a", "--format", "{{json .}}"]), Opts::default()).await?)?
            .into_iter()
            .map(|x| {
                let status = x["Status"].as_str().unwrap_or_default();
                json!({
                    "Id": x["ID"], "Names": [x["Names"]], "Image": x["Image"],
                    "State": if status.starts_with("Up") { "running" } else { "exited" },
                    "Status": x["Status"], "Ports": [], "Command": x["Command"], "Labels": {},
                })
            })
            .collect(),
        "images" => lines(&cli(&args(["images", "--format", "{{json .}}"]), Opts::default()).await?)?
            .into_iter()
            .map(|x| {
                json!({
                    "Id": x["ID"],
                    "RepoTags": [format!("{}:{}", x["Repository"].as_str().unwrap_or_default(), x["Tag"].as_str().unwrap_or_default())],
                    "Size": x["Size"], "Created": x["CreatedAt"],
                })
            })
            .collect(),
        "volumes" | "networks" => {
            let noun = if kind == "volumes" { "volume" } else { "network" };
            lines(&cli(&args([noun, "ls", "--format", "{{json .}}"]), Opts::default()).await?)?
                .into_iter()
                .map(|x| {
                    if kind == "volumes" {
                        json!({ "Name": x["Name"], "Driver": x["Driver"], "Mountpoint": x["Mountpoint"], "Labels": parse_labels(&x["Labels"]) })
                    } else {
                        json!({ "Id": x["ID"], "Name": x["Name"], "Driver": x["Driver"], "Scope": x["Scope"] })
                    }
                })
                .collect()
        }
        _ => bail!("지원하지 않는 리소스 종류입니다."),
    };
    Ok(Value::Array(rows))
}

pub fn encode(segment: &str) -> String {
    percent_encoding::utf8_percent_encode(segment, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub async fn inspect(kind: &str, id: &str) -> Result<Value> {
    let cfg = settings().await?;
    require_ready().await?;
    if cfg.engine == "moby" {
        let suffix = if ["volumes", "networks"].contains(&kind) { "" } else { "/json" };
        return docker("GET", &format!("/{kind}/{}{suffix}", encode(id)), None).await;
    }
    let noun = match kind {
        "containers" => "container",
        "images" => "image",
        "volumes" => "volume",
        _ => "network",
    };
    Ok(serde_json::from_str(&cli(&args([noun, "inspect", id]), Opts::default()).await?)?)
}

pub async fn container_action(id: &str, action: &str, log: &crate::runner::Log) -> Result<Value> {
    let cli_action = if action == "remove" { "rm" } else { action };
    if remote_target() {
        return Ok(cli(&args([cli_action, id]), Opts::timeout(60).log(log)).await?.into());
    }
    let cfg = settings().await?;
    require_ready().await?;
    if cfg.engine == "moby" {
        let (method, route) = if action == "remove" {
            ("DELETE", format!("/containers/{}?t=10", encode(id)))
        } else {
            ("POST", format!("/containers/{}/{action}?t=10", encode(id)))
        };
        let result = docker(method, &route, None).await?;
        log("컨테이너 작업 완료.\n");
        return Ok(result);
    }
    Ok(cli(&args([cli_action, id]), Opts::timeout(60).log(log)).await?.into())
}

pub async fn logs(id: &str, tail: u32) -> Result<String> {
    // Screens poll logs; for a remote engine the API rides a pooled connection instead of one login per poll.
    if remote_target() {
        let route = format!("/containers/{}/logs?stdout=1&stderr=1&timestamps=1&tail={tail}", encode(id));
        return Ok(decode_docker_stream(&docker_bytes("GET", &route, Duration::from_secs(15)).await?));
    }
    cli(&args(["logs", "--timestamps", "--tail", &tail.to_string(), id]), Opts { combine: true, ..Opts::timeout(15) }).await
}

/// Joins Docker's multiplexed stdout/stderr frames; anything not framed is returned as text.
pub fn decode_docker_stream(buffer: &[u8]) -> String {
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset + 8 <= buffer.len() && buffer[offset] <= 2 && buffer[offset + 1..offset + 4] == [0, 0, 0] {
        let length = u32::from_be_bytes(buffer[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if offset + 8 + length > buffer.len() {
            break;
        }
        chunks.extend_from_slice(&buffer[offset + 8..offset + 8 + length]);
        offset += 8 + length;
    }
    String::from_utf8_lossy(if offset > 0 { &chunks } else { buffer }).into_owned()
}

fn short(id: &str) -> String {
    id.trim_start_matches("sha256:").chars().take(12).collect()
}

pub async fn prune_preview(kind: &str) -> Result<Value> {
    require_ready().await?;
    let cfg = settings().await?;
    if cfg.engine == "moby" {
        let route = match kind {
            "volumes" => "/volumes",
            "networks" => "/networks",
            _ => "/images/json",
        };
        let (containers, items) = tokio::try_join!(docker("GET", "/containers/json?all=true", None), docker("GET", route, None))?;
        let containers = containers.as_array().cloned().unwrap_or_default();
        return Ok(match kind {
            "images" => {
                let mut used_ids = std::collections::HashSet::new();
                let mut used_names = std::collections::HashSet::new();
                for c in &containers {
                    if let Some(id) = c["ImageID"].as_str() {
                        used_ids.insert(id.trim_start_matches("sha256:").to_string());
                        used_ids.insert(short(id));
                    }
                    if let Some(image) = c["Image"].as_str() {
                        used_names.insert(image.to_string());
                        if image.starts_with("sha256:") {
                            used_ids.insert(image.trim_start_matches("sha256:").to_string());
                            used_ids.insert(short(image));
                        }
                    }
                }
                let unused = items.as_array().cloned().unwrap_or_default().into_iter().filter(|img| {
                    let full = img["Id"].as_str().unwrap_or_default().trim_start_matches("sha256:").to_string();
                    let tags = img["RepoTags"].as_array().cloned().unwrap_or_default();
                    !used_ids.contains(&full) && !used_ids.contains(&short(&full)) && !tags.iter().any(|t| t.as_str().is_some_and(|t| used_names.contains(t)))
                });
                unused
                    .map(|img| {
                        let id = img["Id"].as_str().unwrap_or_default();
                        let tag = img["RepoTags"][0].as_str().filter(|t| *t != "<none>:<none>");
                        let name = tag.map(String::from).unwrap_or_else(|| if id.is_empty() { "—".into() } else { short(id) });
                        json!({ "id": short(id), "name": name, "size": img["Size"].as_u64().unwrap_or(0) })
                    })
                    .collect()
            }
            "volumes" => {
                let used: std::collections::HashSet<String> = containers
                    .iter()
                    .flat_map(|c| c["Mounts"].as_array().cloned().unwrap_or_default())
                    .filter_map(|m| m["Name"].as_str().map(String::from))
                    .collect();
                items["Volumes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|v| !used.contains(v["Name"].as_str().unwrap_or_default()))
                    .map(|v| json!({ "name": v["Name"], "driver": v["Driver"].as_str().unwrap_or("local") }))
                    .collect()
            }
            "networks" => {
                let mut names = std::collections::HashSet::new();
                let mut ids = std::collections::HashSet::new();
                for c in &containers {
                    if let Some(nets) = c["NetworkSettings"]["Networks"].as_object() {
                        for (name, net) in nets {
                            names.insert(name.clone());
                            if let Some(id) = net["NetworkID"].as_str() {
                                ids.insert(id.to_string());
                                ids.insert(id.chars().take(12).collect::<String>());
                            }
                        }
                    }
                }
                items
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|n| {
                        let name = n["Name"].as_str().unwrap_or_default();
                        let id = n["Id"].as_str().unwrap_or_default();
                        !["bridge", "host", "none"].contains(&name)
                            && !names.contains(name)
                            && !ids.contains(id)
                            && !ids.contains(&id.chars().take(12).collect::<String>())
                    })
                    .map(|n| json!({ "id": n["Id"].as_str().unwrap_or_default().chars().take(12).collect::<String>(), "name": n["Name"], "driver": n["Driver"] }))
                    .collect()
            }
            "containers" => {
                let locks = crate::containers::load_container_locks().await.unwrap_or_default();
                let mut preview_items = Vec::new();
                for c in &containers {
                    let running = c["State"] == "running"
                        || c["Status"].as_str().is_some_and(|s| s.starts_with("Up"));
                    if !running && !crate::containers::is_container_locked(&locks, c) {
                        let id = c["Id"].as_str().unwrap_or_default();
                        let name = c["Names"][0].as_str().unwrap_or(id).trim_start_matches('/');
                        let image = c["Image"].as_str().unwrap_or_default();
                        preview_items.push(json!({
                            "id": short(id),
                            "fullId": id,
                            "name": name,
                            "itemType": "container",
                            "driver": image,
                            "detail": image
                        }));
                    }
                }
                let container_val = Value::Array(containers.clone());
                let project_list = crate::projects::list_projects(&container_val).await.unwrap_or_default();
                for proj in project_list {
                    let members = crate::projects::members(&container_val, &proj.name);
                    if members.is_empty() {
                        let is_project_locked = locks.contains(&format!("project:{}", proj.name))
                            || locks.contains(&proj.name);
                        if !is_project_locked {
                            preview_items.push(json!({
                                "id": format!("project:{}", proj.name),
                                "fullId": format!("project:{}", proj.name),
                                "name": proj.name,
                                "itemType": "project",
                                "driver": "compose",
                                "detail": "빈 프로젝트"
                            }));
                        }
                    }
                }
                preview_items.into()
            }
            _ => Value::Array(vec![]),
        });
    }
    let containers = list("containers").await?;
    let items = list(kind).await?;
    let items = items.as_array().cloned().unwrap_or_default();
    Ok(match kind {
        "images" => {
            let used: std::collections::HashSet<String> =
                containers.as_array().into_iter().flatten().filter_map(|c| c["Image"].as_str().map(String::from)).collect();
            items
                .into_iter()
                .filter(|img| !img["RepoTags"].as_array().into_iter().flatten().any(|t| t.as_str().is_some_and(|t| used.contains(t))))
                .map(|img| {
                    let id: String = img["Id"].as_str().unwrap_or_default().chars().take(12).collect();
                    let name = img["RepoTags"][0].as_str().map(String::from).unwrap_or_else(|| if id.is_empty() { "—".into() } else { id.clone() });
                    json!({ "id": id, "name": name, "size": img["Size"].as_u64().unwrap_or(0) })
                })
                .collect()
        }
        "volumes" => items.into_iter().map(|v| json!({ "name": v["Name"], "driver": v["Driver"].as_str().unwrap_or("local") })).collect(),
        "networks" => items
            .into_iter()
            .filter(|n| !["bridge", "host", "none"].contains(&n["Name"].as_str().unwrap_or_default()))
            .map(|n| json!({ "id": n["Id"].as_str().unwrap_or_default().chars().take(12).collect::<String>(), "name": n["Name"], "driver": n["Driver"] }))
            .collect(),
        "containers" => {
            let locks = crate::containers::load_container_locks().await.unwrap_or_default();
            let mut preview_items = Vec::new();
            if let Some(list) = containers.as_array() {
                for c in list {
                    let running = c["State"] == "running"
                        || c["Status"].as_str().is_some_and(|s| s.starts_with("Up"));
                    if !running && !crate::containers::is_container_locked(&locks, c) {
                        let id = c["Id"].as_str().unwrap_or_default();
                        let short_id: String = id.chars().take(12).collect();
                        let name = c["Names"][0].as_str().unwrap_or(id).trim_start_matches('/');
                        let image = c["Image"].as_str().unwrap_or_default();
                        preview_items.push(json!({
                            "id": short_id,
                            "fullId": id,
                            "name": name,
                            "itemType": "container",
                            "driver": image,
                            "detail": image
                        }));
                    }
                }
            }
            let project_list = crate::projects::list_projects(&containers).await.unwrap_or_default();
            for proj in project_list {
                let members = crate::projects::members(&containers, &proj.name);
                if members.is_empty() {
                    let is_project_locked = locks.contains(&format!("project:{}", proj.name))
                        || locks.contains(&proj.name);
                    if !is_project_locked {
                        preview_items.push(json!({
                            "id": format!("project:{}", proj.name),
                            "fullId": format!("project:{}", proj.name),
                            "name": proj.name,
                            "itemType": "project",
                            "driver": "compose",
                            "detail": "빈 프로젝트"
                        }));
                    }
                }
            }
            preview_items.into()
        }
        _ => Value::Array(vec![]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_multiplexed_logs_keep_stdout_stderr_and_utf8() {
        let mut frame = vec![1, 0, 0, 0, 0, 0, 0, 6];
        frame.extend_from_slice("안녕".as_bytes());
        frame.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 3]);
        frame.extend_from_slice(b"err");
        assert_eq!(decode_docker_stream(&frame), "안녕err");
        assert_eq!(decode_docker_stream(b"plain text"), "plain text");
    }

    #[test]
    fn label_strings_become_maps() {
        assert_eq!(parse_labels(&json!("a=1, b = two")), json!({ "a": "1", "b": "two" }));
        assert_eq!(parse_labels(&json!("")), json!({}));
    }

    /// An in-memory engine: each dial is one "SSH login" served by a tiny HTTP/1.1 server.
    #[derive(Default)]
    struct Fake {
        dials: std::sync::atomic::AtomicUsize,
        /// What the next dials do: serve, fail like a saturated sshd, or never answer.
        mode: Mutex<&'static str>,
        delay: Mutex<Duration>,
        /// Lets a test cut the server side of every connection, like a link that died.
        servers: Mutex<Vec<Arc<tokio::sync::Notify>>>,
        /// Server sides that saw their connection end: for ssh.exe, the process being stopped.
        closed: std::sync::atomic::AtomicUsize,
    }

    struct FakeDial(Arc<Fake>);

    impl Dial for FakeDial {
        fn dial(&self, _profile: &Target) -> Result<Dialed> {
            let fake = self.0.clone();
            fake.dials.fetch_add(1, Ordering::SeqCst);
            let (client, server) = tokio::io::duplex(64 * 1024);
            let stderr = Arc::new(Stderr::default());
            let mode = *fake.mode.lock().unwrap();
            if mode == "fail" {
                *stderr.text.lock().unwrap() = "kex_exchange_identification: Connection reset by peer\n".into();
                stderr.done.store(true, Ordering::SeqCst);
                drop(server);
                return Ok((Box::new(client), Some(stderr)));
            }
            let cut = Arc::new(tokio::sync::Notify::new());
            fake.servers.lock().unwrap().push(cut.clone());
            let delay = *fake.delay.lock().unwrap();
            tokio::spawn(async move {
                if mode == "hang" {
                    // Takes the bytes and never answers, like a stalled login; ends when the client goes away.
                    let mut server = server;
                    let mut sink = [0u8; 1024];
                    while let Ok(1..) = server.read(&mut sink).await {}
                } else {
                    let service = hyper::service::service_fn(move |_req: hyper::Request<hyper::body::Incoming>| async move {
                        tokio::time::sleep(delay).await;
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from_static(br#"{"ok":true}"#))))
                    });
                    let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(server), service);
                    tokio::select! {
                        _ = conn => {}
                        _ = cut.notified() => {}
                    }
                }
                fake.closed.fetch_add(1, Ordering::SeqCst);
            });
            Ok((Box::new(client), Some(stderr)))
        }
    }

    fn fake_pool() -> (&'static Pool, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        *fake.mode.lock().unwrap() = "serve";
        (Box::leak(Box::new(Pool::new(Box::new(FakeDial(fake.clone()))))), fake)
    }

    fn remote(host: &str) -> Target {
        let mut t = Target::local();
        t.id = "remote".into();
        t.host = host.into();
        t.user = "root".into();
        t.port = Some(22222);
        t
    }

    fn dials(fake: &Fake) -> usize {
        fake.dials.load(Ordering::SeqCst)
    }

    fn closed(fake: &Fake) -> usize {
        fake.closed.load(Ordering::SeqCst)
    }

    async fn get(pool: &'static Pool, t: &Target, timeout: Duration) -> Result<(StatusCode, Bytes)> {
        pool.fetch(t, "GET", "/containers/json", None, timeout).await
    }

    #[tokio::test]
    async fn concurrent_remote_requests_share_a_few_long_lived_logins() {
        let (pool, fake) = fake_pool();
        *fake.delay.lock().unwrap() = Duration::from_millis(30);
        let t = remote("pool-share.test");
        let burst = futures_util::future::join_all((0..20).map(|_| get(pool, &t, Duration::from_secs(10)))).await;
        assert!(burst.iter().all(|r| r.as_ref().is_ok_and(|(s, _)| s.is_success())));
        assert_eq!(dials(&fake), REMOTE_CONNECTIONS, "a burst waits for pooled connections instead of logging in");
        for _ in 0..30 {
            get(pool, &t, Duration::from_secs(5)).await.unwrap();
        }
        assert_eq!(dials(&fake), REMOTE_CONNECTIONS, "polling reuses the keep-alive connections");
    }

    #[tokio::test]
    async fn a_failed_login_backs_off_instead_of_retrying() {
        let (pool, fake) = fake_pool();
        *fake.mode.lock().unwrap() = "fail";
        let t = remote("pool-fail.test");
        let first = get(pool, &t, Duration::from_secs(5)).await.unwrap_err().to_string();
        assert!(first.contains("kex_exchange_identification"), "{first}");
        assert_eq!(dials(&fake), 1, "a GET that failed to log in is not retried at once");
        for _ in 0..5 {
            let again = get(pool, &t, Duration::from_secs(5)).await.unwrap_err().to_string();
            assert!(again.contains("새 접속을 멈췄습니다"), "{again}");
        }
        assert_eq!(dials(&fake), 1, "no login while the gate backs off");
        // A changed profile clears the backoff so the user's next try runs.
        *fake.mode.lock().unwrap() = "serve";
        ssh_gate::endpoint(&endpoint_key(&t), "").succeeded();
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        assert_eq!(dials(&fake), 2);
    }

    #[tokio::test]
    async fn a_dead_pooled_connection_is_replaced_by_a_new_login() {
        let (pool, fake) = fake_pool();
        let t = remote("pool-stale.test");
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        // The link dies while the connection sits idle; the client has not noticed yet.
        for cut in fake.servers.lock().unwrap().iter() {
            cut.notify_one();
        }
        let (status, _) = get(pool, &t, Duration::from_secs(5)).await.unwrap();
        assert!(status.is_success());
        assert_eq!(dials(&fake), 2);
    }

    #[tokio::test]
    async fn a_timed_out_request_stops_its_connection() {
        let (pool, fake) = fake_pool();
        *fake.mode.lock().unwrap() = "hang";
        let t = remote("pool-hang.test");
        let error = get(pool, &t, Duration::from_millis(200)).await.unwrap_err().to_string();
        assert!(error.contains("시간 초과"), "{error}");
        for _ in 0..100 {
            if closed(&fake) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(closed(&fake), 1, "the hung connection was torn down");
        let blocked = get(pool, &t, Duration::from_secs(1)).await.unwrap_err().to_string();
        assert!(blocked.contains("새 접속을 멈췄습니다"), "{blocked}");
        assert_eq!(dials(&fake), 1);
    }

    #[tokio::test]
    async fn requests_answered_with_an_error_status_keep_the_connection() {
        let (pool, fake) = fake_pool();
        let t = remote("pool-status.test");
        for _ in 0..5 {
            pool.fetch(&t, "DELETE", "/containers/x", None, Duration::from_secs(5)).await.unwrap();
        }
        assert_eq!(dials(&fake), 1);
    }

    #[tokio::test]
    async fn idle_remote_connections_close_after_the_ttl() {
        let (pool, fake) = fake_pool();
        let t = remote("pool-idle.test");
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        let slot = pool.slot(&t);
        for (_, since) in slot.idle.lock().unwrap().iter_mut() {
            *since -= IDLE_TTL;
        }
        slot.expire();
        for _ in 0..100 {
            if closed(&fake) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(closed(&fake), 1, "an idle connection past the TTL is closed");
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        assert_eq!(dials(&fake), 2);
    }

    #[tokio::test]
    async fn local_connections_are_neither_capped_nor_gated() {
        let (pool, fake) = fake_pool();
        *fake.delay.lock().unwrap() = Duration::from_millis(30);
        let t = Target::local();
        let burst = futures_util::future::join_all((0..8).map(|_| get(pool, &t, Duration::from_secs(10)))).await;
        assert!(burst.iter().all(Result::is_ok));
        assert_eq!(dials(&fake), 8, "local requests run in parallel as before");
        assert_eq!(pool.slot(&t).idle.lock().unwrap().len(), LOCAL_IDLE);
    }

    #[tokio::test]
    async fn closing_remote_connections_drops_idle_and_returning_ones() {
        let (pool, fake) = fake_pool();
        let t = remote("pool-close.test");
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        pool.close_remote();
        get(pool, &t, Duration::from_secs(5)).await.unwrap();
        assert_eq!(dials(&fake), 2);
    }
}
