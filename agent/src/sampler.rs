//! Builds the `/v1/snapshot` document (schema `sparkdash.node-agent/1`; the
//! `Snapshot` struct below is the contract). Samples are taken on demand and
//! cached for `min_interval` (at least 1 s), so however many dashboards poll,
//! the machine is read at most once a second, and not at all when nobody
//! asks. Everything is a file read, a syscall or an NVML call; nothing spawns
//! a process.

use std::collections::{BTreeMap, HashMap};
use std::ffi::{CStr, CString};
use std::fs;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::gpu::{GpuSample, Gpus};
use crate::kmsg::{KernelLog, SharedKernelLog};
use crate::procfs::{self, MemInfo};
use crate::sysfs::{self, read, read_trim, BlockStat, Rdma, RdmaDevice, TempFile, TempSensor};

pub const SCHEMA: &str = "sparkdash.node-agent/1";
const GPU_CLOCK_CAP_MARKER: &str = "/run/sparkdash/gpu-clock-cap";
/// RDMA ports can appear after boot (driver or link bring-up).
const RDMA_REDISCOVER: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot<'a> {
    schema: &'static str,
    hostname: &'a str,
    kernel_release: &'a str,
    arch: &'static str,
    boot_id: Option<&'a str>,
    collected_at_ms: u64,
    uptime_s: Option<f64>,
    cpu: CpuOut<'a>,
    memory: MemInfo,
    gpus: Vec<GpuSample>,
    gpu_driver: Option<&'a str>,
    gpu_error: Option<&'a str>,
    gpu_clock_cap_marker: Option<String>,
    kernel_log: Option<KernelLog>,
    disks: Vec<DiskOut>,
    block_stats: BTreeMap<String, BlockStat>,
    network: NetworkOut,
    rdma: Rdma,
    agent: AgentOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CpuOut<'a> {
    model: Option<&'a str>,
    cores: usize,
    /// The aggregate /proc/stat line as-is; usage comes from the difference
    /// between two snapshots.
    times: Option<Vec<u64>>,
    load: [f64; 3],
    temp_sensors: Vec<TempSensor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskOut {
    device: String,
    mount: String,
    fs_type: String,
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkOut {
    default_interface: Option<String>,
    interfaces: Vec<IfaceOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IfaceOut {
    name: String,
    /// Cumulative kernel counters; RoCE traffic bypasses these (see `rdma`).
    rx_bytes: u64,
    tx_bytes: u64,
    operstate: String,
    speed_mbps: Option<u64>,
    mac: Option<String>,
    ipv4: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentOut {
    version: &'static str,
    started_at_ms: u64,
    rss_kb: Option<u64>,
    cpu_seconds: Option<f64>,
    samples: u64,
    min_interval_ms: u64,
}

pub struct Sampler {
    min_interval: Duration,
    hostname: String,
    kernel_release: String,
    boot_id: Option<String>,
    cores: usize,
    model: Option<String>,
    temp_files: Vec<TempFile>,
    rdma: Option<(Instant, Vec<RdmaDevice>)>,
    clk_tck: f64,
    started_at_ms: u64,
    gpus: Gpus,
    kernel_log: SharedKernelLog,
    cached: Option<(Instant, Arc<Vec<u8>>)>,
    samples: u64,
}

impl Sampler {
    pub fn new(min_interval: Duration, kernel_log: SharedKernelLog) -> Self {
        let (cores, model) = procfs::parse_cpuinfo(&read("/proc/cpuinfo").unwrap_or_default());
        Sampler {
            min_interval,
            hostname: read_trim("/proc/sys/kernel/hostname").unwrap_or_default(),
            kernel_release: read_trim("/proc/sys/kernel/osrelease").unwrap_or_default(),
            boot_id: read_trim("/proc/sys/kernel/random/boot_id").filter(|s| !s.is_empty()),
            cores,
            model,
            temp_files: sysfs::temp_files(
                Path::new("/sys/class/hwmon"),
                Path::new("/sys/class/thermal"),
            ),
            rdma: None,
            // SAFETY: sysconf has no preconditions.
            clk_tck: unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64,
            started_at_ms: now_ms(),
            gpus: Gpus::open(),
            kernel_log,
            cached: None,
            samples: 0,
        }
    }

    /// The latest snapshot as JSON, sampling only if the cached one is older
    /// than `min_interval`.
    pub fn snapshot(&mut self) -> Arc<Vec<u8>> {
        if let Some((at, body)) = &self.cached {
            if at.elapsed() < self.min_interval {
                return Arc::clone(body);
            }
        }
        let body = Arc::new(self.sample());
        self.cached = Some((Instant::now(), Arc::clone(&body)));
        body
    }

    fn rdma_devices(&mut self) -> &[RdmaDevice] {
        if self
            .rdma
            .as_ref()
            .is_none_or(|(at, _)| at.elapsed() >= RDMA_REDISCOVER)
        {
            let devices = sysfs::discover_rdma(Path::new("/sys/class/infiniband"));
            self.rdma = Some((Instant::now(), devices));
        }
        self.rdma.as_ref().map_or(&[], |(_, d)| d.as_slice())
    }

    fn sample(&mut self) -> Vec<u8> {
        self.samples += 1;
        let gpus = self.gpus.sample(process_name);
        let rdma = sysfs::sample_rdma(self.rdma_devices(), Path::new("/sys/class/net"));
        let self_status = read("/proc/self/status").unwrap_or_default();
        let snapshot = Snapshot {
            schema: SCHEMA,
            hostname: &self.hostname,
            kernel_release: &self.kernel_release,
            arch: std::env::consts::ARCH,
            boot_id: self.boot_id.as_deref(),
            collected_at_ms: now_ms(),
            uptime_s: read("/proc/uptime").and_then(|t| procfs::parse_uptime(&t)),
            cpu: CpuOut {
                model: self.model.as_deref(),
                cores: self.cores,
                times: read("/proc/stat").and_then(|t| procfs::parse_cpu_times(&t)),
                load: procfs::parse_loadavg(&read("/proc/loadavg").unwrap_or_default()),
                temp_sensors: sysfs::read_temps(&self.temp_files),
            },
            memory: procfs::parse_meminfo(&read("/proc/meminfo").unwrap_or_default()),
            gpus,
            gpu_driver: self.gpus.driver.as_deref(),
            gpu_error: self.gpus.error.as_deref(),
            gpu_clock_cap_marker: read(GPU_CLOCK_CAP_MARKER).and_then(|t| first_line(&t)),
            kernel_log: self.kernel_log.lock().ok().and_then(|g| g.clone()),
            disks: disks(),
            block_stats: sysfs::block_stats(Path::new("/sys/block")),
            network: network(),
            rdma,
            agent: AgentOut {
                version: env!("CARGO_PKG_VERSION"),
                started_at_ms: self.started_at_ms,
                rss_kb: procfs::parse_status_kb(&self_status, "VmRSS"),
                cpu_seconds: read("/proc/self/stat")
                    .and_then(|t| procfs::parse_proc_cpu_ticks(&t))
                    .map(|ticks| (ticks as f64 / self.clk_tck * 100.0).round() / 100.0),
                samples: self.samples,
                min_interval_ms: self.min_interval.as_millis() as u64,
            },
        };
        serde_json::to_vec(&snapshot).unwrap_or_else(|_| b"{}".to_vec())
    }
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(String::from)
}

/// Executable path (argv[0]) like nvidia-smi's process_name, else comm.
fn process_name(pid: u32) -> String {
    let argv0 = fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .and_then(|b| {
            b.split(|c| *c == 0)
                .next()
                .map(|s| String::from_utf8_lossy(s).into_owned())
        })
        .filter(|s| !s.is_empty());
    argv0
        .or_else(|| read_trim(format!("/proc/{pid}/comm")))
        .unwrap_or_else(|| "unknown".into())
}

fn disks() -> Vec<DiskOut> {
    procfs::parse_mounts(&read("/proc/mounts").unwrap_or_default())
        .into_iter()
        .filter_map(|m| {
            let s = statvfs(&m.mount)?;
            Some(DiskOut {
                device: m.device,
                mount: m.mount,
                fs_type: m.fs_type,
                total_bytes: s.total,
                used_bytes: s.used,
                available_bytes: s.available,
            })
        })
        .filter(|d| d.total_bytes > 0)
        .collect()
}

struct FsUsage {
    total: u64,
    used: u64,
    available: u64,
}

fn statvfs(path: &str) -> Option<FsUsage> {
    let c = CString::new(path).ok()?;
    // SAFETY: statvfs writes into the zeroed struct we own; c outlives the call.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let f = s.f_frsize as u64;
    Some(FsUsage {
        total: (s.f_blocks as u64).saturating_mul(f),
        used: (s.f_blocks as u64)
            .saturating_sub(s.f_bfree as u64)
            .saturating_mul(f),
        available: (s.f_bavail as u64).saturating_mul(f),
    })
}

fn network() -> NetworkOut {
    let ipv4 = ipv4_by_interface();
    let interfaces = procfs::parse_net_dev(&read("/proc/net/dev").unwrap_or_default())
        .into_iter()
        .map(|d| {
            let sys = |f: &str| read_trim(format!("/sys/class/net/{}/{f}", d.name));
            IfaceOut {
                operstate: sys("operstate").unwrap_or_else(|| "unknown".into()),
                speed_mbps: sys("speed").as_deref().and_then(procfs::parse_speed_mbps),
                mac: sys("address").filter(|m| !m.is_empty() && m != "00:00:00:00:00:00"),
                ipv4: ipv4.get(&d.name).cloned().unwrap_or_default(),
                rx_bytes: d.rx_bytes,
                tx_bytes: d.tx_bytes,
                name: d.name,
            }
        })
        .collect();
    NetworkOut {
        default_interface: read("/proc/net/route").and_then(|t| procfs::parse_default_route(&t)),
        interfaces,
    }
}

fn ipv4_by_interface() -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates a list we walk read-only and free once.
    unsafe {
        if libc::getifaddrs(&mut ifap) != 0 {
            return map;
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_addr.is_null() && i32::from((*ifa.ifa_addr).sa_family) == libc::AF_INET {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let name = CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
                map.entry(name).or_default().push(ip.to_string());
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
    }
    map
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn first_non_empty_line() {
        assert_eq!(
            first_line("\n  \n  cap 2000 MHz \nnext\n").as_deref(),
            Some("cap 2000 MHz")
        );
        assert_eq!(first_line(" \n"), None);
    }

    #[test]
    fn snapshot_follows_the_schema_and_is_cached() {
        let log: SharedKernelLog = Arc::new(Mutex::new(None));
        let mut s = Sampler::new(Duration::from_secs(60), Arc::clone(&log));
        let a = s.snapshot();
        let b = s.snapshot();
        assert!(Arc::ptr_eq(&a, &b));
        let doc: serde_json::Value = serde_json::from_slice(&a).unwrap();
        assert_eq!(doc["schema"], SCHEMA);
        assert_eq!(doc["arch"], std::env::consts::ARCH);
        assert_eq!(doc["agent"]["samples"], 1);
        assert_eq!(doc["agent"]["minIntervalMs"], 60_000);
        assert!(doc["memory"]["totalKb"].as_u64().unwrap() > 0);
        assert!(doc["cpu"]["times"].as_array().unwrap().len() >= 4);
        assert!(doc["cpu"]["tempSensors"].is_array());
        assert!(doc["kernelLog"].is_null());
        assert!(doc["blockStats"].is_object());
        assert!(doc["rdma"]["devices"].is_array());
        assert!(doc["rdma"]["netdevs"].is_array());
        let ifaces = doc["network"]["interfaces"].as_array().unwrap();
        assert!(ifaces.iter().any(|i| i["name"] == "lo"));
        for key in [
            "hostname",
            "kernelRelease",
            "bootId",
            "collectedAtMs",
            "uptimeS",
            "gpus",
            "gpuDriver",
            "gpuError",
            "gpuClockCapMarker",
            "disks",
        ] {
            assert!(doc.get(key).is_some(), "missing {key}");
        }

        *log.lock().unwrap() = Some(KernelLog {
            complete: true,
            xid: 2,
            ..KernelLog::default()
        });
        s.cached = None;
        let doc: serde_json::Value = serde_json::from_slice(&s.snapshot()).unwrap();
        assert_eq!(doc["kernelLog"]["complete"], true);
        assert_eq!(doc["kernelLog"]["xid"], 2);
        assert!(doc["kernelLog"]["lastXid"].is_null());
        assert_eq!(doc["agent"]["samples"], 2);
    }
}
