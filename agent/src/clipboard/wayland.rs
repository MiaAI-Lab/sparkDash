//! Wayland through the data-control protocol (wlroots compositors, KDE, and
//! others that implement it). Images stay as the PNG bytes the source offered,
//! so an unchanged image is hashed, never decoded, on each check.

use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;

use wl_clipboard_rs::copy::{self, MimeSource, Options, Source};
use wl_clipboard_rs::paste::{self, get_contents, get_mime_types, ClipboardType, Seat};

use super::os::Backend;
use super::{Content, Local};

const TEXT_TYPES: [&str; 4] = [
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "STRING",
];
const URI_LIST: &str = "text/uri-list";
const GNOME_FILES: &str = "x-special/gnome-copied-files";
const PNG: &str = "image/png";
/// Offered by KeePassXC and other password managers on secrets.
const SECRET_HINT: &str = "x-kde-passwordManagerHint";
const MAX_READ: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum Kind {
    Files,
    Png,
    Text(&'static str),
}

/// What to read from the offered types; `None` for secrets and anything unsupported.
pub fn classify(types: &HashSet<String>) -> Option<Kind> {
    if types.contains(SECRET_HINT) {
        return None;
    }
    if types.contains(URI_LIST) {
        return Some(Kind::Files);
    }
    if types.contains(PNG) {
        return Some(Kind::Png);
    }
    TEXT_TYPES
        .into_iter()
        .find(|t| types.contains(*t))
        .map(Kind::Text)
}

pub struct WaylandBackend;

impl WaylandBackend {
    pub fn open() -> Result<Self, String> {
        match get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
            Ok(_) | Err(paste::Error::ClipboardEmpty | paste::Error::NoSeats) => Ok(WaylandBackend),
            Err(e) => Err(format!("Wayland clipboard unavailable: {e}")),
        }
    }
}

fn open_type(mime: &str) -> Result<impl Read, String> {
    let (pipe, _) = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        paste::MimeType::Specific(mime),
    )
    .map_err(|e| e.to_string())?;
    Ok(pipe)
}

fn read_type(mime: &str) -> Result<Vec<u8>, String> {
    let pipe = open_type(mime)?;
    let mut out = Vec::new();
    pipe.take(MAX_READ)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Local paths from a text/uri-list; other schemes and comments are skipped.
pub fn paths_from_uri_list(list: &str) -> Vec<PathBuf> {
    list.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("file://"))
        .map(|rest| rest.find('/').map_or(rest, |i| &rest[i..]))
        .map(|p| PathBuf::from(percent_decode(p)))
        .collect()
}

pub fn uri_list(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| format!("file://{}\r\n", percent_encode(&p.to_string_lossy())))
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn offered() -> Result<Option<HashSet<String>>, String> {
    match get_mime_types(ClipboardType::Regular, Seat::Unspecified) {
        Ok(t) => Ok(Some(t)),
        Err(paste::Error::ClipboardEmpty | paste::Error::NoSeats) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

impl Backend for WaylandBackend {
    fn name(&self) -> &'static str {
        "Wayland"
    }

    fn peek(&mut self) -> Result<Option<u64>, String> {
        let Some(types) = offered()? else {
            return Ok(None);
        };
        if classify(&types) == Some(Kind::Png) {
            let fp = super::png_fingerprint(open_type(PNG)?.take(MAX_READ))
                .map_err(|e| e.to_string())?;
            return Ok(Some(fp));
        }
        Ok(self.read()?.as_ref().map(super::fingerprint))
    }

    fn read(&mut self) -> Result<Option<Local>, String> {
        let Some(types) = offered()? else {
            return Ok(None);
        };
        match classify(&types) {
            None => Ok(None),
            Some(Kind::Files) => {
                let paths = paths_from_uri_list(&String::from_utf8_lossy(&read_type(URI_LIST)?));
                if !paths.is_empty() {
                    return Ok(Some(Local::Files(paths)));
                }
                match TEXT_TYPES.into_iter().find(|t| types.contains(*t)) {
                    Some(t) => Ok(Some(Local::Text(
                        String::from_utf8_lossy(&read_type(t)?).into_owned(),
                    ))),
                    None => Ok(None),
                }
            }
            Some(Kind::Png) => Ok(Some(Local::Png(read_type(PNG)?))),
            Some(Kind::Text(t)) => Ok(Some(Local::Text(
                String::from_utf8_lossy(&read_type(t)?).into_owned(),
            ))),
        }
    }

    fn write(&mut self, content: &Content) -> Result<(), String> {
        let bytes = |b: &[u8]| Source::Bytes(b.to_vec().into_boxed_slice());
        let sources = match content {
            Content::Text(t) => vec![MimeSource {
                source: bytes(t.as_bytes()),
                mime_type: copy::MimeType::Text,
            }],
            Content::Png(b) => vec![MimeSource {
                source: bytes(b),
                mime_type: copy::MimeType::Specific(PNG.into()),
            }],
            Content::Files(paths) => {
                let list = uri_list(paths);
                let gnome = format!("copy\n{}", list.trim_end().replace("\r\n", "\n"));
                vec![
                    MimeSource {
                        source: bytes(list.as_bytes()),
                        mime_type: copy::MimeType::Specific(URI_LIST.into()),
                    },
                    MimeSource {
                        source: bytes(gnome.as_bytes()),
                        mime_type: copy::MimeType::Specific(GNOME_FILES.into()),
                    },
                ]
            }
        };
        Options::new()
            .copy_multi(sources)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(types: &[&str]) -> HashSet<String> {
        types.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn classifies_offers() {
        assert_eq!(classify(&set(&["text/plain", SECRET_HINT])), None);
        assert_eq!(classify(&set(&[URI_LIST, "text/plain"])), Some(Kind::Files));
        assert_eq!(classify(&set(&[PNG, "text/html"])), Some(Kind::Png));
        assert_eq!(
            classify(&set(&["UTF8_STRING", "text/plain"])),
            Some(Kind::Text("text/plain"))
        );
        assert_eq!(classify(&set(&["application/x-thing"])), None);
    }

    #[test]
    fn uri_lists_round_trip() {
        let paths = vec![
            PathBuf::from("/tmp/a b/ü.txt"),
            PathBuf::from("/x/100%.csv"),
        ];
        let list = uri_list(&paths);
        assert_eq!(
            list,
            "file:///tmp/a%20b/%C3%BC.txt\r\nfile:///x/100%25.csv\r\n"
        );
        assert_eq!(
            paths_from_uri_list(&format!("# comment\n{list}http://x/y\n")),
            paths
        );
        assert_eq!(
            paths_from_uri_list("file://host/srv/f"),
            vec![PathBuf::from("/srv/f")]
        );
    }
}
