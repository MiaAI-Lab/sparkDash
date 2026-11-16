//! Parsers for the /proc files the agent reads. Every function here takes file
//! contents and returns plain data so the tests can feed fixtures.

use serde::Serialize;

/// Every numeric field of the aggregate `cpu ` line of /proc/stat, in order.
pub fn parse_cpu_times(stat: &str) -> Option<Vec<u64>> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|f| f.parse().ok())
        .collect::<Option<_>>()?;
    (!fields.is_empty()).then_some(fields)
}

/// /proc/meminfo fields in KiB; None when the kernel doesn't report the key.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    pub total_kb: Option<u64>,
    pub available_kb: Option<u64>,
    pub free_kb: Option<u64>,
    pub buffers_kb: Option<u64>,
    pub cached_kb: Option<u64>,
    pub shmem_kb: Option<u64>,
    pub swap_total_kb: Option<u64>,
    pub swap_free_kb: Option<u64>,
}

pub fn parse_meminfo(text: &str) -> MemInfo {
    let mut m = MemInfo::default();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let value = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        let slot = match key {
            "MemTotal" => &mut m.total_kb,
            "MemAvailable" => &mut m.available_kb,
            "MemFree" => &mut m.free_kb,
            "Buffers" => &mut m.buffers_kb,
            "Cached" => &mut m.cached_kb,
            "Shmem" => &mut m.shmem_kb,
            "SwapTotal" => &mut m.swap_total_kb,
            "SwapFree" => &mut m.swap_free_kb,
            _ => continue,
        };
        *slot = value;
    }
    m
}

pub fn parse_loadavg(text: &str) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (slot, field) in out.iter_mut().zip(text.split_whitespace()) {
        *slot = field.parse().unwrap_or(0.0);
    }
    out
}

pub fn parse_uptime(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// Cumulative byte counters for one interface from /proc/net/dev.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetDev {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

pub fn parse_net_dev(text: &str) -> Vec<NetDev> {
    text.lines()
        .skip(2)
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let fields: Vec<&str> = rest.split_whitespace().collect();
            if fields.len() < 16 {
                return None;
            }
            Some(NetDev {
                name: name.trim().to_string(),
                rx_bytes: fields[0].parse().ok()?,
                tx_bytes: fields[8].parse().ok()?,
            })
        })
        .collect()
}

/// The interface of the first up (RTF_UP) default route in /proc/net/route.
pub fn parse_default_route(text: &str) -> Option<String> {
    text.lines().skip(1).find_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let flags = u32::from_str_radix(f.get(3)?, 16).ok()?;
        (f[1] == "00000000" && flags & 1 == 1).then(|| f[0].to_string())
    })
}

/// A local block-device filesystem worth showing, from /proc/mounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    pub device: String,
    pub mount: String,
    pub fs_type: String,
}

/// What `df -x` excluded, plus mounts that are never local disks.
const PSEUDO_FS: &[&str] = &[
    "tmpfs", "devtmpfs", "squashfs", "overlay", "efivarfs", "proc", "sysfs", "devpts", "cgroup",
    "cgroup2", "autofs", "nsfs",
];

/// statvfs on these can block indefinitely when the server goes away.
fn is_network_fs(fs_type: &str) -> bool {
    fs_type.starts_with("nfs")
        || fs_type.starts_with("smb")
        || fs_type.starts_with("fuse.")
        || matches!(fs_type, "cifs" | "ceph" | "glusterfs" | "9p")
}

