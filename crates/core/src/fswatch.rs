//! Windows side of bind-mount change notification (the WSL side is crates/agent/src/fsnotify.rs).
//!
//! naru-agent reports the Windows folders running containers bind (`roots`, as `/mnt/<drive>/...`). Each
//! is watched here with ReadDirectoryChangesW, and what changed goes back to the agent in batches over
//! the port-forwarding control channel, where it is raised as an inotify event.
//!
//! The watch asks for names, size and last-write changes only, not attributes: the agent raises an
//! event by setting a file's mode again, which drvfs (mounted with `metadata`) stores as a Windows
//! attribute change. Watching attributes would hear every raised event as a new change, endlessly.
//! Changes under `node_modules` and `.git` are not sent: dev servers ignore them, and an install would
//! otherwise send thousands.
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
#[cfg(not(windows))]
use std::sync::{atomic::AtomicBool, Arc};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// Changes are gathered this long, then sent together.
const BATCH: Duration = Duration::from_millis(50);
/// Most lines in one message.
const MAX_LINES: usize = 512;
/// How often a watch that ended (its folder deleted, say) is tried again.
const RETRY: Duration = Duration::from_secs(5);
pub const SKIP_DIRS: [&str; 2] = ["node_modules", ".git"];

#[derive(Default)]
struct State {
    /// The roots the agent reported last.
    roots: Vec<String>,
    watchers: HashMap<String, Watcher>,
    sender: Option<mpsc::UnboundedSender<(char, String)>>,
    enabled: bool,
    /// Roots whose watch failed to start, reported once until one starts again.
    failed: HashSet<String>,
    retrying: bool,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

/// `/mnt/d/work/app` as `D:\work\app`, for the roots the agent reports.
pub fn to_windows_path(linux: &str) -> Option<String> {
    let rest = linux.strip_prefix("/mnt/")?;
    let mut chars = rest.chars();
    let drive = chars.next().filter(char::is_ascii_lowercase)?;
    let tail = chars.as_str();
    if !(tail.is_empty() || tail.starts_with('/')) {
        return None;
    }
    Some(format!("{}:{}", drive.to_ascii_uppercase(), if tail.is_empty() { "\\".to_string() } else { tail.replace('/', "\\") }))
}

/// One change as the agent reads it: `C`, `M`, `D` or `A`, a tab and the Linux path. `None` for changes
/// the agent need not hear of.
pub fn line(op: char, root: &str, relative: &str) -> Option<String> {
    let relative = relative.replace('\\', "/");
    if relative.split('/').any(|p| SKIP_DIRS.contains(&p) || p == ".." || p == ".") || relative.contains(['\n', '\r', '\t', '\0']) {
        return None;
    }
    let path = if relative.is_empty() { root.to_string() } else { format!("{root}/{relative}") };
    Some(format!("{op}\t{path}"))
}

/// Keeps the last change of each path, in the order paths last changed: a save as delete-then-create
/// needs only its create, and a create-then-delete only its delete.
pub fn merge(events: Vec<(char, String)>) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut last: HashMap<String, char> = HashMap::new();
    for (op, path) in events {
        if last.insert(path.clone(), op).is_some() {
            order.retain(|p| p != &path);
        }
        order.push(path);
    }
    order.into_iter().map(|path| format!("{}\t{path}", last[&path])).collect()
}

/// The roots naru-agent reported; an empty list when the agent went away. Watches follow them while the
/// setting is on.
pub async fn set_roots(roots: Vec<String>) {
    let enabled = crate::state::settings().await.map(|s| s.watch_windows_folders).unwrap_or(true);
    let mut state = STATE.lock().unwrap();
    state.roots = roots;
    state.enabled = enabled;
    apply(&mut state);
    if !state.retrying {
        state.retrying = true;
        tokio::spawn(async {
            loop {
                tokio::time::sleep(RETRY).await;
                apply(&mut STATE.lock().unwrap());
            }
        });
    }
}

/// Settings changed: start or stop watching the roots already known.
pub fn set_enabled(enabled: bool) {
    let mut state = STATE.lock().unwrap();
    state.enabled = enabled;
    apply(&mut state);
}

fn apply(state: &mut State) {
    let wanted: Vec<String> = if state.enabled { state.roots.clone() } else { Vec::new() };
    state.watchers.retain(|root, w| wanted.contains(root) && w.alive.load(Ordering::Relaxed));
    state.failed.retain(|root| wanted.contains(root));
    for root in wanted {
        if state.watchers.contains_key(&root) {
            continue;
        }
        let Some(windows) = to_windows_path(&root) else { continue };
        let sender = state.sender.get_or_insert_with(start_sender).clone();
        match Watcher::start(&windows, &root, sender) {
            Ok(watcher) => {
                state.failed.remove(&root);
                state.watchers.insert(root, watcher);
            }
            Err(e) => {
                if state.failed.insert(root) {
                    eprintln!("폴더 변경 감지를 시작하지 못했습니다: {windows}: {e}");
                }
            }
        }
    }
}

