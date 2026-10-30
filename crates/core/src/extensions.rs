//! Docker Desktop style extensions: OCI images with a UI, an optional VM service and Windows binaries.
//! Each UI runs on its own `<id>.localhost` origin next to the main port, so it cannot reach the Naru API.
use crate::engine::{cli, cli_output, docker, list};
use crate::runner::{args, run, wsl, Log, Opts, Output};
use crate::runtime::require_ready;
use crate::state::{atomic_json, data, read_json, root, settings};
use crate::tools::ensure_compose;
use crate::web::{invalid, ApiResult};
use anyhow::{anyhow, bail, Result};
use axum::body::Body;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

fn directory() -> PathBuf {
    data().join("extensions")
}

/// UI session tokens, each bound to one extension id.
static TOKENS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{24}$").unwrap());

fn safe_asset(p: &str) -> Result<()> {
    if p.is_empty() || p.len() > 1024 || p.contains('\0') || p.replace('\\', "/").split('/').any(|s| s == "..") {
        bail!("확장 파일 경로를 확인해 주세요.");
    }
    Ok(())
}

fn check_id(id: &str) -> Result<()> {
    if !ID.is_match(id) {
        return Err(invalid("확장 id 형식을 확인해 주세요."));
    }
    Ok(())
}

/// The metadata fields Naru reads are validated; anything else in the file is kept as is.
fn validate_metadata(m: &Value) -> Result<()> {
    if !m.is_object() {
        bail!("확장 metadata.json 형식을 확인해 주세요.");
    }
    if let Some(icon) = m.get("icon").filter(|v| !v.is_null()) {
        safe_asset(icon.as_str().unwrap_or_default())?;
    }
    if let Some(tab) = m["ui"].get("dashboard-tab").filter(|v| !v.is_null()) {
        if tab["title"].as_str().is_none_or(|t| t.chars().count() > 200) {
            bail!("확장 UI 제목을 확인해 주세요.");
        }
        safe_asset(tab["root"].as_str().unwrap_or_default())?;
        safe_asset(tab["src"].as_str().unwrap_or_default())?;
        if let Some(socket) = tab["backend"].get("socket").filter(|v| !v.is_null()) {
            safe_asset(socket.as_str().unwrap_or_default())?;
        }
    }
    let vm = &m["vm"];
    if let Some(file) = vm.get("composefile").filter(|v| !v.is_null()) {
        safe_asset(file.as_str().unwrap_or_default())?;
    }
    if let Some(socket) = vm["exposes"].get("socket").filter(|v| !v.is_null()) {
        if !Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(socket.as_str().unwrap_or_default()) {
            bail!("확장 소켓 이름을 확인해 주세요.");
        }
    }
    Ok(())
}

pub async fn extensions() -> Result<Vec<Value>> {
    let dir = directory();
    tokio::fs::create_dir_all(&dir).await?;
    let mut out = vec![];
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await?.is_dir() && ID.is_match(&name) {
            if let Some(ext) = read_json::<Option<Value>>(&entry.path().join("extension.json"), Some(None)).await? {
                out.push(ext);
            }
        }
    }
    Ok(out)
}

fn validate_tree(folder: &Path) -> Result<()> {
    let mut count = 0;
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            count += 1;
            if count > 20000 {
                bail!("확장 UI 파일 수 제한을 초과했습니다.");
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                bail!("확장 UI의 심볼릭 링크는 허용하지 않습니다.");
            }
            if kind.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Ok(())
}

async fn linux_path(windows: &Path) -> Result<String> {
    wsl(&args(["wslpath", "-a", &windows.to_string_lossy()]), Opts::default()).await
}

