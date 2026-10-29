//! Talking to the container engine: a byte stream to the Docker socket, Docker API requests and CLI calls.
//! The engine socket stays inside WSL; no unauthenticated Docker TCP port is exposed.
use crate::connections::{remote_command, ssh_args};
use crate::context::{remote_target, target, Target};
use crate::runner::{args, assert_distro_available, hidden, kill_tree, wsl, Opts};
use crate::runtime::require_ready;
use crate::state::{settings, DISTRO};
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use regex::Regex;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout};

/// A socket-like stream to the engine: socat to the Docker socket inside naru, or `docker system dial-stdio` over SSH.
pub struct EngineStream {
    child: Child,
    stdout: ChildStdout,
    /// Taken on shutdown: closing the handle is how the engine learns our input ended (exec -i).
    stdin: Option<ChildStdin>,
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

pub fn engine_stream(profile: &Target) -> Result<EngineStream> {
    let (exe, cmd) = if profile.id == "local" {
        assert_distro_available()?;
        // dial-stdio half-closes toward the engine when our input ends (exec -i) and exits as soon as the
        // engine closes. socat cannot do both: its -t wait applies to whichever side ends first.
        (
            "wsl.exe",
            args([
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
            ]),
        )
    } else {
        ("ssh.exe", ssh_args(profile, &args(["docker", "system", "dial-stdio"]))?)
    };
    let mut child = hidden(exe)
        .args(&cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("엔진 연결 실패: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stdin = child.stdin.take().expect("piped stdin");
    Ok(EngineStream { child, stdout, stdin: Some(stdin) })
}

type Sender = SendRequest<Full<Bytes>>;

/// Idle keep-alive connections per physical endpoint; each one is a running socat or ssh process.
static POOL: LazyLock<Mutex<HashMap<String, Vec<Sender>>>> = LazyLock::new(Default::default);
const IDLE_PER_ENDPOINT: usize = 2;

fn endpoint(profile: &Target) -> String {
    if profile.id == "local" {
        "local".into()
    } else {
        // Names and profile revisions do not change the physical SSH endpoint.
        format!("{}|{}|{:?}|{}", profile.host, profile.user, profile.port, profile.identity_file)
    }
}

pub fn close_remote_connections() {
    POOL.lock().unwrap().retain(|key, _| key == "local");
}

async fn connect(profile: &Target) -> Result<Sender> {
    let stream = engine_stream(profile)?;
    let (sender, conn) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    Ok(sender)
}

async fn checkout(profile: &Target) -> Result<Sender> {
    let key = endpoint(profile);
    loop {
        let idle = POOL.lock().unwrap().get_mut(&key).and_then(Vec::pop);
        match idle {
            Some(mut sender) if !sender.is_closed() => {
                if sender.ready().await.is_ok() {
                    return Ok(sender);
                }
            }
            Some(_) => continue,
            None => return connect(profile).await,
        }
    }
}

fn checkin(profile: &Target, sender: Sender) {
    let mut pool = POOL.lock().unwrap();
    let idle = pool.entry(endpoint(profile)).or_default();
    if idle.len() < IDLE_PER_ENDPOINT && !sender.is_closed() {
        idle.push(sender);
    }
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

fn error_message(status: hyper::StatusCode, data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data).into_owned();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["message"].as_str().map(String::from))
        .unwrap_or(if text.is_empty() { format!("Docker HTTP {}", status.as_u16()) } else { text })
}

async fn request_once(method: &str, route: &str, body: Option<&Value>, timeout: Duration) -> Result<Value> {
    let profile = target();
    let mut sender = checkout(&profile).await?;
    let work = async {
        let response = sender.send_request(request(method, route, body)?).await?;
        let status = response.status();
        let data = response.into_body().collect().await?.to_bytes();
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
    };
    let result = tokio::time::timeout(timeout, work).await.map_err(|_| anyhow!("Docker API 응답 시간 초과"))?;
    if result.is_ok() {
        checkin(&profile, sender);
    }
    result
}

/// A Docker API call returning parsed JSON (Null for an empty body, a string for non-JSON text).
pub async fn docker(method: &str, route: &str, body: Option<&Value>) -> Result<Value> {
    docker_with(method, route, body, Duration::from_secs(30)).await
}

pub async fn docker_with(method: &str, route: &str, body: Option<&Value>, timeout: Duration) -> Result<Value> {
    let mut attempt = 0;
    loop {
        match request_once(method, route, body, timeout).await {
            Ok(value) => return Ok(value),
            // SSH links drop idle connections; one retry of a read covers a stale pooled socket.
            Err(e) if remote_target()
                && method == "GET"
                && attempt == 0
                && Regex::new(r"(?i)socket hang up|Connection reset|ECONNRESET|kex_exchange|connection closed")
                    .unwrap()
                    .is_match(&e.to_string()) =>
            {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// A streaming Docker API call, e.g. events or logs --follow. The connection is never pooled.
pub async fn docker_stream(method: &str, route: &str, body: Option<&Value>) -> Result<hyper::Response<hyper::body::Incoming>> {
    let mut sender = connect(&target()).await?;
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
    let (exe, all) = if remote_target() {
        let mut remote = args(["docker"]);
        remote.extend_from_slice(cmd);
        ("ssh.exe", ssh_args(&target(), &remote)?)
    } else {
        crate::context::local_only()?;
        assert_distro_available()?;
        let mut all = args(["--distribution", DISTRO, "--user", "root", "--exec"]);
        all.extend(cli_argv(cmd, namespace).await?);
        ("wsl.exe", all)
    };
    crate::runner::run(exe, &all, opts).await
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
}
