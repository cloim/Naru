//! The managed WSL runtime: install, start and stop the engine, Kubernetes and snapshots.
use crate::context::{local_only, remote_target, target};
use crate::engine::docker_with;
use crate::runner::{args, command, detached, distributions, wsl, wsl_sh, Log, Opts};
use crate::state::{atomic_json, container_proxy_config, data, root, settings, DISTRO};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

pub fn require_managed() -> Result<()> {
    local_only()
}

/// Official Alpine root filesystem. Engine packages come from the same release branch and apk verifies their signatures.
pub const BASE_VERSION: &str = "3.24.3";
pub const BASE_SHA256: &str = "f8e1cafba9b1b283b5d30d06f9885c8d2bc161ffe9083ade8e2e157813a53407";
pub const BASE_URL: &str = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-3.24.3-x86_64.tar.gz";
pub const PACKAGES: &[&str] = &[
    "docker-engine",
    "docker-cli",
    "docker-cli-buildx",
    "docker-cli-compose",
    "containerd",
    "nerdctl",
    "buildkit",
    "buildctl",
    "cni-plugins",
    "iptables",
    "ip6tables",
    "iproute2-minimal",
    "socat",
    "curl",
    "util-linux-misc",
    "ca-certificates",
    "tzdata",
];

/// Scripts copied into /usr/local/bin on every start, so the distribution always runs this version.
const SCRIPTS: &[&str] = &["naru-boot.sh", "naru-gpu.sh", "naru-k3s.sh", "naru-netns.sh", "naru-port-relay.sh"];

pub async fn sha256(file: &Path) -> Result<String> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        let mut hasher = Sha256::new();
        let mut f = std::fs::File::open(&file)?;
        std::io::copy(&mut f, &mut hasher)?;
        Ok(hex::encode(hasher.finalize()))
    })
    .await?
}

/// An HTTP client for Naru's own downloads that goes through the proxy from settings, when one is set.
pub async fn http_client(timeout: Duration) -> Result<reqwest::Client> {
    proxied_client(&settings().await?.proxy, timeout)
}

pub fn proxied_client(proxy: &crate::state::Proxy, timeout: Duration) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(timeout).connect_timeout(Duration::from_secs(15));
    let no_proxy = reqwest::NoProxy::from_string(&proxy.no_proxy);
    if !proxy.http.trim().is_empty() {
        let p = reqwest::Proxy::http(proxy.http.trim()).map_err(|e| anyhow!("HTTP 프록시 주소를 확인해 주세요: {e}"))?;
        builder = builder.proxy(p.no_proxy(no_proxy.clone()));
    }
    if !proxy.https.trim().is_empty() {
        let p = reqwest::Proxy::https(proxy.https.trim()).map_err(|e| anyhow!("HTTPS 프록시 주소를 확인해 주세요: {e}"))?;
        builder = builder.proxy(p.no_proxy(no_proxy));
    }
    Ok(builder.build()?)
}

/// Turns a connection failure into guidance a user can act on.
pub fn download_error(e: reqwest::Error) -> anyhow::Error {
    if e.is_connect() || e.is_timeout() {
        anyhow!("다운로드 서버에 연결하지 못했습니다. 인터넷 연결과 프록시 설정을 확인해 주세요. ({e})")
    } else {
        anyhow!(e)
    }
}

