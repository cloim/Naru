//! Serves the Docker named pipes on Windows and the Kubernetes API on localhost.
//! The pipe speaks HTTP to the engine so Windows host paths and proxies can be rewritten;
//! hijacked attach and exec streams pass through untouched.
use crate::context::Target;
use crate::engine::engine_stream;
use crate::paths::{apply, create_rewriter, rewrite_build_url};
use crate::runner::{args, hidden, kill_tree};
use crate::runtime::require_ready;
use crate::state::{container_proxy_config, settings, DISTRO};
use anyhow::Result;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1::SendRequest;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

pub const NARU_PIPE: &str = r"\\.\pipe\naru_engine";
pub const DOCKER_PIPE: &str = r"\\.\pipe\docker_engine";
const BODY_LIMIT: usize = 16 * 1024 * 1024;

type Body = BoxBody<Bytes, hyper::Error>;

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed()
}

fn json_error(status: StatusCode, message: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(full(serde_json::json!({ "message": message }).to_string()))
        .unwrap()
}

/// Idle engine connections shared by all pipe clients. Each one is a wsl.exe process, so reusing them keeps
/// a request's latency low; Compose, for one, races its event subscription against a container's exit.
static IDLE: LazyLock<std::sync::Mutex<Vec<SendRequest<Body>>>> = LazyLock::new(Default::default);
const IDLE_MAX: usize = 4;

async fn upstream_sender() -> Result<SendRequest<Body>> {
    loop {
        let idle = IDLE.lock().unwrap().pop();
        match idle {
            Some(mut sender) if !sender.is_closed() => {
                if sender.ready().await.is_ok() {
                    return Ok(sender);
                }
            }
            Some(_) => continue,
            None => break,
        }
    }
    let stream = engine_stream(&Target::local())?;
    let (sender, conn) = hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    Ok(sender)
}

/// Returns the connection to the pool once its response body has been fully read.
fn release(mut sender: SendRequest<Body>) {
    tokio::spawn(async move {
        if sender.ready().await.is_ok() {
            let mut idle = IDLE.lock().unwrap();
            if idle.len() < IDLE_MAX {
                idle.push(sender);
            }
        }
    });
}

/// Pipe clients connect often; one readiness probe (a wsl.exe call) covers a few seconds of them.
async fn engine_ready() -> bool {
    static LAST_OK: LazyLock<std::sync::Mutex<Option<std::time::Instant>>> = LazyLock::new(Default::default);
    if LAST_OK.lock().unwrap().is_some_and(|at| at.elapsed() < Duration::from_secs(5)) {
        return true;
    }
    let ready = require_ready().await.is_ok();
    *LAST_OK.lock().unwrap() = ready.then(std::time::Instant::now);
    ready
}

async fn proxy_request(mut req: Request<Incoming>) -> Result<Response<Body>, hyper::Error> {
    let method = req.method().as_str().to_string();
    let url = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let rewrite = create_rewriter(&method, &url);
    // Only creates and builds need proxy settings; other calls skip the settings read.
    let proxies = if method == "POST" {
        settings().await.ok().and_then(|cfg| container_proxy_config(&cfg.proxy))
    } else {
        None
    };
    let route = rewrite_build_url(&url, proxies.as_ref());
    let client_upgrade = hyper::upgrade::on(&mut req);
    let (mut parts, body) = req.into_parts();
    parts.uri = match route.parse() {
        Ok(uri) => uri,
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, e.to_string())),
    };
    let body: Body = match rewrite {
        None => body.boxed(),
        Some(kind) => {
            let collected = match http_body_util::Limited::new(body, BODY_LIMIT).collect().await {
                Ok(c) => c.to_bytes(),
                Err(_) => return Ok(json_error(StatusCode::BAD_REQUEST, "Docker 요청 본문이 너무 큽니다.".into())),
            };
            let rewritten = if collected.is_empty() {
                Bytes::new()
            } else {
                match serde_json::from_slice(&collected) {
                    Ok(value) => Bytes::from(apply(kind, value, proxies.as_ref()).to_string()),
                    Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, e.to_string())),
                }
            };
            parts.headers.remove(hyper::header::TRANSFER_ENCODING);
            parts.headers.insert(hyper::header::CONTENT_LENGTH, rewritten.len().into());
            full(rewritten)
        }
    };
    let mut sender = match upstream_sender().await {
        Ok(s) => s,
        Err(e) => return Ok(json_error(StatusCode::BAD_GATEWAY, format!("Naru 엔진 연결 실패: {e}"))),
    };
    let mut response = match sender.send_request(Request::from_parts(parts, body)).await {
        Ok(r) => r,
        Err(e) => return Ok(json_error(StatusCode::BAD_GATEWAY, format!("Naru 엔진 연결 실패: {e}"))),
    };
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        release(sender);
    } else {
        // attach and exec: join both upgraded streams; this engine connection is now a raw stream.
        drop(sender);
        let engine_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            if let (Ok(client), Ok(engine)) = tokio::join!(client_upgrade, engine_upgrade) {
                splice(TokioIo::new(client), TokioIo::new(engine)).await;
            }
        });
    }
    Ok(response.map(BodyExt::boxed))
}

