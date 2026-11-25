//! Resource usage for the diagnostics graphs: this server, the Windows host and each container.
use crate::engine::cli;
use crate::runner::{args, Opts};
use crate::runtime::status;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub fn parse_memory(value: &str) -> Result<f64> {
    static MEMORY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$").unwrap());
    let m = MEMORY.captures(value.trim()).ok_or_else(|| anyhow!("리소스 메모리 형식을 확인해 주세요."))?;
    let unit = m[2].to_lowercase();
    let power = "bkmgt".find(unit.chars().next().unwrap()).unwrap() as i32;
    let base: f64 = if unit.contains('i') { 1024.0 } else { 1000.0 };
    Ok(m[1].parse::<f64>()? * base.powi(power))
}

pub fn parse_container_stats(text: &str) -> Result<Vec<Value>> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            let (id, name, percent, memory) =
                (parts.first().copied(), parts.get(1).copied(), parts.get(2).copied(), parts.get(3).copied());
            let cpu = percent.and_then(|p| p.strip_suffix('%')).and_then(|p| p.parse::<f64>().ok());
            match (id.filter(|s| !s.is_empty()), name.filter(|s| !s.is_empty()), cpu) {
                (Some(id), Some(name), Some(cpu)) if cpu.is_finite() && cpu >= 0.0 => {
                    let used = parse_memory(memory.unwrap_or_default().split('/').next().unwrap_or_default())?;
                    Ok(json!({ "id": id, "name": name, "cpu": cpu, "memory": used }))
                }
                _ => bail!("컨테이너 리소스 형식을 확인해 주세요."),
            }
        })
        .collect()
}

struct Sampler {
    system: System,
    last: Option<Instant>,
}

static SAMPLER: LazyLock<Mutex<Sampler>> = LazyLock::new(|| Mutex::new(Sampler { system: System::new(), last: None }));

pub fn system_sample() -> Value {
    let mut s = SAMPLER.lock().unwrap();
    let pid = Pid::from_u32(std::process::id());
    let first = s.last.is_none();
    s.system.refresh_cpu_usage();
    s.system.refresh_memory();
    s.system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    s.last = Some(Instant::now());
    let process = s.system.process(pid);
    // The first sample has no previous one to compare against, so CPU is unknown until the next call.
    json!({
        "server": {
            "cpu": if first { Value::Null } else { process.map(|p| p.cpu_usage() as f64).into() },
            "memory": process.map(|p| p.memory()).unwrap_or(0),
        },
        "host": {
            "cpu": if first { Value::Null } else { (s.system.global_cpu_usage() as f64).clamp(0.0, 100.0).into() },
            "memory": s.system.used_memory(),
            "limit": s.system.total_memory(),
            "cores": s.system.cpus().len(),
        },
    })
}

struct Cached {
    at: Instant,
    value: Value,
}
static CACHED: LazyLock<tokio::sync::Mutex<Option<Cached>>> = LazyLock::new(Default::default);

/// One sample is shared across clients for two seconds; polling never starts overlapping CLI processes.
pub async fn resource_sample() -> Result<Value> {
    let mut cached = CACHED.lock().await;
    if let Some(c) = cached.as_ref().filter(|c| c.at.elapsed() < Duration::from_secs(2)) {
        return Ok(c.value.clone());
    }
    let (containers, error) = match status().await {
        Ok(state) if state["running"] == true => {
            let format = "{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}";
            match cli(&args(["stats", "--no-stream", "--format", format]), Opts::timeout(12)).await.and_then(|t| parse_container_stats(&t)) {
                Ok(rows) => (Value::Array(rows), Value::Null),
                Err(e) => (Value::Null, e.to_string().into()),
            }
        }
        Ok(_) => (Value::Null, "엔진을 시작하면 컨테이너 사용량을 확인할 수 있습니다.".into()),
        Err(e) => (Value::Null, e.to_string().into()),
    };
    let mut value = system_sample();
    value["timestamp"] = chrono::Utc::now().timestamp_millis().into();
    value["containers"] = containers;
    value["containerError"] = error;
    *cached = Some(Cached { at: Instant::now(), value: value.clone() });
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_units_follow_docker_and_nerdctl() {
        assert_eq!(parse_memory("1.5GiB").unwrap(), 1.5 * 1024f64.powi(3));
        assert_eq!(parse_memory("200MB").unwrap(), 200e6);
        assert_eq!(parse_memory(" 12 kB ").unwrap(), 12e3);
        assert!(parse_memory("12 parsecs").is_err());
        let rows = parse_container_stats("abc\tweb\t1.25%\t10MiB / 1GiB\n").unwrap();
        assert_eq!(rows[0]["cpu"], 1.25);
        assert_eq!(rows[0]["memory"], 10.0 * 1024.0 * 1024.0);
        assert!(parse_container_stats("abc\tweb\tx%\t1MiB").is_err());
    }
}

