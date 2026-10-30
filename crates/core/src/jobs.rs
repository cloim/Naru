//! Durable jobs: each request is written to disk first, then a detached worker process runs it,
//! so a job keeps going when the server restarts.
use crate::context::{engine_key, remote_target, target};
use crate::runner::{detached, process_alive};
use crate::state::{atomic_json, data, read_json};
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}
pub static IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,511}$"));
static NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"));
pub static PROJECT_NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9][a-z0-9_-]{0,127}$"));
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
});
static REGISTRY: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?|https://index\.docker\.io/v1/)$")
});
static TAR_FILE: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)^[a-zA-Z]:[\\/].+\.tar$"));
static K8S_NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9][a-z0-9.-]{0,252}$"));
static K8S_NAMESPACE: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9][a-z0-9-]{0,62}$"));
static HOST_IP: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:\d{1,3}\.){3}\d{1,3}$"));

/// A strict object reader: every key must be declared, missing optional keys take defaults.
struct Fields {
    map: Map<String, Value>,
    seen: Vec<&'static str>,
}

impl Fields {
    fn new(value: &Value) -> Result<Fields> {
        match value {
            Value::Object(map) => Ok(Fields {
                map: map.clone(),
                seen: vec![],
            }),
            Value::Null => Ok(Fields {
                map: Map::new(),
                seen: vec![],
            }),
            _ => bail!("작업 입력은 객체여야 합니다."),
        }
    }
    fn take(&mut self, key: &'static str) -> Option<Value> {
        self.seen.push(key);
        self.map.get(key).cloned().filter(|v| !v.is_null())
    }
    fn string(&mut self, key: &'static str, pattern: &Regex) -> Result<String> {
        let value = self
            .take(key)
            .ok_or_else(|| anyhow!("{key} 값이 필요합니다."))?;
        let s = value
            .as_str()
            .ok_or_else(|| anyhow!("{key} 값은 문자열이어야 합니다."))?;
        if !pattern.is_match(s) {
            bail!("{key} 형식을 확인해 주세요.");
        }
        Ok(s.to_string())
    }
    fn optional_string(&mut self, key: &'static str, pattern: &Regex) -> Result<Option<String>> {
        if self.map.get(key).is_none_or(Value::is_null) {
            self.seen.push(key);
            return Ok(None);
        }
        self.string(key, pattern).map(Some)
    }
    fn text(&mut self, key: &'static str, min: usize, max: usize) -> Result<String> {
        let value = self
            .take(key)
            .ok_or_else(|| anyhow!("{key} 값이 필요합니다."))?;
        let s = value
            .as_str()
            .ok_or_else(|| anyhow!("{key} 값은 문자열이어야 합니다."))?;
        let len = s.chars().count();
        if len < min || len > max {
            bail!("{key} 길이를 확인해 주세요.");
        }
        Ok(s.to_string())
    }
    fn choice(
        &mut self,
        key: &'static str,
        options: &[&str],
        default: Option<&str>,
    ) -> Result<String> {
        match self.take(key) {
            None => default
                .map(String::from)
                .ok_or_else(|| anyhow!("{key} 값이 필요합니다.")),
            Some(v) => match v.as_str() {
                Some(s) if options.contains(&s) => Ok(s.to_string()),
                _ => bail!("{key} 값을 확인해 주세요."),
            },
        }
    }
    fn literal(&mut self, key: &'static str, expected: &str) -> Result<()> {
        match self.take(key) {
            Some(Value::String(s)) if s == expected => Ok(()),
            _ => bail!("확인 문구를 정확히 입력해 주세요."),
        }
    }
    fn int(&mut self, key: &'static str, min: i64, max: i64, default: Option<i64>) -> Result<i64> {
        match self.take(key) {
            None => default.ok_or_else(|| anyhow!("{key} 값이 필요합니다.")),
            // as_i64 is None for fractions, so only integers pass.
            Some(v) => match v.as_i64() {
                Some(n) if (min..=max).contains(&n) => Ok(n),
                _ => bail!("{key} 값의 범위를 확인해 주세요."),
            },
        }
    }
    fn boolean(&mut self, key: &'static str, default: bool) -> Result<bool> {
        match self.take(key) {
            None => Ok(default),
            Some(Value::Bool(b)) => Ok(b),
            _ => bail!("{key} 값은 참 또는 거짓이어야 합니다."),
        }
    }
    fn array(&mut self, key: &'static str, max: usize) -> Result<Vec<Value>> {
        match self.take(key) {
            None => Ok(vec![]),
            Some(Value::Array(items)) if items.len() <= max => Ok(items),
            _ => bail!("{key} 목록을 확인해 주세요."),
        }
    }
    fn done(self, out: Value) -> Result<Value> {
        if let Some(extra) = self.map.keys().find(|k| !self.seen.contains(&k.as_str())) {
            bail!("알 수 없는 입력 항목: {extra}");
        }
        Ok(out)
    }
}

