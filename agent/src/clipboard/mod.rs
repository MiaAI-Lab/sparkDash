//! `sparkdash-agent clipboard`: keeps this desktop's OS clipboard in step with
//! sparkDash's shared clipboard (docs/CLIPBOARD.md). It runs in the user's
//! desktop session, separately from the metrics service, and only when asked.
//!
//! Loops are prevented with one fingerprint of the OS clipboard: whatever this
//! process last read or wrote is "known", so writing a shared entry to the OS
//! clipboard is never mistaken for a new local copy. Shared entries this device
//! wrote, or whose content key it just uploaded, are not applied back.

mod api;
mod os;
mod png_codec;
#[cfg(target_os = "linux")]
mod wayland;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use api::{Api, ApiError, Entry, Limits};

pub const USAGE: &str = "\
usage: sparkdash-agent clipboard --dashboard URL [options]

  --dashboard URL        sparkDash address, e.g. http://127.0.0.1:5555
  --token-file PATH      file holding the dashboard's SPARKDASH_TOKEN (default:
                         sparkdash-agent/token in the user's config directory,
                         if present; none when the dashboard has no token)
  --device NAME          name shown in the clipboard history (default: hostname)
  --interval-ms N        how often the OS clipboard is checked (default 1000, floor 250)
  --files-dir PATH       where shared files are saved before they are put on
                         the clipboard (default: the cache directory)
";

/// Keeps the newest few downloaded file entries; older folders are removed.
const KEEP_FILE_ENTRIES: usize = 10;
const PAUSE_WHEN_REFUSED: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct Args {
    pub dashboard: String,
    pub token_file: Option<PathBuf>,
    pub device: String,
    pub interval: Duration,
    pub files_dir: Option<PathBuf>,
}

pub fn parse_args(mut it: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut dashboard = None;
    let mut a = Args {
        dashboard: String::new(),
        token_file: None,
        device: String::new(),
        interval: Duration::from_millis(1000),
        files_dir: None,
    };
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--dashboard" => {
                let v = value()?;
                if !(v.starts_with("http://") || v.starts_with("https://")) {
                    return Err(format!("--dashboard {v}: use an http:// or https:// URL"));
                }
                dashboard = Some(v.trim_end_matches('/').to_string());
            }
            "--token-file" => a.token_file = Some(value()?.into()),
            "--device" => {
                let v = value()?;
                a.device = device_name(&v).ok_or(format!(
                    "--device {v}: use letters, digits, '.', '_' or '-' (at most 64)"
                ))?;
            }
            "--interval-ms" => {
                let v = value()?;
                let ms: u64 = v
                    .parse()
                    .map_err(|_| format!("--interval-ms: not a number: {v}"))?;
                a.interval = Duration::from_millis(ms.max(250));
            }
            "--files-dir" => a.files_dir = Some(value()?.into()),
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("unknown option {other}")),
        }
    }
    a.dashboard = dashboard.ok_or("--dashboard is required")?;
    if a.device.is_empty() {
        a.device = device_name(&hostname()).unwrap_or_else(|| "desktop".into());
    }
    Ok(a)
}

/// The server's device-name rule; anything else is turned into it or refused.
fn device_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .split('.')
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let ok = cleaned
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric());
    ok.then_some(cleaned)
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        })
        .unwrap_or_default()
}

fn load_token(path: Option<&Path>) -> Result<Option<String>, String> {
    let Some(path) = path else { return Ok(None) };
    let token = std::fs::read_to_string(path)
        .map_err(|e| format!("token file {}: {e}", path.display()))?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(format!("token file {} is empty", path.display()));
    }
    Ok(Some(token))
}

/// What is on the OS clipboard, as read.
#[derive(Debug, Clone, PartialEq)]
pub enum Local {
    Text(String),
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Png(Vec<u8>),
    Rgba {
        width: usize,
        height: usize,
        bytes: Vec<u8>,
    },
    Files(Vec<PathBuf>),
}

/// What to put on the OS clipboard.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Text(String),
    Png(Vec<u8>),
    Files(Vec<PathBuf>),
}

pub fn fingerprint(local: &Local) -> u64 {
    let mut h = DefaultHasher::new();
    match local {
        Local::Text(t) => (0u8, t).hash(&mut h),
        Local::Png(b) => {
            1u8.hash(&mut h);
            h.write(b);
        }
        Local::Rgba {
            width,
            height,
            bytes,
        } => (2u8, width, height, bytes).hash(&mut h),
        Local::Files(paths) => {
            3u8.hash(&mut h);
            for p in paths {
                p.hash(&mut h);
                if let Ok(meta) = std::fs::metadata(p) {
                    meta.len().hash(&mut h);
                    meta.modified().ok().hash(&mut h);
                }
            }
        }
    }
    h.finish()
}

