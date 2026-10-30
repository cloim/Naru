//! Naru engine agent. naru-boot runs it inside the engine network namespace.
//!
//! - Reports which engine ports Windows should open: Docker published ports, iptables DNAT ports
//!   (nerdctl and Kubernetes hostPort or LoadBalancer), --network host container listeners and
//!   kubectl port-forward listeners.
//! - Serves host.docker.internal: TCP to HOST_IP reaches Windows localhost through the Naru server,
//!   and DNS answers the Docker Desktop host names.
use anyhow::{bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::fd::AsRawFd;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpSocket, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot};

const CONTROL_PORT: u16 = 29171; // The Naru server reaches it through the port relay.
const HOST_PORT: u16 = 29172; // naru-boot redirects TCP for HOST_IP here.
const HOST_IP: Ipv4Addr = Ipv4Addr::new(198, 19, 249, 254);
const ENGINE_IP: &str = "198.19.249.2";
const HOST_NAMES: [&str; 2] = ["host.docker.internal", "gateway.docker.internal"];
const DOCKER_SOCKET: &str = "/run/naru/docker.sock";
const SO_ORIGINAL_DST: libc::c_int = 80;
const UPSTREAM_MARK: u32 = 0x6E61; // naru-boot leaves DNS packets with this mark alone.

type Targets = BTreeMap<u16, String>;

#[derive(Default)]
struct Shared {
    controls: Vec<mpsc::UnboundedSender<String>>,
    pending: HashMap<String, oneshot::Sender<Option<TcpStream>>>,
    targets: Targets,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(Default::default);

// ---------- port discovery ----------

/// Maps socket inode to the relay target for every TCP listener on a wildcard or loopback address.
fn listeners() -> HashMap<String, String> {
    let mut found = HashMap::new();
    for (path, loopback, wildcard, host) in [
        ("/proc/net/tcp", "0100007F", "00000000", "127.0.0.1"),
        ("/proc/net/tcp6", "00000000000000000000000001000000", "00000000000000000000000000000000", "[::1]"),
    ] {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        for row in text.lines().skip(1) {
            let fields: Vec<&str> = row.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port)) = fields[1].split_once(':') else { continue };
            if address != loopback && address != wildcard {
                continue;
            }
            if let Ok(port) = u16::from_str_radix(port, 16) {
                found.insert(fields[9].to_string(), format!("{host}:{port}"));
            }
        }
    }
    found
}

fn owned_listeners(pids: &[String]) -> Vec<String> {
    let sockets = listeners();
    let mut result = vec![];
    for pid in pids {
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                let link = link.to_string_lossy();
                if let Some(inode) = link.strip_prefix("socket:[").and_then(|l| l.strip_suffix(']')) {
                    if let Some(target) = sockets.get(inode) {
                        result.push(target.clone());
                    }
                }
            }
        }
    }
    result
}

/// Pids of --network host containers and kubectl processes. A listening kubectl is a port-forward or
/// proxy; k3s rewrites its argv, so the process name is what identifies it.
fn process_scan(host_containers: &HashSet<String>) -> Vec<String> {
    static CGROUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"docker[-/]([0-9a-f]{64})").unwrap());
    let mut pids = vec![];
    let Ok(entries) = std::fs::read_dir("/proc") else { return pids };
    for entry in entries.flatten() {
        let pid = entry.file_name().to_string_lossy().into_owned();
        if !pid.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if std::fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|c| c.trim() == "kubectl") {
            pids.push(pid);
            continue;
        }
        if host_containers.is_empty() {
            continue;
        }
        if let Ok(cgroup) = std::fs::read_to_string(format!("/proc/{pid}/cgroup")) {
            if CGROUP.captures(&cgroup).is_some_and(|m| host_containers.contains(&m[1])) {
                pids.push(pid);
            }
        }
    }
    pids
}

fn docker_get(route: &str) -> Result<Value> {
    if !std::path::Path::new(DOCKER_SOCKET).exists() {
        return Ok(json!([]));
    }
    let mut s = std::os::unix::net::UnixStream::connect(DOCKER_SOCKET)?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(s, "GET {route} HTTP/1.0\r\nHost: docker\r\n\r\n")?;
    let mut data = vec![];
    s.read_to_end(&mut data)?;
    let split = data.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(data.len());
    let head = String::from_utf8_lossy(&data[..split]);
    if !head.starts_with("HTTP/1.0 200") && !head.starts_with("HTTP/1.1 200") {
        bail!("{}", head.lines().next().unwrap_or_default());
    }
    Ok(serde_json::from_slice(data.get(split + 4..).unwrap_or_default())?)
}

