//! Takes out of logs and reports what must not leave the computer: the home folder's path and the user
//! name in it (in every form Windows, WSL and JSON write it), `Authorization` values, the values of
//! password, secret, token, key and cookie settings (`KEY=value`, `key: value`, JSON, `--flag value`,
//! query strings), passwords in URLs, private keys, JWTs, tokens that say what they are (`ghp_…`,
//! `sk-ant-…`, `xoxb-…`, `AKIA…`, `tskey-…`), e-mail addresses, tailnet host names and the computer's
//! name.
//!
//! Patterns, not parsing: it runs over any text (log lines, JSON, command output), so it errs towards
//! taking out too much. The list of what to take out follows Kiri (github.com/libracoder/kiri,
//! Apache-2.0, crates/kiri/src/diag/redact.rs).
use regex::{Captures, Regex};
use std::sync::LazyLock;

pub const REDACTED: &str = "[REDACTED]";

/// Setting names whose values are secrets.
const SECRET_NAME: &str = r"[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|session[_-]?id|auth)[A-Za-z0-9_.-]*";

static PRIVATE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----").unwrap());
static AUTHORIZATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b(authorization\s*[:=]\s*"?\s*(?:bearer|basic|token|digest)?\s*)[^\s",;]+"#).unwrap());
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap());
static JSON_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#"(?i)("{SECRET_NAME}"\s*:\s*")(?:[^"\\]|\\.)*(")"#)).unwrap());
static ASSIGN_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"(?i)(\b{SECRET_NAME}\s*(?:=|:\s)\s*)("[^"]*"|'[^']*'|[^\s,;&"'}}\]]+)"#)).unwrap()
});
static FLAG_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#"(?i)(--{SECRET_NAME}(?:=|\s+))("[^"]*"|'[^']*'|\S+)"#)).unwrap());
static URL_PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)").unwrap());
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b").unwrap());
static KNOWN_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tskey-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})\b",
    )
    .unwrap()
});
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap());
static TAILNET_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b").unwrap());
// `Users\name` in any spelling: C:\Users\name, C:/Users/name, /mnt/c/Users/name, C:\\Users\\name (JSON).
static USERS_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(\busers(?:\\\\|[\\/]))([^\\/\s:*?<>|]+)").unwrap());

/// Who and which computer the text could name.
#[derive(Default)]
pub struct Personal {
    /// The Windows user name.
    pub user: Option<String>,
    /// The computer's name, which WSL and k3s also take as their host and node name.
    pub host: Option<String>,
}

impl Personal {
    pub fn current() -> Personal {
        Personal { user: current_user(), host: std::env::var("COMPUTERNAME").ok() }
    }
}

/// Replaces `word` wherever it stands alone, in any case. Names of fewer than 3 letters are left, to
/// keep ordinary words.
fn whole_word(text: &str, word: Option<&str>, with: &str) -> String {
    match word.filter(|w| w.chars().count() >= 3) {
        Some(word) => {
            let pattern = Regex::new(&format!("(?i)\\b{}\\b", regex::escape(word))).unwrap();
            pattern.replace_all(text, with).into_owned()
        }
        None => text.to_string(),
    }
}

/// Removes secrets and personal details from `text`. The user and computer names are also taken out
/// where they stand alone (a WSL prompt, a node name, a log line).
pub fn redact(text: &str, personal: &Personal) -> String {
    let mut out = PRIVATE_KEY.replace_all(text, "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----").into_owned();
    out = AUTHORIZATION.replace_all(&out, |c: &Captures| format!("{}{REDACTED}", &c[1])).into_owned();
    out = BEARER.replace_all(&out, |c: &Captures| format!("{}{REDACTED}", &c[1])).into_owned();
    out = JSON_SECRET.replace_all(&out, |c: &Captures| format!("{}{REDACTED}{}", &c[1], &c[2])).into_owned();
    out = FLAG_SECRET.replace_all(&out, |c: &Captures| format!("{}{REDACTED}", &c[1])).into_owned();
    out = ASSIGN_SECRET
        // A value an earlier rule already took out (`--token=[REDACTED]`) stays as it is, and so does the
        // scheme word of an `Authorization` header (its value is out already).
        .replace_all(&out, |c: &Captures| {
            if c[2].starts_with("[REDACTED") || c[1].to_ascii_lowercase().starts_with("authorization") {
                c[0].to_string()
            } else {
                format!("{}{REDACTED}", &c[1])
            }
        })
        .into_owned();
    out = URL_PASSWORD.replace_all(&out, |c: &Captures| format!("{}{REDACTED}{}", &c[1], &c[2])).into_owned();
    out = JWT.replace_all(&out, REDACTED).into_owned();
    out = KNOWN_TOKEN.replace_all(&out, REDACTED).into_owned();
    out = EMAIL.replace_all(&out, "[EMAIL]").into_owned();
    out = TAILNET_HOST.replace_all(&out, "[TAILNET-HOST]").into_owned();
    out = USERS_PATH.replace_all(&out, |c: &Captures| format!("{}[USER]", &c[1])).into_owned();
    out = whole_word(&out, personal.host.as_deref(), "[HOST]");
    whole_word(&out, personal.user.as_deref(), "[USER]")
}

