//! Request admission: Host and Origin checks, the session token and the optional Tailscale remote access.
use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::Path;
use std::sync::LazyLock;

#[derive(Debug, Clone)]
pub struct Remote {
    pub host: String,
    pub users: HashSet<String>,
}

#[derive(Deserialize)]
struct RawRemote {
    #[serde(default)]
    host: serde_json::Value,
    #[serde(default)]
    users: serde_json::Value,
}

/// Remote access is off unless remote.json names the Tailscale serve host and the tailnet logins allowed to use it.
pub fn load_remote(file: &Path) -> Option<Remote> {
    let raw: RawRemote = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9.-]+\.ts\.net(:\d{1,5})?$").unwrap());
    let host = raw.host.as_str().unwrap_or("").trim().to_lowercase();
    let users: HashSet<String> = raw
        .users
        .as_array()
        .map(|list| {
            list.iter()
                .map(|u| u.as_str().map(String::from).unwrap_or_else(|| u.to_string()).trim().to_lowercase())
                .filter(|u| !u.is_empty())
                .collect()
        })
        .unwrap_or_default();
    (HOST.is_match(&host) && !users.is_empty()).then_some(Remote { host, users })
}

pub struct Request<'a> {
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub tailscale_user: Option<&'a str>,
    pub peer: Option<IpAddr>,
}

/// Returns the page scheme for an allowed request, or None. Remote requests must arrive through `tailscale serve`,
/// which connects from loopback and replaces any client-supplied Tailscale-User-Login with the verified tailnet login.
pub fn access(req: &Request, port: u16, remote: Option<&Remote>) -> Option<&'static str> {
    let local_hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if let Some(host) = req.host {
        if local_hosts.iter().any(|h| h == host) {
            let origins = [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")];
            return match req.origin {
                None => Some("http"),
                Some(origin) if origins.iter().any(|o| o == origin) => Some("http"),
                _ => None,
            };
        }
    }
    let remote = remote?;
    let loopback = req.peer.is_some_and(|ip| match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    });
    let host_ok = req.host.is_some_and(|h| h.to_lowercase() == remote.host);
    let user_ok = remote.users.contains(&req.tailscale_user.unwrap_or("").to_lowercase());
    let origin_ok = req.origin.is_none_or(|o| o.to_lowercase() == format!("https://{}", remote.host));
    (host_ok && loopback && user_ok && origin_ok).then_some("https")
}

/// Constant-time comparison so the token cannot be guessed byte by byte from timing.
pub fn token_matches(supplied: &str, expected: &str) -> bool {
    let (a, b) = (supplied.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req<'a>(host: &'a str, origin: Option<&'a str>) -> Request<'a> {
        Request { host: Some(host), origin, tailscale_user: None, peer: Some("127.0.0.1".parse().unwrap()) }
    }

    #[test]
    fn local_requests_need_matching_host_and_origin() {
        assert_eq!(access(&req("127.0.0.1:49170", None), 49170, None), Some("http"));
        assert_eq!(access(&req("localhost:49170", Some("http://localhost:49170")), 49170, None), Some("http"));
        assert_eq!(access(&req("localhost:49170", Some("http://evil.example")), 49170, None), None);
        assert_eq!(access(&req("evil.example", None), 49170, None), None);
    }

    #[test]
    fn remote_requests_need_loopback_host_user_and_origin() {
        let remote = Remote { host: "pc.tail.ts.net:8461".into(), users: ["me@example.com".into()].into() };
        let mut r = req("pc.tail.ts.net:8461", Some("https://pc.tail.ts.net:8461"));
        r.tailscale_user = Some("Me@Example.com");
        assert_eq!(access(&r, 49170, Some(&remote)), Some("https"));
        r.peer = Some("100.64.0.2".parse().unwrap());
        assert_eq!(access(&r, 49170, Some(&remote)), None);
        r.peer = Some("127.0.0.1".parse().unwrap());
        r.tailscale_user = Some("other@example.com");
        assert_eq!(access(&r, 49170, Some(&remote)), None);
    }

    #[test]
    fn token_comparison() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("ab", "abc"));
    }
}