/// Lines of a job log kept in the report, and how many failed jobs it lists.
const REPORT_JOB_LINES: usize = 40;
const REPORT_JOBS: usize = 10;
const REPORT_LOG_LINES: u32 = 200;

fn report_part(out: &mut String, title: &str, body: Result<String>) {
    out.push_str(&format!("\n===== {title} =====\n"));
    match body {
        Ok(text) => out.push_str(text.trim_end()),
        Err(e) => out.push_str(&format!("(읽지 못했습니다: {e})")),
    }
    out.push('\n');
}

fn last_lines(text: &str, keep: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(keep)..].join("\n")
}

/// The report a person can save from the diagnostics screen and attach to a bug: versions, the system,
/// the engine's state, the data folder check, the last lines of the engine's logs and the recent failed
/// jobs. Everything goes through `redact` before it leaves, and a part that cannot be read says why
/// instead of failing the whole report.
pub async fn report() -> String {
    let mut out = String::new();
    out.push_str("Naru diagnostic report\n");
    out.push_str("민감정보(비밀번호, 토큰, 사용자와 컴퓨터 이름, 이메일, tailnet 주소)는 가렸습니다. 보내기 전에 한 번 확인해 주세요.\n");
    out.push_str(&format!(
        "\ncreated: {}\nnaru: {}\nwindows: {}\n",
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        System::long_os_version().unwrap_or_default()
    ));
    let wsl = crate::runner::run("wsl.exe", &args(["--version"]), Opts::timeout(20)).await.map(|o| o.stdout);
    report_part(&mut out, "WSL", wsl);
    let state = status().await;
    report_part(&mut out, "engine state", state.as_ref().map(|s| serde_json::to_string_pretty(s).unwrap_or_default()).map_err(|e| anyhow!("{e}")));
    let settings = crate::state::settings().await.map(|s| serde_json::to_string_pretty(&s).unwrap_or_default());
    report_part(&mut out, "settings", settings);
    let storage = match crate::storage::check() {
        crate::storage::Storage::Ready => "ready".to_string(),
        crate::storage::Storage::Fresh => "fresh (runtime not installed)".to_string(),
        crate::storage::Storage::Problem(message) => message,
    };
    report_part(&mut out, "data folder", Ok(format!("{}\n{storage}", crate::state::data().display())));
    report_part(&mut out, "WSL distributions", crate::runner::distributions(false).await.map(|d| d.join("\n")));
    let provenance = crate::state::read_json::<Value>(&crate::state::data().join("provenance.json"), Some(Value::Null)).await;
    report_part(&mut out, "runtime provenance", provenance.map(|p| serde_json::to_string_pretty(&p).unwrap_or_default()));
    let running = state.as_ref().is_ok_and(|s| s["running"] == true && s["managed"] == true);
    for name in ["engine", "agent", "kubernetes", "buildkit"] {
        let log = if running {
            crate::runner::wsl_sh(&format!("tail -n {REPORT_LOG_LINES} /var/log/naru/{name}.log 2>/dev/null || true"), Opts::default()).await
        } else {
            Ok("(엔진이 실행 중이 아니라 읽지 않았습니다)".into())
        };
        report_part(&mut out, &format!("{name}.log"), log);
    }
    let jobs = crate::jobs::job_list().await;
    let failed: Vec<Value> = jobs.as_ref().map(|j| j.iter().filter(|j| j["state"] == "failed").take(REPORT_JOBS).cloned().collect()).unwrap_or_default();
    let mut text = String::new();
    for job in &failed {
        let id = job["id"].as_str().unwrap_or_default();
        text.push_str(&format!(
            "\n--- {} {} {}\n{}\n",
            job["createdAt"].as_str().unwrap_or_default(),
            job["type"].as_str().unwrap_or_default(),
            id,
            job["error"].as_str().unwrap_or_default()
        ));
        // The id comes from Naru's own job list; only a plain id names a file.
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            if let Ok(log) = tokio::fs::read_to_string(crate::jobs::jobs_dir().join(format!("{id}.log"))).await {
                text.push_str(&last_lines(&log, REPORT_JOB_LINES));
                text.push('\n');
            }
        }
    }
    report_part(&mut out, &format!("recent failed jobs ({})", failed.len()), jobs.map(|_| text));
    crate::redact::redact(&out, &crate::redact::Personal::current())
}

/// On a PC with Naru installed: `NARU_REPORT_OUT=<file> cargo test -p naru-core real_report -- --ignored`.
#[cfg(test)]
mod real {
    #[tokio::test]
    #[ignore]
    async fn real_report() {
        std::fs::write(std::env::var("NARU_REPORT_OUT").unwrap(), super::report().await).unwrap();
    }
}