pub async fn download(url: &str, dest: &Path, log: Option<&Log>) -> Result<()> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let client = http_client(Duration::from_secs(15 * 60)).await?;
    let response = client.get(url).send().await.map_err(download_error)?;
    if !response.status().is_success() {
        bail!("다운로드 실패: HTTP {} {url}", response.status().as_u16());
    }
    let temp = dest.with_extension(format!(
        "{}.partial",
        dest.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let mut file = tokio::fs::File::create(&temp).await?;
    let (mut bytes, mut last) = (0u64, Instant::now());
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        bytes += chunk.len() as u64;
        file.write_all(&chunk).await?;
        if last.elapsed() > Duration::from_secs(2) {
            if let Some(log) = log {
                log(&format!("다운로드 {:.1} MB\n", bytes as f64 / 1_048_576.0));
            }
            last = Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&temp, dest).await?;
    Ok(())
}

pub async fn status() -> Result<Value> {
    let cfg = settings().await?;
    if remote_target() {
        let (health, error) = match docker_with("GET", "/info", None, Duration::from_secs(15)).await {
            Ok(v) => (v, Value::Null),
            Err(e) => (Value::Null, e.to_string().into()),
        };
        let ok = !health.is_null();
        let t = target();
        return Ok(json!({
            "connection": "ssh", "managed": false, "installed": ok, "running": ok, "ready": ok,
            "engine": "moby", "health": health, "error": error, "engineId": t.id, "engineName": t.name,
            "kubernetes": { "enabled": false, "version": cfg.kubernetes.version, "port": cfg.kubernetes.port, "traefik": cfg.kubernetes.traefik },
            "pollSeconds": cfg.poll_seconds,
        }));
    }
    let (all, running) = tokio::try_join!(distributions(false), distributions(true))?;
    let installed = all.iter().any(|d| d == DISTRO);
    let active = running.iter().any(|d| d == DISTRO);
    let (mut health, mut error) = (Value::Null, Value::Null);
    if active {
        let probe = if cfg.engine == "moby" {
            wsl(&args(["curl", "-sf", "--max-time", "2", "--unix-socket", "/run/naru/docker.sock", "http://localhost/info"]), Opts::timeout(5)).await
        } else {
            wsl(&args(["/usr/bin/nerdctl", "--address", "/run/naru/containerd.sock", "info", "--format", "{{json .}}"]), Opts::timeout(5)).await
        };
        match probe.and_then(|text| Ok(serde_json::from_str::<Value>(&text)?)) {
            Ok(v) => health = v,
            Err(e) => error = e.to_string().into(),
        }
    }
    Ok(json!({
        "connection": "managed", "managed": true, "installed": installed, "running": active,
        "ready": !health.is_null(), "engine": cfg.engine, "kubernetes": cfg.kubernetes,
        "health": health, "error": error, "distro": DISTRO, "dataPath": data(), "pollSeconds": cfg.poll_seconds,
    }))
}

pub async fn require_ready() -> Result<()> {
    if remote_target() {
        return Ok(());
    }
    if !distributions(true).await?.iter().any(|d| d == DISTRO) {
        bail!("Naru 엔진을 먼저 시작해 주세요.");
    }
    Ok(())
}

pub async fn export_kubeconfig() -> Result<String> {
    require_managed()?;
    require_ready().await?;
    let mut config: serde_yaml::Value = serde_yaml::from_str(&wsl(&args(["cat", "/etc/naru/kubeconfig"]), Opts::default()).await?)?;
    let single = |key: &str| config.get(key).and_then(|v| v.as_sequence()).is_some_and(|s| s.len() == 1);
    if !(single("clusters") && single("contexts") && single("users")) {
        bail!("k3s kubeconfig 구조를 확인해 주세요.");
    }
    let naru = serde_yaml::Value::from("naru");
    config["clusters"][0]["name"] = naru.clone();
    config["users"][0]["name"] = naru.clone();
    config["contexts"][0]["name"] = naru.clone();
    config["contexts"][0]["context"]["cluster"] = naru.clone();
    config["contexts"][0]["context"]["user"] = naru.clone();
    config["current-context"] = naru;
    let text = serde_yaml::to_string(&config)?;
    tokio::fs::write(data().join("kubeconfig.yaml"), &text).await?;
    merge_user_kubeconfig(&config).await?;
    Ok(text)
}

/// Adds the naru cluster, user and context to an existing kubeconfig. Other entries stay; entries named
/// naru are replaced. The current context changes only when none is set, so another cluster stays default.
pub fn merge_kubeconfig(mut existing: serde_yaml::Value, naru: &serde_yaml::Value) -> serde_yaml::Value {
    use serde_yaml::{Mapping, Value};
    if !existing.is_mapping() {
        existing = Value::Mapping(Mapping::new());
    }
    for (key, default) in [("apiVersion", "v1"), ("kind", "Config")] {
        if existing.get(key).is_none() {
            existing[key] = default.into();
        }
    }
    for key in ["clusters", "contexts", "users"] {
        let mut list: Vec<Value> = existing.get(key).and_then(Value::as_sequence).cloned().unwrap_or_default();
        list.retain(|entry| entry.get("name").and_then(Value::as_str) != Some("naru"));
        list.extend(naru.get(key).and_then(Value::as_sequence).cloned().unwrap_or_default());
        existing[key] = Value::Sequence(list);
    }
    let current = existing.get("current-context").and_then(Value::as_str).unwrap_or_default();
    if current.is_empty() {
        existing["current-context"] = "naru".into();
    }
    existing
}

/// Plain `kubectl` and other tools read ~/.kube/config, as they do with Docker Desktop's cluster.
async fn merge_user_kubeconfig(naru: &serde_yaml::Value) -> Result<()> {
    let dir = std::path::PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".kube");
    let file = dir.join("config");
    let existing = match tokio::fs::read_to_string(&file).await {
        Ok(text) if !text.trim().is_empty() => {
            serde_yaml::from_str(&text).with_context(|| format!("{} 형식을 읽을 수 없어 합치지 않았습니다.", file.display()))?
        }
        _ => serde_yaml::Value::Null,
    };
    let merged = serde_yaml::to_string(&merge_kubeconfig(existing, naru))?;
    tokio::fs::create_dir_all(&dir).await?;
    let temp = dir.join(format!("config.naru-{}.tmp", std::process::id()));
    tokio::fs::write(&temp, merged).await?;
    tokio::fs::rename(&temp, &file).await?;
    Ok(())
}