fn k3s_running() -> bool {
    std::fs::read_to_string("/run/naru/k3s.pid")
        .ok()
        .and_then(|p| p.trim().parse::<u32>().ok())
        .is_some_and(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists())
}

/// Published ports implemented only by iptables DNAT, outside Docker's own chains.
fn dnat_ports() -> Targets {
    let Ok(out) = std::process::Command::new("iptables-save").args(["-t", "nat"]).output() else { return Targets::new() };
    parse_dnat(&String::from_utf8_lossy(&out.stdout), k3s_running())
}

fn parse_dnat(text: &str, k3s_running: bool) -> Targets {
    static K3S_CHAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"dnat name: \\"cbr0\\".*-j (CNI-DN-\w+)"#).unwrap());
    static DPORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--dport (\d+)").unwrap());
    static LOOPBACK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-d 127\.0\.0\.1(/32)? ").unwrap());
    // k3s leaves its hostPort rules (CNI network cbr0) behind when it stops; skip them until it runs again.
    let k3s_chains: HashSet<&str> = K3S_CHAIN.captures_iter(text).filter_map(|m| m.get(1)).map(|m| m.as_str()).collect();
    let own = format!("--to-destination {HOST_IP}:");
    let mut found = Targets::new();
    for line in text.lines() {
        if !line.starts_with("-A ") || !line.contains("-j DNAT") || !line.contains(" -p tcp") {
            continue;
        }
        let chain = line.split_whitespace().nth(1).unwrap_or_default();
        if chain.starts_with("DOCKER") || (k3s_chains.contains(chain) && !k3s_running) || line.contains(&own) {
            continue;
        }
        let Some(port) = DPORT.captures(line).and_then(|m| m[1].parse::<u16>().ok()) else { continue };
        let host = if LOOPBACK.is_match(line) { "127.0.0.1" } else { ENGINE_IP };
        found.insert(port, format!("{host}:{port}"));
    }
    found
}

fn discover() -> Result<Targets> {
    let mut found = dnat_ports();
    let mut host_containers = HashSet::new();
    for container in docker_get("/containers/json")?.as_array().into_iter().flatten() {
        if container["HostConfig"]["NetworkMode"] == "host" {
            if let Some(id) = container["Id"].as_str() {
                host_containers.insert(id.to_string());
            }
        }
        for p in container["Ports"].as_array().into_iter().flatten() {
            let Some(port) = p["PublicPort"].as_u64().map(|p| p as u16) else { continue };
            if p["Type"] != "tcp" {
                continue;
            }
            match p["IP"].as_str() {
                Some("0.0.0.0" | "127.0.0.1") => {
                    found.insert(port, format!("127.0.0.1:{port}"));
                }
                Some("::") => {
                    found.entry(port).or_insert(format!("[::1]:{port}"));
                }
                _ => {}
            }
        }
    }
    for target in owned_listeners(&process_scan(&host_containers)) {
        if let Some(port) = target.rsplit(':').next().and_then(|p| p.parse().ok()) {
            found.entry(port).or_insert(target);
        }
    }
    Ok(found)
}

fn targets_message(targets: &Targets) -> String {
    let items: Vec<Value> = targets.iter().map(|(port, target)| json!({ "port": port, "target": target })).collect();
    json!({ "type": "targets", "items": items }).to_string()
}

fn broadcast() {
    let mut shared = SHARED.lock().unwrap();
    let message = targets_message(&shared.targets);
    shared.controls.retain(|c| c.send(message.clone()).is_ok());
}

