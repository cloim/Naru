//! The local web API and screen server on 127.0.0.1:49170.
use crate::bridge::{start_compat_bridge, start_docker_bridge, start_kubernetes_bridge, KubernetesBridge};
use crate::connections::{change_connections, connections, resolve_target, Profile};
use crate::context::{engine_key, target, with_target};
use crate::engine::{self, cli, cli_output, docker, encode};
use crate::jobs::{job_list, reconcile_jobs, submit, IDENTIFIER, PROJECT_NAME};
use crate::projects::{find_project, forget_project, label, list_projects, read_project_files, LABEL_PROJECT, LABEL_SERVICE};
use crate::runner::{args, distributions, hidden, wsl, wsl_sh, Opts};
use crate::runtime::{self, require_managed, require_ready};
use crate::security::{access, load_remote, token_matches, Remote, Request as AccessRequest};
use crate::state::{data, read_json, root, save_settings, settings, Settings, DISTRO};
use crate::web::{invalid, ok, ApiResult, AppError};
use anyhow::{anyhow, bail, Result};
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tower_http::services::{ServeDir, ServeFile};

pub struct App {
    pub port: u16,
    token: String,
    remote: Option<Remote>,
    kubernetes: Mutex<Option<KubernetesBridge>>,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
    completed_jobs: Mutex<String>,
}

type Shared = State<Arc<App>>;

impl App {
    /// Results of the same read within a few seconds are shared across screens and polls.
    async fn cached<F>(&self, key: &str, ttl: Duration, load: F) -> Result<Value>
    where
        F: std::future::Future<Output = Result<Value>>,
    {
        let key = format!("{}:{key}", serde_json::to_string(&target())?);
        if let Some((at, value)) = self.cache.lock().unwrap().get(&key) {
            if at.elapsed() < ttl {
                return Ok(value.clone());
            }
        }
        let value = load.await?;
        self.cache.lock().unwrap().insert(key, (Instant::now(), value.clone()));
        Ok(value)
    }

    fn clear(&self) {
        self.cache.lock().unwrap().clear();
    }
}

const SHORT: Duration = Duration::from_secs(3);

fn id_param(id: &str) -> Result<String> {
    if !IDENTIFIER.is_match(id) {
        return Err(invalid("id 형식을 확인해 주세요."));
    }
    Ok(id.to_string())
}

// ---------- admission ----------

fn access_request<'a>(headers: &'a HeaderMap, peer: Option<SocketAddr>) -> AccessRequest<'a> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    AccessRequest { host: get("host"), origin: get("origin"), tailscale_user: get("tailscale-user-login"), peer: peer.map(|p| p.ip()) }
}

fn forbidden(message: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": message }))).into_response()
}

async fn security(State(app): Shared, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    if access(&access_request(headers, Some(peer)), app.port, app.remote.as_ref()).is_none() {
        return forbidden("허용되지 않은 Host 또는 출처입니다.");
    }
    if headers.get("sec-fetch-site").is_some_and(|v| v == "cross-site") {
        return forbidden("다른 사이트의 요청은 허용되지 않습니다.");
    }
    let path = req.uri().path().to_string();
    // The terminal socket carries a one-time ticket instead of the token; it must come from a page.
    let terminal = path == "/api/terminal";
    if terminal && headers.get("origin").is_none() {
        return forbidden("터미널은 Naru 화면에서만 열 수 있습니다.");
    }
    if path.starts_with("/api/") && path != "/api/session" && !terminal {
        let supplied = headers.get("x-naru-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
        if !token_matches(supplied, &app.token) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "페이지를 새로고침해 연결을 갱신해 주세요." }))).into_response();
        }
    }
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    h.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    if path.starts_with("/api/") && path != "/api/session" {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

static LOCAL_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/api/(settings|disk|snapshots|kubernetes|kubeconfig|forwards|extensions|diagnostics|onboarding)(/|$)").unwrap());
static VOLUME_FILES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/volumes/[^/]+/(files|export|import)(/|$)").unwrap());

/// Every request resolves its engine once; in-flight requests keep this immutable snapshot.
async fn engine_scope(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") || path.starts_with("/api/engines") || path == "/api/session" {
        return next.run(req).await;
    }
    let headers = req.headers();
    let id = headers.get("x-naru-engine").and_then(|v| v.to_str().ok()).unwrap_or("local").to_string();
    let revision = headers.get("x-naru-engine-revision").and_then(|v| v.to_str().ok()).map(String::from);
    let profile = match resolve_target(&id).await {
        Ok(p) => p,
        Err(e) => return AppError(e).into_response(),
    };
    let conflict = |message: &str| (StatusCode::CONFLICT, Json(json!({ "error": message }))).into_response();
    if profile.id != "local" {
        if revision != profile.revision {
            return conflict("연결 설정이 변경되었습니다. 화면을 새로고침해 주세요.");
        }
        if LOCAL_ONLY.is_match(&path) {
            return conflict("로컬 WSL 전용 기능입니다. 로컬 엔진을 선택해 주세요.");
        }
        if VOLUME_FILES.is_match(&path) {
            return conflict("볼륨 파일 탐색과 아카이브는 로컬 WSL 전용입니다.");
        }
    }
    with_target(profile, next.run(req)).await
}

