//! Windows side of engine networking: listens on localhost for every port naru-agent reports and
//! answers the agent's host.docker.internal requests by connecting to Windows localhost.
use crate::runner::{distro_running, wsl_sh, Opts};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Same ports as naru-boot and naru-agent. The relay connects to a target inside the engine namespace.
const RELAY_PORT: u16 = 29170;
const AGENT_PORT: u16 = 29171;
/// Published ports are bound ONLY to Windows loopback (never 0.0.0.0 or LAN); remote access uses Tailscale.
const WINDOWS_HOSTS: [&str; 2] = ["127.0.0.1", "::1"];
static TARGET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:127\.0\.0\.1|\[::1\]|198\.19\.249\.2):(\d{1,5})$").unwrap());

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Proto {
    Tcp,
    Udp,
}

impl Proto {
    pub fn as_str(self) -> &'static str {
        match self {
            Proto::Tcp => "tcp",
            Proto::Udp => "udp",
        }
    }
}

struct Forward {
    target: String,
    tasks: Vec<JoinHandle<()>>,
    error: Option<String>,
}

#[derive(Default)]
struct State {
    relay: Option<IpAddr>,
    control: Option<mpsc::UnboundedSender<String>>,
    targets: Vec<Value>,
    forwards: HashMap<(u16, Proto), Forward>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

/// The agent's list decides which Windows ports open; anything malformed is dropped.
pub fn valid_targets(items: &Value) -> Vec<(u16, Proto, String)> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let port = item["port"].as_u64().filter(|p| (1..65536).contains(p))? as u16;
            let proto = match item["proto"].as_str() {
                None | Some("tcp") => Proto::Tcp,
                Some("udp") => Proto::Udp,
                _ => return None,
            };
            let target = item["target"].as_str()?;
            let target_port: u32 = TARGET.captures(target)?[1].parse().ok()?;
            (target_port > 0 && target_port < 65536).then(|| (port, proto, target.to_string()))
        })
        .collect()
}

async fn relay_socket(target: &str) -> Option<TcpStream> {
    let host = STATE.lock().unwrap().relay?;
    let mut socket = TcpStream::connect((host, RELAY_PORT)).await.ok()?;
    socket.set_nodelay(true).ok();
    socket.write_all(format!("{target}\n").as_bytes()).await.ok()?;
    Some(socket)
}

async fn join(mut a: TcpStream, mut b: TcpStream) {
    a.set_nodelay(true).ok();
    let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
}

/// Pipes `socket` through the relay. Returns it back when the engine runs without its own namespace,
/// so callers can use their WSL path instead.
pub async fn pipe_relay(socket: TcpStream, target: &str) -> Option<TcpStream> {
    if STATE.lock().unwrap().relay.is_none() {
        return Some(socket);
    }
    match relay_socket(target).await {
        Some(upstream) => {
            tokio::spawn(join(socket, upstream));
            None
        }
        None => Some(socket),
    }
}

fn open_udp_loop(socket: Arc<UdpSocket>, target: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        let sessions: Arc<Mutex<HashMap<SocketAddr, mpsc::Sender<Vec<u8>>>>> = Default::default();
        let mut buf = vec![0u8; 65535];
        while let Ok((n, peer)) = socket.recv_from(&mut buf).await {
            if n == 0 || n > u16::MAX as usize {
                continue;
            }
            let packet = buf[..n].to_vec();
            let existing = sessions.lock().unwrap().get(&peer).cloned();
            if let Some(tx) = existing {
                if tx.try_send(packet.clone()).is_ok() {
                    continue;
                }
            }
            let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
            let _ = tx.try_send(packet);
            sessions.lock().unwrap().insert(peer, tx);
            let socket_reply = socket.clone();
            let target_clone = target.clone();
            let sessions_cleanup = sessions.clone();
            tokio::spawn(async move {
                if let Some(mut upstream) = relay_socket(&AGENT_PORT.to_string()).await {
                    if upstream.write_all(format!("UDP {target_clone}\n").as_bytes()).await.is_ok() {
                        let (mut tcp_read, mut tcp_write) = upstream.into_split();
                        let send_task = tokio::spawn(async move {
                            while let Ok(Some(pkt)) = tokio::time::timeout(Duration::from_secs(60), rx.recv()).await {
                                let len = (pkt.len() as u16).to_be_bytes();
                                if tcp_write.write_all(&len).await.is_err() || tcp_write.write_all(&pkt).await.is_err() {
                                    break;
                                }
                            }
                        });
                        let recv_task = tokio::spawn(async move {
                            let mut len_buf = [0u8; 2];
                            let mut payload = vec![0u8; 65535];
                            loop {
                                if tokio::time::timeout(Duration::from_secs(60), tcp_read.read_exact(&mut len_buf))
                                    .await
                                    .ok()
                                    .and_then(Result::ok)
                                    .is_none()
                                {
                                    break;
                                }
                                let len = u16::from_be_bytes(len_buf) as usize;
                                if len == 0 || tcp_read.read_exact(&mut payload[..len]).await.is_err() {
                                    break;
                                }
                                let _ = socket_reply.send_to(&payload[..len], peer).await;
                            }
                        });
                        tokio::select! {
                            _ = send_task => {}
                            _ = recv_task => {}
                        }
                    }
                }
                sessions_cleanup.lock().unwrap().remove(&peer);
            });
        }
    })
}

