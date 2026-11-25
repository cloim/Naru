//! Windows file changes under bind mounts, raised as Linux inotify events.
//!
//! WSL mounts Windows drives over 9P (drvfs at `/mnt/<drive>`), and nothing tells Linux when a file
//! changes on Windows, so dev servers in containers (Vite, webpack, nodemon) never see a save made in a
//! Windows editor. The Naru server watches the Windows folders of running containers' bind mounts (the
//! roots this agent reports) and sends what changed as `OP\tPATH` lines; this raises the event a Linux
//! change would have raised:
//!
//! - `C` (created), `M` (modified) and `A` (a folder to read again): sets the mode the file or folder
//!   already has. That raises `IN_ATTRIB` on it and in its parent's watch, which Node's `fs.watch`,
//!   chokidar, watchdog and `notify` all listen for. The contents and the write time stay as they are.
//! - `D` (deleted): the same on the parent folder, whose watchers read it again.
//!
//! drvfs makes a new inode on every lookup of a folder nothing holds, and an inotify watch sits on the
//! inode it was added to, so a change raised on a fresh inode reaches no watcher. Every folder under a
//! root is therefore held open with `O_PATH` (nothing opens on the Windows side), which keeps its inode.
//!
//! Paths are limited to the current roots, never follow a symlink and touch only regular files and
//! folders. The technique comes from Kiri (github.com/libracoder/kiri, Apache-2.0,
//! crates/kiri-init/src/linux/fsnotify.rs).
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::ffi::{CStr, CString};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{mpsc, OnceLock};

/// Where WSL mounts the Windows drives (Naru's wsl.conf keeps the default).
const AUTOMOUNT: &str = "/mnt/";
/// Folders held open in all, and under one root; past these, deeper folders of a huge tree go without,
/// and a data folder with thousands of subfolders cannot take the share of every other root.
const MAX_PINS: usize = 16384;
const MAX_PINS_PER_ROOT: usize = 4096;
/// Folders opened and listed between looks at the channel, so changes never wait behind a long walk.
const WALK_STEP: usize = 32;
/// Skipped when holding folders: dependency and git trees, which dev servers' watchers ignore by default
/// and which can hold most of a project's folders. The server sends no changes from them either.
pub const SKIP_DIRS: [&str; 2] = ["node_modules", ".git"];

pub enum Command {
    /// Every root in use: those gone are let go, new ones walked a little at a time.
    Roots(Vec<String>),
    /// The roots of a container just created, held at once.
    Hold(Vec<String>),
    /// Hold roots synchronously and signal when done (used before dockerd boots).
    HoldSync(Vec<String>, mpsc::Sender<()>),
    Events(Vec<String>),
}

/// The raiser runs on its own thread: holding folders walks whole trees over 9P. Commands come first;
/// the walk goes on a few folders at a time while none are waiting.
pub fn sender() -> &'static mpsc::Sender<Command> {
    static SENDER: OnceLock<mpsc::Sender<Command>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut raiser = Raiser::default();
            loop {
                let command = if raiser.walking() {
                    match rx.try_recv() {
                        Ok(command) => Some(command),
                        Err(mpsc::TryRecvError::Empty) => None,
                        Err(mpsc::TryRecvError::Disconnected) => return,
                    }
                } else {
                    match rx.recv() {
                        Ok(command) => Some(command),
                        Err(_) => return,
                    }
                };
                match command {
                    Some(Command::Roots(roots)) => raiser.set_roots(roots),
                    Some(Command::Hold(roots)) => raiser.hold_now(roots),
                    Some(Command::HoldSync(roots, done)) => {
                        raiser.hold_now(roots);
                        let _ = done.send(());
                    }
                    Some(Command::Events(lines)) => lines.iter().for_each(|l| raiser.raise_line(l)),
                    None => raiser.walk_some(WALK_STEP),
                }
            }
        });
        tx
    })
}

