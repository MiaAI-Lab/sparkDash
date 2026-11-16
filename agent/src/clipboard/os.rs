//! OS clipboard access. Wayland compositors with the data-control protocol use
//! [`super::wayland`]; X11, macOS and Windows use arboard. macOS and Windows
//! expose a change counter, so an unchanged clipboard is never read there.

use super::{png_codec, Content, Local};

pub trait Backend {
    fn name(&self) -> &'static str;
    /// False only when the platform can tell cheaply that nothing changed.
    fn changed(&mut self) -> bool {
        true
    }
    /// `Ok(None)` when there is nothing to share (empty, unsupported, or marked secret).
    fn read(&mut self) -> Result<Option<Local>, String>;
    /// The [`super::fingerprint`] of what [`Backend::read`] would return, ideally without holding it.
    fn peek(&mut self) -> Result<Option<u64>, String> {
        Ok(self.read()?.as_ref().map(super::fingerprint))
    }
    fn write(&mut self, content: &Content) -> Result<(), String>;
}

pub fn open() -> Result<Box<dyn Backend>, String> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            match super::wayland::WaylandBackend::open() {
                Ok(b) => return Ok(Box::new(b)),
                Err(e) if std::env::var_os("DISPLAY").is_none() => return Err(e),
                Err(e) => eprintln!("sparkdash-agent clipboard: {e}; using X11 instead"),
            }
        } else if std::env::var_os("DISPLAY").is_none() {
            return Err("no WAYLAND_DISPLAY or DISPLAY".into());
        }
    }
    Ok(Box::new(Arboard::open()?))
}

struct Arboard {
    clipboard: arboard::Clipboard,
    counter: Option<i64>,
}

impl Arboard {
    fn open() -> Result<Self, String> {
        Ok(Arboard {
            clipboard: arboard::Clipboard::new().map_err(|e| e.to_string())?,
            counter: None,
        })
    }
}

impl Backend for Arboard {
    fn name(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS"
        } else if cfg!(windows) {
            "Windows"
        } else {
            "X11"
        }
    }

    fn changed(&mut self) -> bool {
        let now = platform::change_count();
        let changed = now.is_none() || now != self.counter;
        self.counter = now;
        changed
    }

    fn read(&mut self) -> Result<Option<Local>, String> {
        if platform::marked_secret() {
            return Ok(None);
        }
        if let Ok(files) = self.clipboard.get().file_list() {
            if !files.is_empty() {
                return Ok(Some(Local::Files(files)));
            }
        }
        match self.clipboard.get_text() {
            Ok(text) if !text.is_empty() => return Ok(Some(Local::Text(text))),
            Ok(_) | Err(arboard::Error::ContentNotAvailable) => {}
            Err(e) => return Err(e.to_string()),
        }
        match self.clipboard.get_image() {
            Ok(img) => Ok(Some(Local::Rgba {
                width: img.width,
                height: img.height,
                bytes: img.bytes.into_owned(),
            })),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&mut self, content: &Content) -> Result<(), String> {
        let result = match content {
            Content::Text(t) => self.clipboard.set_text(t.as_str()),
            Content::Png(bytes) => {
                let (width, height, rgba) = png_codec::decode(bytes)?;
                self.clipboard.set_image(arboard::ImageData {
                    width,
                    height,
                    bytes: rgba.into(),
                })
            }
            Content::Files(paths) => self.clipboard.set().file_list(paths),
        };
        result.map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::NSPasteboard;

    /// Set by password managers on copies that must not leave the machine (nspasteboard.org).
    const CONCEALED: &str = "org.nspasteboard.ConcealedType";

    pub fn change_count() -> Option<i64> {
        Some(NSPasteboard::generalPasteboard().changeCount() as i64)
    }

    pub fn marked_secret() -> bool {
        NSPasteboard::generalPasteboard()
            .types()
            .is_some_and(|types| types.iter().any(|t| t.to_string() == CONCEALED))
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::DataExchange::{
        GetClipboardSequenceNumber, IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };

    pub fn change_count() -> Option<i64> {
        Some(i64::from(unsafe { GetClipboardSequenceNumber() }))
    }

    /// Set by password managers on copies that clipboard monitors must ignore.
    pub fn marked_secret() -> bool {
        let name: Vec<u16> = "ExcludeClipboardContentFromMonitorProcessing\0"
            .encode_utf16()
            .collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        format != 0 && unsafe { IsClipboardFormatAvailable(format) } != 0
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn change_count() -> Option<i64> {
        None
    }

    pub fn marked_secret() -> bool {
        false
    }
}
