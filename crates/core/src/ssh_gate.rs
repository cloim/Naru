//! Every SSH login to a remote engine passes a gate, one per physical endpoint (host, user, port, key).
//! The gate counts logins, bounds how many short commands run at once, and after connection failures
//! holds new logins back with exponential backoff, so a saturated sshd is not hammered with retries.
//! Windows OpenSSH has no ControlMaster, so each ssh.exe process is one full login.
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

/// Short ssh commands (docker CLI, file checks) running at once per endpoint; more wait their turn.
pub const COMMANDS_PER_ENDPOINT: usize = 3;
const BACKOFF_BASE: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// Logins in one minute above this are logged once a minute: normal use stays far below.
const WARN_PER_MINUTE: usize = 12;
const WINDOW: Duration = Duration::from_secs(60);

/// The delay before the next login after `failures` consecutive connection failures, scaled by `jitter`
/// in [0, 1] into the upper half so that clients that failed together do not come back together.
pub fn backoff(failures: u32, jitter: f64) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let full = BACKOFF_BASE.saturating_mul(1 << (failures - 1).min(16)).min(BACKOFF_MAX);
    full.mul_f64(0.5 + 0.5 * jitter.clamp(0.0, 1.0))
}

#[derive(Default)]
struct Counters {
    started: u64,
    live: usize,
    peak: usize,
    recent: VecDeque<Instant>,
    failures: u32,
    blocked_until: Option<Instant>,
    last_error: String,
    warned_at: Option<Instant>,
}

impl Counters {
    fn trim(&mut self, now: Instant) {
        while self.recent.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            self.recent.pop_front();
        }
    }
}

pub struct Endpoint {
    label: String,
    commands: Arc<Semaphore>,
    state: Mutex<Counters>,
}

static ENDPOINTS: LazyLock<Mutex<HashMap<String, Arc<Endpoint>>>> = LazyLock::new(Default::default);

/// The gate for one endpoint key; `label` names it in logs and diagnostics.
pub fn endpoint(key: &str, label: &str) -> Arc<Endpoint> {
    ENDPOINTS
        .lock()
        .unwrap()
        .entry(key.to_string())
        .or_insert_with(|| {
            Arc::new(Endpoint { label: label.to_string(), commands: Arc::new(Semaphore::new(COMMANDS_PER_ENDPOINT)), state: Mutex::default() })
        })
        .clone()
}

/// Forgets failures everywhere, e.g. after a profile changed: the user expects the next try to run.
pub fn reset_backoff() {
    for gate in ENDPOINTS.lock().unwrap().values() {
        let mut s = gate.state.lock().unwrap();
        s.failures = 0;
        s.blocked_until = None;
    }
}

/// Login counters for every endpoint, for diagnostics.
pub fn snapshot() -> Value {
    let gates: Vec<Arc<Endpoint>> = ENDPOINTS.lock().unwrap().values().cloned().collect();
    Value::Array(gates.iter().map(|g| g.snapshot()).collect())
}

/// One running ssh.exe process; dropping it marks the process gone.
pub struct Login(Arc<Endpoint>);

impl Drop for Login {
    fn drop(&mut self) {
        let mut s = self.0.state.lock().unwrap();
        s.live = s.live.saturating_sub(1);
    }
}

impl Endpoint {
    /// Refuses a new login while backing off after failures.
    pub fn admit(&self) -> Result<()> {
        let now = Instant::now();
        let s = self.state.lock().unwrap();
        match s.blocked_until {
            Some(until) if until > now => {
                let wait = (until - now).as_secs_f64().ceil() as u64;
                Err(anyhow!(
                    "원격 엔진 SSH 연결이 연속으로 실패해 {wait}초 동안 새 접속을 멈췄습니다. 마지막 오류: {}",
                    s.last_error
                ))
            }
            _ => Ok(()),
        }
    }

    /// Records an ssh.exe process start; keep the guard for as long as the process runs.
    pub fn started(self: &Arc<Self>) -> Login {
        let now = Instant::now();
        let mut s = self.state.lock().unwrap();
        s.started += 1;
        s.live += 1;
        s.peak = s.peak.max(s.live);
        s.trim(now);
        s.recent.push_back(now);
        if s.recent.len() > WARN_PER_MINUTE && s.warned_at.is_none_or(|t| now.duration_since(t) >= WINDOW) {
            s.warned_at = Some(now);
            eprintln!("원격 엔진 SSH 로그인 과다: {} 최근 1분 {}회, 동시 {}개", self.label, s.recent.len(), s.live);
        }
        Login(self.clone())
    }

