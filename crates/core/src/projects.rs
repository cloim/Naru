//! Compose projects: grouped from container labels, Naru-saved compose files and earlier sightings,
//! so a project stays listed after `down` and can be brought up again.
use crate::connections::remote_command;
use crate::context::{engine_key, remote_target};
use crate::engine;
use crate::jobs::PROJECT_NAME;
use crate::runner::{args, command, Log, Opts};
use crate::state::{atomic_json, data, read_json};
use crate::tools::ensure_windows_tool;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// Compose labels every container it creates; these let Naru group and manage existing projects.
pub const LABEL_PROJECT: &str = "com.docker.compose.project";
pub const LABEL_WORKING_DIR: &str = "com.docker.compose.project.working_dir";
pub const LABEL_CONFIG_FILES: &str = "com.docker.compose.project.config_files";
pub const LABEL_ENV_FILES: &str = "com.docker.compose.project.environment_file";
pub const LABEL_SERVICE: &str = "com.docker.compose.service";
pub const HOST: &str = "npipe:////./pipe/naru_engine";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Known {
    pub working_dir: String,
    pub config_files: Vec<String>,
    pub env_files: Vec<String>,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    #[serde(flatten)]
    pub known: Known,
    pub files_found: bool,
}

pub struct Scope {
    pub registry: PathBuf,
    pub managed_dir: PathBuf,
}

pub fn scope() -> Scope {
    let base = if remote_target() {
        data().join("engines").join(engine_key())
    } else {
        data().to_path_buf()
    };
    Scope {
        registry: base.join("projects.json"),
        managed_dir: base.join("compose"),
    }
}

fn split(value: Option<&str>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

pub fn label<'a>(container: &'a Value, key: &str) -> Option<&'a str> {
    container["Labels"][key].as_str()
}

pub async fn list_projects(containers: &Value) -> Result<Vec<Project>> {
    let Scope {
        registry,
        managed_dir,
    } = scope();
    let mut known: BTreeMap<String, Known> = read_json(&registry, Some(BTreeMap::new())).await?;
    let before = known.clone();
    tokio::fs::create_dir_all(&managed_dir).await?;
    let mut entries = tokio::fs::read_dir(&managed_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await?.is_dir() && PROJECT_NAME.is_match(&name) {
            let folder = managed_dir.join(&name);
            known.insert(
                name,
                Known {
                    working_dir: folder.to_string_lossy().into_owned(),
                    config_files: vec![folder.join("compose.yaml").to_string_lossy().into_owned()],
                    env_files: vec![],
                    managed: true,
                },
            );
        }
    }
    for c in containers.as_array().into_iter().flatten() {
        let Some(name) = label(c, LABEL_PROJECT) else {
            continue;
        };
        if known.get(name).is_some_and(|k| k.managed) {
            continue;
        }
        let Some(working_dir) = label(c, LABEL_WORKING_DIR) else {
            continue;
        };
        known.insert(
            name.to_string(),
            Known {
                working_dir: working_dir.to_string(),
                config_files: split(label(c, LABEL_CONFIG_FILES)),
                env_files: split(label(c, LABEL_ENV_FILES)),
                managed: false,
            },
        );
    }
    if known != before {
        atomic_json(&registry, &known).await?;
    }
    let mut projects = vec![];
    for (name, k) in known {
        let mut found = !k.config_files.is_empty();
        for file in &k.config_files {
            let exists = if remote_target() && !k.managed {
                remote_command(&args(["test", "-f", file]), Opts::default())
                    .await
                    .is_ok()
            } else {
                Path::new(file).exists()
            };
            found &= exists;
        }
        projects.push(Project {
            name,
            known: k,
            files_found: found,
        });
    }
    Ok(projects)
}

pub async fn find_project(name: &str, containers: &Value) -> Result<Project> {
    list_projects(containers)
        .await?
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| anyhow!("프로젝트를 찾을 수 없습니다."))
}

fn members(containers: &Value, name: &str) -> Vec<Value> {
    containers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| label(c, LABEL_PROJECT) == Some(name))
        .cloned()
        .collect()
}