/// [`fingerprint`] of `Local::Png` read from a stream, without holding the image.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn png_fingerprint(mut r: impl std::io::Read) -> std::io::Result<u64> {
    let mut h = DefaultHasher::new();
    1u8.hash(&mut h);
    let mut buf = [0u8; 64 * 1024];
    loop {
        match r.read(&mut buf)? {
            0 => return Ok(h.finish()),
            n => h.write(&buf[..n]),
        }
    }
}

/// Doubling wait after failures, reset by a success.
#[derive(Default)]
struct Backoff {
    current: Option<Duration>,
}

impl Backoff {
    fn fail(&mut self) -> Duration {
        let next = self
            .current
            .map_or(Duration::from_secs(2), |d| (d * 2).min(MAX_BACKOFF));
        self.current = Some(next);
        next
    }
    fn reset(&mut self) {
        self.current = None;
    }
}

/// Decides, per shared entry, whether this device should apply it.
#[derive(Default)]
struct EchoGuard {
    uploaded_key: Option<String>,
    applied_key: Option<String>,
}

impl EchoGuard {
    fn should_apply(&self, entry: &Entry, device: &str) -> bool {
        if entry.source.device.as_deref() == Some(device) {
            return false;
        }
        let key = Some(&entry.content_key);
        key != self.uploaded_key.as_ref() && key != self.applied_key.as_ref()
    }
}

