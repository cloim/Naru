//! A stand-in for ssh.exe that measures how Naru uses SSH against a remote engine, without a server.
//! tests/ssh-churn.mjs copies it into a folder named ssh.exe and puts that folder first in PATH.
//!
//! - Every start is appended to FAKE_SSH_LOG as `<epoch ms>\t<pid>\tstart\t<remote command>`, a normal end as `end`.
//! - FAKE_SSH_LOGIN_MS (default 300) delays the start like a real login.
//! - While the file named by FAKE_SSH_FAIL_FILE exists, it fails like a saturated sshd: exit 255 with
//!   `kex_exchange_identification: Connection reset by peer`.
//! - `docker system dial-stdio` answers a few Docker API routes over stdin/stdout with HTTP/1.1 keep-alive;
//!   other commands print canned output.
use std::io::{BufRead, BufReader, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn record(event: &str, remote: &str) {
    if let Some(path) = std::env::var_os("FAKE_SSH_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{}\t{}\t{event}\t{remote}", now_ms(), std::process::id());
        }
    }
}

/// Splits the command line ssh_args builds: each word single-quoted, quotes escaped as '\''.
fn unquote(line: &str) -> Vec<String> {
    let (mut words, mut word, mut quoted, mut any) = (vec![], String::new(), false, false);
    for c in line.chars() {
        match c {
            '\'' => {
                quoted = !quoted;
                any = true;
            }
            ' ' if !quoted => {
                if any {
                    words.push(std::mem::take(&mut word));
                    any = false;
                }
            }
            '\\' if !quoted => {}
            c => {
                word.push(c);
                any = true;
            }
        }
    }
    if any {
        words.push(word);
    }
    words
}

const CONTAINERS: &str = r#"[{"Id":"abc123abc123abc123","Names":["/web"],"Image":"nginx:latest","ImageID":"sha256:1","State":"running","Status":"Up 1 hour","Ports":[],"Mounts":[],"Labels":{"com.docker.compose.project":"demo","com.docker.compose.service":"web","com.docker.compose.project.working_dir":"/srv/demo","com.docker.compose.project.config_files":"/srv/demo/compose.yaml"},"NetworkSettings":{"Networks":{}}}]"#;

fn route(method: &str, path: &str) -> (u16, Vec<u8>) {
    let path = path.split('?').next().unwrap_or_default();
    let path = match path.strip_prefix("/v1.") {
        Some(rest) => &rest[rest.find('/').unwrap_or(0)..],
        None => path,
    };
    let json = |s: &str| (200, s.as_bytes().to_vec());
    match (method, path) {
        (_, "/_ping") => (200, b"OK".to_vec()),
        (_, "/info") => json(r#"{"ID":"fake","Name":"fake-engine","Containers":1,"ServerVersion":"27.0.0"}"#),
        (_, "/version") => json(r#"{"Version":"27.0.0","ApiVersion":"1.46","Components":[{"Name":"Engine"}]}"#),
        (_, "/containers/json") => json(CONTAINERS),
        (_, "/images/json") | (_, "/networks") => json("[]"),
        (_, "/volumes") => json(r#"{"Volumes":[]}"#),
        (_, p) if p.ends_with("/logs") => {
            let text = b"2026-11-25T00:00:00.000000000Z hello from fake engine\n";
            let mut frame = vec![1, 0, 0, 0];
            frame.extend_from_slice(&(text.len() as u32).to_be_bytes());
            frame.extend_from_slice(text);
            (200, frame)
        }
        (_, p) if p.ends_with("/stats") => {
            // stream=false waits for a second sample, as dockerd does.
            std::thread::sleep(Duration::from_millis(1000));
            json(r#"{"read":"2026-11-25T00:00:00Z","cpu_stats":{},"precpu_stats":{},"memory_stats":{}}"#)
        }
        (_, p) if p.starts_with("/containers/") && p.ends_with("/json") => json(r#"{"Id":"abc123abc123abc123","Name":"/web","Config":{"Labels":{}},"State":{"Running":true}}"#),
        _ => (404, br#"{"message":"not found in fake engine"}"#.to_vec()),
    }
}

/// HTTP/1.1 with keep-alive until stdin ends, as `docker system dial-stdio` relays the engine socket.
fn dial_stdio() {
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    loop {
        let mut start = String::new();
        if input.read_line(&mut start).unwrap_or(0) == 0 {
            return;
        }
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if input.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; length];
        if input.read_exact(&mut body).is_err() {
            return;
        }
        let mut parts = start.split_whitespace();
        let (method, path) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        let (status, body) = route(method, path);
        let reason = if status == 200 { "OK" } else { "Not Found" };
        let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len());
        if output.write_all(head.as_bytes()).and_then(|_| output.write_all(&body)).and_then(|_| output.flush()).is_err() {
            return;
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let remote = argv.last().cloned().unwrap_or_default();
    record("start", &remote);
    let login = std::env::var("FAKE_SSH_LOGIN_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    std::thread::sleep(Duration::from_millis(login));
    if std::env::var_os("FAKE_SSH_FAIL_FILE").is_some_and(|f| std::path::Path::new(&f).exists()) {
        eprintln!("kex_exchange_identification: Connection reset by peer");
        record("fail", &remote);
        std::process::exit(255);
    }
    let words = unquote(&remote);
    let word = |i: usize| words.get(i).map(String::as_str).unwrap_or_default();
    let mut out = std::io::stdout().lock();
    match (word(0), word(1)) {
        ("docker", "system") if word(2) == "dial-stdio" => {
            drop(out);
            dial_stdio();
        }
        ("docker", "stats") => {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = writeln!(out, "abc123abc123\tweb\t1.25%\t10MiB / 1GiB");
        }
        ("docker", "logs") => {
            let _ = writeln!(out, "2026-11-25T00:00:00.000000000Z hello from fake engine");
        }
        ("head", _) => {
            let _ = writeln!(out, "services:\n  web:\n    image: nginx:latest");
        }
        ("sh", "-c") => {
            // A batched file check prints one line per file after $0.
            for _ in words.iter().skip(4) {
                let _ = writeln!(out, "1");
            }
        }
        _ => {}
    }
    record("end", &remote);
}
