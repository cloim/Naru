//! What an image will not start without, read from its own start script before the first run, so the
//! create screen can ask first. Example: postgres stops at once unless POSTGRES_PASSWORD (or
//! POSTGRES_HOST_AUTH_METHOD=trust) is set.
//!
//! The script is copied out of a container that is created and never started, then removed with its
//! anonymous volumes. Only an image already on the engine is read; nothing is pulled for this.
//!
//! Only checks that stop the script count: `${VAR:?message}`, and `if [ -z "$VAR" ]` (or `test -z`,
//! `[[ -z ]]`, joined with `&&`) whose block exits or calls a function that does. Other variables the
//! same condition tests empty, or compares with a value (`[ 'trust' != "$X" ]`), are alternatives. A
//! check that only applies when another variable is set (`-n`), one joined with `||`, and variables the
//! image or the script sets itself do not count. The approach follows Kiri (github.com/libracoder/kiri,
//! Apache-2.0, crates/kiri/src/ui/needs.rs).
use crate::engine::{docker, docker_bytes, encode};
use anyhow::{bail, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Need {
    pub name: String,
    /// Another variable and the value that does instead (`POSTGRES_HOST_AUTH_METHOD`, `trust`).
    pub alternatives: Vec<(String, String)>,
}

/// Scripts larger than this are not read.
const MAX_SCRIPT: usize = 1024 * 1024;

static RE_FUNCTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?\s*$").unwrap());
static RE_EXIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?:^|[\s;&|])exit\s+["']?[1-9]"#).unwrap());
static RE_REQUIRED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([A-Z_][A-Z0-9_]*):\?").unwrap());
// `${NAME:=value}` with a written value: the variable can never be empty. A default taken from another
// variable (`${MARIADB_X:=${MYSQL_X:-}}`, an old name) or an empty one can, so it stays the user's.
// `${NAME:-}` only reads it safely and is not a default at all.
static RE_DEFAULT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([A-Z_][A-Z0-9_]*):?=[^}$]").unwrap());
// `declare -g NAME`, `local NAME`: the script keeps the variable for itself.
static RE_DECLARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:declare|local|readonly|typeset)\s+(?:-\w+\s+)*([A-Z_][A-Z0-9_]*)\b").unwrap());
static RE_IF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:el)?if\s+(.+?)\s*(?:;\s*then)?\s*$").unwrap());
static RE_EMPTY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(?:\[\[?|test)\s+-z\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-)?\}?"?\s*(?:\]\]?)?$"#).unwrap()
});
static RE_SET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^(?:\[\[?|test)\s+-n\s"#).unwrap());
static RE_NOT_EQUAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^(?:\[\[?|test)\s+(?:['"]([^'"$]+)['"]\s+!=\s+"?\$\{?([A-Z_][A-Z0-9_]*)\}?"?|"?\$\{?([A-Z_][A-Z0-9_]*)\}?"?\s+!=\s+['"]([^'"$]+)['"])\s*(?:\]\]?)?$"#,
    )
    .unwrap()
});

fn without_comment(line: &str) -> &str {
    // A `#` that starts a word begins a comment; `$#` and `${#x}` do not.
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'#' && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
            return &line[..i];
        }
    }
    line
}

/// Functions whose body exits with an error, or calls one that does.
fn fatal_functions(lines: &[&str]) -> HashSet<String> {
    let mut bodies: HashMap<String, Vec<&str>> = HashMap::new();
    let mut current: Option<(String, usize)> = None;
    for line in lines {
        let indent = line.len() - line.trim_start().len();
        match &current {
            None => {
                if let Some(m) = RE_FUNCTION.captures(line) {
                    current = Some((m[1].to_string(), indent));
                }
            }
            Some((name, start)) => {
                if line.trim() == "}" && indent <= *start {
                    current = None;
                } else {
                    bodies.entry(name.clone()).or_default().push(line);
                }
            }
        }
    }
    let mut fatal: HashSet<String> =
        bodies.iter().filter(|(_, body)| body.iter().any(|l| RE_EXIT.is_match(without_comment(l)))).map(|(n, _)| n.clone()).collect();
    loop {
        let more: Vec<String> = bodies
            .iter()
            .filter(|(name, body)| !fatal.contains(*name) && body.iter().any(|l| calls_fatal(l, &fatal)))
            .map(|(n, _)| n.clone())
            .collect();
        if more.is_empty() {
            return fatal;
        }
        fatal.extend(more);
    }
}