/// Gathers changes for BATCH and sends them to the agent.
fn start_sender() -> mpsc::UnboundedSender<(char, String)> {
    let (tx, mut rx) = mpsc::unbounded_channel::<(char, String)>();
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut events = vec![first];
            tokio::time::sleep(BATCH).await;
            while let Ok(event) = rx.try_recv() {
                events.push(event);
            }
            for chunk in merge(events).chunks(MAX_LINES) {
                crate::ports::send_control(json!({ "type": "fs", "events": chunk }).to_string());
            }
        }
    });
    tx
}

#[cfg(windows)]
use watcher::Watcher;

#[cfg(windows)]
mod watcher {
    use super::line;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME,
        FILE_ACTION_RENAMED_OLD_NAME, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    /// A watch on one root, on its own thread. Dropping it stops the thread, which closes its handles.
    pub struct Watcher {
        stop: usize,
        /// False once the thread ended, so the watch is started again.
        pub alive: Arc<AtomicBool>,
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            // SAFETY: the thread closes this event only after it has seen it set.
            unsafe { SetEvent(self.stop as HANDLE) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl Watcher {
        pub fn start(windows: &str, root: &str, sender: mpsc::UnboundedSender<(char, String)>) -> std::io::Result<Watcher> {
            let path = wide(windows);
            // SAFETY: valid null-terminated path; a directory opens with BACKUP_SEMANTICS, read for change lists.
            let dir = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if dir == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: manual-reset events with no name.
            let stop = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            let ready = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if stop.is_null() || ready.is_null() {
                let e = std::io::Error::last_os_error();
                // SAFETY: handles opened above.
                unsafe {
                    CloseHandle(dir);
                    if !stop.is_null() {
                        CloseHandle(stop);
                    }
                    if !ready.is_null() {
                        CloseHandle(ready);
                    }
                }
                return Err(e);
            }
            let (dir_raw, stop_raw, ready_raw) = (dir as usize, stop as usize, ready as usize);
            let (root, windows) = (root.to_string(), windows.to_string());
            let alive = Arc::new(AtomicBool::new(true));
            let flag = alive.clone();
            std::thread::spawn(move || {
                run(dir_raw as HANDLE, stop_raw as HANDLE, ready_raw as HANDLE, &root, &windows, &sender);
                flag.store(false, Ordering::Relaxed);
            });
            Ok(Watcher { stop: stop_raw, alive })
        }
    }

    fn run(dir: HANDLE, stop: HANDLE, ready: HANDLE, root: &str, windows: &str, sender: &mpsc::UnboundedSender<(char, String)>) {
        // DWORD-aligned, as ReadDirectoryChangesW requires; 64 KiB is the most a network share accepts.
        let mut buf = vec![0u32; 16 * 1024];
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;
        loop {
            // SAFETY: zeroed OVERLAPPED with our event; `buf` and `ov` outlive the request, which is
            // completed or cancelled and waited for before either is reused or dropped.
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = ready;
            let size = (buf.len() * 4) as u32;
            let ok = unsafe { ReadDirectoryChangesW(dir, buf.as_mut_ptr().cast(), size, 1, filter, std::ptr::null_mut(), &mut ov, None) };
            if ok == 0 {
                break;
            }
            let handles = [ready, stop];
            // SAFETY: both handles are valid events.
            let which = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            let mut bytes = 0u32;
            if which != WAIT_OBJECT_0 {
                // SAFETY: cancel and wait for the request issued above before its buffer goes away.
                unsafe {
                    CancelIoEx(dir, &ov);
                    GetOverlappedResult(dir, &ov, &mut bytes, 1);
                }
                break;
            }
            // SAFETY: the request completed; this reads its result.
            if unsafe { GetOverlappedResult(dir, &ov, &mut bytes, 0) } == 0 {
                break;
            }
            // SAFETY: manual-reset event, reset before the next request.
            unsafe { windows_sys::Win32::System::Threading::ResetEvent(ready) };
            if bytes == 0 {
                // The folder itself is gone: end, and the watch is tried again once it is back.
                if !std::path::Path::new(windows).is_dir() {
                    break;
                }
                // Too many changes for the buffer: have the root's watchers read it again.
                let _ = sender.send(('A', root.to_string()));
                continue;
            }
            for (action, name) in entries(&buf, bytes as usize) {
                let op = match action {
                    FILE_ACTION_ADDED | FILE_ACTION_RENAMED_NEW_NAME => 'C',
                    FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME => 'D',
                    FILE_ACTION_MODIFIED => 'M',
                    _ => continue,
                };
                if let Some(l) = line(op, root, &name) {
                    let path = l[2..].to_string();
                    if sender.send((op, path)).is_err() {
                        break;
                    }
                }
            }
        }
        // SAFETY: this thread owns the three handles; nothing uses them after this.
        unsafe {
            CloseHandle(dir);
            CloseHandle(ready);
            CloseHandle(stop);
        }
    }

    /// The FILE_NOTIFY_INFORMATION records in the first `len` bytes: action and relative name.
    pub(super) fn entries(buf: &[u32], len: usize) -> Vec<(u32, String)> {
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast(), (buf.len() * 4).min(len)) };
        let mut out = Vec::new();
        let mut offset = 0usize;
        while offset + 12 <= bytes.len() {
            let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let (next, action, name_len) = (u32_at(offset) as usize, u32_at(offset + 4), u32_at(offset + 8) as usize);
            let start = offset + 12;
            let Some(raw) = bytes.get(start..start + name_len) else { break };
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            out.push((action, String::from_utf16_lossy(&units)));
            if next == 0 {
                break;
            }
            offset += next;
        }
        out
    }
}

