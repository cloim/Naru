//! A job worker process: `naru --worker <id>` runs one persisted job and records how it ended.
use crate::context::{remote_target, with_target, Target};
use crate::engine::{self, cli, close_remote_connections};
use crate::extensions::{install_extension, uninstall_extension};
use crate::forwarding::{create_forward, remove_forward, stop_forward};
use crate::jobs::{assert_job_target, jobs_dir, now, validate_job};
use crate::projects::{self, find_project, save_managed_project, LABEL_PROJECT};
use crate::registry::ensure_credential_helper;
use crate::runner::{args, command, wsl, Log, Opts};
use crate::runtime::{self, download, kubectl, require_ready, sha256};
use crate::state::{atomic_json, data, read_json, save_settings, DISTRO};
use crate::tools::{ensure_windows_tool, sync_cli_proxies, user_docker_config};
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};

const TRIVY_URL: &str = "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz";
const TRIVY_SHA256: &str = "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea";

/// Runs the job and returns the process exit code.
pub async fn run_worker(id: &str) -> i32 {
    if !Regex::new(r"^[a-f0-9-]{36}$").unwrap().is_match(id) {
        eprintln!("Invalid job id");
        return 2;
    }
    let dir = jobs_dir();
    let file = dir.join(format!("{id}.json"));
    let input_file = dir.join(format!("{id}.input.json.private"));
    let log_file = match std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{id}.log"))) {
        Ok(f) => Arc::new(Mutex::new(f)),
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let log: Log = {
        let log_file = log_file.clone();
        Arc::new(move |text: &str| {
            let _ = log_file.lock().unwrap().write_all(text.as_bytes());
        })
    };
    let mut job: Value = match read_json(&file, None).await {
        Ok(j) => j,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let target: Target = match serde_json::from_value(job["target"].clone()) {
        Ok(t) => t,
        Err(_) => Target::local(),
    };
    if job["engineId"].is_string() && job["engineId"].as_str() != Some(target.id.as_str()) {
        eprintln!("작업의 엔진 정보가 잘못되었습니다.");
        return 1;
    }
    let lock_path = data().join("runtime.lock");
    let mut locked = false;
    let result: Result<()> = with_target(target, async {
        // One job at a time touches the runtime; create_new fails while another worker holds the lock.
        let mut lock = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|_| anyhow!("다른 작업이 런타임을 사용 중입니다."))?;
        locked = true;
        lock.write_all(std::process::id().to_string().as_bytes())?;
        let kind = job["type"].as_str().unwrap_or_default().to_string();
        assert_job_target(&kind)?;
        let p = validate_job(&kind, &read_json(&input_file, None).await?)?;
        job["state"] = "running".into();
        job["pid"] = std::process::id().into();
        job["startedAt"] = now().into();
        atomic_json(&file, &job).await?;
        execute(id, &kind, &p, &log).await
    })
    .await;
    let code = match result {
        Ok(()) => {
            job["state"] = "succeeded".into();
            0
        }
        Err(e) => {
            log(&format!("\n오류: {e}\n"));
            job["state"] = "failed".into();
            job["error"] = e.to_string().into();
            1
        }
    };
    job["finishedAt"] = now().into();
    close_remote_connections();
    let _ = atomic_json(&file, &job).await;
    let _ = tokio::fs::remove_file(&input_file).await;
    if locked {
        let _ = tokio::fs::remove_file(&lock_path).await;
    }
    code
}

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p[key].as_str().unwrap_or_default()
}

async fn wslpath(path: &str) -> Result<String> {
    wsl(&args(["wslpath", "-a", path]), Opts::default()).await
}

fn windows_path(value: &str) -> bool {
    Regex::new(r"^[a-zA-Z]:[\\/]").unwrap().is_match(value)
}