fn calls_fatal(line: &str, fatal: &HashSet<String>) -> bool {
    let first = without_comment(line).split(|c: char| c.is_whitespace() || c == ';').find(|w| !w.is_empty());
    first.is_some_and(|w| fatal.contains(w))
}

/// The lines of the block that starts after line `start` (an `if`), up to its `elif`, `else` or `fi`.
fn block<'a>(lines: &[&'a str], start: usize) -> Vec<&'a str> {
    let mut depth = 0;
    let mut out = Vec::new();
    let mut i = start + 1;
    // `then` alone on the next line.
    if lines.get(i).is_some_and(|l| l.trim() == "then") {
        i += 1;
    }
    while let Some(line) = lines.get(i) {
        let code = without_comment(line).trim();
        if code.starts_with("if ") {
            depth += 1;
        }
        if depth == 0 && (code == "fi" || code == "else" || code.starts_with("elif ") || code.starts_with("fi;")) {
            break;
        }
        if code == "fi" || code.starts_with("fi;") || code.ends_with("; fi") {
            depth -= 1;
        }
        out.push(*line);
        i += 1;
    }
    out
}

/// For each line, the conditions of the `if` blocks it sits in (not its own). Single-line
/// `if ...; then ...; fi` opens nothing.
fn enclosing(lines: &[&str]) -> Vec<Vec<String>> {
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        out.push(stack.clone());
        let code = without_comment(line).trim();
        if let Some(m) = RE_IF.captures(code).filter(|_| code.starts_with("if ")) {
            let opens = code.ends_with("then") || lines.get(i + 1).is_some_and(|l| l.trim() == "then");
            if opens && !code.contains("; fi") {
                stack.push(m[1].to_string());
            }
        } else if code == "fi" || code.starts_with("fi;") || code.starts_with("fi ") {
            stack.pop();
        }
    }
    out
}