/// `<container>.localhost` and `<container>.naru.localhost` reach the container's first published port.
async fn container_proxy(State(app): Shared, req: Request, next: Next) -> Response {
    static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([a-zA-Z0-9_-]+)\.(?:naru\.)?localhost(?::\d+)?$").unwrap());
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default().to_string();
    let Some(name) = HOST.captures(&host).map(|m| m[1].to_lowercase()) else { return next.run(req).await };
    if ["naru", "www", "app", "localhost"].contains(&name.as_str()) {
        return next.run(req).await;
    }
    let Ok(list) = engine::list("containers").await else { return next.run(req).await };
    let port = list.as_array().into_iter().flatten().find_map(|c| {
        let n = c["Names"][0].as_str().or(c["Id"].as_str()).unwrap_or_default().trim_start_matches('/').to_lowercase();
        (n == name).then(|| c["Ports"].as_array().into_iter().flatten().find_map(|p| p["PublicPort"].as_u64())).flatten()
    });
    let Some(port) = port else {
        let page = format!(
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Naru - Container Proxy</title></head>\
             <body style=\"font-family:sans-serif;padding:40px;text-align:center;color:#333;\"><h2>컨테이너 프록시 연결 안내</h2>\
             <p>'<strong>{name}</strong>' 컨테이너가 실행 중이지 않거나 공개된 포트가 없습니다.</p>\
             <p><a href=\"http://127.0.0.1:{}\">Naru 대시보드로 이동</a></p></body></html>",
            app.port
        );
        return (StatusCode::BAD_GATEWAY, Html(page)).into_response();
    };
    match proxy_to(port, req).await {
        Ok(response) => response,
        Err(e) => (StatusCode::BAD_GATEWAY, format!("컨테이너 프록시 오류: {e}")).into_response(),
    }
}

async fn proxy_to(port: u64, mut req: Request) -> Result<Response> {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port as u16)).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await?;
    tokio::spawn(conn);
    req.headers_mut().insert(header::HOST, HeaderValue::from_str(&format!("127.0.0.1:{port}"))?);
    let response = sender.send_request(req).await?;
    Ok(response.map(Body::new))
}

// ---------- handlers ----------

async fn put_settings(State(app): Shared, Json(body): Json<Value>) -> ApiResult {
    let current = runtime::status().await?;
    let next = Settings::parse(body.clone()).map_err(|e| invalid(e.to_string()))?;
    if current["managed"] == true && current["running"] == true && settings().await?.engine_changed(&next) {
        return Err(anyhow!("엔진 설정을 변경하려면 Naru 런타임을 종료해 주세요.").into());
    }
    let previous_port = current["kubernetes"]["port"].as_u64();
    let value = save_settings(body).await?;
    crate::tools::sync_cli_proxies().await?;
    if previous_port != Some(value.kubernetes.port as u64) {
        let mut bridge = app.kubernetes.lock().unwrap();
        if let Some(old) = bridge.take() {
            old.stop();
        }
        *bridge = Some(start_kubernetes_bridge(value.kubernetes.port));
    }
    app.clear();
    Ok(Json(serde_json::to_value(value)?))
}