pub async fn install(log: &Log) -> Result<()> {
    require_managed()?;
    if distributions(false).await?.iter().any(|d| d == DISTRO) {
        bail!("Naru 배포판이 이미 설치되어 있습니다.");
    }
    let tar = data().join("cache").join(BASE_URL.rsplit('/').next().unwrap());
    if !tar.exists() {
        download(BASE_URL, &tar, Some(log)).await?;
    }
    log("공식 SHA256으로 배포판을 검증합니다.\n");
    let observed = sha256(&tar).await?;
    if observed != BASE_SHA256 {
        log(&format!("로컬 배포판은 공식 릴리스와 다릅니다 ({observed}). 원본을 보존하고 공식 릴리스를 받습니다.\n"));
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
        tokio::fs::rename(&tar, tar.with_extension(format!("gz.unverified-{stamp}"))).await?;
        download(BASE_URL, &tar, Some(log)).await?;
        if sha256(&tar).await? != BASE_SHA256 {
            bail!("공식 릴리스 배포판 SHA256 검증 실패.");
        }
    }
    let location = data().join("wsl");
    tokio::fs::create_dir_all(&location).await?;
    let import = args(["--import", DISTRO, &location.to_string_lossy(), &tar.to_string_lossy(), "--version", "2"]);
    command("wsl.exe", &import, Opts::timeout(180).log(log)).await?;
    log("엔진 패키지를 설치합니다.\n");
    // apk takes the proxy from the environment. A proxy on Windows localhost is not reachable from WSL,
    // so it is addressed through the WSL gateway; that works when the proxy listens beyond loopback.
    const APK: &str = r#"gw=$(ip route | awk '/default/ {print $3; exit}')
reach() { printf '%s' "$1" | sed -E "s#^(([a-zA-Z]+://)?([^@/]*@)?)(localhost|127\.0\.0\.1|\[::1\])([:/]|\$)#\1${gw}\5#"; }
if [ -n "$NARU_HTTP_PROXY" ]; then export http_proxy="$(reach "$NARU_HTTP_PROXY")"; fi
if [ -n "$NARU_HTTPS_PROXY" ]; then export https_proxy="$(reach "$NARU_HTTPS_PROXY")"; fi
if [ -n "$NARU_NO_PROXY" ]; then export no_proxy="$NARU_NO_PROXY"; fi
exec apk add --no-cache "$@""#;
    let proxy = settings().await?.proxy;
    let mut apk = args([
        "env",
        &format!("NARU_HTTP_PROXY={}", proxy.http.trim()),
        &format!("NARU_HTTPS_PROXY={}", proxy.https.trim()),
        &format!("NARU_NO_PROXY={}", proxy.no_proxy.trim()),
        "sh",
        "-c",
        APK,
        "sh",
    ]);
    apk.extend(PACKAGES.iter().map(|p| p.to_string()));
    wsl(&apk, Opts::timeout(15 * 60).log(log))
        .await
        .map_err(|e| anyhow!("엔진 패키지를 내려받지 못했습니다. 인터넷 연결과 프록시 설정을 확인해 주세요.\n{e}"))?;
    // WSL regenerates hosts and resolv.conf on the next boot from these settings.
    let conf = "[automount]\nmountFsTab=false\noptions=metadata\n[network]\ngenerateHosts=true\ngenerateResolvConf=true\n[user]\ndefault=root\n";
    wsl_sh(
        "cat > /etc/wsl.conf; rm -f /etc/resolv.conf /etc/hosts; mkdir -p /etc/naru /var/lib/naru /var/log/naru",
        Opts::default().input(conf).log(log),
    )
    .await?;
    install_scripts(log).await?;
    command("wsl.exe", &args(["--terminate", DISTRO]), Opts::timeout(30)).await?;
    atomic_json(
        &data().join("provenance.json"),
        &json!({
            "base": { "version": BASE_VERSION, "sha256": BASE_SHA256, "url": BASE_URL },
            "packages": PACKAGES,
            "installedAt": chrono::Utc::now().to_rfc3339(),
        }),
    )
    .await?;
    log("Naru 전용 WSL2 배포판 설치 완료.\n");
    Ok(())
}