async fn execute(id: &str, kind: &str, p: &Value, log: &Log) -> Result<()> {
    let long = || Opts::timeout(15 * 60).log(log);
    match kind {
        "installRuntime" => runtime::install(log).await?,
        "startRuntime" => runtime::start(log).await?,
        "stopRuntime" => runtime::stop(log).await?,
        "compactDisk" => crate::disk::compact_disk(log).await?,
        "startKubernetes" => runtime::start_kubernetes(log).await?,
        "stopKubernetes" => runtime::stop_kubernetes(log).await?,
        "installExtension" => install_extension(s(p, "image"), log).await?,
        "uninstallExtension" => uninstall_extension(s(p, "id"), log).await?,
        "createForward" => create_forward(p, log).await?,
        "stopForward" => stop_forward(s(p, "id"), log).await?,
        "removeForward" => remove_forward(s(p, "id"), log).await?,
        "registryLogin" => {
            ensure_credential_helper(log).await?;
            let opts = Opts::timeout(60).log(log).input(s(p, "password"));
            cli(&args(["login", s(p, "server"), "--username", s(p, "username"), "--password-stdin"]), opts).await?;
        }
        "registryLogout" => {
            cli(&args(["logout", s(p, "server")]), Opts::default().log(log)).await?;
        }
        "exportImage" => {
            let file = std::path::Path::new(s(p, "file"));
            if file.exists() {
                bail!("대상 파일이 이미 있습니다. 새 파일 이름을 지정해 주세요.");
            }
            tokio::fs::create_dir_all(file.parent().unwrap()).await?;
            cli(&args(["save", "-o", &wslpath(s(p, "file")).await?, s(p, "image")]), long()).await?;
            log(&format!("이미지 저장 완료: {}\n", s(p, "file")));
        }
        "importImage" => {
            tokio::fs::metadata(s(p, "file")).await?;
            cli(&args(["load", "-i", &wslpath(s(p, "file")).await?]), long()).await?;
        }
        "scanImage" => scan_image(id, s(p, "image"), log).await?,
        "installCLI" => install_cli(log).await?,
        "containerAction" => {
            engine::container_action(s(p, "id"), s(p, "action"), log).await?;
        }
        "pullImage" => {
            cli(&args(["pull", s(p, "image")]), long()).await?;
        }
        "pushImage" => {
            cli(&args(["push", s(p, "image")]), long()).await?;
        }
        "removeImage" => {
            cli(&args(["image", "rm", s(p, "id")]), Opts::default().log(log)).await?;
        }
        "tagImage" => {
            cli(&args(["tag", s(p, "id"), s(p, "target")]), Opts::default().log(log)).await?;
        }
        "createVolume" => {
            cli(&args(["volume", "create", s(p, "name")]), Opts::default().log(log)).await?;
        }
        "removeVolume" => {
            cli(&args(["volume", "rm", s(p, "name")]), Opts::default().log(log)).await?;
        }
        "createNetwork" => {
            cli(&args(["network", "create", s(p, "name")]), Opts::default().log(log)).await?;
        }
        "removeNetwork" => {
            cli(&args(["network", "rm", s(p, "id")]), Opts::default().log(log)).await?;
        }
        "pruneResources" => {
            let mut a = args(["system", "prune", "-f"]);
            if p["all"] == true {
                a.push("--all".into());
            }
            if p["volumes"] == true {
                a.push("--volumes".into());
            }
            cli(&a, long()).await?;
            log("미사용 리소스 정리(Prune) 완료.\n");
        }
        "pruneImages" => {
            cli(&args(["image", "prune", "-a", "-f"]), long()).await?;
            log("미사용 이미지 정리 완료.\n");
        }
        "pruneVolumes" => {
            cli(&args(["volume", "prune", "-f"]), long()).await?;
            log("미사용 볼륨 정리 완료.\n");
        }
        "pruneNetworks" => {
            cli(&args(["network", "prune", "-f"]), long()).await?;
            log("미사용 네트워크 정리 완료.\n");
        }
        "createContainer" => create_container(p, log).await?,
        "buildImage" => {
            let context = std::path::absolute(s(p, "context"))?;
            if !tokio::fs::metadata(&context).await?.is_dir() {
                bail!("빌드 context는 폴더여야 합니다.");
            }
            let target = wslpath(&context.to_string_lossy()).await?;
            let dockerfile = format!("{target}/{}", s(p, "dockerfile"));
            cli(&args(["build", "-f", &dockerfile, "-t", s(p, "tag"), &target]), Opts::timeout(30 * 60).log(log)).await?;
        }
        "compose" => {
            let value: serde_yaml::Value = serde_yaml::from_str(s(p, "yaml"))?;
            if !value.get("services").is_some_and(|v| v.is_mapping()) {
                bail!("Compose services 정의를 확인해 주세요.");
            }
            save_managed_project(s(p, "name"), s(p, "yaml")).await?;
            log("compose.yaml을 저장했습니다.\n");
            if p["action"] == "up" {
                let containers = engine::list("containers").await?;
                projects::compose(&find_project(s(p, "name"), &containers).await?, &args(["up", "--detach"]), log).await?;
            }
        }
        "project" => {
            let (name, action) = (s(p, "name"), s(p, "action"));
            if action == "delete" {
                projects::delete_project(name, log).await?;
                return Ok(());
            }
            let containers = engine::list("containers").await?;
            let project = find_project(name, &containers).await?;
            if project.files_found {
                let extra = match action {
                    "up" => args(["up", "--detach"]),
                    "down" => args(["down"]),
                    other => args([other]),
                };
                projects::compose(&project, &extra, log).await?;
            } else if ["start", "stop", "restart"].contains(&action) {
                // Without the compose file only the existing containers can be driven.
                log("compose 파일이 없어 컨테이너를 직접 제어합니다.\n");
                for c in containers.as_array().into_iter().flatten().filter(|c| projects::label(c, LABEL_PROJECT) == Some(name)) {
                    engine::container_action(c["Id"].as_str().unwrap_or_default(), action, log).await?;
                }
            } else {
                bail!("compose 파일을 찾을 수 없어 이 작업을 실행할 수 없습니다.");
            }
        }
        "deleteProject" => projects::delete_project(s(p, "name"), log).await?,
        "kubeApply" => {
            for document in serde_yaml::Deserializer::from_str(s(p, "yaml")) {
                serde_yaml::Value::deserialize(document)?;
            }
            require_ready().await?;
            wsl(&kubectl(&["apply", "-f", "-"]), Opts::timeout(120).log(log).input(s(p, "yaml"))).await?;
        }
        "kubeDelete" => {
            require_ready().await?;
            let cmd = kubectl(&["-n", s(p, "namespace"), "delete", s(p, "kind"), s(p, "name"), "--timeout=60s"]);
            wsl(&cmd, Opts::timeout(90).log(log)).await?;
        }
        "snapshot" => runtime::snapshot(s(p, "name"), log).await?,
        "deleteSnapshot" => {
            let dir = data().join("snapshots");
            tokio::fs::remove_file(dir.join(format!("{}.tar", s(p, "id")))).await?;
            tokio::fs::remove_file(dir.join(format!("{}.json", s(p, "id")))).await?;
        }
        "restoreSnapshot" => restore_snapshot(s(p, "id"), log).await?,
        _ => bail!("Unknown job"),
    }
    Ok(())
}

