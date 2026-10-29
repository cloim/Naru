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