fn open(state: &mut State, port: u16, proto: Proto, target: String) {
    let mut forward = Forward { target: target.clone(), tasks: vec![], error: None };
    for host in WINDOWS_HOSTS {
        let target = target.clone();
        match proto {
            Proto::Tcp => {
                // Binding happens synchronously so a conflict is reported on this pass.
                let std_listener = std::net::TcpListener::bind((host, port)).and_then(|l| {
                    l.set_nonblocking(true)?;
                    Ok(l)
                });
                match std_listener.and_then(TcpListener::from_std) {
                    Ok(listener) => forward.tasks.push(tokio::spawn(async move {
                        while let Ok((socket, _)) = listener.accept().await {
                            let target = target.clone();
                            tokio::spawn(async move {
                                if let Some(upstream) = relay_socket(&target).await {
                                    join(socket, upstream).await;
                                }
                            });
                        }
                    })),
                    Err(e) => {
                        let message = format!("{host}:{port}/tcp {}", e.kind());
                        eprintln!("포트 전달 실패: {message}");
                        forward.error = Some(message);
                    }
                }
            }
            Proto::Udp => {
                let std_socket = std::net::UdpSocket::bind((host, port)).and_then(|s| {
                    s.set_nonblocking(true)?;
                    Ok(s)
                });
                match std_socket.and_then(UdpSocket::from_std) {
                    Ok(socket) => forward.tasks.push(open_udp_loop(Arc::new(socket), target)),
                    Err(e) => {
                        let message = format!("{host}:{port}/udp {}", e.kind());
                        eprintln!("포트 전달 실패: {message}");
                        forward.error = Some(message);
                    }
                }
            }
        }
    }
    state.forwards.insert((port, proto), forward);
}

fn close(state: &mut State, key: (u16, Proto)) {
    if let Some(forward) = state.forwards.remove(&key) {
        forward.tasks.iter().for_each(JoinHandle::abort);
    }
}

/// Sends a message to naru-agent over the control channel; false while it is not connected.
pub fn send_control(message: String) -> bool {
    STATE.lock().unwrap().control.as_ref().is_some_and(|c| c.send(message).is_ok())
}

fn close_all(state: &mut State) {
    state.relay = None;
    state.targets.clear();
    for key in state.forwards.keys().copied().collect::<Vec<_>>() {
        close(state, key);
    }
}

fn apply(state: &mut State) {
    let wanted: HashMap<(u16, Proto), String> = valid_targets(&Value::Array(state.targets.clone()))
        .into_iter()
        .map(|(port, proto, target)| ((port, proto), target))
        .collect();
    // Failed listeners are retried on every pass, e.g. after another program releases the port.
    let stale: Vec<(u16, Proto)> = state
        .forwards
        .iter()
        .filter(|(key, f)| wanted.get(key) != Some(&f.target) || f.error.is_some())
        .map(|(key, _)| *key)
        .collect();
    for key in stale {
        close(state, key);
    }
    for ((port, proto), target) in wanted {
        if !state.forwards.contains_key(&(port, proto)) {
            open(state, port, proto, target);
        }
    }
}

/// host.docker.internal: the agent holds a container connection until Windows localhost answers.
async fn open_host(id: String, port: u16) {
    for host in ["127.0.0.1", "::1"] {
        if let Ok(local) = TcpStream::connect((host, port)).await {
            if let Some(mut upstream) = relay_socket(&AGENT_PORT.to_string()).await {
                if upstream.write_all(format!("DATA {id}\n").as_bytes()).await.is_ok() {
                    join(local, upstream).await;
                }
            }
            return;
        }
    }
    let control = STATE.lock().unwrap().control.clone();
    if let Some(control) = control {
        let _ = control.send(json!({ "type": "fail", "id": id }).to_string());
    }
}