/// Local disks the way `df -l -x tmpfs …` lists them: real block devices, no
/// loop/snap mounts or the EFI partition, one entry per device at its
/// shortest mount path (bind mounts repeat the device).
pub fn parse_mounts(text: &str) -> Vec<Mount> {
    let mut out: Vec<Mount> = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let (device, mount, fs_type) = (unescape_mount(f[0]), unescape_mount(f[1]), f[2]);
        if !device.starts_with("/dev/") || device.starts_with("/dev/loop") {
            continue;
        }
        if PSEUDO_FS.contains(&fs_type) || is_network_fs(fs_type) {
            continue;
        }
        if mount == "/boot/efi" || mount.contains("/snap") {
            continue;
        }
        match out.iter_mut().find(|m| m.device == device) {
            Some(seen) if mount.len() < seen.mount.len() => {
                seen.mount = mount;
                seen.fs_type = fs_type.to_string();
            }
            Some(_) => {}
            None => out.push(Mount {
                device,
                mount,
                fs_type: fs_type.to_string(),
            }),
        }
    }
    out
}

/// /proc/mounts escapes space, tab, newline and backslash as octal.
fn unescape_mount(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes
            .get(i + 1..i + 4)
            .filter(|d| d.iter().all(|b| (b'0'..=b'7').contains(b)));
        if let (b'\\', Some(d)) = (bytes[i], octal) {
            let code = d.iter().fold(0u32, |acc, b| acc * 8 + u32::from(b - b'0'));
            out.push(code as u8);
            i += 4;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A `Key:   123 kB` field of /proc/<pid>/status, in KiB.
pub fn parse_status_kb(status: &str, key: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        rest.split_whitespace().next()?.parse().ok()
    })
}

/// utime + stime (clock ticks) from /proc/<pid>/stat. The comm field may hold
/// spaces and parentheses, so fields are counted after the last ')'.
pub fn parse_proc_cpu_ticks(stat: &str) -> Option<u64> {
    let after = &stat[stat.rfind(')')? + 1..];
    let f: Vec<&str> = after.split_whitespace().collect();
    // After the comm: state(0) ppid(1) … utime(11) stime(12).
    Some(f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?)
}

/// Link speed from /sys/class/net/<if>/speed; down or virtual links report -1
/// or fail to read.
pub fn parse_speed_mbps(text: &str) -> Option<u64> {
    text.trim()
        .parse::<i64>()
        .ok()
        .filter(|s| *s > 0)
        .map(|s| s as u64)
}