async fn watch_ports() {
    let mut last_error = String::new();
    loop {
        match tokio::task::spawn_blocking(discover).await {
            Ok(Ok(current)) => {
                last_error.clear();
                let changed = {
                    let mut shared = SHARED.lock().unwrap();
                    let changed = shared.targets != current;
                    shared.targets = current;
                    changed
                };
                if changed {
                    broadcast();
                }
            }
            // The next pass retries; Docker may still be starting.
            Ok(Err(e)) if e.to_string() != last_error => {
                last_error = e.to_string();
                eprintln!("discover: {last_error}");
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

// ---------- control channel ----------

/// The Naru server opens one CONTROL connection, then one DATA connection per host request.
async fn on_control(stream: TcpStream) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut first = String::new();
    reader.read_line(&mut first).await?;
    let words: Vec<&str> = first.split_whitespace().collect();
    match words.as_slice() {
        ["CONTROL"] => {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let message = {
                let mut shared = SHARED.lock().unwrap();
                shared.controls.push(tx);
                targets_message(&shared.targets)
            };
            let (read, mut write) = reader.into_inner().into_split();
            write.write_all(format!("{message}\n").as_bytes()).await?;
            let writer = tokio::spawn(async move {
                while let Some(line) = rx.recv().await {
                    if write.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
                if request["type"] == "fail" {
                    let waiter = request["id"].as_str().and_then(|id| SHARED.lock().unwrap().pending.remove(id));
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(None);
                    }
                }
            }
            writer.abort();
        }
        ["DATA", id] => {
            let waiter = SHARED.lock().unwrap().pending.remove(*id);
            if let Some(waiter) = waiter {
                let _ = waiter.send(Some(reader.into_inner()));
            }
        }
        _ => {}
    }
    Ok(())
}

// ---------- host.docker.internal ----------

fn original_port(stream: &TcpStream) -> Option<u16> {
    let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(stream.as_raw_fd(), libc::SOL_IP, SO_ORIGINAL_DST, &mut addr as *mut _ as *mut libc::c_void, &mut len)
    };
    (rc == 0).then(|| u16::from_be(addr.sin_port))
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Closes with a TCP reset, as a closed port would.
fn reset(stream: TcpStream) {
    // A zero linger makes close send RST at once; it never blocks.
    let linger = libc::linger { l_onoff: 1, l_linger: 0 };
    unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_LINGER,
            &linger as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::linger>() as libc::socklen_t,
        );
    }
    drop(stream);
}

async fn on_host(mut stream: TcpStream) {
    let Some(port) = original_port(&stream) else { return reset(stream) };
    let id = random_id();
    let (tx, rx) = oneshot::channel();
    let control = {
        let mut shared = SHARED.lock().unwrap();
        shared.pending.insert(id.clone(), tx);
        shared.controls.last().cloned()
    };
    let asked = control.is_some_and(|c| c.send(json!({ "type": "open", "id": id, "port": port }).to_string()).is_ok());
    let windows = if asked { tokio::time::timeout(Duration::from_secs(10), rx).await.ok().and_then(Result::ok).flatten() } else { None };
    SHARED.lock().unwrap().pending.remove(&id);
    match windows {
        Some(mut upstream) => {
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        }
        // Nothing listens on Windows: reset like a closed port instead of a silent close.
        None => reset(stream),
    }
}

fn upstream_dns() -> String {
    std::fs::read_to_string("/etc/resolv.conf")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("nameserver"))
        .map(str::trim)
        .find(|ip| *ip != HOST_IP.to_string())
        .unwrap_or("1.1.1.1")
        .to_string()
}

/// Returns (lowercase name, qtype, end of the question section).
fn question(packet: &[u8]) -> Option<(String, u16, usize)> {
    let mut labels = vec![];
    let mut offset = 12;
    loop {
        let length = *packet.get(offset)? as usize;
        if length == 0 {
            break;
        }
        labels.push(String::from_utf8_lossy(packet.get(offset + 1..offset + 1 + length)?).into_owned());
        offset += 1 + length;
    }
    let qtype = u16::from_be_bytes(packet.get(offset + 1..offset + 3)?.try_into().ok()?);
    Some((labels.join(".").to_lowercase(), qtype, offset + 5))
}

fn host_answer(packet: &[u8]) -> Option<Vec<u8>> {
    let (name, qtype, end) = question(packet)?;
    if !HOST_NAMES.contains(&name.as_str()) || packet.len() < end {
        return None;
    }
    let flags = 0x8180 | (u16::from_be_bytes([packet[2], packet[3]]) & 0x0100);
    let answers: u16 = if qtype == 1 { 1 } else { 0 };
    let mut reply = packet[..2].to_vec();
    for value in [flags, 1, answers, 0, 0] {
        reply.extend_from_slice(&value.to_be_bytes());
    }
    reply.extend_from_slice(&packet[12..end]);
    if answers == 1 {
        reply.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
        reply.extend_from_slice(&HOST_IP.octets());
    }
    Some(reply)
}

fn marked_udp() -> Result<UdpSocket> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    set_mark(socket.as_raw_fd())?;
    socket.set_nonblocking(true)?;
    Ok(UdpSocket::from_std(socket)?)
}