pub async fn install_extension(image: &str, log: &Log) -> Result<()> {
    require_ready().await?;
    let cfg = settings().await?;
    let id: String = hex::encode(Sha256::digest(image.as_bytes())).chars().take(24).collect();
    let folder = directory().join(&id);
    if folder.join("extension.json").exists() {
        log("이미 설치된 확장입니다.\n");
        return Ok(());
    }
    tokio::fs::create_dir_all(&folder).await?;
    if cli(&args(["image", "inspect", image]), Opts::default()).await.is_err() {
        cli(&args(["pull", image]), Opts::timeout(15 * 60).log(log)).await?;
    }
    let unpack = format!("naru-ext-unpack-{id}");
    let cid = cli(&args(["create", "--name", &unpack, image, "/bin/true"]), Opts::default()).await?.trim().to_string();
    let copy = |source: String, dest: PathBuf| {
        let cid = cid.clone();
        let log = log.clone();
        async move {
            safe_asset(&source)?;
            tokio::fs::create_dir_all(dest.parent().unwrap()).await?;
            cli(&args(["cp", &format!("{cid}:{source}"), &linux_path(&dest).await?]), Opts::timeout(120).log(&log)).await?;
            anyhow::Ok(())
        }
    };
    let result: Result<()> = async {
        copy("/metadata.json".into(), folder.join("metadata.json")).await?;
        let metadata: Value = read_json(&folder.join("metadata.json"), None).await?;
        validate_metadata(&metadata)?;
        let tab = metadata["ui"].get("dashboard-tab").filter(|v| !v.is_null()).cloned();
        if let Some(tab) = &tab {
            let ui = folder.join("ui");
            tokio::fs::create_dir_all(&ui).await?;
            copy(format!("{}/.", tab["root"].as_str().unwrap().trim_end_matches('/')), ui.clone()).await?;
            validate_tree(&ui)?;
            let src = ui.join(tab["src"].as_str().unwrap());
            let canonical_ui = std::fs::canonicalize(&ui)?;
            let canonical = std::fs::canonicalize(&src).map_err(|_| anyhow!("확장 시작 페이지를 찾을 수 없습니다."))?;
            if !canonical.starts_with(&canonical_ui) || canonical == canonical_ui {
                bail!("확장 시작 페이지 경로가 잘못되었습니다.");
            }
        }
        let mut binaries = vec![];
        for entry in metadata["host"]["binaries"].as_array().into_iter().flatten() {
            for binary in entry["windows"].as_array().into_iter().flatten() {
                let path = binary["path"].as_str().unwrap_or_default();
                safe_asset(path)?;
                let name = path.rsplit('/').next().unwrap_or_default().to_string();
                copy(path.to_string(), folder.join("bin").join(&name)).await?;
                binaries.push(name);
            }
        }
        let project = format!("naru-extension-{id}");
        let mut vm_service: Option<String> = None;
        let vm = &metadata["vm"];
        if vm["image"].is_string() || vm["composefile"].is_string() {
            if cfg.engine == "moby" {
                ensure_compose(log).await?;
            }
            let compose_folder = folder.join("compose");
            tokio::fs::create_dir_all(&compose_folder).await?;
            let mut compose: serde_yaml::Value = if let Some(vm_image) = vm["image"].as_str() {
                serde_yaml::to_value(json!({ "services": { "backend": { "image": vm_image.replace("${DESKTOP_PLUGIN_IMAGE}", image) } } }))?
            } else {
                let file = vm["composefile"].as_str().unwrap();
                let parent = file.rsplit_once('/').map_or("", |(p, _)| p);
                copy(format!("{}/.", parent.trim_end_matches('/')), compose_folder.clone()).await?;
                let name = file.rsplit('/').next().unwrap_or(file);
                serde_yaml::from_str(&tokio::fs::read_to_string(compose_folder.join(name)).await?)?
            };
            let services = compose.get_mut("services").and_then(|s| s.as_mapping_mut()).filter(|s| !s.is_empty());
            let Some(services) = services else { bail!("확장 Compose services 정의가 없습니다.") };
            let socket_dir = format!("/var/lib/naru/extensions/{id}/guest-services");
            wsl(&args(["mkdir", "-p", &socket_dir]), Opts::default()).await?;
            for (service, config) in services.iter_mut() {
                let config = config.as_mapping_mut().ok_or_else(|| anyhow!("확장 Compose 서비스 형식 오류"))?;
                if let Some(img) = config.get("image").and_then(|v| v.as_str()).map(|s| s.replace("${DESKTOP_PLUGIN_IMAGE}", image)) {
                    config.insert("image".into(), img.into());
                }
                let mut labels = serde_yaml::Mapping::new();
                match config.get("labels") {
                    Some(serde_yaml::Value::Sequence(list)) => {
                        for item in list.iter().filter_map(|x| x.as_str()) {
                            let (k, v) = item.split_once('=').unwrap_or((item, ""));
                            labels.insert(k.into(), v.into());
                        }
                    }
                    Some(serde_yaml::Value::Mapping(map)) => labels = map.clone(),
                    _ => {}
                }
                labels.insert("io.naru.extension".into(), id.clone().into());
                config.insert("labels".into(), labels.into());
                if vm["exposes"]["socket"].is_string() {
                    let mut volumes: Vec<serde_yaml::Value> = config
                        .get("volumes")
                        .and_then(|v| v.as_sequence())
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|v| match v.as_str() {
                            Some(s) => !s.contains(":/run/guest-services"),
                            None => v.get("target").and_then(|t| t.as_str()) != Some("/run/guest-services"),
                        })
                        .collect();
                    volumes.push(serde_yaml::to_value(json!({ "type": "bind", "source": socket_dir, "target": "/run/guest-services" }))?);
                    config.insert("volumes".into(), volumes.into());
                }
                if vm_service.is_none() {
                    vm_service = service.as_str().map(String::from);
                }
            }
            let file = compose_folder.join("naru-compose.yaml");
            tokio::fs::write(&file, serde_yaml::to_string(&compose)?).await?;
            cli(&args(["compose", "-p", &project, "-f", &linux_path(&file).await?, "up", "-d"]), Opts::timeout(15 * 60).log(log)).await?;
        }
        let title = tab.as_ref().and_then(|t| t["title"].as_str()).unwrap_or(image).to_string();
        let record = json!({
            "id": id, "image": image, "engine": cfg.engine, "title": title, "metadata": metadata,
            "binaries": binaries, "project": project, "vmService": vm_service, "installedAt": crate::jobs::now(),
        });
        atomic_json(&folder.join("extension.json"), &record).await?;
        log("확장 설치 완료. UI는 별도 로컬 출처에서 격리하여 실행합니다.\n");
        Ok(())
    }
    .await;
    if result.is_err() {
        log("확장 설치가 완료되지 않았습니다. 설치 로그와 추출 파일을 보존합니다.\n");
    }
    let _ = cli(&args(["rm", &cid]), Opts::default().log(log)).await;
    result
}