async fn install_file(source: &Path, dest: &str, log: Option<&Log>) -> Result<()> {
    let contents = tokio::fs::read_to_string(source).await.with_context(|| source.display().to_string())?.replace('\r', "");
    let mut opts = Opts::default().input(contents);
    opts.log = log.cloned();
    wsl_sh(&format!("cat > {dest}; chmod 755 {dest}"), opts).await?;
    Ok(())
}

async fn install_scripts(log: &Log) -> Result<()> {
    for name in SCRIPTS {
        let dest = format!("/usr/local/bin/{}", name.trim_end_matches(".sh"));
        install_file(&root().join("scripts").join(name), &dest, Some(log)).await?;
    }
    // The agent is a static Linux binary built from crates/agent and shipped with the app.
    let agent = root().join("scripts").join("naru-agent");
    let linux = wsl(&args(["wslpath", "-a", &agent.to_string_lossy()]), Opts::default()).await?;
    wsl(&args(["install", "-m", "755", &linux, "/usr/local/bin/naru-agent"]), Opts::default()).await?;
    Ok(())
}

/// The Docker CLI inside WSL hands these to containers and builds, as Windows clients get from the bridge.
async fn write_cli_proxies(proxy: &crate::state::Proxy) -> Result<()> {
    // Before the first boot the file does not exist yet; start from the default naru-boot would write.
    let text = wsl_sh("cat /etc/naru/docker/config.json 2>/dev/null || true", Opts::default()).await?;
    let mut config: Value = if text.trim().is_empty() {
        json!({ "auths": { "https://index.docker.io/v1/": {} } })
    } else {
        serde_json::from_str(&text)?
    };
    match container_proxy_config(proxy) {
        Some(proxies) => config["proxies"] = json!({ "default": proxies }),
        None => {
            if let Some(map) = config.as_object_mut() {
                map.remove("proxies");
            }
        }
    }
    let text = serde_json::to_string_pretty(&config)? + "\n";
    wsl_sh("mkdir -p /etc/naru/docker; umask 077; cat > /etc/naru/docker/config.json", Opts::default().input(text)).await?;
    Ok(())
}

async fn engine_responds(engine: &str) -> bool {
    let probe = if engine == "moby" {
        args(["curl", "-sf", "--max-time", "2", "--unix-socket", "/run/naru/docker.sock", "http://localhost/_ping"])
    } else {
        args(["/usr/bin/nerdctl", "--address", "/run/naru/containerd.sock", "info"])
    };
    wsl(&probe, Opts::timeout(5)).await.is_ok()
}