async fn drop_record(name: &str) -> Result<()> {
    let Scope {
        registry,
        managed_dir,
    } = scope();
    let mut known: BTreeMap<String, Known> = read_json(&registry, Some(BTreeMap::new())).await?;
    if known.get(name).is_some_and(|k| k.managed) {
        let _ = tokio::fs::remove_dir_all(managed_dir.join(name)).await;
    }
    known.remove(name);
    atomic_json(&registry, &known).await
}

pub async fn forget_project(name: &str, containers: &Value) -> Result<()> {
    if !members(containers, name).is_empty() {
        bail!("컨테이너가 남아 있는 프로젝트는 목록에서 제거할 수 없습니다.");
    }
    drop_record(name).await
}

pub async fn delete_project(name: &str, log: &Log) -> Result<()> {
    let mut containers = engine::list("containers").await?;
    let project = list_projects(&containers)
        .await?
        .into_iter()
        .find(|p| p.name == name);
    let mut list = members(&containers, name);
    if !list.is_empty() {
        log(&format!("소속 컨테이너 {}개를 정리합니다.\n", list.len()));
        if let Some(project) = project.as_ref().filter(|p| p.files_found) {
            log("docker compose down 실행 중...\n");
            if let Err(e) = compose(project, &args(["down"]), log).await {
                log(&format!(
                    "compose down 실패, 개별 컨테이너를 직접 삭제합니다: {e}\n"
                ));
            }
            containers = engine::list("containers").await?;
            list = members(&containers, name);
        }
        for c in list {
            let id = c["Id"].as_str().unwrap_or_default();
            let label = c["Names"][0].as_str().unwrap_or(id).to_string();
            let running = c["State"] == "running"
                || c["Status"].as_str().is_some_and(|s| s.starts_with("Up"));
            if running {
                log(&format!("컨테이너 정지: {label}\n"));
                let _ = engine::container_action(id, "stop", log).await;
            }
            log(&format!("컨테이너 삭제: {label}\n"));
            if let Err(e) = engine::container_action(id, "remove", log).await {
                log(&format!("컨테이너 삭제 오류 ({id}): {e}\n"));
            }
        }
    }
    let remaining = members(&engine::list("containers").await?, name).len();
    if remaining > 0 {
        bail!("컨테이너 삭제에 실패하여 프로젝트를 삭제할 수 없습니다. (남은 컨테이너: {remaining}개)");
    }
    drop_record(name).await?;
    log(&format!("프로젝트 '{name}' 삭제 완료.\n"));
    Ok(())
}

pub async fn read_project_files(project: &Project) -> Result<Value> {
    let mut out = vec![];
    for file in &project.known.config_files {
        if remote_target() && !project.known.managed {
            let text = remote_command(
                &args(["head", "-c", "1048576", "--", file]),
                Opts::default(),
            )
            .await
            .ok();
            out.push(json!({ "path": file, "text": text }));
            continue;
        }
        match tokio::fs::metadata(file).await {
            Ok(m) if m.is_file() && m.len() > 1024 * 1024 => {
                out.push(json!({ "path": file, "text": null, "error": "파일이 너무 큽니다." }))
            }
            Ok(m) if m.is_file() => {
                out.push(json!({ "path": file, "text": tokio::fs::read_to_string(file).await? }))
            }
            _ => out.push(json!({ "path": file, "text": null })),
        }
    }
    Ok(out.into())
}

pub async fn save_managed_project(name: &str, yaml: &str) -> Result<()> {
    let folder = scope().managed_dir.join(name);
    tokio::fs::create_dir_all(&folder).await?;
    tokio::fs::write(folder.join("compose.yaml"), yaml).await?;
    Ok(())
}

fn yaml_key(value: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(value.to_string())
}

fn set_service_value(service: &mut serde_yaml::Mapping, key: &str, value: serde_yaml::Value) {
    service.insert(yaml_key(key), value);
}

fn remove_service_value(service: &mut serde_yaml::Mapping, key: &str) {
    service.remove(yaml_key(key));
}

async fn read_compose_file(project: &Project, file: &str) -> Result<String> {
    if remote_target() && !project.known.managed {
        return remote_command(
            &args(["head", "-c", "1048576", "--", file]),
            Opts::default(),
        )
        .await;
    }
    Ok(tokio::fs::read_to_string(file).await?)
}