fn parse_ls(output: &str, base: &str) -> Vec<Value> {
    let mut entries: Vec<Value> = output
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with("total"))
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 8 {
                return None;
            }
            let mode = parts[0];
            // long-iso dates take two fields, busybox dates three.
            let start = if parts.get(5).is_some_and(|p| p.contains('-')) { 7 } else { 8 };
            let name = parts.get(start..)?.join(" ");
            if name.is_empty() || name == "." || name == ".." {
                return None;
            }
            Some(json!({
                "name": name, "path": join_posix(base, &name), "isDir": mode.starts_with('d'),
                "size": parts[4].parse::<u64>().unwrap_or(0), "mode": mode,
            }))
        })
        .collect();
    entries.sort_by(|a, b| {
        b["isDir"].as_bool().cmp(&a["isDir"].as_bool()).then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    entries
}

/// Normalizes a POSIX path the way path.posix.normalize does, keeping it absolute.
fn normalize_posix(raw: &str) -> String {
    let mut parts: Vec<&str> = vec![];
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

fn join_posix(base: &str, name: &str) -> String {
    normalize_posix(&format!("{base}/{name}"))
}

const LIST_DIR: &str = "ls -la --time-style=long-iso -- \"$1\" 2>/dev/null || ls -la -- \"$1\"";

async fn container_files(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let id = id_param(&id)?;
    let path = normalize_posix(q.get("path").map_or("/", String::as_str));
    let output = cli(&args(["exec", &id, "sh", "-c", LIST_DIR, "sh", &path]), Opts::timeout(15)).await?;
    Ok(Json(json!({ "path": path, "entries": parse_ls(&output, &path) })))
}

async fn container_file(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let id = id_param(&id)?;
    let path = normalize_posix(q.get("path").map_or("", String::as_str));
    if path == "/" {
        return Err(invalid("파일 경로를 지정해 주세요.").into());
    }
    let text = cli(&args(["exec", &id, "cat", "--", &path]), Opts::timeout(15)).await?;
    Ok(Json(json!({ "path": path, "text": text })))
}

fn file_body(body: &Value) -> Result<(String, String)> {
    let ok_keys = body.as_object().is_some_and(|o| o.keys().all(|k| k == "path" || k == "text"));
    match (body["path"].as_str(), body["text"].as_str()) {
        (Some(p), Some(t)) if ok_keys && !p.is_empty() && p.len() <= 4096 && t.len() <= 10 * 1024 * 1024 => {
            Ok((p.to_string(), t.to_string()))
        }
        _ => Err(invalid("파일 저장 요청을 확인해 주세요.")),
    }
}

async fn save_container_file(Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult {
    let id = id_param(&id)?;
    let (path, text) = file_body(&body)?;
    let path = normalize_posix(&path);
    cli(&args(["exec", "-i", &id, "sh", "-c", "cat > \"$1\"", "sh", &path]), Opts::timeout(15).input(text)).await?;
    Ok(Json(json!({ "ok": true, "path": path })))
}

async fn delete_container_file(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let id = id_param(&id)?;
    let path = normalize_posix(q.get("path").map_or("", String::as_str));
    if path == "/" {
        return Err(invalid("루트 디렉터리는 삭제할 수 없습니다.").into());
    }
    cli(&args(["exec", &id, "rm", "-rf", "--", &path]), Opts::timeout(15)).await?;
    ok()
}

/// A path inside a volume, never above its mount point.
async fn volume_path(id: &str, raw: &str) -> Result<(String, String)> {
    let id = id_param(id)?;
    let vol = engine::inspect("volumes", &id).await?;
    let mountpoint = vol["Mountpoint"].as_str().filter(|m| !m.is_empty()).ok_or_else(|| anyhow!("볼륨 마운트 경로를 찾을 수 없습니다."))?;
    let rel = normalize_posix(raw);
    Ok((mountpoint.trim_end_matches('/').to_string() + &rel, rel))
}

async fn volume_files(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let (dir, rel) = volume_path(&id, q.get("path").map_or("/", String::as_str)).await?;
    let output = wsl(&args(["sh", "-c", LIST_DIR, "sh", &dir]), Opts::timeout(15)).await?;
    Ok(Json(json!({ "path": rel, "entries": parse_ls(&output, &rel) })))
}

async fn volume_file(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let (file, rel) = volume_path(&id, q.get("path").map_or("", String::as_str)).await?;
    let text = wsl(&args(["cat", "--", &file]), Opts::timeout(15)).await?;
    Ok(Json(json!({ "path": rel, "text": text })))
}

async fn save_volume_file(Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult {
    let (path, text) = file_body(&body)?;
    let (file, rel) = volume_path(&id, &path).await?;
    wsl(&args(["sh", "-c", "cat > \"$1\"", "sh", &file]), Opts::timeout(15).input(text)).await?;
    Ok(Json(json!({ "ok": true, "path": rel })))
}

async fn delete_volume_file(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let (file, rel) = volume_path(&id, q.get("path").map_or("", String::as_str)).await?;
    if rel == "/" {
        return Err(invalid("루트 디렉터리는 삭제할 수 없습니다.").into());
    }
    wsl(&args(["rm", "-rf", "--", &file]), Opts::timeout(15)).await?;
    ok()
}

fn tar_child(extra: &[&str]) -> Result<tokio::process::Child> {
    crate::runner::assert_distro_available()?;
    let mut a = args(["--distribution", DISTRO, "--user", "root", "--exec", "tar"]);
    a.extend(extra.iter().map(|s| s.to_string()));
    Ok(hidden("wsl.exe").args(a).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn()?)
}

async fn export_volume(Path(id): Path<String>) -> Result<Response, AppError> {
    let (mountpoint, _) = volume_path(&id, "/").await?;
    let mut child = tar_child(&["-czf", "-", "-C", &mountpoint, "."])?;
    let stdout = child.stdout.take().unwrap();
    // The child lives as long as the download stream.
    let stream = tokio_util::io::ReaderStream::new(stdout);
    let body = Body::from_stream(futures_util::StreamExt::map(stream, move |chunk| {
        let _keep = &child;
        chunk
    }));
    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.tar.gz\"", encode(&id))),
        ],
        body,
    )
        .into_response())
}

