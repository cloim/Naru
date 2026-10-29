//! Docker API request rewriting for Windows clients: host paths become WSL paths and proxies are filled in.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^([a-zA-Z]):(?:[\\/](.*))?$").unwrap());
static CREATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:/v[0-9.]+)?/(containers|volumes)/create(?:\?|$)").unwrap());
static BUILD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:/v[0-9.]+)?/build(?:\?|$)").unwrap());

/// Windows clients send host paths such as D:\work\app; the Linux engine sees drives under /mnt.
pub fn to_linux_path(value: &str) -> String {
    let Some(m) = DRIVE.captures(value) else { return value.to_string() };
    let rest = m.get(2).map_or("", |r| r.as_str()).replace('\\', "/");
    let rest = rest.trim_end_matches('/');
    let drive = m[1].to_lowercase();
    if rest.is_empty() {
        format!("/mnt/{drive}")
    } else {
        format!("/mnt/{drive}/{rest}")
    }
}

/// A bind is "source:target[:options]"; a drive source carries its own colon.
pub fn rewrite_bind(bind: &str) -> String {
    static WIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z]:[\\/]").unwrap());
    if !WIN.is_match(bind) {
        return bind.to_string();
    }
    match bind[2..].find(':') {
        None => to_linux_path(bind),
        Some(i) => {
            let end = i + 2;
            format!("{}{}", to_linux_path(&bind[..end]), &bind[end..])
        }
    }
}

/// The same variables the Docker CLI adds from its proxies config.
pub fn proxy_env(proxies: Option<&Value>) -> Vec<String> {
    let Some(p) = proxies else { return vec![] };
    [("HTTP_PROXY", "httpProxy"), ("HTTPS_PROXY", "httpsProxy"), ("NO_PROXY", "noProxy")]
        .into_iter()
        .filter_map(|(key, field)| p[field].as_str().filter(|v| !v.is_empty()).map(|v| (key, v)))
        .flat_map(|(key, value)| [format!("{key}={value}"), format!("{}={value}", key.to_lowercase())])
        .collect()
}

fn key(entry: &str) -> &str {
    entry.split('=').next().unwrap_or_default()
}

/// Values the client set win over proxies.
pub fn rewrite_container_create(mut body: Value, proxies: Option<&Value>) -> Value {
    let env = proxy_env(proxies);
    if !env.is_empty() && body.is_object() {
        let mut list: Vec<Value> = body["Env"].as_array().cloned().unwrap_or_default();
        let present: std::collections::HashSet<String> =
            list.iter().filter_map(Value::as_str).map(|e| key(e).to_string()).collect();
        list.extend(env.into_iter().filter(|e| !present.contains(key(e))).map(Value::from));
        body["Env"] = list.into();
    }
    if let Some(host) = body.get_mut("HostConfig").filter(|h| h.is_object()) {
        if let Some(binds) = host.get_mut("Binds").and_then(Value::as_array_mut) {
            for bind in binds.iter_mut() {
                if let Some(s) = bind.as_str() {
                    *bind = rewrite_bind(s).into();
                }
            }
        }
        if let Some(mounts) = host.get_mut("Mounts").and_then(Value::as_array_mut) {
            for mount in mounts.iter_mut().filter(|m| m["Type"] == "bind") {
                if let Some(source) = mount["Source"].as_str().map(to_linux_path) {
                    mount["Source"] = source.into();
                }
            }
        }
    }
    body
}