/// The variables a script reads as required, from its text alone.
pub fn script_needs(script: &str) -> Vec<Need> {
    let lines: Vec<&str> = script.lines().collect();
    let fatal = fatal_functions(&lines);
    // Variables the script sets or defaults itself are not the user's to give.
    let mut own: HashSet<String> = HashSet::new();
    for line in &lines {
        let code = without_comment(line);
        // Only declared variables: a plain assignment may happen only in one case (mariadb sets
        // MARIADB_ROOT_PASSWORD itself only when asked for a random one), so it does not make it the script's.
        if let Some(m) = RE_DECLARE.captures(code) {
            own.insert(m[1].to_string());
        }
        for m in RE_DEFAULT.captures_iter(code) {
            own.insert(m[1].to_string());
        }
    }
    let mut needs: Vec<Need> = Vec::new();
    let mut add = |need: Need| {
        if !needs.iter().any(|n| n.name == need.name) {
            needs.push(need);
        }
    };
    for line in &lines {
        for m in RE_REQUIRED.captures_iter(without_comment(line)) {
            if !own.contains(&m[1]) {
                add(Need { name: m[1].to_string(), alternatives: vec![] });
            }
        }
    }
    let outer = enclosing(&lines);
    for (i, line) in lines.iter().enumerate() {
        let Some(m) = RE_IF.captures(without_comment(line)) else { continue };
        // Inside a block that runs only when something is set (`-n`): applies only in that case.
        if outer[i].iter().any(|c| c.split("&&").chain(c.split("||")).any(|p| RE_SET.is_match(p.trim()))) {
            continue;
        }
        let condition = m[1].trim().trim_end_matches(';');
        if condition.contains("||") {
            continue;
        }
        let mut empty: Vec<String> = Vec::new();
        let mut unless: Vec<(String, String)> = Vec::new();
        let mut understood = true;
        for part in condition.split("&&").map(str::trim) {
            if let Some(e) = RE_EMPTY.captures(part) {
                empty.push(e[1].to_string());
            } else if let Some(n) = RE_NOT_EQUAL.captures(part) {
                let (value, name) = match (n.get(1), n.get(2)) {
                    (Some(v), Some(name)) => (v.as_str(), name.as_str()),
                    _ => (&n[4], &n[3]),
                };
                unless.push((name.to_string(), value.to_string()));
            } else {
                // `-n` (applies only when something is set) and anything else: not a plain requirement.
                let _ = RE_SET.is_match(part);
                understood = false;
            }
        }
        if !understood || empty.is_empty() {
            continue;
        }
        let stops = block(&lines, i).iter().any(|l| RE_EXIT.is_match(without_comment(l)) || calls_fatal(l, &fatal));
        if !stops {
            continue;
        }
        let user: Vec<String> = empty.into_iter().filter(|n| n.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') && !own.contains(n)).collect();
        let Some(primary) = user.iter().find(|n| !n.contains("ALLOW_EMPTY") && !n.contains("RANDOM") && !n.ends_with("_HASH") && !n.ends_with("_FILE")) else { continue };
        let mut alternatives: Vec<(String, String)> =
            user.iter().filter(|n| n.contains("ALLOW_EMPTY") || n.contains("RANDOM")).map(|n| (n.clone(), "yes".into())).collect();
        alternatives.extend(unless);
        add(Need { name: primary.clone(), alternatives });
    }
    needs
}

/// Drops what the image's own environment already gives (a value for the variable or an alternative).
pub fn unmet(needs: Vec<Need>, image_env: &[String]) -> Vec<Need> {
    let set = |name: &str| image_env.iter().any(|e| e.strip_prefix(name).and_then(|r| r.strip_prefix('=')).is_some_and(|v| !v.is_empty()));
    needs.into_iter().filter(|n| !set(&n.name) && !n.alternatives.iter().any(|(a, v)| image_env.contains(&format!("{a}={v}")))).collect()
}

/// The first file of a tar archive: its name, type flag, link target and contents.
pub fn first_entry(tar: &[u8]) -> Option<(u8, String, Vec<u8>)> {
    let header = tar.get(..512)?;
    let text = |range: std::ops::Range<usize>| String::from_utf8_lossy(&header[range]).trim_end_matches('\0').trim().to_string();
    let size = usize::from_str_radix(&text(124..136), 8).ok()?;
    let kind = header[156];
    let link = text(157..257);
    let body = tar.get(512..512 + size)?.to_vec();
    Some((kind, link, body))
}

/// The script the image starts with: the entrypoint (or command), past a shell or an init such as tini.
pub fn start_script(entrypoint: &[String], cmd: &[String]) -> Option<String> {
    let all: Vec<&str> = if entrypoint.is_empty() { cmd.iter().map(String::as_str).collect() } else { entrypoint.iter().map(String::as_str).collect() };
    let mut rest = all.as_slice();
    loop {
        let (first, tail) = rest.split_first()?;
        let base = first.rsplit('/').next().unwrap_or(first);
        match base {
            "tini" | "dumb-init" | "docker-init" | "catatonit" => {
                rest = tail.iter().position(|a| *a == "--").map_or(tail, |i| &tail[i + 1..]);
                rest = if rest.first().is_some_and(|a| a.starts_with('-')) { &rest[1..] } else { rest };
            }
            "sh" | "bash" | "dash" | "ash" => {
                // `sh -c '...'` runs inline code, not a script file.
                let next = tail.first()?;
                if next.starts_with('-') {
                    return None;
                }
                return Some(next.to_string());
            }
            _ => return Some(first.to_string()),
        }
    }
}

static CACHE: LazyLock<Mutex<HashMap<String, Vec<Need>>>> = LazyLock::new(Default::default);

/// The variables `image` needs before its first run. `checked` is false when the image is not on the
/// engine yet (nothing is pulled) or its start is not a script.
pub async fn image_needs(image: &str) -> Result<Value> {
    let Ok(inspect) = docker("GET", &format!("/images/{}/json", encode(image)), None).await else {
        return Ok(json!({ "checked": false, "needs": [] }));
    };
    let id = inspect["Id"].as_str().unwrap_or_default().to_string();
    if let Some(needs) = CACHE.lock().unwrap().get(&id).cloned() {
        return Ok(json!({ "checked": true, "needs": needs }));
    }
    let strings = |v: &Value| v.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>();
    let config = &inspect["Config"];
    let env = strings(&config["Env"]);
    let Some(script) = start_script(&strings(&config["Entrypoint"]), &strings(&config["Cmd"])) else {
        return Ok(json!({ "checked": false, "needs": [] }));
    };
    let created = docker("POST", "/containers/create", Some(&json!({ "Image": id, "Labels": { "dev.naru.probe": "needs" } }))).await?;
    let container = created["Id"].as_str().unwrap_or_default().to_string();
    let text = read_script(&container, &script, &env, config["WorkingDir"].as_str().unwrap_or("/")).await;
    let _ = docker("DELETE", &format!("/containers/{container}?force=1&v=1"), None).await;
    let Some(text) = text? else {
        return Ok(json!({ "checked": false, "needs": [] }));
    };
    let needs = unmet(script_needs(&text), &env);
    CACHE.lock().unwrap().insert(id, needs.clone());
    Ok(json!({ "checked": true, "needs": needs }))
}

/// The start script's text, found on the image's PATH when named bare, following symlinks. `None` when
/// it is missing, too large or not a shell script.
async fn read_script(container: &str, script: &str, env: &[String], workdir: &str) -> Result<Option<String>> {
    let candidates: Vec<String> = if script.starts_with('/') {
        vec![script.to_string()]
    } else if script.contains('/') {
        vec![format!("{}/{}", workdir.trim_end_matches('/'), script.trim_start_matches("./"))]
    } else {
        let path = env.iter().find_map(|e| e.strip_prefix("PATH=")).unwrap_or("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        path.split(':').filter(|d| d.starts_with('/')).map(|d| format!("{}/{script}", d.trim_end_matches('/'))).collect()
    };
    for mut path in candidates {
        for _ in 0..5 {
            let route = format!("/containers/{container}/archive?path={}", encode(&path));
            let Ok(tar) = docker_bytes("GET", &route, Duration::from_secs(20)).await else { break };
            let Some((kind, link, body)) = first_entry(&tar) else { break };
            if kind == b'2' && !link.is_empty() {
                path = if link.starts_with('/') { link } else { format!("{}/{link}", path.rsplit_once('/').map_or("", |(d, _)| d)) };
                continue;
            }
            if body.len() > MAX_SCRIPT || !body.starts_with(b"#!") {
                return Ok(None);
            }
            let first = String::from_utf8_lossy(body.split(|b| *b == b'\n').next().unwrap_or_default()).to_string();
            if !["sh", "bash", "dash", "ash"].iter().any(|s| first.contains(s)) {
                return Ok(None);
            }
            return Ok(Some(String::from_utf8_lossy(&body).into_owned()));
        }
    }
    if script.is_empty() {
        bail!("시작 스크립트가 없습니다.");
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Modeled on the official postgres image's docker-entrypoint.sh.
    const POSTGRES: &str = r#"#!/usr/bin/env bash
set -Eeo pipefail
file_env() {
	local var="$1"
	if [ "${!var:-}" ] && [ "${!fileVar:-}" ]; then
		printf >&2 'error: both %s and %s are set (but are exclusive)\n' "$var" "$fileVar"
		exit 1
	fi
}
docker_verify_minimum_env() {
	if [ -z "$POSTGRES_PASSWORD" ] && [ 'trust' != "$POSTGRES_HOST_AUTH_METHOD" ]; then
		# The - option suppresses leading tabs but *not* spaces. :)
		cat >&2 <<-'EOE'
			Error: Database is uninitialized and superuser password is not specified.
		EOE
		exit 1
	fi
	if [ 'trust' = "$POSTGRES_HOST_AUTH_METHOD" ]; then
		echo warning
	fi
}
docker_setup_env() {
	file_env 'POSTGRES_PASSWORD'
	file_env 'POSTGRES_USER' 'postgres'
	declare -g DATABASE_ALREADY_EXISTS
	: "${POSTGRES_HOST_AUTH_METHOD:=}"
}
_main() {
	if [ -z "$DATABASE_ALREADY_EXISTS" ]; then
		docker_verify_minimum_env
	fi
}
"#;

    // Modeled on the official mariadb image's docker-entrypoint.sh.
    const MARIADB: &str = r#"#!/bin/bash
mysql_error() {
	mysql_log ERROR "$@" >&2
	exit 1
}
docker_verify_minimum_env() {
	if [ -z "$MARIADB_ROOT_PASSWORD" ] && [ -z "$MARIADB_ROOT_PASSWORD_HASH" ] && [ -z "$MARIADB_ALLOW_EMPTY_ROOT_PASSWORD" ] && [ -z "$MARIADB_RANDOM_ROOT_PASSWORD" ]; then
		mysql_error $'Database is uninitialized and password option is not specified\n\tYou need to specify one of MARIADB_ROOT_PASSWORD'
	fi
	if [ -n "$MARIADB_PASSWORD" ] && [ -z "$MARIADB_USER" ]; then
		mysql_error 'MARIADB_PASSWORD needs MARIADB_USER'
	fi
	if [ -n "$MARIADB_REPLICATION_USER" ]; then
		if [ -z "$MARIADB_MASTER_HOST" ]; then
			# its a master, we're creating a user
			if [ -z "$MARIADB_REPLICATION_PASSWORD" ] && [ -z "$MARIADB_REPLICATION_PASSWORD_HASH" ]; then
				mysql_error "MARIADB_REPLICATION_PASSWORD or MARIADB_REPLICATION_PASSWORD_HASH not found"
			fi
		else
			if [ -z "$MARIADB_REPLICATION_PASSWORD" ] ; then
				mysql_error "MARIADB_REPLICATION_PASSWORD is mandatory"
			fi
		fi
	fi
}
docker_setup_env() {
	: "${MARIADB_ALLOW_EMPTY_ROOT_PASSWORD:=${MYSQL_ALLOW_EMPTY_PASSWORD:-}}"
	: "${MARIADB_RANDOM_ROOT_PASSWORD:=${MYSQL_RANDOM_ROOT_PASSWORD:-}}"
	: "${MARIADB_MASTER_PORT:=3306}"
	if [ -n "$MARIADB_RANDOM_ROOT_PASSWORD" ]; then
		MARIADB_ROOT_PASSWORD="$(pwgen --numerals -1 32)"
		export MARIADB_ROOT_PASSWORD
	fi
}
"#;

    #[test]
    fn postgres_needs_its_password_or_trust() {
        assert_eq!(
            script_needs(POSTGRES),
            [Need { name: "POSTGRES_PASSWORD".into(), alternatives: vec![("POSTGRES_HOST_AUTH_METHOD".into(), "trust".into())] }]
        );
    }

    #[test]
    fn mariadb_needs_a_root_password_or_an_alternative() {
        let needs = script_needs(MARIADB);
        assert_eq!(needs.len(), 1, "{needs:?}");
        assert_eq!(needs[0].name, "MARIADB_ROOT_PASSWORD");
        assert_eq!(
            needs[0].alternatives,
            [("MARIADB_ALLOW_EMPTY_ROOT_PASSWORD".to_string(), "yes".to_string()), ("MARIADB_RANDOM_ROOT_PASSWORD".to_string(), "yes".to_string())]
        );
    }

    #[test]
    fn required_parameters_count_and_defaults_or_warnings_do_not() {
        let script = "#!/bin/sh\n: \"${API_TOKEN:?API_TOKEN is required}\"\n: \"${PORT:=8080}\"\nif [ -z \"$DEBUG\" ]; then\n  echo off\nfi\nif [ -z \"$LOG_DIR\" ] || [ -z \"$X\" ]; then exit 1; fi\ndeclare -g NAME_SET\nif [ -z \"$NAME_SET\" ]; then\n  exit 1\nfi\n";
        assert_eq!(script_needs(script), [Need { name: "API_TOKEN".into(), alternatives: vec![] }]);
    }

    #[test]
    fn the_image_environment_meets_needs() {
        let needs = script_needs(POSTGRES);
        assert!(unmet(needs.clone(), &["POSTGRES_PASSWORD=x".into()]).is_empty());
        assert!(unmet(needs.clone(), &["POSTGRES_HOST_AUTH_METHOD=trust".into()]).is_empty());
        assert_eq!(unmet(needs, &["POSTGRES_PASSWORD=".into()]).len(), 1);
    }

    #[test]
    fn the_start_script_is_found_past_inits_and_shells() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(start_script(&s(&["docker-entrypoint.sh"]), &s(&["postgres"])).as_deref(), Some("docker-entrypoint.sh"));
        assert_eq!(start_script(&s(&["/sbin/tini", "--", "/entrypoint.sh"]), &[]).as_deref(), Some("/entrypoint.sh"));
        assert_eq!(start_script(&s(&["tini", "-g", "--", "/startup/docker-entrypoint.sh", "neo4j"]), &[]).as_deref(), Some("/startup/docker-entrypoint.sh"));
        assert_eq!(start_script(&s(&["sh", "/run.sh"]), &[]).as_deref(), Some("/run.sh"));
        assert_eq!(start_script(&s(&["/bin/sh", "-c", "echo hi"]), &[]), None);
        assert_eq!(start_script(&[], &s(&["nginx", "-g", "daemon off;"])).as_deref(), Some("nginx"));
        assert_eq!(start_script(&[], &[]), None);
    }

    #[test]
    fn tar_entries_and_links_are_read() {
        let mut tar = vec![0u8; 512];
        tar[..9].copy_from_slice(b"entry.sh\0");
        tar[124..135].copy_from_slice(b"00000000005");
        tar[156] = b'0';
        tar.extend_from_slice(b"#!/sh");
        tar.resize(1024, 0);
        assert_eq!(first_entry(&tar), Some((b'0', String::new(), b"#!/sh".to_vec())));
        let mut link = vec![0u8; 512];
        link[124..135].copy_from_slice(b"00000000000");
        link[156] = b'2';
        link[157..186].copy_from_slice(b"usr/local/bin/entrypoint.sh\0\0");
        assert_eq!(first_entry(&link).map(|(k, l, _)| (k, l)), Some((b'2', "usr/local/bin/entrypoint.sh".to_string())));
        assert_eq!(first_entry(&[0u8; 10]), None);
    }
}


/// On a PC with Naru's engine running:
/// `NARU_IMAGES=postgres:17-alpine,mariadb:11 cargo test -p naru-core real_images -- --ignored --nocapture`.
#[cfg(test)]
mod real {
    #[tokio::test]
    #[ignore]
    async fn real_images() {
        for image in std::env::var("NARU_IMAGES").unwrap().split(',') {
            println!("{image}: {}", super::image_needs(image).await.unwrap());
        }
    }
}
