//! Kernel log counters (GPU allocation failures, Xid errors, OOM kills) that
//! sparkDash used to get by running `journalctl -k --grep` over SSH. A thread
//! blocks on /dev/kmsg: it replays the kernel ring buffer once, then sleeps in
//! read() until the kernel logs something, so it costs no wakeups while the
//! log is quiet.
//!
//! Reading /dev/kmsg needs CAP_SYSLOG when kernel.dmesg_restrict=1 (the
//! Ubuntu default); the systemd unit grants just that capability.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::sync::{Arc, Mutex};

use serde::Serialize;

const NV_ERR_NO_MEMORY: &[u8] = b"NV_ERR_NO_MEMORY";
const XID: &[u8] = b"NVRM: Xid";
const OOM: &[&[u8]] = &[b"Out of memory: Killed process", b"oom-kill:"];
const LAST_XID_MAX: usize = 80;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelLog {
    /// The first record read had sequence number 0: the ring buffer has not
    /// rotated since boot, so the counts cover the whole boot.
    pub complete: bool,
    pub nv_err_no_memory: u64,
    pub xid: u64,
    pub oom_kills: u64,
    pub last_xid: Option<String>,
}

/// None until /dev/kmsg is open (and forever if it can't be).
pub type SharedKernelLog = Arc<Mutex<Option<KernelLog>>>;

impl KernelLog {
    pub fn observe(&mut self, message: &[u8]) {
        if contains(message, NV_ERR_NO_MEMORY) {
            self.nv_err_no_memory += 1;
        }
        if contains(message, XID) {
            self.xid += 1;
            self.last_xid = Some(describe_xid(message));
        }
        if OOM.iter().any(|n| contains(message, n)) {
            self.oom_kills += 1;
        }
    }
}

pub fn spawn(shared: SharedKernelLog) {
    std::thread::Builder::new()
        .name("kmsg".into())
        .spawn(move || {
            let mut file = match File::open("/dev/kmsg") {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("sparkdash-agent: /dev/kmsg unavailable ({e}); kernelLog stays null");
                    return;
                }
            };
            let mut first = true;
            // One read returns one record; records are at most ~8 KiB.
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match file.read(&mut buf) {
                    Ok(0) => return,
                    Ok(n) => {
                        let Some((seq, message)) = parse_record(&buf[..n]) else {
                            continue;
                        };
                        let Ok(mut guard) = shared.lock() else { return };
                        let log = guard.get_or_insert_with(KernelLog::default);
                        if first {
                            log.complete = seq == 0;
                            first = false;
                        }
                        log.observe(message);
                    }
                    // EPIPE: records were overwritten before we read them; the
                    // next read continues from the oldest remaining one.
                    Err(e) if e.raw_os_error() == Some(libc::EPIPE) => continue,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) => {
                        eprintln!("sparkdash-agent: /dev/kmsg read failed: {e}");
                        return;
                    }
                }
            }
        })
        .expect("spawn kmsg thread");
}

/// A record is `prio,seq,usec,flags[,...];message\n` followed by optional
/// ` KEY=value` continuation lines. Returns the sequence number and the
/// message line.
pub fn parse_record(record: &[u8]) -> Option<(u64, &[u8])> {
    let semi = record.iter().position(|b| *b == b';')?;
    let mut fields = record[..semi].split(|b| *b == b',');
    fields.next()?;
    let seq = std::str::from_utf8(fields.next()?).ok()?.parse().ok()?;
    let rest = &record[semi + 1..];
    let end = rest.iter().position(|b| *b == b'\n').unwrap_or(rest.len());
    Some((seq, &rest[..end]))
}

/// `Xid <code>` when the message has the usual `Xid (PCI:…): <code>, …`
/// shape, else the message itself as printable ASCII.
fn describe_xid(message: &[u8]) -> String {
    let text = String::from_utf8_lossy(message);
    let mut search = text.as_ref();
    while let Some(i) = search.find("Xid (") {
        let after = &search[i + 5..];
        if let Some(code) = after
            .find(')')
            .and_then(|close| after[close + 1..].strip_prefix(':'))
            .map(|s| s.trim_start())
            .map(|s| &s[..s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len())])
            .filter(|code| !code.is_empty())
        {
            return format!("Xid {code}");
        }
        search = after;
    }
    text.chars()
        .filter(|c| (' '..='~').contains(c))
        .take(LAST_XID_MAX)
        .collect::<String>()
        .trim()
        .to_string()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sequence_and_message_line() {
        let (seq, msg) =
            parse_record(b"3,1234,5678,-,caller=T1;NVRM: oops\n SUBSYSTEM=pci\n DEVICE=+pci:x\n")
                .unwrap();
        assert_eq!(seq, 1234);
        assert_eq!(msg, b"NVRM: oops");
        assert_eq!(parse_record(b"6,0,0,-;hello").unwrap(), (0, &b"hello"[..]));
        assert!(parse_record(b"no header").is_none());
        assert!(parse_record(b"6,x,0,-;hello").is_none());
    }

    #[test]
    fn counts_matching_messages() {
        let mut log = KernelLog::default();
        for raw in [
            &b"3,1,5,-;NVRM: nvAssertFailed: status NV_ERR_NO_MEMORY\n"[..],
            b"4,2,6,-;NVRM: Xid (PCI:0000:01:00): 79, pid=1234, name=python, GPU has fallen off the bus.\n",
            b"3,3,7,-;Out of memory: Killed process 4321 (python) total-vm:1kB\n",
            b"6,4,8,-;oom-kill:constraint=CONSTRAINT_NONE,task=python,pid=4321\n",
            b"6,5,9,-;usb 1-1: new device\n",
            b"6,6,9,-;SUBSYSTEM mentions\n NV_ERR_NO_MEMORY=only-in-continuation\n",
        ] {
            log.observe(parse_record(raw).unwrap().1);
        }
        assert_eq!(
            log,
            KernelLog {
                complete: false,
                nv_err_no_memory: 1,
                xid: 1,
                oom_kills: 2,
                last_xid: Some("Xid 79".into()),
            }
        );
    }

    #[test]
    fn last_xid_falls_back_to_printable_text() {
        assert_eq!(
            describe_xid(b"NVRM: Xid (PCI:0000:01:00):13, Graphics"),
            "Xid 13"
        );
        assert_eq!(
            describe_xid(b"NVRM: Xid (a) (b): 48"),
            "NVRM: Xid (a) (b): 48"
        );
        assert_eq!(describe_xid(b"NVRM: Xid (a): x, Xid (b): 31"), "Xid 31");
        assert_eq!(
            describe_xid("NVRM: Xid \u{1}odd\u{e9} format".as_bytes()),
            "NVRM: Xid odd format"
        );
        assert_eq!(describe_xid(&[b'x'; 200]).len(), LAST_XID_MAX);
    }
}