#[cfg(not(windows))]
struct Watcher {
    alive: Arc<AtomicBool>,
}

#[cfg(not(windows))]
impl Watcher {
    fn start(_: &str, _: &str, _: mpsc::UnboundedSender<(char, String)>) -> std::io::Result<Watcher> {
        Err(std::io::Error::other("Windows only"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::to_linux_path;

    #[test]
    fn roots_become_windows_paths() {
        assert_eq!(to_windows_path("/mnt/d/work/app").as_deref(), Some(r"D:\work\app"));
        assert_eq!(to_windows_path("/mnt/c").as_deref(), Some(r"C:\"));
        assert_eq!(to_windows_path("/mnt/dd/x"), None);
        assert_eq!(to_windows_path("/home/x"), None);
        assert_eq!(to_linux_path(&to_windows_path("/mnt/d/work/app").unwrap()), "/mnt/d/work/app");
    }

    #[test]
    fn lines_skip_dependency_trees() {
        assert_eq!(line('M', "/mnt/d/app", r"src\main.js").as_deref(), Some("M\t/mnt/d/app/src/main.js"));
        assert_eq!(line('A', "/mnt/d/app", "").as_deref(), Some("A\t/mnt/d/app"));
        assert_eq!(line('C', "/mnt/d/app", r"node_modules\x\index.js"), None);
        assert_eq!(line('M', "/mnt/d/app", r".git\index"), None);
        assert_eq!(line('M', "/mnt/d/app", "a\tb"), None);
    }

    #[test]
    fn a_batch_keeps_each_paths_last_change() {
        let events = vec![('D', "/a".into()), ('M', "/b".into()), ('C', "/a".into()), ('C', "/c".into()), ('D', "/c".into())];
        assert_eq!(merge(events), ["M\t/b", "C\t/a", "D\t/c"]);
    }

    #[cfg(windows)]
    #[test]
    fn notify_records_are_read() {
        // Two records: "a.js" modified, then "b" added.
        let mut bytes = Vec::new();
        let name = |s: &str| s.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
        let (a, b) = (name("a.js"), name("b"));
        let first_len = (12 + a.len()).div_ceil(4) * 4;
        bytes.extend((first_len as u32).to_le_bytes());
        bytes.extend(3u32.to_le_bytes());
        bytes.extend((a.len() as u32).to_le_bytes());
        bytes.extend(&a);
        bytes.resize(first_len, 0);
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        bytes.extend((b.len() as u32).to_le_bytes());
        bytes.extend(&b);
        let len = bytes.len();
        bytes.resize(len.div_ceil(4) * 4, 0);
        let buf: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(watcher::entries(&buf, len), [(3, "a.js".to_string()), (1, "b".to_string())]);
    }

    /// A real watch: a save, a new file and a delete arrive; a chmod-like attribute change does not.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_real_folder_reports_saves_but_not_attribute_changes() {
        let dir = std::env::temp_dir().join(format!("naru-fswatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("a.txt"), "one").unwrap();
        let root = "/mnt/x/watched";
        let (tx, mut rx) = mpsc::unbounded_channel();
        let watcher = Watcher::start(&dir.to_string_lossy(), root, tx).unwrap();
        assert!(watcher.alive.load(Ordering::Relaxed));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut perms = std::fs::metadata(dir.join("a.txt")).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(dir.join("a.txt"), perms.clone()).unwrap();
        perms.set_readonly(false);
        std::fs::set_permissions(dir.join("a.txt"), perms).unwrap();
        std::fs::write(dir.join("node_modules").join("x.js"), "skip").unwrap();
        std::fs::write(dir.join("a.txt"), "two").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        drop(watcher);
        let mut got = Vec::new();
        while let Ok(event) = rx.try_recv() {
            got.push(event);
        }
        let merged = merge(got);
        assert_eq!(merged, [format!("M\t{root}/a.txt"), format!("D\t{root}/b.txt")], "{merged:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