pub fn run(args: Args) -> i32 {
    let token_file = args
        .token_file
        .clone()
        .or_else(|| Some(config_dir()?.join("sparkdash-agent/token")).filter(|p| p.exists()));
    let token = match load_token(token_file.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("sparkdash-agent clipboard: {e}");
            return 2;
        }
    };
    let mut backend = match os::open() {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "sparkdash-agent clipboard: no desktop clipboard here ({e}); nothing to sync"
            );
            return 0;
        }
    };
    keep_big_buffers_out_of_the_heap();
    let api = Api::new(&args.dashboard, token, &args.device);
    let files_dir = args.files_dir.clone().unwrap_or_else(default_files_dir);
    eprintln!(
        "sparkdash-agent clipboard: syncing {} as {:?} ({} backend)",
        args.dashboard,
        args.device,
        backend.name()
    );

    let (tx, rx) = mpsc::channel::<Entry>();
    let poller = api.clone();
    std::thread::Builder::new()
        .name("clipboard changes".into())
        .spawn(move || watch_shared(poller, tx))
        .expect("spawn clipboard watcher");

    let mut limits: Option<Limits> = None;
    let mut known = backend.peek().ok().flatten();
    let mut guard = EchoGuard::default();
    let mut paused_until: Option<Instant> = None;
    let mut backoff = Backoff::default();

    loop {
        match rx.recv_timeout(args.interval) {
            Ok(entry) => {
                if guard.should_apply(&entry, &args.device) {
                    match fetch(&api, &entry, &files_dir) {
                        Ok(content) => match backend.write(&content) {
                            Ok(()) => {
                                known = backend.peek().ok().flatten();
                                guard.applied_key = Some(entry.content_key.clone());
                            }
                            Err(e) => {
                                eprintln!("sparkdash-agent clipboard: can't set the clipboard: {e}")
                            }
                        },
                        Err(e) => eprintln!(
                            "sparkdash-agent clipboard: can't fetch entry {}: {e}",
                            entry.id
                        ),
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return 1,
        }

        if paused_until.is_some_and(|t| Instant::now() < t) {
            continue;
        }
        // A paused share is retried even if the clipboard's change counter has
        // not moved since: the counter was spent on the attempt that failed.
        let retrying = paused_until.take().is_some();
        if !backend.changed() && !retrying {
            continue;
        }
        let unchanged = match backend.peek() {
            Ok(fp) => fp.is_none() || fp == known,
            Err(e) => {
                eprintln!("sparkdash-agent clipboard: can't read the clipboard: {e}");
                true
            }
        };
        if unchanged {
            continue;
        }
        let Ok(Some(local)) = backend.read() else {
            continue;
        };
        let fp = fingerprint(&local);
        if limits.is_none() {
            limits = api.limits().ok();
        }
        let Some(lim) = limits.as_ref() else {
            paused_until = Some(Instant::now() + backoff.fail());
            continue;
        };
        match upload(&api, local, lim) {
            Ok(Some(entry)) => {
                known = Some(fp);
                guard.uploaded_key = Some(entry.content_key);
                backoff.reset();
            }
            Ok(None) => known = Some(fp),
            Err(ApiError::TooLarge(msg)) => {
                eprintln!("sparkdash-agent clipboard: not shared, too large: {msg}");
                known = Some(fp);
            }
            Err(e @ (ApiError::Off | ApiError::Refused(_))) => {
                eprintln!("sparkdash-agent clipboard: {e}; trying again in a minute");
                paused_until = Some(Instant::now() + PAUSE_WHEN_REFUSED);
            }
            Err(e) => {
                let wait = backoff.fail();
                eprintln!("sparkdash-agent clipboard: share failed ({e}); retrying in {wait:?}");
                paused_until = Some(Instant::now() + wait);
            }
        }
    }
}

/// Long-polls the dashboard and forwards each new latest entry. The first
/// answer only sets the starting revision: starting up never overwrites the
/// local clipboard with an older shared copy.
fn watch_shared(api: Api, tx: mpsc::Sender<Entry>) {
    let mut since: Option<i64> = None;
    let mut backoff = Backoff::default();
    loop {
        match api.changes(since, Duration::from_secs(25)) {
            Ok((revision, latest)) => {
                backoff.reset();
                let first = since.is_none();
                if since != Some(revision) {
                    since = Some(revision);
                    if let (false, Some(entry)) = (first, latest) {
                        if tx.send(entry).is_err() {
                            return;
                        }
                    }
                }
            }
            Err(e @ (ApiError::Off | ApiError::Refused(_))) => {
                eprintln!("sparkdash-agent clipboard: {e}; trying again in a minute");
                std::thread::sleep(PAUSE_WHEN_REFUSED);
            }
            Err(e) => {
                let wait = backoff.fail();
                eprintln!("sparkdash-agent clipboard: can't reach the dashboard ({e}); retrying in {wait:?}");
                std::thread::sleep(wait);
            }
        }
    }
}

fn fetch(api: &Api, entry: &Entry, files_dir: &Path) -> Result<Content, ApiError> {
    match entry.kind.as_str() {
        "text" => api.text(&entry.id).map(Content::Text),
        "image" => {
            let part = entry
                .parts
                .first()
                .ok_or(ApiError::Protocol("image entry without a part".into()))?;
            api.part(&entry.id, &part.id).map(Content::Png)
        }
        "files" => {
            let dir = files_dir.join(&entry.id);
            std::fs::create_dir_all(&dir).map_err(|e| ApiError::Io(e.to_string()))?;
            let mut paths = Vec::with_capacity(entry.parts.len());
            for part in &entry.parts {
                let bytes = api.part(&entry.id, &part.id)?;
                let path = dir.join(safe_file_name(&part.name));
                std::fs::write(&path, bytes).map_err(|e| ApiError::Io(e.to_string()))?;
                paths.push(path);
            }
            prune_file_entries(files_dir, KEEP_FILE_ENTRIES);
            Ok(Content::Files(paths))
        }
        other => Err(ApiError::Protocol(format!("unknown entry type {other}"))),
    }
}

/// Sends a local copy. `Ok(None)` when there was nothing shareable in it.
fn upload(api: &Api, local: Local, limits: &Limits) -> Result<Option<Entry>, ApiError> {
    match local {
        Local::Text(text) => {
            if text.is_empty() {
                return Ok(None);
            }
            if text.len() as u64 > limits.max_text_bytes {
                return Err(ApiError::TooLarge(format!("{} bytes of text", text.len())));
            }
            api.post_text(&text).map(Some)
        }
        Local::Png(bytes) => upload_image(api, bytes, limits),
        Local::Rgba {
            width,
            height,
            bytes,
        } => {
            let png = png_codec::encode(width, height, &bytes).map_err(ApiError::Io)?;
            upload_image(api, png, limits)
        }
        Local::Files(paths) => {
            let files: Vec<(PathBuf, u64)> = paths
                .into_iter()
                .filter_map(|p| {
                    std::fs::metadata(&p)
                        .ok()
                        .filter(|m| m.is_file())
                        .map(|m| (p, m.len()))
                })
                .collect();
            if files.is_empty() {
                return Ok(None);
            }
            let total: u64 = files.iter().map(|(_, n)| n).sum();
            if files.len() as u64 > limits.max_parts
                || total > limits.max_entry_bytes
                || files.iter().any(|(_, n)| *n > limits.max_part_bytes)
            {
                return Err(ApiError::TooLarge(format!(
                    "{} files, {total} bytes",
                    files.len()
                )));
            }
            let mut ids = Vec::with_capacity(files.len());
            for (path, _) in &files {
                let bytes = std::fs::read(path).map_err(|e| ApiError::Io(e.to_string()))?;
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "file".into());
                ids.push(api.upload(&name, mime_for(&name), bytes)?);
            }
            api.commit(&ids, "files").map(Some)
        }
    }
}

fn upload_image(api: &Api, png: Vec<u8>, limits: &Limits) -> Result<Option<Entry>, ApiError> {
    if png.len() as u64 > limits.max_part_bytes {
        return Err(ApiError::TooLarge(format!("{} byte image", png.len())));
    }
    let id = api.upload("clipboard.png", "image/png", png)?;
    api.commit(&[id], "image").map(Some)
}

fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    match cleaned.trim() {
        "" | "." | ".." => "file".into(),
        n => n.to_string(),
    }
}