    /// A login worked: the next failure starts the backoff from the beginning.
    pub fn succeeded(&self) {
        let mut s = self.state.lock().unwrap();
        s.failures = 0;
        s.blocked_until = None;
    }

    /// A login failed: new logins wait for the returned delay, doubling with each failure in a row.
    pub fn failed(&self, error: &str) -> Duration {
        let mut s = self.state.lock().unwrap();
        s.failures = s.failures.saturating_add(1);
        let delay = backoff(s.failures, rand::random::<f64>());
        s.blocked_until = Some(Instant::now() + delay);
        s.last_error = error.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("연결 실패").chars().take(200).collect();
        delay
    }

    /// Waits for one of the command slots of this endpoint.
    pub async fn command_slot(&self) -> OwnedSemaphorePermit {
        self.commands.clone().acquire_owned().await.expect("gate semaphore is never closed")
    }

    pub fn snapshot(&self) -> Value {
        let now = Instant::now();
        let mut s = self.state.lock().unwrap();
        s.trim(now);
        json!({
            "endpoint": self.label,
            "logins": s.started,
            "lastMinute": s.recent.len(),
            "live": s.live,
            "peak": s.peak,
            "failures": s.failures,
            "blockedSeconds": s.blocked_until.filter(|u| *u > now).map(|u| (u - now).as_secs_f64()),
            "lastError": if s.last_error.is_empty() { Value::Null } else { s.last_error.clone().into() },
        })
    }

    #[cfg(test)]
    pub fn counts(&self) -> (u64, usize, usize, usize) {
        let mut s = self.state.lock().unwrap();
        s.trim(Instant::now());
        (s.started, s.live, s.peak, s.recent.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_a_minute_with_jitter_in_the_upper_half() {
        assert_eq!(backoff(0, 0.3), Duration::ZERO);
        assert_eq!(backoff(1, 1.0), Duration::from_secs(2));
        assert_eq!(backoff(2, 1.0), Duration::from_secs(4));
        assert_eq!(backoff(5, 1.0), Duration::from_secs(32));
        assert_eq!(backoff(6, 1.0), Duration::from_secs(60));
        assert_eq!(backoff(40, 1.0), Duration::from_secs(60));
        assert_eq!(backoff(3, 0.0), Duration::from_secs(4));
        for n in 1..10 {
            let (low, high) = (backoff(n, 0.0), backoff(n, 1.0));
            assert!(low * 2 == high && low > Duration::ZERO);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failures_hold_logins_back_until_the_backoff_ends() {
        let gate = endpoint("test|backoff", "test-backoff");
        gate.admit().unwrap();
        let first = gate.failed("kex_exchange_identification: Connection reset by peer");
        assert!(first >= Duration::from_secs(1) && first <= Duration::from_secs(2));
        let error = gate.admit().unwrap_err().to_string();
        assert!(error.contains("kex_exchange_identification"), "{error}");
        tokio::time::advance(first + Duration::from_millis(1)).await;
        gate.admit().unwrap();
        let mut delays = vec![first];
        for _ in 0..7 {
            delays.push(gate.failed("Connection reset"));
        }
        assert!(delays[3] >= Duration::from_secs(8), "{delays:?}");
        assert!(delays.iter().all(|d| *d <= BACKOFF_MAX), "{delays:?}");
        assert!(gate.admit().is_err());
        gate.succeeded();
        gate.admit().unwrap();
        // After a success the backoff starts over from the first step.
        assert!(gate.failed("Connection reset") <= BACKOFF_BASE);
    }

    #[tokio::test(start_paused = true)]
    async fn logins_are_counted_per_minute_with_live_and_peak() {
        let gate = endpoint("test|count", "test-count");
        let a = gate.started();
        let b = gate.started();
        drop(a);
        let _c = gate.started();
        assert_eq!(gate.counts(), (3, 2, 2, 3));
        drop(b);
        tokio::time::advance(WINDOW).await;
        assert_eq!(gate.counts(), (3, 1, 2, 0));
        assert_eq!(gate.snapshot()["endpoint"], "test-count");
    }

    #[tokio::test]
    async fn command_slots_bound_concurrent_commands() {
        let gate = endpoint("test|slots", "test-slots");
        let held: Vec<_> = futures_util::future::join_all((0..COMMANDS_PER_ENDPOINT).map(|_| gate.command_slot())).await;
        assert!(tokio::time::timeout(Duration::from_millis(50), gate.command_slot()).await.is_err());
        drop(held);
        let _slot = tokio::time::timeout(Duration::from_millis(50), gate.command_slot()).await.unwrap();
    }
}