pub async fn uninstall_extension(id: &str, log: &Log) -> Result<()> {
    check_id(id)?;
    let folder = directory().join(id);
    let ext: Value = read_json(&folder.join("extension.json"), None).await?;
    require_ready().await?;
    if settings().await?.engine != ext["engine"].as_str().unwrap_or_default() {
        bail!("확장을 설치한 컨테이너 엔진으로 전환해 주세요.");
    }
    if ext["vmService"].is_string() {
        let file = linux_path(&folder.join("compose").join("naru-compose.yaml")).await?;
        cli(&args(["compose", "-p", ext["project"].as_str().unwrap_or_default(), "-f", &file, "down"]), Opts::timeout(120).log(log)).await?;
    }
    // The exact id directory inside the extension store; user data elsewhere stays.
    if folder.parent() != Some(directory().as_path()) {
        bail!("확장 삭제 경로 오류");
    }
    tokio::fs::remove_dir_all(&folder).await?;
    TOKENS.lock().unwrap().retain(|_, v| v != id);
    log("확장 제거 완료.\n");
    Ok(())
}

/// Runs one of the Windows executables the extension declared and installed into its own bin folder.
async fn run_host(ext: &Value, cmd: &str, rest: &[String], mut opts: Opts) -> Result<Output> {
    let name = Path::new(cmd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let declared = ext["binaries"].as_array().into_iter().flatten().any(|b| b.as_str() == Some(name.as_str()));
    if !declared || cmd.contains("..") {
        bail!("확장이 선언한 호스트 실행파일만 실행할 수 있습니다.");
    }
    let bin = directory().join(ext["id"].as_str().unwrap_or_default()).join("bin");
    opts.cwd = Some(bin.clone());
    run(&bin.join(&name).to_string_lossy(), rest, opts).await
}

/// Main API routes for the extension list and UI sessions.
pub fn routes<S: Clone + Send + Sync + 'static>(port: u16) -> Router<S> {
    Router::new()
        .route("/api/extensions", get(|| async { ApiResult::Ok(Json(Value::Array(extensions().await?))) }))
        .route(
            "/api/extensions/{id}/session",
            post(move |UrlPath(id): UrlPath<String>| async move {
                check_id(&id)?;
                let ext: Value = read_json(&directory().join(&id).join("extension.json"), None).await?;
                let tab = &ext["metadata"]["ui"]["dashboard-tab"];
                let src = tab["src"].as_str().ok_or_else(|| anyhow!("이 확장에는 UI가 없습니다."))?;
                let token = hex::encode(rand::random::<[u8; 32]>());
                TOKENS.lock().unwrap().insert(token.clone(), id.clone());
                ApiResult::Ok(Json(json!({
                    "url": format!("http://{id}.localhost:{}/{src}#naru-token={token}", port + 1),
                    "title": ext["title"],
                })))
            }),
        )
}