async fn create_container(p: &Value, log: &Log) -> Result<()> {
    let mut a = args(["run", "-d", "--restart", s(p, "restart")]);
    if let Some(name) = p["name"].as_str() {
        a.extend(["--name".into(), name.into()]);
    }
    for port in p["ports"].as_array().into_iter().flatten() {
        a.extend(["-p".into(), format!("127.0.0.1:{}:{}/{}", port["host"], port["container"], s(port, "protocol"))]);
    }
    for env in p["env"].as_array().into_iter().flatten() {
        a.extend(["-e".into(), env.as_str().unwrap_or_default().into()]);
    }
    for m in p["mounts"].as_array().into_iter().flatten() {
        let (source, target) = (s(m, "source"), s(m, "target"));
        if source.contains(',') || target.contains(',') {
            bail!("마운트 경로에는 쉼표를 사용할 수 없습니다.");
        }
        if remote_target() && windows_path(source) {
            bail!("원격 엔진의 Linux 마운트 경로를 입력해 주세요.");
        }
        let source = if !source.starts_with('/') && windows_path(source) { wslpath(source).await? } else { source.to_string() };
        let kind = if source.starts_with('/') || windows_path(&source) { "bind" } else { "volume" };
        let readonly = if m["readOnly"] == true { ",readonly" } else { "" };
        a.extend(["--mount".into(), format!("type={kind},source={source},target={target}{readonly}")]);
    }
    a.push(s(p, "image").into());
    a.extend(p["command"].as_array().into_iter().flatten().map(|c| c.as_str().unwrap_or_default().to_string()));
    cli(&a, Opts::timeout(15 * 60).log(log)).await?;
    Ok(())
}