fn handle(message: Value) {
    match message["type"].as_str() {
        Some("targets") => {
            let mut state = STATE.lock().unwrap();
            state.targets = message["items"].as_array().cloned().unwrap_or_default();
            apply(&mut state);
        }
        Some("roots") => {
            let roots = message["items"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
            tokio::spawn(crate::fswatch::set_roots(roots));
        }
        Some("open") => {
            static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{32}$").unwrap());
            let id = message["id"].as_str().filter(|id| ID.is_match(id));
            let port = message["port"].as_u64().filter(|p| (1..65536).contains(p));
            if let (Some(id), Some(port)) = (id, port) {
                tokio::spawn(open_host(id.to_string(), port as u16));
            }
        }
        _ => {}
    }
}

/// Opens the control channel and serves it until the agent goes away.
async fn connect() -> anyhow::Result<()> {
    // Check the running list first; any wsl call would boot a stopped distribution.
    if !distro_running().await? {
        close_all(&mut STATE.lock().unwrap());
        return Ok(());
    }
    let host = wsl_sh("cat /run/naru/port-relay 2>/dev/null || true", Opts::default()).await?;
    let Ok(ip) = host.parse::<std::net::Ipv4Addr>() else {
        close_all(&mut STATE.lock().unwrap());
        return Ok(());
    };
    STATE.lock().unwrap().relay = Some(IpAddr::V4(ip));
    let Some(mut socket) = relay_socket(&AGENT_PORT.to_string()).await else { return Ok(()) };
    socket.write_all(b"CONTROL\n").await?;
    let (reader, mut writer) = socket.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    STATE.lock().unwrap().control = Some(tx);
    let writing = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if writer.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(reader).lines();
    // The relay keeps half-open sockets; for the control channel, end of input means the agent is gone.
    while let Ok(Some(line)) = lines.next_line().await {
        match serde_json::from_str(&line) {
            Ok(message) => handle(message),
            Err(e) => eprintln!("포트 전달: {e}"),
        }
    }
    writing.abort();
    STATE.lock().unwrap().control = None;
    // The agent reports its roots again when it comes back.
    crate::fswatch::set_roots(Vec::new()).await;
    Ok(())
}

pub fn start_port_forwarding() {
    tokio::spawn(async {
        let mut last_error = String::new();
        loop {
            match connect().await {
                Ok(()) => last_error.clear(),
                Err(e) if e.to_string() != last_error => {
                    last_error = e.to_string();
                    eprintln!("포트 전달: {last_error}");
                }
                Err(_) => {}
            }
            // The agent restarts with the engine; reconnect soon, or close everything if the engine stopped.
            let connected = STATE.lock().unwrap().control.is_some();
            tokio::time::sleep(Duration::from_secs(if connected { 2 } else { 10 })).await;
            let mut state = STATE.lock().unwrap();
            if state.forwards.values().any(|f| f.error.is_some()) {
                apply(&mut state);
            }
        }
    });
}

pub fn port_forwarding_status() -> Value {
    let state = STATE.lock().unwrap();
    let mut ports: Vec<Value> = state
        .forwards
        .iter()
        .map(|((port, proto), f)| json!({ "port": port, "proto": proto.as_str(), "target": f.target, "error": f.error }))
        .collect();
    ports.sort_by_key(|p| (p["port"].as_u64(), p["proto"].as_str().unwrap_or_default().to_string()));
    json!({ "relay": state.relay.map(|ip| ip.to_string()), "agent": state.control.is_some(), "ports": ports })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_targets_are_validated() {
        let ok = json!([
            { "port": 5432, "target": "127.0.0.1:5432" },
            { "port": 8080, "proto": "tcp", "target": "[::1]:8080" },
            { "port": 5353, "proto": "udp", "target": "127.0.0.1:5353" },
            { "port": 80, "target": "198.19.249.2:80" },
        ]);
        let mut items = ok.as_array().unwrap().clone();
        items.extend(
            json!([
                { "port": 22, "target": "10.0.0.1:22" },
                { "port": 53, "proto": "sctp", "target": "127.0.0.1:53" },
                { "port": 0, "target": "127.0.0.1:1" },
                { "port": 70000, "target": "127.0.0.1:70000" },
                { "port": 9000, "target": "127.0.0.1:0" },
                { "port": "81", "target": "127.0.0.1:81" },
                { "port": 82, "target": "127.0.0.1:82\nDATA x" },
                null,
            ])
            .as_array()
            .unwrap()
            .clone(),
        );
        let valid = valid_targets(&Value::Array(items));
        assert_eq!(
            valid,
            vec![
                (5432, Proto::Tcp, "127.0.0.1:5432".into()),
                (8080, Proto::Tcp, "[::1]:8080".into()),
                (5353, Proto::Udp, "127.0.0.1:5353".into()),
                (80, Proto::Tcp, "198.19.249.2:80".into()),
            ]
        );
        assert!(valid_targets(&Value::Null).is_empty());
    }
}