fn prune_file_entries(dir: &Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = read
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.0));
    for (_, path) in dirs.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Images are read every check on some desktops. glibc raises its mmap threshold
/// after the first large free, after which those buffers stay in the heap and the
/// RSS never comes back down; a fixed threshold hands them back to the kernel.
fn keep_big_buffers_out_of_the_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, 256 * 1024);
    }
}

fn config_dir() -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".config")))
    }
}

fn default_files_dir() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("sparkdash-clipboard")
}

#[cfg(test)]
mod tests {
    use super::*;
    use api::{Part, Source};

    fn args(list: &[&str]) -> Result<Args, String> {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    fn entry(key: &str, device: Option<&str>) -> Entry {
        Entry {
            id: "e".into(),
            kind: "text".into(),
            content_key: key.into(),
            parts: Vec::<Part>::new(),
            source: Source {
                device: device.map(Into::into),
            },
        }
    }

    #[test]
    fn parses_arguments() {
        assert!(args(&[]).is_err());
        assert!(args(&["--dashboard", "ftp://x"]).is_err());
        assert!(args(&["--dashboard", "http://x", "--device", "-bad"]).is_err());
        let a = args(&[
            "--dashboard",
            "http://127.0.0.1:5555/",
            "--device",
            "desk-01",
            "--interval-ms",
            "10",
        ])
        .unwrap();
        assert_eq!(a.dashboard, "http://127.0.0.1:5555");
        assert_eq!(a.device, "desk-01");
        assert_eq!(a.interval, Duration::from_millis(250));
        assert!(!args(&["--dashboard", "https://x"])
            .unwrap()
            .device
            .is_empty());
    }

    #[test]
    fn device_names_follow_the_server_rule() {
        assert_eq!(
            device_name("work station.local").as_deref(),
            Some("work-station")
        );
        assert_eq!(device_name(" box_1 ").as_deref(), Some("box_1"));
        assert_eq!(device_name(&"a".repeat(80)).map(|n| n.len()), Some(64));
        assert_eq!(device_name(""), None);
    }

    #[test]
    fn echo_guard_skips_own_and_known_entries() {
        let mut g = EchoGuard::default();
        assert!(g.should_apply(&entry("k1", Some("other")), "me"));
        assert!(!g.should_apply(&entry("k1", Some("me")), "me"));
        g.uploaded_key = Some("k1".into());
        assert!(!g.should_apply(&entry("k1", None), "me"));
        g.applied_key = Some("k2".into());
        assert!(!g.should_apply(&entry("k2", None), "me"));
        assert!(g.should_apply(&entry("k3", None), "me"));
    }

    #[test]
    fn fingerprints_tell_kinds_and_content_apart() {
        let text = fingerprint(&Local::Text("a".into()));
        assert_eq!(text, fingerprint(&Local::Text("a".into())));
        assert_ne!(text, fingerprint(&Local::Text("b".into())));
        assert_ne!(
            fingerprint(&Local::Png(vec![1])),
            fingerprint(&Local::Rgba {
                width: 1,
                height: 1,
                bytes: vec![1]
            })
        );
    }

    #[test]
    fn streamed_png_fingerprint_matches_the_buffered_one() {
        let png: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            png_fingerprint(&png[..]).unwrap(),
            fingerprint(&Local::Png(png.clone()))
        );
    }

    #[test]
    fn backoff_doubles_to_a_minute_and_resets() {
        let mut b = Backoff::default();
        assert_eq!(b.fail(), Duration::from_secs(2));
        assert_eq!(b.fail(), Duration::from_secs(4));
        for _ in 0..10 {
            b.fail();
        }
        assert_eq!(b.fail(), MAX_BACKOFF);
        b.reset();
        assert_eq!(b.fail(), Duration::from_secs(2));
    }

    #[test]
    fn file_names_cannot_leave_their_folder() {
        assert_eq!(safe_file_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_file_name(".."), "file");
        assert_eq!(safe_file_name("report final.pdf"), "report final.pdf");
    }

    #[test]
    fn keeps_only_the_newest_file_entries() {
        let root =
            std::env::temp_dir().join(format!("sparkdash-clip-prune-{}", std::process::id()));
        for i in 0..4 {
            std::fs::create_dir_all(root.join(format!("e{i}"))).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }
        prune_file_entries(&root, 2);
        let mut left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        left.sort();
        assert_eq!(left, ["e2", "e3"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