#[derive(Clone)]
struct Isolated {
    port: u16,
}

#[derive(Clone)]
struct ExtensionId(String);

async fn isolate(State(s): State<Isolated>, mut req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default().to_string();
    let pattern = Regex::new(&format!(r"^([a-f0-9]{{24}})\.localhost:{}$", s.port + 1)).unwrap();
    let origin_ok = req.headers().get(header::ORIGIN).is_none_or(|o| o.to_str().ok() == Some(&format!("http://{host}")));
    let Some(id) = pattern.captures(&host).map(|m| m[1].to_string()).filter(|_| origin_ok) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    req.extensions_mut().insert(ExtensionId(id));
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    headers.insert("Referrer-Policy", "no-referrer".parse().unwrap());
    response
}

fn bad_request(e: anyhow::Error) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response()
}

async fn sdk() -> Response {
    let built = root().join("dist").join("extension-sdk.js");
    let file = if built.exists() { built } else { root().join("public").join("extension-sdk.js") };
    match tokio::fs::read(file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/javascript")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn asset(axum::Extension(ExtensionId(id)): axum::Extension<ExtensionId>, req: Request) -> Response {
    let base = directory().join(&id).join("ui");
    let requested = req.uri().path().trim_start_matches('/');
    let requested = if requested.is_empty() { "index.html" } else { requested };
    let decoded = percent_encoding::percent_decode_str(requested).decode_utf8_lossy().into_owned();
    if decoded.split(['/', '\\']).any(|s| s == "..") || decoded.contains(':') {
        return StatusCode::FORBIDDEN.into_response();
    }
    let file = base.join(&decoded);
    let Ok(bytes) = tokio::fs::read(&file).await else { return StatusCode::NOT_FOUND.into_response() };
    if decoded.ends_with(".html") {
        let html = String::from_utf8_lossy(&bytes);
        let head = Regex::new(r"(?i)<head[^>]*>").unwrap();
        let injected = head.replace(&html, "$0<script src=\"/sdk.js\"></script>").into_owned();
        return ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], injected).into_response();
    }
    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}

