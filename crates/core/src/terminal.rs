//! Container terminals over WebSocket. A short-lived ticket from the API authorizes the socket,
//! because a browser WebSocket cannot carry the API token header.
use crate::context::{target, with_target, Target};
use crate::engine::{docker, encode, engine_stream};
use crate::jobs::IDENTIFIER;
use crate::runner::{args, hidden, kill_tree, wsl, Opts};
use crate::runtime::require_ready;
use crate::state::{settings, DISTRO};
use crate::web::{invalid, ApiResult};
use anyhow::{anyhow, bail, Result};
use axum::extract::ws::{Message, WebSocket};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub struct Ticket {
    id: String,
    target: Target,
    shell: String,
    engine: String,
    connection: String,
    namespace: String,
    expires: Instant,
}

static TICKETS: LazyLock<Mutex<HashMap<String, Ticket>>> = LazyLock::new(Default::default);

/// Issues a ticket valid for 30 seconds; `scheme` is ws or wss depending on how the page was reached.
pub async fn create_ticket(id: &str, body: &Value, host: &str, scheme: &str) -> ApiResult {
    require_ready().await?;
    if !IDENTIFIER.is_match(id) {
        return Err(invalid("컨테이너 id 형식을 확인해 주세요.").into());
    }
    let shell = body["shell"].as_str().unwrap_or("/bin/sh");
    if !["/bin/sh", "/bin/bash", "/bin/ash"].contains(&shell) {
        return Err(invalid("지원하지 않는 셸입니다.").into());
    }
    let cfg = settings().await?;
    let ticket = hex::encode(rand::random::<[u8; 24]>());
    {
        let mut tickets = TICKETS.lock().unwrap();
        tickets.retain(|_, t| t.expires > Instant::now());
        tickets.insert(
            ticket.clone(),
            Ticket {
                id: id.into(),
                target: target(),
                shell: shell.into(),
                engine: cfg.engine.clone(),
                connection: cfg.connection,
                namespace: cfg.namespace,
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
    }
    Ok(Json(json!({ "url": format!("{scheme}://{host}/api/terminal?ticket={ticket}"), "engine": cfg.engine })))
}

/// Takes the ticket out; each one opens one socket.
pub fn redeem(key: &str) -> Option<Ticket> {
    TICKETS.lock().unwrap().remove(key).filter(|t| t.expires > Instant::now())
}

pub async fn serve(socket: WebSocket, ticket: Ticket) {
    let t = ticket.target.clone();
    with_target(t, async move {
        let (mut tx, rx) = socket.split();
        if let Err(e) = start(&mut tx, rx, &ticket).await {
            let _ = tx.send(Message::Text(json!({ "type": "error", "error": e.to_string() }).to_string().into())).await;
        }
        let _ = tx.close().await;
    })
    .await;
}

type Tx = futures_util::stream::SplitSink<WebSocket, Message>;
type Rx = futures_util::stream::SplitStream<WebSocket>;

fn dimension(value: &Value, min: i64, max: i64) -> Result<i64> {
    value.as_i64().filter(|n| (min..=max).contains(n)).ok_or_else(|| anyhow!("터미널 크기를 확인해 주세요."))
}

fn input(data: &Value) -> Result<Vec<u8>> {
    match data["data"].as_str() {
        Some(s) if s.len() <= 65536 => Ok(s.as_bytes().to_vec()),
        _ => bail!("터미널 입력 형식이 잘못되었습니다."),
    }
}

async fn start(tx: &mut Tx, mut rx: Rx, ticket: &Ticket) -> Result<()> {
    require_ready().await?;
    let cfg = settings().await?;
    if cfg.engine != ticket.engine || cfg.connection != ticket.connection {
        bail!("엔진이 변경되었습니다. 터미널에 다시 연결해 주세요.");
    }
    if ticket.engine == "containerd" {
        return containerd(tx, rx, ticket).await;
    }
    let exec = docker(
        "POST",
        &format!("/containers/{}/exec", encode(&ticket.id)),
        Some(&json!({ "AttachStdin": true, "AttachStdout": true, "AttachStderr": true, "Tty": true, "Cmd": [ticket.shell] })),
    )
    .await?;
    let exec_id = exec["Id"].as_str().ok_or_else(|| anyhow!("exec 생성 결과를 확인할 수 없습니다."))?.to_string();
    let stream = engine_stream(&ticket.target)?;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let payload = json!({ "Detach": false, "Tty": true }).to_string();
    let request = format!(
        "POST /exec/{exec_id}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
        payload.len()
    );
    writer.write_all(request.as_bytes()).await?;
    // Read the HTTP response head; whatever follows it is already terminal output.
    let mut header = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    let rest = loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            bail!("터미널 연결이 끊어졌습니다.");
        }
        header.extend_from_slice(&buf[..n]);
        if header.len() > 65536 {
            bail!("터미널 HTTP 응답 헤더가 너무 큽니다.");
        }
        if let Some(end) = header.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&header[..end]).into_owned();
            let status: u16 = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            if status != 101 && status != 200 {
                bail!("터미널 연결 실패: Docker HTTP {status}");
            }
            break header[end + 4..].to_vec();
        }
    };
    tx.send(Message::Text(json!({ "type": "ready" }).to_string().into())).await?;
    if !rest.is_empty() {
        tx.send(Message::Binary(rest.into())).await?;
    }
    let target = ticket.target.clone();
    loop {
        tokio::select! {
            n = reader.read(&mut buf) => match n {
                Ok(0) | Err(_) => return Ok(()),
                Ok(n) => tx.send(Message::Binary(buf[..n].to_vec().into())).await?,
            },
            message = rx.next() => {
                let Some(Ok(message)) = message else { return Ok(()) };
                let Message::Text(text) = message else { continue };
                let data: Value = serde_json::from_str(&text)?;
                match data["type"].as_str() {
                    Some("input") => writer.write_all(&input(&data)?).await?,
                    Some("resize") => {
                        let (cols, rows) = (dimension(&data["cols"], 2, 500)?, dimension(&data["rows"], 1, 250)?);
                        with_target(target.clone(), docker("POST", &format!("/exec/{exec_id}/resize?h={rows}&w={cols}"), None)).await?;
                    }
                    _ => bail!("터미널 메시지 형식이 잘못되었습니다."),
                }
            }
        }
    }
}