async fn import_volume(Path(id): Path<String>, body: axum::body::Bytes) -> ApiResult {
    let (mountpoint, _) = volume_path(&id, "/").await?;
    let mut child = tar_child(&["-xzf", "-", "-C", &mountpoint])?;
    let mut stdin = child.stdin.take().unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut stdin, &body).await?;
    drop(stdin);
    let status = child.wait().await?;
    if !status.success() {
        bail_api(&format!("복원 실패 (exit code {})", status.code().unwrap_or(-1)))?;
    }
    ok()
}

fn bail_api(message: &str) -> Result<()> {
    bail!(message.to_string())
}

async fn image_history(Path(id): Path<String>) -> ApiResult {
    let id = id_param(&id)?;
    if settings().await?.engine == "moby" {
        return Ok(Json(docker("GET", &format!("/images/{}/history", encode(&id)), None).await?));
    }
    let text = cli(&args(["history", "--no-trunc", "--format", "{{json .}}", &id]), Opts::default()).await?;
    Ok(Json(text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()))
}

async fn network_check(Json(body): Json<Value>) -> ApiResult {
    static TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$").unwrap());
    let known = body.as_object().is_some_and(|o| o.keys().all(|k| ["source", "target", "port"].contains(&k.as_str())));
    let source = body["source"].as_str().filter(|s| IDENTIFIER.is_match(s));
    // Hosts and addresses only: the target reaches a shell inside the container.
    let target = body["target"].as_str().filter(|t| TARGET.is_match(t));
    let port = match &body["port"] {
        Value::Null => None,
        v => Some(v.as_u64().filter(|p| (1..=65535).contains(p)).ok_or_else(|| invalid("포트를 확인해 주세요."))?),
    };
    let (Some(source), Some(target), true) = (source, target, known) else {
        return Err(invalid("진단 요청을 확인해 주세요.").into());
    };
    let script = match port {
        Some(_) => "nc -zv -w 2 \"$1\" \"$2\" 2>&1 || timeout 2 bash -c \"</dev/tcp/$1/$2\" 2>&1",
        None => "ping -c 2 -W 2 \"$1\" 2>&1 || getent hosts \"$1\" 2>&1",
    };
    let port = port.map(|p| p.to_string()).unwrap_or_default();
    match cli_output(&args(["exec", source, "sh", "-c", script, "sh", target, &port]), Opts::timeout(10), None).await {
        Ok(out) => Ok(Json(json!({
            "ok": out.code == Some(0),
            "output": if out.stdout.is_empty() { out.stderr } else { out.stdout },
            "code": out.code,
        }))),
        Err(e) => Ok(Json(json!({ "ok": false, "output": e.to_string() }))),
    }
}

fn job_scope(job: &Value) -> String {
    job["engineScopeId"].as_str().or(job["engineId"].as_str()).unwrap_or("local").to_string()
}

async fn jobs(State(app): Shared) -> ApiResult {
    reconcile_jobs().await?;
    let list = job_list().await?;
    let finished: String = list
        .iter()
        .filter(|j| matches!(j["state"].as_str(), Some("failed" | "succeeded")))
        .filter_map(|j| j["id"].as_str())
        .collect::<Vec<_>>()
        .join(",");
    {
        let mut completed = app.completed_jobs.lock().unwrap();
        if *completed != finished {
            *completed = finished;
            app.clear();
        }
    }
    let key = engine_key();
    Ok(Json(list.into_iter().filter(|j| job_scope(j) == key).collect()))
}

async fn job(State(app): Shared, Path(id): Path<String>) -> ApiResult {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(invalid("작업 id 형식을 확인해 주세요.").into());
    }
    reconcile_jobs().await?;
    let file = crate::jobs::jobs_dir().join(format!("{id}.json"));
    let current: Value = read_json(&file, None).await?;
    if job_scope(&current) != engine_key() {
        return Err(anyhow!("다른 엔진의 작업입니다.").into());
    }
    if matches!(current["state"].as_str(), Some("succeeded" | "failed")) {
        app.clear();
    }
    let log = match tokio::fs::read(crate::jobs::jobs_dir().join(format!("{id}.log"))).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    Ok(Json(json!({ "job": read_json::<Value>(&file, None).await?, "log": log })))
}

async fn create_job(State(app): Shared, Json(body): Json<Value>) -> Result<Response, AppError> {
    let known = body.as_object().is_some_and(|o| o.keys().all(|k| k == "type" || k == "payload"));
    let kind = body["type"].as_str().filter(|_| known).ok_or_else(|| invalid("작업 요청을 확인해 주세요."))?;
    let payload = match &body["payload"] {
        Value::Null => json!({}),
        p @ Value::Object(_) => p.clone(),
        _ => return Err(invalid("작업 입력은 객체여야 합니다.").into()),
    };
    let job = submit(kind, &payload).await.map_err(|e| {
        if e.to_string().contains("진행 중인 작업") || e.to_string().contains("접수 중") { e } else { invalid(e.to_string()) }
    })?;
    app.clear();
    Ok((StatusCode::ACCEPTED, Json(job)).into_response())
}