pub fn rewrite_volume_create(mut body: Value) -> Value {
    let bind = body["DriverOpts"]["o"].as_str().is_some_and(|o| Regex::new(r"\bbind\b").unwrap().is_match(o));
    if bind {
        if let Some(device) = body["DriverOpts"]["device"].as_str().map(to_linux_path) {
            body["DriverOpts"]["device"] = device.into();
        }
    }
    body
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Rewrite {
    Container,
    Volume,
}

/// Docker API create calls carry host paths in their JSON body; anything else passes through.
pub fn create_rewriter(method: &str, url: &str) -> Option<Rewrite> {
    if method != "POST" {
        return None;
    }
    CREATE.captures(url).map(|m| if &m[1] == "containers" { Rewrite::Container } else { Rewrite::Volume })
}

pub fn apply(rewrite: Rewrite, body: Value, proxies: Option<&Value>) -> Value {
    match rewrite {
        Rewrite::Container => rewrite_container_create(body, proxies),
        Rewrite::Volume => rewrite_volume_create(body),
    }
}

/// Builds receive proxies as build args, as the Docker CLI does.
pub fn rewrite_build_url(url: &str, proxies: Option<&Value>) -> String {
    let env = proxy_env(proxies);
    if env.is_empty() || !BUILD.is_match(url) {
        return url.to_string();
    }
    let Ok(mut parsed) = url::Url::parse(&format!("http://docker{url}")) else { return url.to_string() };
    let mut args: serde_json::Map<String, Value> = parsed
        .query_pairs()
        .find(|(k, _)| k == "buildargs")
        .and_then(|(_, v)| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    for entry in env {
        let (k, v) = entry.split_once('=').unwrap();
        args.entry(k.to_string()).or_insert_with(|| v.into());
    }
    let rest: Vec<(String, String)> =
        parsed.query_pairs().filter(|(k, _)| k != "buildargs").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    {
        let mut q = parsed.query_pairs_mut();
        q.clear();
        for (k, v) in &rest {
            q.append_pair(k, v);
        }
        q.append_pair("buildargs", &Value::Object(args).to_string());
    }
    format!("{}?{}", parsed.path(), parsed.query().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_paths_become_mnt_paths() {
        assert_eq!(to_linux_path(r"D:\work\app\"), "/mnt/d/work/app");
        assert_eq!(to_linux_path("C:"), "/mnt/c");
        assert_eq!(to_linux_path("/already/linux"), "/already/linux");
        assert_eq!(rewrite_bind(r"D:\work:/app:ro"), "/mnt/d/work:/app:ro");
        assert_eq!(rewrite_bind("named:/data"), "named:/data");
        let body = rewrite_container_create(
            json!({ "HostConfig": { "Binds": [r"C:\x:/x"], "Mounts": [{ "Type": "bind", "Source": r"E:\y" }, { "Type": "volume", "Source": "v" }] } }),
            None,
        );
        assert_eq!(body["HostConfig"]["Binds"][0], "/mnt/c/x:/x");
        assert_eq!(body["HostConfig"]["Mounts"][0]["Source"], "/mnt/e/y");
        assert_eq!(body["HostConfig"]["Mounts"][1]["Source"], "v");
        let vol = rewrite_volume_create(json!({ "DriverOpts": { "o": "bind", "device": r"D:\data" } }));
        assert_eq!(vol["DriverOpts"]["device"], "/mnt/d/data");
    }

    #[test]
    fn rewriter_matches_create_calls_only() {
        assert_eq!(create_rewriter("POST", "/v1.47/containers/create?name=a"), Some(Rewrite::Container));
        assert_eq!(create_rewriter("POST", "/volumes/create"), Some(Rewrite::Volume));
        assert_eq!(create_rewriter("GET", "/containers/create"), None);
        assert_eq!(create_rewriter("POST", "/containers/x/start"), None);
    }

    #[test]
    fn proxies_fill_only_what_the_client_left_out() {
        let proxies = json!({ "httpProxy": "http://p:1", "noProxy": "localhost" });
        let body = rewrite_container_create(json!({ "Env": ["HTTP_PROXY=http://mine:2"] }), Some(&proxies));
        assert_eq!(body["Env"], json!(["HTTP_PROXY=http://mine:2", "http_proxy=http://p:1", "NO_PROXY=localhost", "no_proxy=localhost"]));
        assert_eq!(rewrite_container_create(json!({ "Image": "a" }), None), json!({ "Image": "a" }));
        let url = rewrite_build_url("/v1.47/build?t=app&buildargs=%7B%22no_proxy%22%3A%22x%22%7D", Some(&proxies));
        let parsed = url::Url::parse(&format!("http://d{url}")).unwrap();
        let args: Value = serde_json::from_str(&parsed.query_pairs().find(|(k, _)| k == "buildargs").unwrap().1).unwrap();
        assert_eq!(args, json!({ "no_proxy": "x", "HTTP_PROXY": "http://p:1", "http_proxy": "http://p:1", "NO_PROXY": "localhost" }));
        assert_eq!(parsed.query_pairs().find(|(k, _)| k == "t").unwrap().1, "app");
        assert_eq!(rewrite_build_url("/v1.47/containers/json", Some(&proxies)), "/v1.47/containers/json");
        assert_eq!(rewrite_build_url("/build?t=a", None), "/build?t=a");
    }
}