/// Logical CPUs and a model name from /proc/cpuinfo. Arm kernels have no
/// "model name", so the model stays None there.
pub fn parse_cpuinfo(text: &str) -> (usize, Option<String>) {
    let cores = text.lines().filter(|l| l.starts_with("processor")).count();
    let model = text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == "model name").then(|| v.trim().to_string())
    });
    (cores, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_times_are_every_field_of_the_aggregate_line() {
        let stat = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\nintr 5\n";
        assert_eq!(
            parse_cpu_times(stat),
            Some(vec![100, 0, 100, 800, 0, 0, 0, 0, 0, 0])
        );
        assert_eq!(parse_cpu_times("cpu  1 2 3 4\n"), Some(vec![1, 2, 3, 4]));
        assert_eq!(parse_cpu_times("cpu0 1 2 3 4\n"), None);
        assert_eq!(parse_cpu_times("cpu  1 x 3\n"), None);
        assert_eq!(parse_cpu_times("cpu \n"), None);
    }

    #[test]
    fn meminfo_keeps_missing_keys_null() {
        let m = parse_meminfo(
            "MemTotal:       127535392 kB\nMemFree:         1024 kB\nMemAvailable:    8388608 kB\n\
             Buffers:  10 kB\nCached:   20 kB\nSwapCached: 5 kB\nShmem: 7 kB\nSwapTotal: 16 kB\nSwapFree: 4 kB\n",
        );
        assert_eq!(m.total_kb, Some(127535392));
        assert_eq!(m.available_kb, Some(8388608));
        assert_eq!(m.free_kb, Some(1024));
        assert_eq!(m.buffers_kb, Some(10));
        assert_eq!(m.cached_kb, Some(20));
        assert_eq!(m.shmem_kb, Some(7));
        assert_eq!((m.swap_total_kb, m.swap_free_kb), (Some(16), Some(4)));

        let old = parse_meminfo("MemTotal: 100 kB\nMemFree: 50 kB\n");
        assert_eq!(old.available_kb, None);
        assert_eq!(old.swap_total_kb, None);
        let json = serde_json::to_value(old).unwrap();
        assert!(json["availableKb"].is_null());
        assert_eq!(json["totalKb"], 100);
    }

    #[test]
    fn net_dev_and_default_route() {
        let dev = "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n\
            lo: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n\
            enp1s0f1np1: 123 4 0 0 0 0 0 0 456 7 0 0 0 0 0 0\n";
        let parsed = parse_net_dev(dev);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "lo");
        assert_eq!(
            parsed[1],
            NetDev {
                name: "enp1s0f1np1".into(),
                rx_bytes: 123,
                tx_bytes: 456
            }
        );

        let route =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
            docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n\
            down0\t00000000\t010200C0\t0002\t0\t0\t100\t00000000\t0\t0\t0\n\
            wlan0\t00000000\t010200C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n";
        assert_eq!(parse_default_route(route).as_deref(), Some("wlan0"));
        assert_eq!(parse_default_route("Iface\n"), None);
    }

    #[test]
    fn mounts_match_what_df_listed() {
        let text = "/dev/nvme0n1p2 /var/lib/docker/bind ext4 rw 0 0\n\
            /dev/nvme0n1p2 / ext4 rw 0 0\n\
            /dev/loop0 /snap/bare/5 squashfs ro 0 0\n\
            /dev/nvme0n1p1 /boot/efi vfat rw 0 0\n\
            overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n\
            /dev/sda1 /mnt/my\\040disk ext4 rw 0 0\n\
            /dev/sdb1 /mnt/nfs-ish nfs4 rw 0 0\n\
            /dev/sdc1 /mnt/fuse fuse.sshfs rw 0 0\n\
            /dev/sdd1 /mnt/cifs cifs rw 0 0\n\
            /dev/sde1 /mnt/smb smb3 rw 0 0\n\
            /dev/sdf1 /mnt/ninep 9p rw 0 0\n\
            server:/export /mnt/remote nfs rw 0 0\n\
            tmpfs /run tmpfs rw 0 0\n";
        let m = parse_mounts(text);
        assert_eq!(
            m,
            vec![
                Mount {
                    device: "/dev/nvme0n1p2".into(),
                    mount: "/".into(),
                    fs_type: "ext4".into()
                },
                Mount {
                    device: "/dev/sda1".into(),
                    mount: "/mnt/my disk".into(),
                    fs_type: "ext4".into()
                },
            ]
        );
    }

    #[test]
    fn process_status_and_stat() {
        let status = "Name:\tsomed\nVmRSS:\t 2667124 kB\nVmSwap:\t  818000 kB\n";
        assert_eq!(parse_status_kb(status, "VmRSS"), Some(2667124));
        assert_eq!(parse_status_kb(status, "VmSwap"), Some(818000));
        assert_eq!(parse_status_kb(status, "VmHWM"), None);
        let stat = "42 (weird (name) x) S 1 42 42 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 1 0 5 0 0";
        assert_eq!(parse_proc_cpu_ticks(stat), Some(10));
    }

    #[test]
    fn small_files() {
        assert_eq!(parse_speed_mbps("200000\n"), Some(200000));
        assert_eq!(parse_speed_mbps("-1\n"), None);
        assert_eq!(parse_speed_mbps("0\n"), None);
        let (cores, model) = parse_cpuinfo("processor\t: 0\nCPU part\t: 0xd87\n\nprocessor\t: 1\n");
        assert_eq!((cores, model), (2, None));
        let (_, model) = parse_cpuinfo("processor : 0\nmodel name\t: Some CPU\n");
        assert_eq!(model.as_deref(), Some("Some CPU"));
        assert_eq!(parse_loadavg("0.50 1.25 2.00 1/100 42\n"), [0.5, 1.25, 2.0]);
        assert_eq!(parse_uptime("241840.12 4000000.0\n"), Some(241840.12));
    }
}