async fn kubernetes_running() -> Result<Value> {
    Ok(wsl_sh("test -f /run/naru/k3s.pid && kill -0 \"$(cat /run/naru/k3s.pid)\"", Opts::timeout(5)).await.is_ok().into())
}

async fn kubernetes_state(State(app): Shared) -> ApiResult {
    require_managed()?;
    require_ready().await?;
    Ok(Json(json!({ "running": app.cached("kube:state", SHORT, kubernetes_running()).await? })))
}

async fn kubernetes(State(app): Shared, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    require_managed()?;
    require_ready().await?;
    if app.cached("kube:state", SHORT, kubernetes_running()).await? != true {
        return Err(anyhow!("Kubernetes가 꺼져 있습니다. 상단의 Kubernetes 시작으로 실행해 주세요.").into());
    }
    let kind = q.get("kind").map_or("pods", String::as_str).to_string();
    let kinds = ["pods", "deployments", "services", "nodes", "namespaces", "configmaps", "persistentvolumeclaims", "events"];
    if !kinds.contains(&kind.as_str()) {
        return Err(invalid("지원하지 않는 Kubernetes 리소스입니다.").into());
    }
    let mut extra = vec!["get", kind.as_str(), "-o", "json"];
    if !["nodes", "namespaces"].contains(&kind.as_str()) {
        extra.push("-A");
    }
    let cmd = runtime::kubectl(&extra);
    let load = async { Ok(serde_json::from_str(&wsl(&cmd, Opts::timeout(10)).await?)?) };
    Ok(Json(app.cached(&format!("kube:{kind}"), SHORT, load).await?))
}

async fn kubernetes_logs(Query(q): Query<HashMap<String, String>>) -> ApiResult {
    require_managed()?;
    require_ready().await?;
    let name = q.get("name").filter(|n| Regex::new(r"^[a-z0-9][a-z0-9.-]{0,252}$").unwrap().is_match(n));
    let namespace = q.get("namespace").filter(|n| Regex::new(r"^[a-z0-9][a-z0-9-]{0,62}$").unwrap().is_match(n));
    let (Some(name), Some(namespace)) = (name, namespace) else { return Err(invalid("Pod 이름과 네임스페이스를 확인해 주세요.").into()) };
    let cmd = runtime::kubectl(&["-n", namespace, "logs", name, "--all-containers=true", "--tail=300"]);
    Ok(Json(json!({ "text": wsl(&cmd, Opts::timeout(15)).await? })))
}

async fn kubeconfig() -> Result<Response, AppError> {
    let text = runtime::export_kubeconfig().await?;
    Ok((
        [(header::CONTENT_TYPE, "text/yaml; charset=utf-8"), (header::CONTENT_DISPOSITION, "attachment; filename=\"naru-kubeconfig.yaml\"")],
        text,
    )
        .into_response())
}

async fn snapshots() -> ApiResult {
    let dir = data().join("snapshots");
    tokio::fs::create_dir_all(&dir).await?;
    let mut rows = vec![];
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_name().to_string_lossy().ends_with(".json") {
            rows.push(read_json::<Value>(&entry.path(), None).await?);
        }
    }
    Ok(Json(rows.into()))
}

async fn project_containers() -> Result<Value> {
    require_ready().await?;
    engine::list("containers").await
}

fn project_param(name: &str) -> Result<String> {
    if !PROJECT_NAME.is_match(name) {
        return Err(invalid("프로젝트 이름을 확인해 주세요."));
    }
    Ok(name.to_string())
}

fn container_label(c: &Value) -> String {
    c["Names"][0].as_str().map(String::from).unwrap_or_else(|| c["Id"].as_str().unwrap_or_default().chars().take(12).collect()).trim_start_matches('/').to_string()
}

async fn projects(State(app): Shared) -> ApiResult {
    let load = async { Ok(serde_json::to_value(list_projects(&project_containers().await?).await?)?) };
    Ok(Json(app.cached("projects", SHORT, load).await?))
}

async fn project_files(Path(name): Path<String>) -> ApiResult {
    let project = find_project(&project_param(&name)?, &project_containers().await?).await?;
    let mut value = serde_json::to_value(&project)?;
    value["files"] = read_project_files(&project).await?;
    Ok(Json(value))
}

async fn project_logs(Path(name): Path<String>) -> ApiResult {
    let name = project_param(&name)?;
    let containers = project_containers().await?;
    let mut sections = vec![];
    for c in containers.as_array().into_iter().flatten().filter(|c| label(c, LABEL_PROJECT) == Some(name.as_str())) {
        let service = label(c, LABEL_SERVICE).map(String::from).unwrap_or_else(|| container_label(c));
        let text = engine::logs(c["Id"].as_str().unwrap_or_default(), 200).await.unwrap_or_else(|e| e.to_string());
        let text = if text.is_empty() { "아직 출력된 로그가 없습니다.".to_string() } else { text };
        sections.push(format!("== {service} ({}) ==\n{text}", container_label(c)));
    }
    Ok(Json(json!({ "text": sections.join("\n\n") })))
}