/// Validates a job request and returns it with defaults filled in.
pub fn validate_job(kind: &str, payload: &Value) -> Result<Value> {
    let mut f = Fields::new(payload)?;
    let out = match kind {
        "installRuntime" | "startRuntime" | "stopRuntime" | "compactDisk" | "startKubernetes"
        | "stopKubernetes" | "installCLI" | "pruneImages" | "pruneVolumes" | "pruneNetworks" => {
            json!({})
        }
        "containerAction" => json!({
            "id": f.string("id", &IDENTIFIER)?,
            "action": f.choice("action", &["start", "stop", "restart", "pause", "unpause", "remove"], None)?,
        }),
        "registryLogin" => json!({
            "server": f.string("server", &REGISTRY)?,
            "username": f.text("username", 1, 256)?,
            "password": f.text("password", 1, 4096)?,
        }),
        "registryLogout" => json!({ "server": f.string("server", &REGISTRY)? }),
        "exportImage" => {
            json!({ "image": f.string("image", &IDENTIFIER)?, "file": f.string("file", &TAR_FILE)? })
        }
        "importImage" => json!({ "file": f.string("file", &TAR_FILE)? }),
        "scanImage" | "pullImage" | "pushImage" => {
            json!({ "image": f.string("image", &IDENTIFIER)? })
        }
        "installExtension" => {
            let image = f.string("image", &IDENTIFIER)?;
            f.literal("confirmation", "TRUST")?;
            json!({ "image": image, "confirmation": "TRUST" })
        }
        "uninstallExtension" => {
            let id = f.string("id", &re(r"^[a-f0-9]{24}$"))?;
            f.literal("confirmation", "REMOVE")?;
            json!({ "id": id, "confirmation": "REMOVE" })
        }
        "pruneResources" => {
            json!({ "all": f.boolean("all", true)?, "volumes": f.boolean("volumes", false)? })
        }
        "createContainer" | "updateContainer" => {
            let id = if kind == "updateContainer" {
                Some(f.string("id", &IDENTIFIER)?)
            } else {
                None
            };
            let image = f.string("image", &IDENTIFIER)?;
            let name = f.optional_string("name", &NAME)?;
            let mut ports = vec![];
            for p in f.array("ports", 20)? {
                let mut pf = Fields::new(&p)?;
                ports.push(pf.done_with(|pf| {
                    let host_ip = pf.optional_string("hostIp", &HOST_IP)?;
                    if host_ip.as_ref().is_some_and(|value| value.split('.').any(|part| part.parse::<u8>().is_err())) {
                        bail!("hostIp 값을 확인해 주세요.");
                    }
                    Ok(json!({
                        "host": pf.int("host", if kind == "updateContainer" { 1 } else { 1024 }, 65535, None)?,
                        "container": pf.int("container", 1, 65535, None)?,
                        "protocol": pf.choice("protocol", &["tcp", "udp"], Some("tcp"))?,
                        "hostIp": host_ip,
                    }))
                })?);
            }
            let env_re = re(r"^[A-Za-z_][A-Za-z0-9_]*=[^\x00\r\n]*$");
            let env = f.array("env", 100)?;
            if env
                .iter()
                .any(|e| e.as_str().is_none_or(|s| !env_re.is_match(s)))
            {
                bail!("환경 변수 형식을 확인해 주세요.");
            }
            let mut mounts = vec![];
            for m in f.array("mounts", 20)? {
                let mut mf = Fields::new(&m)?;
                mounts.push(mf.done_with(|mf| {
                    Ok(json!({
                        "source": mf.text("source", 1, 1024)?,
                        "target": mf.string("target", &re(r"(?s)^/[^\x00]*$"))?,
                        "readOnly": mf.boolean("readOnly", false)?,
                    }))
                })?);
            }
            let command = f.array("command", 100)?;
            if command
                .iter()
                .any(|c| c.as_str().is_none_or(|s| s.chars().count() > 4096))
            {
                bail!("명령 형식을 확인해 주세요.");
            }
            json!({
                "id": id, "image": image, "name": name, "ports": ports, "env": env, "mounts": mounts, "command": command,
                "restart": f.choice("restart", &["no", "unless-stopped", "always", "on-failure"], Some("no"))?,
                "nanoCpus": f.int("nanoCpus", 0, 256_000_000_000, Some(0))?,
                "memory": f.int("memory", 0, 1_125_899_906_842_624, Some(0))?,
            })
        }
        "removeImage" => json!({ "id": f.string("id", &IDENTIFIER)? }),
        "tagImage" => {
            json!({ "id": f.string("id", &IDENTIFIER)?, "target": f.string("target", &IDENTIFIER)? })
        }
        "buildImage" => {
            let context = f.text("context", 1, 2048)?;
            let tag = f.string("tag", &IDENTIFIER)?;
            let dockerfile = f
                .optional_string("dockerfile", &re(r"^[a-zA-Z0-9][a-zA-Z0-9_./-]*$"))?
                .unwrap_or("Dockerfile".into());
            if dockerfile.split('/').any(|p| p == "..") {
                bail!("상위 폴더 참조는 허용되지 않습니다.");
            }
            json!({ "context": context, "tag": tag, "dockerfile": dockerfile })
        }
        "createVolume" | "removeVolume" | "createNetwork" => {
            json!({ "name": f.string("name", &NAME)? })
        }
        "removeNetwork" => json!({ "id": f.string("id", &IDENTIFIER)? }),
        "project" => json!({
            "name": f.string("name", &PROJECT_NAME)?,
            "action": f.choice("action", &["start", "stop", "restart", "up", "down", "pull", "build", "delete"], None)?,
        }),
        "deleteProject" => json!({ "name": f.string("name", &PROJECT_NAME)? }),
        "compose" => json!({
            "name": f.string("name", &PROJECT_NAME)?,
            "yaml": f.text("yaml", 1, 1024 * 1024)?,
            "action": f.choice("action", &["save", "up"], None)?,
        }),
        "kubeApply" => json!({ "yaml": f.text("yaml", 1, 1024 * 1024)? }),
        "kubeDelete" => json!({
            "kind": f.choice("kind", &["pods", "deployments", "services", "configmaps", "persistentvolumeclaims", "namespaces"], None)?,
            "name": f.string("name", &K8S_NAME)?,
            "namespace": f.optional_string("namespace", &K8S_NAMESPACE)?.unwrap_or("default".into()),
        }),
        "snapshot" => {
            let name = f.text("name", 1, 200)?.trim().to_string();
            if name.is_empty() || name.chars().count() > 100 {
                bail!("스냅샷 이름을 확인해 주세요.");
            }
            json!({ "name": name })
        }
        "restoreSnapshot" | "deleteSnapshot" => {
            let id = f.string("id", &UUID)?;
            f.literal(
                "confirmation",
                if kind == "restoreSnapshot" {
                    "RESTORE"
                } else {
                    "DELETE"
                },
            )?;
            json!({ "id": id })
        }
        "createForward" => json!({
            "resource": f.string("resource", &re(r"^(pod|svc|deployment)/[a-z0-9][a-z0-9.-]{0,252}$"))?,
            "namespace": f.optional_string("namespace", &K8S_NAMESPACE)?.unwrap_or("default".into()),
            "localPort": f.int("localPort", 1024, 65535, None)?,
            "remotePort": f.int("remotePort", 1, 65535, None)?,
        }),
        "stopForward" | "removeForward" => json!({ "id": f.string("id", &UUID)? }),
        _ => bail!("지원하지 않는 작업입니다."),
    };
    f.done(out)
}