fn set_mark(fd: libc::c_int) -> Result<()> {
    let mark = UPSTREAM_MARK;
    let rc = unsafe {
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_MARK, &mark as *const _ as *const libc::c_void, std::mem::size_of::<u32>() as libc::socklen_t)
    };
    if rc != 0 {
        bail!("SO_MARK: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

async fn dns_udp(server: Arc<UdpSocket>) {
    let mut buf = vec![0u8; 65535];
    loop {
        let Ok((n, from)) = server.recv_from(&mut buf).await else { continue };
        let packet = buf[..n].to_vec();
        let server = server.clone();
        tokio::spawn(async move {
            let reply = match host_answer(&packet) {
                Some(reply) => Some(reply),
                None => forward_udp(&packet).await.ok(),
            };
            if let Some(reply) = reply {
                let _ = server.send_to(&reply, from).await;
            }
        });
    }
}

async fn forward_udp(packet: &[u8]) -> Result<Vec<u8>> {
    let socket = marked_udp()?;
    let upstream: SocketAddr = format!("{}:53", upstream_dns()).parse()?;
    socket.send_to(packet, upstream).await?;
    let mut buf = vec![0u8; 65535];
    let (n, _) = tokio::time::timeout(Duration::from_secs(5), socket.recv_from(&mut buf)).await??;
    buf.truncate(n);
    Ok(buf)
}

async fn dns_tcp(mut stream: TcpStream) -> Result<()> {
    let socket = TcpSocket::new_v4()?;
    set_mark(socket.as_raw_fd())?;
    let mut upstream = socket.connect(format!("{}:53", upstream_dns()).parse()?).await?;
    tokio::io::copy_bidirectional(&mut stream, &mut upstream).await?;
    Ok(())
}

async fn accept_loop<F, Fut>(listener: TcpListener, handle: F)
where
    F: Fn(TcpStream) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    loop {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(handle(stream));
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let control = TcpListener::bind(("127.0.0.1", CONTROL_PORT)).await?;
    let host = TcpListener::bind(("0.0.0.0", HOST_PORT)).await?;
    let dns_stream = TcpListener::bind((HOST_IP, 53)).await?;
    let dns = Arc::new(UdpSocket::bind((HOST_IP, 53)).await?);
    println!("naru-agent ready");
    tokio::spawn(accept_loop(control, |s| async move {
        let _ = on_control(s).await;
    }));
    tokio::spawn(accept_loop(host, on_host));
    tokio::spawn(accept_loop(dns_stream, |s| async move {
        let _ = dns_tcp(s).await;
    }));
    tokio::spawn(dns_udp(dns));
    watch_ports().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for part in name.split('.') {
            q.push(part.len() as u8);
            q.extend_from_slice(part.as_bytes());
        }
        q.push(0);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&[0, 1]);
        q
    }

    #[test]
    fn dns_answers_host_names_only() {
        let a = host_answer(&query("Host.Docker.Internal", 1)).unwrap();
        assert_eq!(&a[..2], &[0x12, 0x34]);
        assert_eq!(u16::from_be_bytes([a[6], a[7]]), 1);
        assert_eq!(&a[a.len() - 4..], &[198, 19, 249, 254]);
        let aaaa = host_answer(&query("host.docker.internal", 28)).unwrap();
        assert_eq!(u16::from_be_bytes([aaaa[6], aaaa[7]]), 0);
        assert!(host_answer(&query("github.com", 1)).is_none());
    }

    #[test]
    fn dnat_rules_skip_docker_own_and_stopped_k3s() {
        let rules = r#"-A CNI-DN-abc -p tcp -m tcp --dport 80 -j DNAT --to-destination 10.42.0.22:80
-A CNI-HOSTPORT-DNAT -p tcp -m comment --comment "dnat name: \"cbr0\" id: \"a\"" -m multiport --dports 80 -j CNI-DN-abc
-A CNI-DN-def -d 127.0.0.1/32 -p tcp -m tcp --dport 48081 -j DNAT --to-destination 10.4.0.2:80
-A DOCKER ! -i docker0 -p tcp -m tcp --dport 5432 -j DNAT --to-destination 172.17.0.2:5432
-A PREROUTING -d 10.255.255.254/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination 198.19.249.254:53"#;
        let stopped = parse_dnat(rules, false);
        assert_eq!(stopped.into_iter().collect::<Vec<_>>(), vec![(48081, "127.0.0.1:48081".to_string())]);
        let running = parse_dnat(rules, true);
        assert_eq!(running.get(&80).map(String::as_str), Some("198.19.249.2:80"));
    }
}