async fn forget(State(app): Shared, Path(name): Path<String>) -> ApiResult {
    forget_project(&project_param(&name)?, &project_containers().await?).await?;
    app.clear();
    ok()
}

async fn diagnostics() -> ApiResult {
    let state = runtime::status().await?;
    let mut logs = serde_json::Map::new();
    if state["running"] == true && state["managed"] == true {
        for name in ["engine", "kubernetes", "buildkit", "agent"] {
            logs.insert(name.into(), wsl_sh(&format!("tail -n 100 /var/log/naru/{name}.log 2>/dev/null || true"), Opts::default()).await?.into());
        }
    }
    Ok(Json(json!({
        "state": state,
        "distributions": distributions(false).await?,
        "provenance": read_json::<Value>(&data().join("provenance.json"), Some(Value::Null)).await?,
        "logs": logs,
        "runtime": format!("naru {}", env!("CARGO_PKG_VERSION")),
        "uptime": START.elapsed().as_secs_f64(),
    })))
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

async fn terminal_ticket(
    State(app): Shared,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult {
    let scheme = if access(&access_request(&headers, Some(peer)), app.port, app.remote.as_ref()) == Some("https") { "wss" } else { "ws" };
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default();
    crate::terminal::create_ticket(&id, &body, host, scheme).await
}

async fn terminal_socket(ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>) -> Response {
    match q.get("ticket").and_then(|k| crate::terminal::redeem(k)) {
        Some(ticket) => ws.max_message_size(65536).on_upgrade(move |socket| crate::terminal::serve(socket, ticket)),
        None => StatusCode::FORBIDDEN.into_response(),
    }
}

// ---------- engines ----------

async fn engines() -> ApiResult {
    Ok(Json(serde_json::to_value(connections().await?)?))
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn add_engine(Json(body): Json<Value>) -> Result<Response, AppError> {
    let profile = Profile::parse(body).map_err(|e| invalid(e.to_string()))?.into_target(new_id(), new_id(), new_id());
    let added = profile.clone();
    change_connections(move |cfg| {
        cfg.profiles.push(added);
        Ok(())
    })
    .await?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(profile)?)).into_response())
}