async fn write_compose_file(project: &Project, file: &str, text: &str) -> Result<()> {
    if remote_target() && !project.known.managed {
        remote_command(&args(["tee", "--", file]), Opts::default().input(text)).await?;
    } else {
        tokio::fs::write(file, text).await?;
    }
    Ok(())
}

fn apply_service_input(
    document: &mut serde_yaml::Value,
    service_name: &str,
    input: &Value,
) -> Result<()> {
    let service = document
        .get_mut("services")
        .and_then(serde_yaml::Value::as_mapping_mut)
        .and_then(|services| services.get_mut(yaml_key(service_name)))
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| anyhow!("Compose 서비스 정의를 수정할 수 없습니다."))?;

    set_service_value(
        service,
        "image",
        yaml_key(input["image"].as_str().unwrap_or_default()),
    );
    if let Some(name) = input["name"].as_str().filter(|name| !name.is_empty()) {
        set_service_value(service, "container_name", yaml_key(name));
    } else {
        remove_service_value(service, "container_name");
    }
    set_service_value(
        service,
        "environment",
        serde_yaml::to_value(input["env"].as_array().cloned().unwrap_or_default())?,
    );
    let ports = input["ports"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|port| {
            format!(
                "{}:{}:{}/{}",
                port["hostIp"].as_str().unwrap_or("127.0.0.1"),
                port["host"].as_i64().unwrap_or_default(),
                port["container"].as_i64().unwrap_or_default(),
                port["protocol"].as_str().unwrap_or("tcp")
            )
        })
        .collect::<Vec<_>>();
    set_service_value(service, "ports", serde_yaml::to_value(ports)?);
    let volumes = input["mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|mount| {
            format!(
                "{}:{}{}",
                mount["source"].as_str().unwrap_or_default(),
                mount["target"].as_str().unwrap_or_default(),
                if mount["readOnly"] == true { ":ro" } else { "" }
            )
        })
        .collect::<Vec<_>>();
    set_service_value(service, "volumes", serde_yaml::to_value(volumes)?);
    if input["command"]
        .as_array()
        .is_some_and(|command| !command.is_empty())
    {
        set_service_value(
            service,
            "command",
            serde_yaml::to_value(input["command"].clone())?,
        );
    } else {
        remove_service_value(service, "command");
    }
    match input["restart"].as_str() {
        Some("no") | None => remove_service_value(service, "restart"),
        Some(restart) => set_service_value(service, "restart", yaml_key(restart)),
    }
    match input["nanoCpus"].as_i64() {
        Some(value) if value > 0 => set_service_value(
            service,
            "cpus",
            yaml_key(&format!("{}", value as f64 / 1_000_000_000.0)),
        ),
        _ => remove_service_value(service, "cpus"),
    }
    match input["memory"].as_i64() {
        Some(value) if value > 0 => {
            set_service_value(service, "mem_limit", yaml_key(&format!("{value}b")))
        }
        _ => remove_service_value(service, "mem_limit"),
    }
    Ok(())
}

/// Updates the source Compose service and recreates only that service. The original file is
/// restored and applied again if Compose rejects the new definition.
pub async fn update_service(
    project: &Project,
    service_name: &str,
    input: &Value,
    log: &Log,
) -> Result<()> {
    let mut selected = None;
    for file in project.known.config_files.iter().rev() {
        let source = read_compose_file(project, file).await?;
        let document: serde_yaml::Value = serde_yaml::from_str(&source)?;
        let exists = document
            .get("services")
            .and_then(serde_yaml::Value::as_mapping)
            .is_some_and(|services| services.contains_key(yaml_key(service_name)));
        if exists {
            selected = Some((file.clone(), source, document));
            break;
        }
    }
    let Some((file, original, mut document)) = selected else {
        bail!("Compose 서비스 정의를 찾을 수 없습니다: {service_name}");
    };
    apply_service_input(&mut document, service_name, input)?;

    let changed = serde_yaml::to_string(&document)?;
    write_compose_file(project, &file, &changed).await?;
    log(&format!("Compose 서비스 설정 저장: {file}\n"));
    let apply = compose(
        project,
        &args([
            "up",
            "--detach",
            "--force-recreate",
            "--no-deps",
            service_name,
        ]),
        log,
    )
    .await;
    if let Err(error) = apply {
        log("Compose 적용 실패, 원본 파일과 서비스를 복구합니다.\n");
        write_compose_file(project, &file, &original).await?;
        let restore = compose(
            project,
            &args([
                "up",
                "--detach",
                "--force-recreate",
                "--no-deps",
                service_name,
            ]),
            log,
        )
        .await;
        if let Err(restore_error) = restore {
            bail!("설정 적용 실패: {error}. 원본 파일은 복구했지만 서비스 복구도 실패했습니다: {restore_error}");
        }
        bail!("설정 적용에 실패하여 원본 Compose 설정과 서비스를 복구했습니다: {error}");
    }
    Ok(())
}