/// `/mnt/d/work/app` as `("/mnt/d", "work/app")`. Anything else, a `.` or `..` component, or a control
/// character is refused. The drive root itself (`/mnt/d`) has an empty relative part.
pub fn split_drive_path(path: &str) -> Option<(&str, &str)> {
    if path.contains(['\n', '\r', '\0', '\t']) {
        return None;
    }
    let rest = path.strip_prefix(AUTOMOUNT)?;
    let b = rest.as_bytes();
    if b.is_empty() || !b[0].is_ascii_lowercase() || (b.len() > 1 && b[1] != b'/') {
        return None;
    }
    let rel = rest.get(2..).unwrap_or("");
    if rel.split('/').any(|p| p == "." || p == "..") || rel.starts_with('/') || rel.ends_with('/') || rel.contains("//") {
        return None;
    }
    Some((&path[..AUTOMOUNT.len() + 1], rel))
}

fn under(path: &str, root: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

/// The Windows folders containers bind, from `/containers/json?all=1` (or one inspect): one root for
/// nested binds. Created containers count too, so their folders stay held from creation to start.
pub fn roots(containers: &Value) -> Vec<String> {
    let live = |c: &Value| c["State"].as_str().is_none_or(|s| ["running", "created", "restarting", "paused"].contains(&s));
    let mut found: Vec<String> = containers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| live(c))
        .flat_map(|c| c["Mounts"].as_array().cloned().unwrap_or_default())
        .filter(|m| m["Type"] == "bind")
        .filter_map(|m| m["Source"].as_str().map(str::to_owned))
        .filter(|s| split_drive_path(s).is_some_and(|(_, rel)| !rel.is_empty()))
        .collect();
    found.sort();
    found.dedup();
    let mut out: Vec<String> = Vec::new();
    for root in found {
        if !out.iter().any(|kept| under(&root, kept)) {
            out.push(root);
        }
    }
    out
}

/// Windows folders bound by saved containers that dockerd will auto-start on boot
/// (restart policy `always`, `on-failure`, or `unless-stopped` when not manually stopped).
/// Reading these before dockerd starts avoids the race where a dev server adds inotify watches
/// before the agent pins the drvfs folders.
pub fn saved_restart_roots(docker_root: &std::path::Path) -> Vec<String> {
    let dir = docker_root.join("containers");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let base = entry.path();
        let Ok(host_text) = std::fs::read_to_string(base.join("hostconfig.json")) else { continue };
        let Ok(host) = serde_json::from_str::<Value>(&host_text) else { continue };
        let policy = host["RestartPolicy"]["Name"].as_str().unwrap_or_default();
        let auto_start = match policy {
            "always" | "on-failure" => true,
            "unless-stopped" => {
                let cfg_text = std::fs::read_to_string(base.join("config.v2.json")).unwrap_or_default();
                let cfg = serde_json::from_str::<Value>(&cfg_text).unwrap_or_default();
                !cfg["ManuallyStopped"].as_bool().unwrap_or(false)
            }
            _ => false,
        };
        if !auto_start {
            continue;
        }
        for bind in host["Binds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let src = bind.split(':').next().unwrap_or_default();
            if split_drive_path(src).is_some_and(|(_, rel)| !rel.is_empty()) {
                found.push(src.to_string());
            }
        }
        for m in host["Mounts"].as_array().into_iter().flatten().filter(|m| m["Type"] == "bind") {
            if let Some(src) = m["Source"].as_str().filter(|s| split_drive_path(s).is_some_and(|(_, rel)| !rel.is_empty())) {
                found.push(src.to_string());
            }
        }
    }
    found.sort();
    found.dedup();
    let mut out: Vec<String> = Vec::new();
    for root in found {
        if !out.iter().any(|kept| under(&root, kept)) {
            out.push(root);
        }
    }
    out
}

const DIR_FLAGS: libc::c_int = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