async fn update_engine(Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult {
    let input = Profile::parse(body).map_err(|e| invalid(e.to_string()))?;
    change_connections(move |cfg| {
        let i = cfg.profiles.iter().position(|p| p.id == id).ok_or_else(|| anyhow!("연결 프로필을 찾을 수 없습니다."))?;
        let previous = &cfg.profiles[i];
        let scope = if input.same_endpoint(previous) { previous.scope_id.clone().unwrap_or(previous.id.clone()) } else { new_id() };
        cfg.profiles[i] = input.into_target(id, scope, new_id());
        Ok(())
    })
    .await?;
    ok()
}

async fn delete_engine(Path(id): Path<String>) -> ApiResult {
    change_connections(move |cfg| {
        cfg.profiles.retain(|p| p.id != id);
        if cfg.selected == id {
            cfg.selected = "local".into();
        }
        Ok(())
    })
    .await?;
    ok()
}

async fn test_engine(Json(body): Json<Value>) -> ApiResult {
    let profile = Profile::parse(body).map_err(|e| invalid(e.to_string()))?.into_target("test".into(), "test".into(), "test".into());
    let version = with_target(profile, async { engine::docker_with("GET", "/version", None, Duration::from_secs(15)).await }).await?;
    let podman = version["Components"].as_array().into_iter().flatten().any(|c| c["Name"].as_str().is_some_and(|n| n.to_lowercase().contains("podman")));
    if version["Version"].as_str().is_none() || podman {
        return Err(anyhow!("Docker 엔진을 확인해 주세요. Podman 전용 서버는 Docker 설치 후 연결할 수 있습니다.").into());
    }
    Ok(Json(json!({ "ok": true, "version": version["Version"], "checkedAt": crate::jobs::now() })))
}

async fn select_engine(Json(body): Json<Value>) -> ApiResult {
    let id = body["id"].as_str().ok_or_else(|| invalid("엔진 id가 필요합니다."))?.to_string();
    resolve_target(&id).await?;
    change_connections(move |cfg| {
        if id != "local" && !cfg.profiles.iter().any(|p| p.id == id) {
            bail!("연결 프로필을 다시 선택해 주세요.");
        }
        cfg.selected = id;
        Ok(())
    })
    .await?;
    ok()
}

// ---------- router ----------

fn routes(app: Arc<App>) -> Router {
    let kinds = ["containers", "images", "volumes", "networks"];
    let mut api = Router::new()
        .route("/api/session", get(|State(app): Shared| async move { Json(json!({ "token": app.token })) }))
        .route("/api/forwards", get(|| async { ApiResult::Ok(Json(Value::from(crate::forwarding::list_forwards().await?))) }))
        .route("/api/port-forwarding", get(|| async { Json(crate::ports::port_forwarding_status()) }))
        .route(
            "/api/status",
            get(|State(app): Shared| async move { ApiResult::Ok(Json(app.cached("status", SHORT, runtime::status()).await?)) }),
        )
        .route(
            "/api/disk",
            get(|State(app): Shared| async move {
                let mut usage = app.cached("disk", Duration::from_secs(30), crate::disk::disk_usage()).await?;
                usage["minReclaim"] = crate::disk::MIN_RECLAIM.into();
                ApiResult::Ok(Json(usage))
            }),
        )
        .route("/api/settings", get(|| async { ApiResult::Ok(Json(serde_json::to_value(settings().await?)?)) }).put(put_settings))
        .route(
            "/api/{kind}/prune-preview",
            get(|Path(kind): Path<String>| async move {
                if !["images", "volumes", "networks"].contains(&kind.as_str()) {
                    return Err(invalid("지원하지 않는 리소스 종류입니다.").into());
                }
                ApiResult::Ok(Json(engine::prune_preview(&kind).await?))
            }),
        )
        .route("/api/containers/{id}/logs", get(|Path(id): Path<String>| async move { ApiResult::Ok(Json(json!({ "text": engine::logs(&id_param(&id)?, 300).await? }))) }))
        .route(
            "/api/containers/{id}/exec",
            post(|Path(id): Path<String>, Json(body): Json<Value>| async move {
                let id = id_param(&id)?;
                let list = body["args"].as_array().filter(|a| !a.is_empty() && a.len() <= 100 && a.iter().all(|x| x.as_str().is_some_and(|s| s.len() <= 4096)));
                let known = body.as_object().is_some_and(|o| o.keys().all(|k| k == "args"));
                let Some(list) = list.filter(|_| known) else { return Err(invalid("실행 명령을 확인해 주세요.").into()) };
                let mut a = args(["exec", &id]);
                a.extend(list.iter().map(|x| x.as_str().unwrap().to_string()));
                let out = cli_output(&a, Opts::timeout(30), None).await?;
                ApiResult::Ok(Json(json!({ "text": out.stdout, "stderr": out.stderr, "code": out.code })))
            }),
        )
        .route(
            "/api/containers/{id}/stats",
            get(|Path(id): Path<String>| async move {
                require_ready().await?;
                let id = id_param(&id)?;
                ApiResult::Ok(Json(if settings().await?.engine == "moby" {
                    docker("GET", &format!("/containers/{}/stats?stream=false", encode(&id)), None).await?
                } else {
                    json!({ "text": cli(&args(["stats", "--no-stream", &id]), Opts::default()).await? })
                }))
            }),
        )
        .route("/api/containers/{id}/files", get(container_files).delete(delete_container_file))
        .route("/api/containers/{id}/files/content", get(container_file).put(save_container_file))
        .route("/api/containers/{id}/terminal", post(terminal_ticket))
        .route("/api/terminal", get(terminal_socket))
        .route("/api/volumes/{id}/files", get(volume_files).delete(delete_volume_file))
        .route("/api/volumes/{id}/files/content", get(volume_file).put(save_volume_file))
        .route("/api/volumes/{id}/export", get(export_volume))
        .route("/api/volumes/{id}/import", post(import_volume).layer(DefaultBodyLimit::max(500 * 1024 * 1024)))
        .route("/api/images/{id}/history", get(image_history))
        .route("/api/networks/ping", post(network_check))
        .route("/api/jobs", get(jobs).post(create_job))
        .route("/api/jobs/{id}", get(job))
        .route("/api/kubernetes/state", get(kubernetes_state))
        .route("/api/kubernetes", get(kubernetes))
        .route("/api/kubernetes/logs", get(kubernetes_logs))
        .route("/api/kubeconfig", get(kubeconfig))
        .route("/api/snapshots", get(snapshots))
        .route("/api/projects", get(projects))
        .route("/api/projects/{name}/files", get(project_files))
        .route("/api/projects/{name}/logs", get(project_logs))
        .route("/api/projects/{name}", delete(forget))
        .route("/api/diagnostics/resources", get(|| async { ApiResult::Ok(Json(crate::diagnostics::resource_sample().await?)) }))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/engines", get(engines).post(add_engine))
        .route("/api/engines/test", post(test_engine))
        .route("/api/engines/selection/current", put(select_engine))
        .route("/api/engines/{id}", put(update_engine).delete(delete_engine))
        .merge(crate::extensions::routes(app.port))
        .merge(crate::onboarding::routes());
    for kind in kinds {
        api = api
            .route(
                &format!("/api/{kind}"),
                get(move |State(app): Shared| async move { ApiResult::Ok(Json(app.cached(kind, SHORT, engine::list(kind)).await?)) }),
            )
            .route(
                &format!("/api/{kind}/{{id}}/inspect"),
                get(move |Path(id): Path<String>| async move { ApiResult::Ok(Json(engine::inspect(kind, &id_param(&id)?).await?)) }),
            );
    }
    let dist = root().join("dist");
    let screens = ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html")));
    // Unknown API paths answer in JSON; everything else is a screen of the single-page app.
    let fallback = move |req: Request| {
        let screens = screens.clone();
        async move {
            if req.uri().path().starts_with("/api/") {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "API 경로를 확인해 주세요." }))).into_response();
            }
            match tower::ServiceExt::oneshot(screens, req).await {
                Ok(response) => response.into_response(),
                Err(never) => match never {},
            }
        }
    };
    api.fallback(fallback)
        .layer(axum::middleware::from_fn(engine_scope))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(app.clone(), security))
        .layer(axum::middleware::from_fn_with_state(app.clone(), container_proxy))
        .with_state(app)
}