async fn scan_image(id: &str, image: &str, log: &Log) -> Result<()> {
    require_ready().await?;
    if wsl(&args(["test", "-x", "/usr/local/bin/trivy"]), Opts::default()).await.is_err() {
        let tar = data().join("cache").join("trivy_0.72.0_Linux-64bit.tar.gz");
        if !tar.exists() {
            download(TRIVY_URL, &tar, Some(log)).await?;
        }
        if sha256(&tar).await? != TRIVY_SHA256 {
            bail!("Trivy SHA256 검증 실패.");
        }
        let linux = wslpath(&tar.to_string_lossy()).await?;
        wsl(&args(["tar", "-xzf", &linux, "-C", "/usr/local/bin", "trivy"]), Opts::default()).await?;
    }
    let input = format!("/var/lib/naru/scan-{id}.tar");
    cli(&args(["save", "-o", &input, image]), Opts::timeout(15 * 60).log(log)).await?;
    let result = async {
        let scans = data().join("scans");
        tokio::fs::create_dir_all(&scans).await?;
        let report_file = scans.join(format!("{id}.json"));
        let output = wslpath(&report_file.to_string_lossy()).await?;
        wsl(
            &args(["/usr/local/bin/trivy", "image", "--input", &input, "--scanners", "vuln", "--format", "json", "--output", &output]),
            Opts::timeout(15 * 60).log(log),
        )
        .await?;
        let report: Value = read_json(&report_file, None).await?;
        let mut counts = serde_json::Map::new();
        for r in report["Results"].as_array().into_iter().flatten() {
            for v in r["Vulnerabilities"].as_array().into_iter().flatten() {
                let severity = s(v, "Severity").to_string();
                let n = counts.get(&severity).and_then(Value::as_u64).unwrap_or(0) + 1;
                counts.insert(severity, n.into());
            }
        }
        log(&serde_json::to_string_pretty(&json!({ "image": image, "severityCounts": counts, "report": report_file }))?);
        anyhow::Ok(())
    }
    .await;
    wsl(&args(["rm", "-f", &input]), Opts::default()).await?;
    result
}