async fn rpc(
    axum::Extension(ExtensionId(origin)): axum::Extension<ExtensionId>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if check_id(&id).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let token = headers.get("x-extension-token").and_then(|t| t.to_str().ok()).unwrap_or_default();
    if TOKENS.lock().unwrap().get(token) != Some(&id) || origin != id {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match rpc_call(&id, body).await {
        Ok(response) => response,
        Err(e) => bad_request(e),
    }
}

async fn rpc_call(id: &str, body: Value) -> Result<Response> {
    let ext: Value = read_json(&directory().join(id).join("extension.json"), None).await?;
    let cfg = settings().await?;
    if ext["engine"].as_str() != Some(cfg.engine.as_str()) {
        bail!("확장을 설치한 엔진으로 전환해 주세요.");
    }
    require_ready().await?;
    let method = body["method"].as_str().ok_or_else(|| anyhow!("method 값이 필요합니다."))?.to_string();
    let rpc_args = match &body["args"] {
        Value::Null => vec![],
        Value::Array(a) => a.clone(),
        _ => bail!("args 값은 배열이어야 합니다."),
    };
    let first = rpc_args.first().cloned().unwrap_or(Value::Null);
    let json_response = |v: Value| Json(v).into_response();
    match method.as_str() {
        "containers" | "images" | "volumes" => {
            let options = if first.is_object() { first } else { json!({}) };
            if cfg.engine == "moby" {
                // The serializer is not Send, so the query is finished before any await.
                let query = {
                let mut params = url::form_urlencoded::Serializer::new(String::new());
                if method == "containers" {
                    params.append_pair("all", if options["all"].as_bool() == Some(true) { "1" } else { "0" });
                    if let Some(limit) = options["limit"].as_u64() {
                        params.append_pair("limit", &limit.to_string());
                    }
                    if options["size"].as_bool() == Some(true) {
                        params.append_pair("size", "1");
                    }
                }
                if method == "images" && options["all"].as_bool() == Some(true) {
                    params.append_pair("all", "1");
                }
                match &options["filters"] {
                    Value::Null => {}
                    Value::String(s) => {
                        params.append_pair("filters", s);
                    }
                    other => {
                        params.append_pair("filters", &other.to_string());
                    }
                }
                params.finish()
                };
                let route = if method == "volumes" { "/volumes".to_string() } else { format!("/{method}/json") };
                let result = docker("GET", &format!("{route}?{query}"), None).await?;
                return Ok(json_response(if method == "volumes" { result["Volumes"].clone() } else { result }));
            }
            let rows = list(&method).await?;
            let rows = if method == "containers" && options["all"].as_bool() != Some(true) {
                Value::Array(rows.as_array().into_iter().flatten().filter(|r| r["State"] == "running").cloned().collect())
            } else {
                rows
            };
            Ok(json_response(rows))
        }
        "dialog" => {
            let options = if first.is_null() { json!({}) } else { first };
            let allowed = [
                "openFile", "openDirectory", "multiSelections", "showHiddenFiles", "createDirectory", "promptToCreate",
                "noResolveAliases", "treatPackageAsDirectory", "dontAddToRecent",
            ];
            let valid = options.as_object().is_some_and(|o| o.keys().all(|k| ["title", "defaultPath", "properties", "filters"].contains(&k.as_str())))
                && options["title"].as_str().is_none_or(|t| t.chars().count() <= 200)
                && options["defaultPath"].as_str().is_none_or(|t| t.chars().count() <= 2048)
                && options["properties"].as_array().is_none_or(|p| p.iter().all(|x| x.as_str().is_some_and(|s| allowed.contains(&s))));
            if !valid {
                bail!("파일 대화상자 옵션을 확인해 주세요.");
            }
            let script = root().join("scripts").join("extension-file-dialog.ps1");
            let output = crate::runner::command(
                "powershell.exe",
                &args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", &script.to_string_lossy()]),
                Opts::timeout(10 * 60).input(options.to_string()),
            )
            .await?;
            Ok(json_response(serde_json::from_str(&output)?))
        }
        "namespaces" => Ok(json_response(if cfg.engine == "moby" {
            json!([])
        } else {
            cli(&args(["namespace", "list", "--quiet"]), Opts::default()).await?.split('\n').map(Value::from).collect()
        })),
        "host" => Ok(json_response(json!({
            "platform": "win32", "arch": std::env::consts::ARCH.replace("x86_64", "x64").replace("aarch64", "arm64"),
            "hostname": std::env::var("COMPUTERNAME").unwrap_or_default(), "image": ext["image"], "id": ext["id"],
        }))),
        "exec" | "exec-stream" => exec(&ext, method == "exec-stream", &rpc_args).await,
        "service" => service(&ext, id, &first).await,
        _ => bail!("지원되지 않은 확장 API: {method}"),
    }
}

async fn exec(ext: &Value, streaming: bool, rpc_args: &[Value]) -> Result<Response> {
    let scope = rpc_args.first().and_then(Value::as_str).filter(|s| ["docker-cli", "host", "container"].contains(s));
    let cmd = rpc_args.get(1).and_then(Value::as_str).filter(|c| !c.is_empty());
    let (Some(scope), Some(cmd)) = (scope, cmd) else { bail!("실행 요청 형식을 확인해 주세요.") };
    let rest: Vec<String> = match rpc_args.get(2) {
        Some(Value::Array(a)) if a.len() <= 500 && a.iter().all(Value::is_string) => {
            a.iter().map(|v| v.as_str().unwrap().to_string()).collect()
        }
        _ => bail!("실행 인자를 확인해 주세요."),
    };
    let options = rpc_args.get(3).cloned().unwrap_or(json!({}));
    let namespace = match options["namespace"].as_str() {
        Some(ns) if Regex::new(r"^[a-zA-Z0-9_.-]{1,64}$").unwrap().is_match(ns) => Some(ns.to_string()),
        Some(_) => bail!("네임스페이스 형식을 확인해 주세요."),
        None => None,
    };
    let env: Vec<(String, String)> = options["env"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect())
        .unwrap_or_default();
    let ext = ext.clone();
    let (scope, cmd) = (scope.to_string(), cmd.to_string());
    let run_it = move |opts: Opts| async move {
        match scope.as_str() {
            "host" => run_host(&ext, &cmd, &rest, Opts { env: env.clone(), ..opts }).await,
            "docker-cli" => {
                let mut all = vec![cmd.clone()];
                all.extend(rest.clone());
                cli_output(&all, opts, namespace.as_deref()).await
            }
            _ => {
                let service = ext["vmService"].as_str().ok_or_else(|| anyhow!("확장의 VM 서비스가 없습니다."))?;
                let id = ext["id"].as_str().unwrap_or_default();
                let file = linux_path(&directory().join(id).join("compose").join("naru-compose.yaml")).await?;
                let mut all = args(["compose", "-p", ext["project"].as_str().unwrap_or_default(), "-f", &file, "exec", "-T"]);
                if let Some(cwd) = options["cwd"].as_str() {
                    all.extend(["-w".into(), cwd.to_string()]);
                }
                for (k, v) in &env {
                    all.extend(["-e".into(), format!("{k}={v}")]);
                }
                all.extend([service.to_string(), cmd.clone()]);
                all.extend(rest.clone());
                cli_output(&all, opts, namespace.as_deref()).await
            }
        }
    };
    if !streaming {
        let out = run_it(Opts::timeout(120)).await?;
        return Ok(Json(json!({ "code": out.code, "stdout": out.stdout, "stderr": out.stderr })).into_response());
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<String, std::io::Error>>();
    let pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let mut opts = Opts::timeout(30 * 60);
    let events = tx.clone();
    opts.on_output = Some(Arc::new(move |is_err, text| {
        let _ = events.send(Ok(json!({ if is_err { "stderr" } else { "stdout" }: text }).to_string() + "\n"));
    }));
    let spawned = pid.clone();
    opts.on_spawn = Some(Arc::new(move |p| spawned.store(p, std::sync::atomic::Ordering::SeqCst)));
    tokio::spawn(async move {
        tokio::select! {
            result = run_it(opts) => {
                let last = match result {
                    Ok(out) => json!({ "code": out.code }),
                    Err(e) => json!({ "error": e.to_string() }),
                };
                let _ = tx.send(Ok(last.to_string() + "\n"));
            }
            // The page left: stop the command instead of letting it run on.
            _ = tx.closed() => {
                let p = pid.load(std::sync::atomic::Ordering::SeqCst);
                if p != 0 { crate::runner::kill_tree(p); }
            }
        }
    });
    let stream = tokio_stream_from(rx);
    Ok(([(header::CONTENT_TYPE, "application/x-ndjson")], Body::from_stream(stream)).into_response())
}

fn tokio_stream_from(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Result<String, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<String, std::io::Error>> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

async fn service(ext: &Value, id: &str, config: &Value) -> Result<Response> {
    let socket = ext["metadata"]["vm"]["exposes"]["socket"].as_str().ok_or_else(|| anyhow!("확장의 Unix 소켓 서비스가 없습니다."))?;
    let method = config["method"].as_str().unwrap_or("GET");
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&method) {
        bail!("HTTP 메서드를 확인해 주세요.");
    }
    let url = config["url"].as_str().filter(|u| u.starts_with('/') && !u.starts_with("//")).ok_or_else(|| anyhow!("서비스 경로를 확인해 주세요."))?;
    let mut a = args([
        "curl", "-sS", "--max-time", "60", "--unix-socket",
        &format!("/var/lib/naru/extensions/{id}/guest-services/{socket}"), "-X", method,
    ]);
    for (key, value) in config["headers"].as_object().into_iter().flatten() {
        let value = value.as_str().map(String::from).unwrap_or_else(|| value.to_string());
        if key.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            bail!("잘못된 HTTP 헤더");
        }
        a.extend(["-H".into(), format!("{key}: {value}")]);
    }
    let mut opts = Opts::timeout(65);
    if let Some(data) = config.get("data").filter(|d| !d.is_null()) {
        a.extend(["--data-binary".into(), "@-".into()]);
        opts.input = Some(data.as_str().map(String::from).unwrap_or_else(|| data.to_string()).into_bytes());
    }
    a.extend(["--write-out".into(), "\n%{http_code}".into(), format!("http://localhost{url}")]);
    let output = wsl(&a, opts).await?;
    let (body, status) = output.rsplit_once('\n').unwrap_or(("", &output));
    let status: u16 = status.trim().parse().unwrap_or(500);
    if status >= 400 {
        return Ok((StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), Json(json!({ "error": body }))).into_response());
    }
    Ok(Json(serde_json::from_str::<Value>(body).unwrap_or_else(|_| Value::String(body.to_string()))).into_response())
}

/// The isolated extension origin on port + 1.
pub async fn serve_isolated(port: u16) -> Result<()> {
    let state = Isolated { port };
    let app = Router::new()
        .route("/sdk.js", get(sdk))
        .route("/rpc/{id}", post(rpc))
        .fallback(asset)
        .layer(axum::middleware::from_fn_with_state(state.clone(), isolate))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port + 1)).await?;
    println!("Extension isolation http://127.0.0.1:{}", port + 1);
    axum::serve(listener, app).await?;
    Ok(())
}