/// Marks jobs whose worker died while the server was down, and clears a stale runtime lock.
async fn recover() -> Result<()> {
    tokio::fs::create_dir_all(data()).await?;
    for mut job in job_list().await? {
        let active = matches!(job["state"].as_str(), Some("running" | "queued"));
        let alive = job["pid"].as_u64().is_some_and(|pid| crate::runner::process_alive(pid as u32));
        if active && !alive {
            job["state"] = "failed".into();
            job["error"] = "이전 작업 프로세스가 종료되었습니다.".into();
            job["finishedAt"] = crate::jobs::now().into();
            let id = job["id"].as_str().unwrap_or_default().to_string();
            crate::state::atomic_json(&crate::jobs::jobs_dir().join(format!("{id}.json")), &job).await?;
        }
    }
    let lock = data().join("runtime.lock");
    if let Ok(text) = tokio::fs::read_to_string(&lock).await {
        if !text.trim().parse::<u32>().is_ok_and(crate::runner::process_alive) {
            let _ = tokio::fs::remove_file(&lock).await;
        }
    }
    Ok(())
}

/// Starts every Naru service and serves until the process ends.
pub async fn run(port: u16) -> Result<()> {
    LazyLock::force(&START);
    recover().await?;
    let app = Arc::new(App {
        port,
        token: hex::encode(rand::random::<[u8; 32]>()),
        remote: load_remote(&data().join("remote.json")),
        kubernetes: Mutex::new(None),
        cache: Mutex::new(HashMap::new()),
        completed_jobs: Mutex::new(String::new()),
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let remote = app.remote.as_ref().map(|r| format!(" | https://{}", r.host)).unwrap_or_default();
    println!("Naru http://127.0.0.1:{port} | {}{remote}", data().display());
    start_docker_bridge();
    start_compat_bridge();
    crate::ports::start_port_forwarding();
    *app.kubernetes.lock().unwrap() = Some(start_kubernetes_bridge(settings().await?.kubernetes.port));
    tokio::spawn(async move {
        if let Err(e) = crate::extensions::serve_isolated(port).await {
            eprintln!("확장 격리 서버: {e}");
        }
    });
    // Containers with a restart policy come back only when the engine starts with the server.
    if settings().await?.auto_start && crate::onboarding::onboarded().await {
        tokio::spawn(async {
            match runtime::status().await {
                Ok(s) if s["managed"] == true && s["installed"] == true && s["running"] != true => {
                    if let Err(e) = submit("startRuntime", &json!({})).await {
                        eprintln!("엔진 자동 시작: {e}");
                    }
                }
                Ok(_) => {}
                Err(e) => eprintln!("엔진 자동 시작: {e}"),
            }
        });
    }
    let service = routes(app).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_parse_long_iso_and_busybox_formats() {
        let out = "total 8\n\
            drwxr-xr-x 2 root root 4096 2026-10-01 10:00 conf d\n\
            -rw-r--r-- 1 root root 12 2026-10-01 10:00 a.txt\n\
            -rw-r--r--    1 root     root            5 Oct  1 10:00 b.txt\n\
            drwxr-xr-x 2 root root 4096 2026-10-01 10:00 .\n";
        let entries = parse_ls(out, "/etc");
        let names: Vec<_> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["conf d", "a.txt", "b.txt"]);
        assert_eq!(entries[0]["path"], "/etc/conf d");
        assert_eq!(entries[1]["size"], 12);
    }

    /// axum checks route conflicts only when the router is built; catch them here, not at startup.
    #[test]
    fn router_builds_without_conflicts() {
        let app = Arc::new(App {
            port: 49170,
            token: "t".into(),
            remote: None,
            kubernetes: Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
            completed_jobs: Mutex::new(String::new()),
        });
        let _ = routes(app);
    }

    #[test]
    fn posix_paths_never_climb_above_root() {
        assert_eq!(normalize_posix("../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize_posix("/a/./b/../c/"), "/a/c");
        assert_eq!(normalize_posix(""), "/");
    }
}