/// The Windows user name, from the environment.
pub fn current_user() -> Option<String> {
    std::env::var("USERNAME").ok().or_else(|| {
        std::env::var("USERPROFILE").ok().and_then(|p| p.rsplit(['\\', '/']).next().map(str::to_string))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(text: &str) -> String {
        redact(text, &Personal { user: Some("cloim".into()), host: Some("HL-DESKTOP".into()) })
    }

    #[test]
    fn home_paths_and_the_user_name() {
        assert_eq!(r(r"open C:\Users\cloim\AppData\Local\Naru\x"), r"open C:\Users\[USER]\AppData\Local\Naru\x");
        assert_eq!(r("C:/Users/cloim/.config"), "C:/Users/[USER]/.config");
        assert_eq!(r("/mnt/c/Users/cloim/.config/Pacific"), "/mnt/c/Users/[USER]/.config/Pacific");
        assert_eq!(r(r#"{"dir":"C:\\Users\\cloim\\x"}"#), r#"{"dir":"C:\\Users\\[USER]\\x"}"#);
        assert_eq!(r(r"\\?\C:\Users\Another.Person\x"), r"\\?\C:\Users\[USER]\x");
        assert_eq!(r("root@cloim-pc:~$ ls"), "root@[USER]-pc:~$ ls");
        // Short names stay, so ordinary words are not taken out.
        assert_eq!(redact("an ok log", &Personal { user: Some("ok".into()), host: None }), "an ok log");
        // The computer's name, as Windows, WSL and k3s write it.
        assert_eq!(r(r#""Name": "HL-DESKTOP","#), r#""Name": "[HOST]","#);
        assert_eq!(r(r#"node="hl-desktop" msg"#), r#"node="[HOST]" msg"#);
    }

    #[test]
    fn settings_that_hold_secrets() {
        assert_eq!(r("POSTGRES_PASSWORD=hunter2 PGDATA=/var/lib"), "POSTGRES_PASSWORD=[REDACTED] PGDATA=/var/lib");
        assert_eq!(r("api_key: abc123def"), "api_key: [REDACTED]");
        assert_eq!(r(r#"{"token":"abc\"def","name":"web"}"#), r#"{"token":"[REDACTED]","name":"web"}"#);
        assert_eq!(r(r#"{"Password": "x y z"}"#), r#"{"Password": "[REDACTED]"}"#);
        assert_eq!(r("ssh --password 's3cret' host"), "ssh --password [REDACTED] host");
        assert_eq!(r("login --token=abc host"), "login --token=[REDACTED] host");
        assert_eq!(r("GET /x?access_token=abc&page=2"), "GET /x?access_token=[REDACTED]&page=2");
        assert_eq!(r("Authorization: Bearer abcdefghijkl"), "Authorization: Bearer [REDACTED]");
        assert_eq!(r(r#"{"auth":"dXNlcjpwYXNz"}"#), r#"{"auth":"[REDACTED]"}"#);
        // Names that only look similar stay.
        assert_eq!(r("PGDATA=/var/lib/postgresql/data"), "PGDATA=/var/lib/postgresql/data");
    }

    #[test]
    fn urls_keys_and_tokens() {
        assert_eq!(r("HTTP_PROXY=http://me:pa55@proxy.corp:8080"), "HTTP_PROXY=http://me:[REDACTED]@proxy.corp:8080");
        assert_eq!(r("postgres://app:pw@db:5432/app"), "postgres://app:[REDACTED]@db:5432/app");
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\nyc2E=\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(r(key), "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----");
        assert_eq!(r("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX2hlcmU done"), "jwt [REDACTED] done");
        for token in ["ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-ant-api03-abcdefghijklmnopqrstuv", "xoxb-1234567890-abcdef", "AKIAABCDEFGHIJKLMNOP", "tskey-auth-abcdef1234567890"] {
            assert_eq!(r(&format!("value {token} end")), "value [REDACTED] end", "{token}");
        }
    }

    #[test]
    fn people_and_machines() {
        assert_eq!(r("by someone@example.com today"), "by [EMAIL] today");
        assert_eq!(r("https://hl-desktop.tailafc36b.ts.net:8461"), "https://[TAILNET-HOST]:8461");
        // Ordinary log text is left alone.
        let line = "2026-11-25 06:28:52 UTC [1] LOG:  database system is ready to accept connections";
        assert_eq!(r(line), line);
    }
}