fn open_at(dir: libc::c_int, name: &CStr, flags: libc::c_int) -> Option<OwnedFd> {
    // SAFETY: `dir` is a valid directory fd (or AT_FDCWD) and `name` is NUL-terminated.
    let raw = unsafe { libc::openat(dir, name.as_ptr(), flags) };
    // SAFETY: a non-negative result is a new fd this function owns.
    (raw >= 0).then(|| unsafe { OwnedFd::from_raw_fd(raw) })
}

/// The parent folder of `rel` under the drive `base`, each folder opened without following a symlink,
/// and the last component. An empty `rel` is the drive itself and has no parent here.
fn open_parent(base: &str, rel: &str) -> Option<(OwnedFd, CString)> {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    let (leaf, folders) = parts.split_last()?;
    let mut dir = open_at(libc::AT_FDCWD, &CString::new(base).ok()?, DIR_FLAGS)?;
    for folder in folders {
        dir = open_at(dir.as_raw_fd(), &CString::new(*folder).ok()?, DIR_FLAGS)?;
    }
    Some((dir, CString::new(*leaf).ok()?))
}

fn open_dir(path: &str) -> Option<OwnedFd> {
    let (base, rel) = split_drive_path(path)?;
    let (parent, leaf) = open_parent(base, rel)?;
    open_at(parent.as_raw_fd(), &leaf, DIR_FLAGS)
}

/// Sets the mode `fd` already has, through /proc/self/fd (an `O_PATH` fd cannot be chmod-ed directly):
/// the inode is the one opened, never a symlink swapped in since. Only regular files and folders.
fn chmod_same(fd: &OwnedFd) -> bool {
    // SAFETY: zeroed stat filled by fstat on a valid fd.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
        return false;
    }
    if !matches!(st.st_mode & libc::S_IFMT, libc::S_IFREG | libc::S_IFDIR) {
        return false;
    }
    let Ok(path) = CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())) else { return false };
    // SAFETY: valid NUL-terminated path.
    unsafe { libc::chmod(path.as_ptr(), st.st_mode & 0o7777) == 0 }
}

/// Raises the event for `path` itself: a file or a folder, opened without following a symlink.
fn touch(path: &str) -> bool {
    let Some((base, rel)) = split_drive_path(path) else { return false };
    let Some((parent, leaf)) = open_parent(base, rel) else { return false };
    open_at(parent.as_raw_fd(), &leaf, libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC).is_some_and(|fd| chmod_same(&fd))
}