impl Fields {
    fn done_with(&mut self, build: impl FnOnce(&mut Fields) -> Result<Value>) -> Result<Value> {
        let out = build(self)?;
        let seen = std::mem::take(&mut self.seen);
        Fields {
            map: std::mem::take(&mut self.map),
            seen,
        }
        .done(out)
    }
}

const REMOTE_JOBS: &[&str] = &[
    "containerAction",
    "pullImage",
    "pushImage",
    "removeImage",
    "tagImage",
    "createVolume",
    "removeVolume",
    "createNetwork",
    "removeNetwork",
    "pruneResources",
    "pruneImages",
    "pruneVolumes",
    "pruneNetworks",
    "createContainer",
    "updateContainer",
    "compose",
    "project",
    "deleteProject",
];

pub fn assert_job_target(kind: &str) -> Result<()> {
    if remote_target() && !REMOTE_JOBS.contains(&kind) {
        bail!("로컬 WSL 전용 작업입니다. 로컬 엔진을 선택해 주세요.");
    }
    Ok(())
}

pub fn jobs_dir() -> PathBuf {
    data().join("jobs")
}

pub async fn job_list() -> Result<Vec<Value>> {
    let dir = jobs_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let mut jobs = vec![];
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            if let Ok(job) = read_json::<Value>(&entry.path(), None).await {
                jobs.push(job);
            }
        }
    }
    jobs.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["createdAt"].as_str().unwrap_or(""))
    });
    Ok(jobs)
}