fn compose_args(
    project: &Project,
    working_dir: &str,
    files: &[String],
    extra: &[String],
) -> Vec<String> {
    let mut a = args([
        "--project-name",
        &project.name,
        "--project-directory",
        working_dir,
    ]);
    for file in files {
        a.extend(["--file".into(), file.clone()]);
    }
    for file in &project.known.env_files {
        a.extend(["--env-file".into(), file.clone()]);
    }
    a.extend_from_slice(extra);
    a
}

/// Runs Windows Compose against Naru's pipe; the pipe maps Windows bind paths for the engine.
pub async fn compose(project: &Project, extra: &[String], log: &Log) -> Result<String> {
    let opts = Opts::timeout(30 * 60).log(log);
    if remote_target() {
        let working_dir = if project.known.managed {
            format!("/var/tmp/naru-compose/{}/{}", engine_key(), project.name)
        } else {
            project.known.working_dir.clone()
        };
        if !working_dir.starts_with('/') {
            bail!("원격 Compose 작업 경로를 확인해 주세요.");
        }
        let mut opts = opts;
        let files = if project.known.managed {
            remote_command(&args(["mkdir", "-p", "--", &working_dir]), Opts::default()).await?;
            opts.input = Some(tokio::fs::read(&project.known.config_files[0]).await?);
            vec!["-".to_string()]
        } else {
            project.known.config_files.clone()
        };
        let mut all = args(["docker", "compose"]);
        all.extend(compose_args(project, &working_dir, &files, extra));
        return remote_command(&all, opts).await;
    }
    let binary = ensure_windows_tool("compose", log).await?;
    let mut opts = opts;
    opts.cwd = Some(PathBuf::from(&project.known.working_dir));
    opts.env = vec![
        ("DOCKER_HOST".into(), HOST.into()),
        ("DOCKER_CONTEXT".into(), String::new()),
        ("COMPOSE_PROGRESS".into(), "plain".into()),
    ];
    command(
        &binary.to_string_lossy(),
        &compose_args(
            project,
            &project.known.working_dir,
            &project.known.config_files,
            extra,
        ),
        opts,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_service_settings_are_replaced_without_touching_other_services() {
        let mut document: serde_yaml::Value = serde_yaml::from_str(
            r#"
services:
  web:
    image: old
    restart: always
  db:
    image: postgres
"#,
        )
        .unwrap();
        let input = json!({
            "image": "nginx:alpine",
            "name": "web-app",
            "env": ["MODE=prod"],
            "ports": [{"host": 8080, "container": 80, "protocol": "tcp"}],
            "mounts": [{"source": "web-data", "target": "/data", "readOnly": true}],
            "command": ["nginx", "-g", "daemon off;"],
            "restart": "unless-stopped",
            "nanoCpus": 1_500_000_000_i64,
            "memory": 536_870_912_i64
        });

        apply_service_input(&mut document, "web", &input).unwrap();

        let web = &document["services"]["web"];
        assert_eq!(web["image"].as_str(), Some("nginx:alpine"));
        assert_eq!(web["container_name"].as_str(), Some("web-app"));
        assert_eq!(web["ports"][0].as_str(), Some("127.0.0.1:8080:80/tcp"));
        assert_eq!(web["volumes"][0].as_str(), Some("web-data:/data:ro"));
        assert_eq!(web["cpus"].as_str(), Some("1.5"));
        assert_eq!(web["mem_limit"].as_str(), Some("536870912b"));
        assert_eq!(
            document["services"]["db"]["image"].as_str(),
            Some("postgres")
        );
    }
}