fn parent_of(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

/// One root's folders still to hold, breadth first.
struct Walk {
    root: String,
    queue: VecDeque<String>,
    held: usize,
}

#[derive(Default)]
struct Raiser {
    roots: Vec<String>,
    held: HashMap<String, OwnedFd>,
    /// Newest root first; the walk takes one folder from each in turn.
    walks: Vec<Walk>,
    turn: usize,
}

impl Raiser {
    fn set_roots(&mut self, roots: Vec<String>) {
        self.held.retain(|path, _| roots.iter().any(|r| under(path, r)));
        self.walks.retain(|w| roots.contains(&w.root));
        let added: Vec<String> = roots.iter().filter(|r| !self.roots.contains(r)).cloned().collect();
        self.roots = roots;
        for root in added {
            self.walks.insert(0, Walk { queue: VecDeque::from([root.clone()]), root, held: 0 });
            self.turn = 0;
        }
    }

    fn walking(&self) -> bool {
        self.walks.iter().any(|w| !w.queue.is_empty())
    }

    /// Opens and lists up to `count` folders, one from each root in turn, queueing their subfolders.
    fn walk_some(&mut self, count: usize) {
        for _ in 0..count {
            self.walks.retain(|w| !w.queue.is_empty());
            if self.walks.is_empty() || self.held.len() >= MAX_PINS {
                self.walks.clear();
                return;
            }
            self.turn %= self.walks.len();
            let i = self.turn;
            self.turn += 1;
            self.step(i);
        }
    }

    /// Holds the next folder of one root's walk and queues its subfolders. Never follows a symlink;
    /// skips SKIP_DIRS.
    fn step(&mut self, i: usize) {
        let walk = &mut self.walks[i];
        let Some(dir) = walk.queue.pop_front() else { return };
        if walk.held >= MAX_PINS_PER_ROOT || self.held.len() >= MAX_PINS {
            walk.queue.clear();
            return;
        }
        let Some(fd) = open_dir(&dir) else { return };
        let list = std::fs::read_dir(format!("/proc/self/fd/{}", fd.as_raw_fd()));
        walk.held += 1;
        for entry in list.into_iter().flatten().flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if is_dir && !SKIP_DIRS.contains(&name.as_str()) && !name.contains(['\n', '\r', '\t']) {
                walk.queue.push_back(format!("{dir}/{name}"));
            }
        }
        self.held.insert(dir, fd);
    }

    /// A container was just created: holds its folders right away, before it starts and its dev server
    /// adds watches. A watch added first would sit on an inode drvfs drops, and never hear anything.
    fn hold_now(&mut self, roots: Vec<String>) {
        for root in roots {
            // Walked again even when already held: a folder deleted and made again since has a new inode.
            // Opening a folder still held gives the held one back, so watches on it lose nothing.
            self.walks.retain(|w| w.root != root);
            if !self.roots.iter().any(|r| under(&root, r)) {
                self.roots.push(root.clone());
            }
            self.walks.insert(0, Walk { queue: VecDeque::from([root.clone()]), root, held: 0 });
            while !self.walks[0].queue.is_empty() {
                self.step(0);
            }
        }
        self.turn = 0;
    }

    /// Holds a folder that just appeared at once, and queues its subfolders first in its root's walk.
    fn hold_new(&mut self, path: &str) {
        let Some(fd) = open_dir(path) else { return };
        if self.held.len() < MAX_PINS {
            self.held.insert(path.to_owned(), fd);
        }
        let root = self.roots.iter().find(|r| under(path, r)).cloned();
        if let Some(root) = root {
            match self.walks.iter_mut().find(|w| w.root == root) {
                Some(walk) => walk.queue.push_front(path.to_owned()),
                None => self.walks.insert(0, Walk { root, queue: VecDeque::from([path.to_owned()]), held: 0 }),
            }
        }
    }

    fn raise_line(&mut self, line: &str) {
        let Some((op, path)) = line.split_once('\t') else { return };
        if split_drive_path(path).is_none() || !self.roots.iter().any(|r| under(path, r)) {
            return;
        }
        if path.split('/').any(|p| SKIP_DIRS.contains(&p)) {
            return;
        }
        match op {
            "C" => {
                // A new folder is held before its parent hears of it, so a watcher that adds a watch on it
                // in answer gets the held inode.
                if parent_of(path).is_some_and(|p| self.held.contains_key(p)) {
                    self.hold_new(path);
                }
                touch(path);
            }
            "M" | "A" => {
                touch(path);
            }
            "D" => {
                self.held.retain(|p, _| !under(p, path));
                if let Some(parent) = parent_of(path).filter(|p| self.roots.iter().any(|r| under(p, r))) {
                    touch(parent);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_drive_paths_without_traversal() {
        assert_eq!(split_drive_path("/mnt/d/work/app.js"), Some(("/mnt/d", "work/app.js")));
        assert_eq!(split_drive_path("/mnt/d"), Some(("/mnt/d", "")));
        for bad in ["/mnt/d/../etc", "/mnt/d/./x", "/etc/passwd", "/mnt/D/x", "/mnt/dd/x", "/mnt/d/x\ny", "/mnt/d/x/", "/mnt/d//x", "/mnt/"] {
            assert_eq!(split_drive_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn roots_are_windows_binds_of_running_containers_without_nesting() {
        let containers = json!([
            { "Mounts": [
                { "Type": "bind", "Source": "/mnt/d/work/app" },
                { "Type": "bind", "Source": "/mnt/d/work/app/src" },
                { "Type": "volume", "Source": "/var/lib/docker/volumes/v/_data" },
                { "Type": "bind", "Source": "/home/x" },
                { "Type": "bind", "Source": "/mnt/c" }
            ] },
            { "State": "running", "Mounts": [{ "Type": "bind", "Source": "/mnt/d/work/app" }, { "Type": "bind", "Source": "/mnt/d/work/apple" }] },
            { "State": "exited", "Mounts": [{ "Type": "bind", "Source": "/mnt/d/old" }] }
        ]);
        assert_eq!(roots(&containers), ["/mnt/d/work/app", "/mnt/d/work/apple"]);
    }

    #[test]
    fn changes_outside_the_roots_are_ignored() {
        let mut raiser = Raiser { roots: vec!["/mnt/d/work/app".into()], ..Default::default() };
        // Nothing to open in this test environment; only the filtering decides whether a line is tried.
        raiser.raise_line("M\t/mnt/d/work/other/x.js");
        raiser.raise_line("M\t/mnt/d/work/app/node_modules/a/index.js");
        raiser.raise_line("X\t/mnt/d/work/app/x.js");
        raiser.raise_line("D\t/mnt/d/work/app");
        assert!(raiser.held.is_empty());
    }

    /// In WSL: `NARU_ROOTS=/mnt/d/a,/mnt/d/b <test binary> real_roots_are_held --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_roots_are_held() {
        let roots: Vec<String> = std::env::var("NARU_ROOTS").unwrap().split(',').map(String::from).collect();
        let mut raiser = Raiser::default();
        raiser.set_roots(roots.clone());
        while raiser.walking() {
            raiser.walk_some(WALK_STEP);
        }
        for root in &roots {
            let n = raiser.held.keys().filter(|p| under(p, root)).count();
            println!("{root}: {n} held, open_dir={}", open_dir(root).is_some());
        }
    }

    #[test]
    fn the_newest_root_walks_first_and_gone_roots_stop() {
        let mut raiser = Raiser::default();
        raiser.set_roots(vec!["/mnt/d/a".into(), "/mnt/d/b".into()]);
        raiser.set_roots(vec!["/mnt/d/a".into(), "/mnt/d/b".into(), "/mnt/d/c".into()]);
        assert_eq!(raiser.walks.iter().map(|w| w.root.as_str()).collect::<Vec<_>>(), ["/mnt/d/c", "/mnt/d/b", "/mnt/d/a"]);
        raiser.set_roots(vec!["/mnt/d/c".into()]);
        assert_eq!(raiser.walks.iter().map(|w| w.root.as_str()).collect::<Vec<_>>(), ["/mnt/d/c"]);
        assert!(raiser.walking());
        // Nothing exists here, so the walk ends without holding anything.
        raiser.walk_some(8);
        assert!(!raiser.walking() && raiser.held.is_empty());
    }

    #[test]
    fn saved_restart_roots_collects_auto_started_containers_only() {
        let dir = std::env::temp_dir().join(format!("naru-fsnotify-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c1 = dir.join("containers/c1");
        let c2 = dir.join("containers/c2");
        let c3 = dir.join("containers/c3");
        std::fs::create_dir_all(&c1).unwrap();
        std::fs::create_dir_all(&c2).unwrap();
        std::fs::create_dir_all(&c3).unwrap();
        std::fs::write(c1.join("hostconfig.json"), r#"{"RestartPolicy":{"Name":"always"},"Binds":["/mnt/d/app:/app:rw"]}"#).unwrap();
        std::fs::write(c2.join("hostconfig.json"), r#"{"RestartPolicy":{"Name":"unless-stopped"},"Mounts":[{"Type":"bind","Source":"/mnt/d/web"}]}"#).unwrap();
        std::fs::write(c2.join("config.v2.json"), r#"{"ManuallyStopped":true}"#).unwrap();
        std::fs::write(c3.join("hostconfig.json"), r#"{"RestartPolicy":{"Name":"no"},"Binds":["/mnt/d/nope:/x"]}"#).unwrap();
        assert_eq!(saved_restart_roots(&dir), vec!["/mnt/d/app"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