async fn install_cli(log: &Log) -> Result<()> {
    let bin = data().join("bin");
    tokio::fs::create_dir_all(&bin).await?;
    let mut provenance = vec![];
    for name in ["docker", "kubectl", "helm", "compose", "buildx", "wincred"] {
        let dest = ensure_windows_tool(name, log).await?;
        provenance.push(json!({ "tool": name, "sha256": sha256(&dest).await?, "source": "Official checksum-verified release" }));
    }
    atomic_json(&bin.join("provenance.json"), &provenance).await?;
    let plugins = bin.join("cli-plugins").to_string_lossy().into_owned();
    let config_dir = data().join("docker");
    tokio::fs::create_dir_all(&config_dir).await?;
    let mut naru_config: Value = read_json(&config_dir.join("config.json"), Some(json!({}))).await?;
    naru_config["cliPluginsExtraDirs"] = json!([plugins]);
    naru_config["credsStore"] = "wincred".into();
    atomic_json(&config_dir.join("config.json"), &naru_config).await?;
    let user_dir = user_docker_config();
    let mut user: Value = read_json(&user_dir.join("config.json"), Some(json!({}))).await?;
    let mut dirs: Vec<Value> = user["cliPluginsExtraDirs"].as_array().cloned().unwrap_or_default();
    if !dirs.iter().any(|d| d.as_str() == Some(plugins.as_str())) {
        dirs.push(plugins.clone().into());
    }
    user["cliPluginsExtraDirs"] = dirs.into();
    atomic_json(&user_dir.join("config.json"), &user).await?;
    sync_cli_proxies().await?;
    let docker = bin.join("docker.exe").to_string_lossy().into_owned();
    let config = user_dir.to_string_lossy().into_owned();
    let (context, host) = ("naru", "host=npipe:////./pipe/naru_engine");
    let listed = command(&docker, &args(["--config", &config, "context", "ls", "--format", "{{json .}}"]), Opts::default()).await?;
    if !engine::lines(&listed)?.iter().any(|c| c["Name"] == context) {
        command(&docker, &args(["--config", &config, "context", "create", context, "--docker", host]), Opts::default().log(log)).await?;
    }
    command(&docker, &args(["--config", &config, "context", "update", context, "--docker", host]), Opts::default().log(log)).await?;
    command(&docker, &args(["--config", &config, "context", "use", context]), Opts::default().log(log)).await?;
    let _ = tokio::fs::remove_file(bin.join("naru.cmd")).await;
    let kubeconfig = data().join("kubeconfig.yaml");
    for tool in ["kubectl", "helm"] {
        let exe = bin.join(format!("{tool}.exe"));
        let script = format!("@echo off\r\n\"{}\" --kubeconfig \"{}\" %*\r\n", exe.display(), kubeconfig.display());
        tokio::fs::write(bin.join(format!("naru-{tool}.cmd")), script).await?;
    }
    log(&format!("Windows CLI 설치 완료: {}\nDocker 기본 context: {context}\ndocker ps\ndocker compose version\n", bin.display()));
    Ok(())
}

async fn restore_snapshot(id: &str, log: &Log) -> Result<()> {
    let dir = data().join("snapshots");
    let meta: Value = read_json(&dir.join(format!("{id}.json")), None).await?;
    let tar = dir.join(format!("{id}.tar"));
    if Some(sha256(&tar).await?.as_str()) != meta["sha256"].as_str() {
        bail!("스냅샷 검증 실패.");
    }
    runtime::stop(log).await?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let backup = dir.join(format!("pre-restore-{stamp}.tar"));
    let location = data().join("wsl").to_string_lossy().into_owned();
    command("wsl.exe", &args(["--export", DISTRO, &backup.to_string_lossy()]), Opts::timeout(15 * 60).log(log)).await?;
    command("wsl.exe", &args(["--unregister", DISTRO]), Opts::timeout(60).log(log)).await?;
    let restored = async {
        command("wsl.exe", &args(["--import", DISTRO, &location, &tar.to_string_lossy(), "--version", "2"]), Opts::timeout(15 * 60).log(log)).await?;
        save_settings(meta["settings"].clone()).await?;
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = restored {
        log("복원 실패, 변경 전 배포판 복구를 시도합니다.\n");
        command("wsl.exe", &args(["--import", DISTRO, &location, &backup.to_string_lossy(), "--version", "2"]), Opts::timeout(15 * 60).log(log)).await?;
        return Err(e);
    }
    log(&format!("스냅샷 복원 완료. 변경 전 백업: {}\n", backup.display()));
    Ok(())
}