pub async fn start(log: &Log) -> Result<()> {
    require_managed()?;
    let cfg = settings().await?;
    let current = status().await?;
    if current["installed"] != true {
        bail!("Naru 런타임 설치를 먼저 실행해 주세요.");
    }
    if current["ready"] == true {
        log("엔진이 이미 준비되었습니다.\n");
        return Ok(());
    }
    install_scripts(log).await?;
    write_cli_proxies(&cfg.proxy).await?;
    // Pass proxy values as env arguments, never interpolate into a shell program.
    let launch = args([
        "-d",
        DISTRO,
        "-u",
        "root",
        "--exec",
        "env",
        &format!("HTTP_PROXY={}", cfg.proxy.http),
        &format!("HTTPS_PROXY={}", cfg.proxy.https),
        &format!("NO_PROXY={}", cfg.proxy.no_proxy),
        "/usr/local/bin/naru-boot",
        &cfg.engine,
    ]);
    let pid = detached("wsl.exe", &launch, None).await?;
    log(&format!("독립 WSL supervisor 시작, PID {pid}\n"));
    for _ in 0..45 {
        if engine_responds(&cfg.engine).await {
            log("컨테이너 엔진 응답 확인.\n");
            if cfg.kubernetes.enabled {
                start_kubernetes(log).await?;
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let tail = wsl(&args(["tail", "-n", "60", "/var/log/naru/engine.log"]), Opts::default()).await.unwrap_or_default();
    bail!("엔진 시작 실패:\n{tail}")
}

pub async fn stop(log: &Log) -> Result<()> {
    require_managed()?;
    if !distributions(true).await?.iter().any(|d| d == DISTRO) {
        log("이미 종료되어 있습니다.\n");
        return Ok(());
    }
    // Graceful shutdown first, then terminate this distribution only.
    wsl_sh(
        "for file in /run/naru/k3s.pid /run/naru/supervisor.pid; do if [ -f \"$file\" ]; then kill \"$(cat \"$file\")\" 2>/dev/null || true; fi; done",
        Opts::default(),
    )
    .await?;
    let mut stopped = false;
    for _ in 0..30 {
        if wsl(&args(["test", "!", "-f", "/run/naru/supervisor.pid"]), Opts::default()).await.is_ok() {
            stopped = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !stopped {
        bail!("엔진 정상 종료 제한 시간 초과. 로그를 확인해 주세요.");
    }
    command("wsl.exe", &args(["--terminate", DISTRO]), Opts::timeout(30)).await?;
    log("Naru 배포판 종료 완료.\n");
    Ok(())
}

pub fn kubectl(extra: &[&str]) -> Vec<String> {
    let mut a = args(["/usr/local/bin/naru-netns", "/usr/local/bin/k3s", "kubectl", "--kubeconfig", "/etc/naru/kubeconfig"]);
    a.extend(extra.iter().map(|s| s.to_string()));
    a
}

pub async fn start_kubernetes(log: &Log) -> Result<()> {
    require_managed()?;
    require_ready().await?;
    let cfg = settings().await?;
    let version = &cfg.kubernetes.version;
    let stored = wsl_sh("cat /etc/naru/k3s-version 2>/dev/null || true", Opts::default()).await?;
    if &stored != version {
        let cache = data().join("cache").join(version);
        tokio::fs::create_dir_all(&cache).await?;
        let url = format!("https://github.com/k3s-io/k3s/releases/download/{}", crate::engine::encode(version));
        let sums = http_client(Duration::from_secs(30))
            .await?
            .get(format!("{url}/sha256sum-amd64.txt"))
            .send()
            .await
            .map_err(download_error)?;
        if !sums.status().is_success() {
            bail!("k3s 버전 또는 체크섬을 확인할 수 없습니다.");
        }
        let text = sums.text().await?;
        let expected = text
            .lines()
            .find(|line| {
                let name = line.split_whitespace().nth(1).unwrap_or_default();
                name == "k3s" || name == "*k3s"
            })
            .and_then(|line| line.split_whitespace().next())
            .ok_or_else(|| anyhow!("k3s 체크섬 항목이 없습니다."))?
            .to_string();
        let binary = cache.join("k3s");
        if !binary.exists() {
            download(&format!("{url}/k3s"), &binary, Some(log)).await?;
        }
        if sha256(&binary).await? != expected {
            bail!("k3s SHA256 검증 실패.");
        }
        let linux = wsl(&args(["wslpath", "-a", &binary.to_string_lossy()]), Opts::default()).await?;
        wsl(&args(["cp", &linux, "/usr/local/bin/k3s"]), Opts::default()).await?;
        wsl(&args(["chmod", "755", "/usr/local/bin/k3s"]), Opts::default()).await?;
        wsl_sh("cat > /etc/naru/k3s-version", Opts::default().input(version.as_str())).await?;
    }
    detached(
        "wsl.exe",
        &args([
            "-d",
            DISTRO,
            "-u",
            "root",
            "--exec",
            "/usr/local/bin/naru-k3s",
            &cfg.engine,
            &cfg.kubernetes.port.to_string(),
            &cfg.kubernetes.traefik.to_string(),
        ]),
        None,
    )
    .await?;
    log(&format!("k3s {version} 시작, readiness 확인 중\n"));
    for i in 0..120 {
        if wsl(&kubectl(&["get", "--raw=/readyz"]), Opts::timeout(5)).await.is_ok() {
            export_kubeconfig().await?;
            log("Kubernetes API 준비 완료. Naru 전용 Windows kubeconfig를 저장했습니다.\n");
            return Ok(());
        }
        if i > 3 && wsl_sh("test -f /run/naru/k3s.pid && kill -0 \"$(cat /run/naru/k3s.pid)\"", Opts::default()).await.is_err() {
            let tail = wsl(&args(["tail", "-n", "8", "/var/log/naru/kubernetes.log"]), Opts::default()).await.unwrap_or_default();
            bail!("k3s 프로세스 종료:\n{tail}");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    bail!("Kubernetes 준비 시간 초과. 진단의 Kubernetes 로그를 확인해 주세요.")
}

pub async fn stop_kubernetes(log: &Log) -> Result<()> {
    require_managed()?;
    require_ready().await?;
    wsl_sh("if [ -f /run/naru/k3s.pid ]; then kill \"$(cat /run/naru/k3s.pid)\"; fi", Opts::default()).await?;
    log("Kubernetes 종료 요청 완료.\n");
    Ok(())
}

pub async fn snapshot(name: &str, log: &Log) -> Result<()> {
    require_managed()?;
    let s = status().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir = data().join("snapshots");
    let file = dir.join(format!("{id}.tar"));
    tokio::fs::create_dir_all(&dir).await?;
    if s["running"] == true {
        stop(log).await?;
    }
    let result = async {
        command("wsl.exe", &args(["--export", DISTRO, &file.to_string_lossy()]), Opts::timeout(15 * 60).log(log)).await?;
        let bytes = tokio::fs::metadata(&file).await?.len();
        atomic_json(
            &dir.join(format!("{id}.json")),
            &json!({
                "id": id, "name": name, "createdAt": chrono::Utc::now().to_rfc3339(), "bytes": bytes,
                "settings": settings().await?, "sha256": sha256(&file).await?,
            }),
        )
        .await?;
        log("일관된 정지 상태의 스냅샷 저장 완료.\n");
        Ok(())
    }
    .await;
    if s["ready"] == true {
        start(log).await?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubeconfig_merge_keeps_other_clusters_and_default_context() {
        let naru: serde_yaml::Value = serde_yaml::from_str(
            "clusters: [{name: naru, cluster: {server: 'https://127.0.0.1:6445'}}]\n\
             contexts: [{name: naru, context: {cluster: naru, user: naru}}]\n\
             users: [{name: naru, user: {token: x}}]\n",
        )
        .unwrap();
        let existing: serde_yaml::Value = serde_yaml::from_str(
            "apiVersion: v1\nkind: Config\ncurrent-context: work\n\
             clusters: [{name: work, cluster: {server: 'https://work'}}, {name: naru, cluster: {server: old}}]\n\
             contexts: [{name: work, context: {cluster: work, user: work}}]\n\
             users: [{name: work, user: {token: w}}]\n",
        )
        .unwrap();
        let merged = merge_kubeconfig(existing, &naru);
        assert_eq!(merged["current-context"], "work");
        let clusters = merged["clusters"].as_sequence().unwrap();
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[1]["cluster"]["server"], "https://127.0.0.1:6445");
        assert_eq!(merged["contexts"].as_sequence().unwrap().len(), 2);
        let fresh = merge_kubeconfig(serde_yaml::Value::Null, &naru);
        assert_eq!(fresh["current-context"], "naru");
        assert_eq!(fresh["kind"], "Config");
    }
}