fn active(job: &Value) -> bool {
    matches!(job["state"].as_str(), Some("queued" | "running"))
}

fn millis(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// Finished job records stay for 30 days, at most 200. Logs, input copies and temp files with the same id go too.
// Files without a record may be mid-submission (the input copy is written first), so only those older than an hour go.
const JOB_KEEP_DAYS: i64 = 30;
const JOB_KEEP_COUNT: usize = 200;
const ORPHAN_GRACE: Duration = Duration::from_secs(3600);

pub async fn prune_jobs(now_ms: i64) -> Result<()> {
    let dir = jobs_dir();
    let jobs = job_list().await?;
    let cutoff = now_ms - JOB_KEEP_DAYS * 86_400_000;
    let kept: std::collections::HashSet<String> = jobs
        .iter()
        .enumerate()
        .filter(|(i, job)| {
            active(job)
                || (*i < JOB_KEEP_COUNT
                    && millis(job["createdAt"].as_str().unwrap_or("")) >= cutoff)
        })
        .filter_map(|(_, job)| job["id"].as_str().map(String::from))
        .collect();
    let recorded: std::collections::HashMap<String, &Value> = jobs
        .iter()
        .filter_map(|j| j["id"].as_str().map(|id| (id.to_string(), j)))
        .collect();
    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let file = entry.file_name().to_string_lossy().into_owned();
        let id: String = file.chars().take(36).collect();
        let job = recorded.get(&id);
        let finished = job.is_some_and(|j| !active(j));
        // Even for kept jobs, a finished job's input copy goes. Temp files may be mid-write, so they get a grace period.
        if kept.contains(&id)
            && !(finished && file.ends_with(".input.json.private"))
            && !file.ends_with(".tmp")
        {
            continue;
        }
        if job.is_none() || file.ends_with(".tmp") {
            let modified = entry.metadata().await.ok().and_then(|m| m.modified().ok());
            let young = modified.is_none_or(|m| {
                SystemTime::now().duration_since(m).unwrap_or_default() < ORPHAN_GRACE
            });
            if young {
                continue;
            }
        }
        let _ = tokio::fs::remove_file(entry.path()).await;
    }
    Ok(())
}

pub async fn reconcile_jobs() -> Result<()> {
    for job in job_list().await? {
        if !active(&job) {
            continue;
        }
        if job["state"] == "queued"
            && chrono::Utc::now().timestamp_millis()
                - millis(job["createdAt"].as_str().unwrap_or(""))
                < 30_000
        {
            continue;
        }
        if job["pid"]
            .as_u64()
            .is_some_and(|pid| process_alive(pid as u32))
        {
            continue;
        }
        let id = job["id"].as_str().unwrap_or_default().to_string();
        let file = jobs_dir().join(format!("{id}.json"));
        // The worker may have persisted success between the directory scan and liveness check.
        let latest: Value = read_json(&file, None).await?;
        if !active(&latest) || latest["pid"] != job["pid"] || latest["state"] != job["state"] {
            continue;
        }
        let mut failed = job.clone();
        failed["state"] = "failed".into();
        failed["error"] =
            "작업 프로세스가 종료되었습니다. 로그를 확인하고 다시 실행해 주세요.".into();
        failed["finishedAt"] = now().into();
        atomic_json(&file, &failed).await?;
        let _ = tokio::fs::remove_file(jobs_dir().join(format!("{id}.input.json.private"))).await;
    }
    let lock = data().join("runtime.lock");
    if let Ok(text) = tokio::fs::read_to_string(&lock).await {
        if !text.trim().parse::<u32>().is_ok_and(process_alive) {
            let _ = tokio::fs::remove_file(&lock).await;
        }
    }
    prune_jobs(chrono::Utc::now().timestamp_millis()).await
}

static SUBMITTING: AtomicBool = AtomicBool::new(false);