/// Joins a hijacked client stream with the engine. Input ending (exec -i after stdin) only half-closes
/// toward the engine, but when the engine ends the stream everything closes: a named pipe has no
/// half-close, so the client sees the end only when the pipe itself closes.
async fn splice<C, E>(client: C, engine: E)
where
    C: AsyncRead + AsyncWrite + Unpin,
    E: AsyncRead + AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut engine_read, mut engine_write) = tokio::io::split(engine);
    let upload = async {
        let _ = tokio::io::copy(&mut client_read, &mut engine_write).await;
        let _ = engine_write.shutdown().await;
        std::future::pending::<()>().await
    };
    let download = async {
        let _ = tokio::io::copy(&mut engine_read, &mut client_write).await;
        let _ = client_write.shutdown().await;
    };
    tokio::select! {
        _ = upload => {}
        _ = download => {}
    }
}

async fn serve_engine<S>(stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if !engine_ready().await {
        return;
    }
    let service = hyper::service::service_fn(proxy_request);
    // Clients half-close after sending stdin (docker exec -i); the reply must still flow back.
    let _ = hyper::server::conn::http1::Builder::new()
        .half_close(true)
        .keep_alive(true)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

/// Serves a Docker pipe to the engine. Returns an error when another program already owns the pipe.
#[cfg(windows)]
pub async fn serve_pipe(pipe: &'static str) -> Result<()> {
    use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
    // Message mode like dockerd's own pipe: the Docker CLI signals end of stdin (exec -i) with a
    // zero-length message, which only a message-mode pipe delivers.
    let options = || {
        let mut o = ServerOptions::new();
        o.pipe_mode(PipeMode::Message);
        o
    };
    let mut server = options().first_pipe_instance(true).create(pipe)?;
    loop {
        server.connect().await?;
        let client = server;
        server = options().create(pipe)?;
        tokio::spawn(serve_engine(client));
    }
}

pub fn start_docker_bridge() {
    #[cfg(windows)]
    tokio::spawn(async {
        if let Err(e) = serve_pipe(NARU_PIPE).await {
            eprintln!("Docker named pipe bridge ({NARU_PIPE}): {e}");
        }
    });
}

/// Serves the default Windows docker_engine pipe whenever no other engine holds it.
pub fn start_compat_bridge() {
    #[cfg(windows)]
    tokio::spawn(async {
        loop {
            let _ = serve_pipe(DOCKER_PIPE).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

pub struct KubernetesBridge {
    task: tokio::task::JoinHandle<()>,
}

impl KubernetesBridge {
    pub fn stop(self) {
        self.task.abort();
    }
}

/// The Kubernetes API on 127.0.0.1:port. The relay is a plain TCP hop; the fallback spawns wsl.exe per connection.
pub fn start_kubernetes_bridge(port: u16) -> KubernetesBridge {
    let task = tokio::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Kubernetes localhost bridge ({port}): {e}");
                return;
            }
        };
        let mut sockets = tokio::task::JoinSet::new();
        while let Ok((socket, _)) = listener.accept().await {
            sockets.spawn(async move {
                let socket = match crate::ports::pipe_relay(socket, &port.to_string()).await {
                    None => return,
                    Some(socket) => socket,
                };
                if require_ready().await.is_err() {
                    return;
                }
                let child = hidden("wsl.exe")
                    .args(args(["-d", DISTRO, "-u", "root", "--exec", "socat", "-", &format!("TCP:127.0.0.1:{port}")]))
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn();
                let Ok(mut child) = child else { return };
                let pid = child.id();
                let mut stdio = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
                let mut socket = socket;
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stdio).await;
                if let Some(pid) = pid {
                    kill_tree(pid);
                }
            });
        }
    });
    KubernetesBridge { task }
}