async fn containerd(tx: &mut Tx, mut rx: Rx, ticket: &Ticket) -> Result<()> {
    let tty = format!("/run/naru/terminal-{}", hex::encode(rand::random::<[u8; 12]>()));
    let executable = format!(
        "/usr/bin/nerdctl --address /run/naru/containerd.sock --namespace {} exec -it {} {}",
        ticket.namespace, ticket.id, ticket.shell
    );
    let mut child = hidden("wsl.exe")
        .args(args(["-d", DISTRO, "-u", "root", "--exec", "socat", "-", &format!("EXEC:{executable},pty,setsid,ctty,stderr,rawer,link={tty}")]))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let pid = child.id();
    let mut stdout = child.stdout.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    tx.send(Message::Text(json!({ "type": "ready" }).to_string().into())).await?;
    let mut buf = vec![0u8; 16 * 1024];
    let result: Result<()> = async {
        loop {
            tokio::select! {
                n = stdout.read(&mut buf) => match n {
                    Ok(0) | Err(_) => return Ok(()),
                    Ok(n) => tx.send(Message::Binary(buf[..n].to_vec().into())).await?,
                },
                message = rx.next() => {
                    let Some(Ok(message)) = message else { return Ok(()) };
                    let Message::Text(text) = message else { continue };
                    let data: Value = serde_json::from_str(&text)?;
                    match data["type"].as_str() {
                        Some("input") => stdin.write_all(&input(&data)?).await?,
                        Some("resize") => {
                            let (cols, rows) = (dimension(&data["cols"], 2, 500)?, dimension(&data["rows"], 1, 250)?);
                            // socat creates the pty link a moment after start.
                            for attempt in 0..10 {
                                let resized = wsl(&args(["stty", "-F", &tty, "cols", &cols.to_string(), "rows", &rows.to_string()]), Opts::default()).await;
                                if resized.is_ok() { break; }
                                if attempt == 9 { resized?; }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }
                        _ => bail!("터미널 메시지 형식을 확인해 주세요."),
                    }
                }
            }
        }
    }
    .await;
    drop(stdin);
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    let _ = wsl(&args(["rm", "-f", &tty]), Opts::default()).await;
    result
}