pub async fn submit(kind: &str, input: &Value) -> Result<Value> {
    let payload = validate_job(kind, input)?;
    assert_job_target(kind)?;
    if SUBMITTING.swap(true, Ordering::SeqCst) {
        bail!("다른 작업을 접수 중입니다.");
    }
    let result = async {
        reconcile_jobs().await?;
        if let Some(running) = job_list().await?.into_iter().find(active) {
            bail!(
                "진행 중인 작업이 있습니다: {}",
                running["type"].as_str().unwrap_or_default()
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = jobs_dir();
        let t = target();
        let job = json!({
            "id": id, "type": kind, "engineId": t.id, "engineScopeId": engine_key(), "target": t,
            "state": "queued", "createdAt": now(),
        });
        atomic_json(&dir.join(format!("{id}.input.json.private")), &payload).await?;
        atomic_json(&dir.join(format!("{id}.json")), &job).await?;
        // Persist first; dispatch independently so the screen receives the durable job id immediately.
        let record = job.clone();
        tokio::spawn(async move {
            let exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let launch = detached(&exe, &["--worker".into(), id.clone()], None).await;
            if let Err(e) = launch {
                let mut failed = record;
                failed["state"] = "failed".into();
                failed["error"] = e.to_string().into();
                failed["finishedAt"] = now().into();
                let _ = atomic_json(&jobs_dir().join(format!("{id}.json")), &failed).await;
            }
        });
        Ok(job)
    }
    .await;
    SUBMITTING.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_inputs_are_strict_and_get_defaults() {
        assert!(validate_job("pullImage", &json!({ "image": "nginx:alpine" })).is_ok());
        assert!(validate_job("pullImage", &json!({ "image": "-bad" })).is_err());
        assert!(validate_job("pullImage", &json!({ "image": "a", "extra": 1 })).is_err());
        assert!(validate_job("nope", &json!({})).is_err());
        assert_eq!(
            validate_job("pruneResources", &json!({})).unwrap(),
            json!({ "all": true, "volumes": false })
        );
        let c = validate_job(
            "createContainer",
            &json!({ "image": "nginx", "ports": [{ "host": 8080, "container": 80 }] }),
        )
        .unwrap();
        assert_eq!(c["ports"][0]["protocol"], "tcp");
        assert_eq!(c["restart"], "no");
        assert!(validate_job(
            "createContainer",
            &json!({ "image": "n", "ports": [{ "host": 80, "container": 80 }] })
        )
        .is_err());
        assert!(validate_job(
            "createContainer",
            &json!({ "image": "n", "ports": [{ "host": 8080, "container": 80, "x": 1 }] })
        )
        .is_err());
        assert!(validate_job(
            "createContainer",
            &json!({ "image": "n", "env": ["BAD KEY=1"] })
        )
        .is_err());
        let update = validate_job(
            "updateContainer",
            &json!({
                "id": "web", "image": "nginx:alpine", "restart": "unless-stopped",
                "nanoCpus": 1_500_000_000_i64, "memory": 536_870_912_i64,
                "ports": [{ "hostIp": "0.0.0.0", "host": 80, "container": 80 }]
            }),
        )
        .unwrap();
        assert_eq!(update["nanoCpus"], 1_500_000_000_i64);
        assert_eq!(update["memory"], 536_870_912_i64);
        assert_eq!(update["ports"][0]["hostIp"], "0.0.0.0");
        assert!(validate_job(
            "updateContainer",
            &json!({ "id": "web", "image": "nginx", "nanoCpus": -1 })
        )
        .is_err());
        assert!(validate_job(
            "buildImage",
            &json!({ "context": "D:\\a", "tag": "t", "dockerfile": "../x" })
        )
        .is_err());
        assert!(validate_job(
            "restoreSnapshot",
            &json!({ "id": "123e4567-e89b-12d3-a456-426614174000", "confirmation": "NO" })
        )
        .is_err());
        assert_eq!(
            validate_job("kubeDelete", &json!({ "kind": "pods", "name": "web" })).unwrap()
                ["namespace"],
            "default"
        );
        assert!(validate_job(
            "exportImage",
            &json!({ "image": "a", "file": "D:\\out\\a.tar" })
        )
        .is_ok());
        assert!(validate_job("exportImage", &json!({ "image": "a", "file": "out.tar" })).is_err());
    }

    #[test]
    fn destructive_jobs_need_exact_confirmation() {
        for (kind, word) in [("restoreSnapshot", "RESTORE"), ("deleteSnapshot", "DELETE")] {
            let id = "123e4567-e89b-12d3-a456-426614174000";
            assert!(validate_job(kind, &json!({ "id": id, "confirmation": word })).is_ok());
            assert!(validate_job(
                kind,
                &json!({ "id": id, "confirmation": word.to_lowercase() })
            )
            .is_err());
        }
    }
}
