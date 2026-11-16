//! Readers for /sys trees. Each takes its root directory so the tests can run
//! them against fixture trees.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// CPU temperature hwmon drivers (GB10 also exposes nvme/mlx5 hwmons, which
/// are not the CPU).
const CPU_HWMON_NAMES: &[&str] = &["coretemp", "k10temp", "zenpower", "acpitz", "soc_thermal"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TempFile {
    pub source: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TempSensor {
    pub source: String,
    pub millidegrees: i64,
}

/// For each allowlisted hwmon its first `temp*_input`, then every thermal
/// zone's `temp`. Resolved once; only the values are read per sample.
pub fn temp_files(hwmon_root: &Path, thermal_root: &Path) -> Vec<TempFile> {
    let mut files = Vec::new();
    for hwmon in sorted_dir(hwmon_root) {
        let Some(name) = read_trim(hwmon.join("name")) else {
            continue;
        };
        if !CPU_HWMON_NAMES.contains(&name.as_str()) {
            continue;
        }
        let first = sorted_dir(&hwmon)
            .into_iter()
            .find(|p| file_name(p).is_some_and(|n| n.starts_with("temp") && n.ends_with("_input")));
        if let Some(path) = first {
            files.push(TempFile { source: name, path });
        }
    }
    for zone in sorted_dir(thermal_root) {
        if !file_name(&zone).is_some_and(|n| n.starts_with("thermal_zone")) {
            continue;
        }
        if let Some(source) = read_trim(zone.join("type")) {
            files.push(TempFile {
                source,
                path: zone.join("temp"),
            });
        }
    }
    files
}

pub fn read_temps(files: &[TempFile]) -> Vec<TempSensor> {
    files
        .iter()
        .filter_map(|f| {
            Some(TempSensor {
                source: f.source.clone(),
                millidegrees: read_trim(&f.path)?.parse().ok()?,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockStat {
    pub sectors_read: u64,
    pub sectors_written: u64,
}

/// /sys/block/<dev>/stat: fields 3 and 7 are sectors read and written.
pub fn parse_block_stat(text: &str) -> Option<BlockStat> {
    let f: Vec<&str> = text.split_whitespace().collect();
    Some(BlockStat {
        sectors_read: f.get(2)?.parse().ok()?,
        sectors_written: f.get(6)?.parse().ok()?,
    })
}

pub fn block_stats(root: &Path) -> BTreeMap<String, BlockStat> {
    sorted_dir(root)
        .into_iter()
        .filter_map(|dev| {
            let stat = parse_block_stat(&read(dev.join("stat"))?)?;
            Some((file_name(&dev)?.to_string(), stat))
        })
        .collect()
}

/// An RDMA device found under /sys/class/infiniband; port 1 is sampled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RdmaDevice {
    pub name: String,
    pub port: PathBuf,
    pub netdev: Option<String>,
    pub hw_counters: Vec<(String, PathBuf)>,
}

pub fn discover_rdma(root: &Path) -> Vec<RdmaDevice> {
    sorted_dir(root)
        .into_iter()
        .filter_map(|dev| {
            let port = dev.join("ports/1");
            let hw_counters = sorted_dir(port.join("hw_counters"))
                .into_iter()
                .filter(|p| p.is_file())
                .filter_map(|p| Some((file_name(&p)?.to_string(), p)))
                .collect();
            Some(RdmaDevice {
                name: file_name(&dev)?.to_string(),
                netdev: sorted_dir(dev.join("device/net"))
                    .first()
                    .and_then(|p| file_name(p).map(String::from)),
                hw_counters,
                port,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdmaOut {
    pub name: String,
    pub state: Option<String>,
    pub phys_state: Option<String>,
    pub rate: Option<String>,
    pub link_layer: Option<String>,
    pub netdev: Option<String>,
    pub hw_counters: BTreeMap<String, i64>,
    /// port_rcv_data / port_xmit_data as the kernel reports them, in 4-byte
    /// words.
    pub rx_data: Option<u64>,
    pub tx_data: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdmaNetdev {
    pub name: String,
    pub operstate: Option<String>,
    pub mtu: Option<i64>,
    pub speed: Option<i64>,
    pub rx_bytes: Option<i64>,
    pub tx_bytes: Option<i64>,
    pub rx_errors: Option<i64>,
    pub tx_errors: Option<i64>,
    pub rx_dropped: Option<i64>,
    pub tx_dropped: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rdma {
    pub devices: Vec<RdmaOut>,
    pub netdevs: Vec<RdmaNetdev>,
}

pub fn sample_rdma(devices: &[RdmaDevice], net_root: &Path) -> Rdma {
    let out: Vec<RdmaOut> = devices
        .iter()
        .map(|d| {
            let text = |f: &str| read_trim(d.port.join(f));
            let counter = |f: &str| text(f).and_then(|v| v.parse().ok());
            RdmaOut {
                name: d.name.clone(),
                state: text("state"),
                phys_state: text("phys_state"),
                rate: text("rate"),
                link_layer: text("link_layer"),
                netdev: d.netdev.clone(),
                hw_counters: d
                    .hw_counters
                    .iter()
                    .filter_map(|(name, path)| Some((name.clone(), read_trim(path)?.parse().ok()?)))
                    .collect(),
                rx_data: counter("counters/port_rcv_data"),
                tx_data: counter("counters/port_xmit_data"),
            }
        })
        .collect();
    let mut names: Vec<&str> = Vec::new();
    for n in out.iter().filter_map(|d| d.netdev.as_deref()) {
        if !names.contains(&n) {
            names.push(n);
        }
    }
    let netdevs = names
        .into_iter()
        .map(|name| {
            let dir = net_root.join(name);
            let int = |f: &str| read_trim(dir.join(f)).and_then(|v| v.parse().ok());
            RdmaNetdev {
                name: name.to_string(),
                operstate: read_trim(dir.join("operstate")),
                mtu: int("mtu"),
                speed: int("speed"),
                rx_bytes: int("statistics/rx_bytes"),
                tx_bytes: int("statistics/tx_bytes"),
                rx_errors: int("statistics/rx_errors"),
                tx_errors: int("statistics/tx_errors"),
                rx_dropped: int("statistics/rx_dropped"),
                tx_dropped: int("statistics/tx_dropped"),
            }
        })
        .collect();
    Rdma {
        devices: out,
        netdevs,
    }
}

pub fn sorted_dir(path: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| {
        natural_cmp(
            file_name(a).unwrap_or_default(),
            file_name(b).unwrap_or_default(),
        )
    });
    v
}

/// Digit runs compare by value: "thermal_zone10" after "thermal_zone9",
/// "temp10_input" after "temp2_input".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    loop {
        match (a.first(), b.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let da = a.iter().take_while(|c| c.is_ascii_digit()).count();
                let db = b.iter().take_while(|c| c.is_ascii_digit()).count();
                let (na, nb) = (trim_zeros(&a[..da]), trim_zeros(&b[..db]));
                let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
                if ord != Ordering::Equal {
                    return ord;
                }
                (a, b) = (&a[da..], &b[db..]);
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                (a, b) = (&a[1..], &b[1..]);
            }
        }
    }
}

fn trim_zeros(digits: &[u8]) -> &[u8] {
    let zeros = digits.iter().take_while(|c| **c == b'0').count();
    &digits[zeros..]
}

fn file_name(p: &Path) -> Option<&str> {
    p.file_name()?.to_str()
}

pub fn read(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok()
}

pub fn read_trim(path: impl AsRef<Path>) -> Option<String> {
    read(path).map(|s| s.trim().to_string())
}

#[cfg(test)]
pub mod testdir {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scratch directory removed on drop.
    pub struct TestDir(PathBuf);

    impl TestDir {
        pub fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "sparkdash-agent-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TestDir(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }

        pub fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }

        pub fn mkdir(&self, rel: &str) {
            std::fs::create_dir_all(self.0.join(rel)).unwrap();
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testdir::TestDir;
    use super::*;

    #[test]
    fn natural_order() {
        let mut v = vec![
            "thermal_zone10",
            "thermal_zone9",
            "cooling_device0",
            "temp10_input",
            "temp2_input",
            "hwmon02",
            "hwmon1",
        ];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec![
                "cooling_device0",
                "hwmon1",
                "hwmon02",
                "temp2_input",
                "temp10_input",
                "thermal_zone9",
                "thermal_zone10"
            ]
        );
    }

    #[test]
    fn temp_sensors_in_hwmon_then_zone_order() {
        let t = TestDir::new();
        t.write("hwmon/hwmon10/name", "acpitz\n");
        t.write("hwmon/hwmon10/temp1_input", "41000\n");
        t.write("hwmon/hwmon2/name", "nvme\n");
        t.write("hwmon/hwmon2/temp1_input", "30000\n");
        t.write("hwmon/hwmon9/name", "k10temp\n");
        t.write("hwmon/hwmon9/temp10_input", "99000\n");
        t.write("hwmon/hwmon9/temp2_input", "55500\n");
        t.write("hwmon/hwmon11/name", "coretemp\n");
        t.write("hwmon/hwmon11/temp1_input", "garbage\n");
        t.write("thermal/thermal_zone10/type", "gpu-thermal\n");
        t.write("thermal/thermal_zone10/temp", "-5000\n");
        t.write("thermal/thermal_zone2/type", "cpu-thermal\n");
        t.write("thermal/thermal_zone2/temp", "47000\n");
        t.write("thermal/thermal_zone3/temp", "1\n");
        t.write("thermal/cooling_device0/type", "fan\n");

        let files = temp_files(&t.path().join("hwmon"), &t.path().join("thermal"));
        let sources: Vec<&str> = files.iter().map(|f| f.source.as_str()).collect();
        assert_eq!(
            sources,
            [
                "k10temp",
                "acpitz",
                "coretemp",
                "cpu-thermal",
                "gpu-thermal"
            ]
        );
        t.write("thermal/thermal_zone2/temp", "48000\n");
        let sensor = |source: &str, millidegrees| TempSensor {
            source: source.into(),
            millidegrees,
        };
        assert_eq!(
            read_temps(&files),
            vec![
                sensor("k10temp", 55500),
                sensor("acpitz", 41000),
                sensor("cpu-thermal", 48000),
                sensor("gpu-thermal", -5000),
            ]
        );
    }

    #[test]
    fn block_stats_from_sys_block() {
        let t = TestDir::new();
        t.write(
            "nvme0n1/stat",
            "  100 0 2000 0   50 0 4000 0 0 0 0 0 0 0 0 0 0\n",
        );
        t.write("sda/stat", "1 2 3 4 5 6 7\n");
        t.write("bad/stat", "1 2\n");
        t.mkdir("nostat");
        let stats = block_stats(t.path());
        assert_eq!(stats.len(), 2);
        assert_eq!(
            stats["nvme0n1"],
            BlockStat {
                sectors_read: 2000,
                sectors_written: 4000
            }
        );
        assert_eq!(stats["sda"].sectors_written, 7);
        let json = serde_json::to_value(&stats).unwrap();
        assert_eq!(json["sda"]["sectorsRead"], 3);
    }

    #[test]
    fn rdma_devices_and_netdevs() {
        let t = TestDir::new();
        let p = "ib/rocep1s0f1/ports/1";
        t.write(&format!("{p}/state"), "4: ACTIVE\n");
        t.write(&format!("{p}/phys_state"), "5: LinkUp\n");
        t.write(&format!("{p}/rate"), "200 Gb/sec (2X NDR)\n");
        t.write(&format!("{p}/link_layer"), "Ethernet\n");
        t.write(&format!("{p}/counters/port_rcv_data"), "1000\n");
        t.write(&format!("{p}/counters/port_xmit_data"), "2000\n");
        t.write(&format!("{p}/hw_counters/out_of_buffer"), "7\n");
        t.write(&format!("{p}/hw_counters/rnr_nak_retry_err"), "0\n");
        t.write(&format!("{p}/hw_counters/broken"), "n/a\n");
        t.mkdir(&format!("{p}/hw_counters/subdir"));
        t.mkdir("ib/rocep1s0f1/device/net/enp1s0f1np1");
        t.mkdir("ib/roceP2p1s0f1/ports/1");
        t.mkdir("ib/roceP2p1s0f1/device/net/enp1s0f1np1");
        t.mkdir("ib/mlx5_10");
        t.write("net/enp1s0f1np1/operstate", "up\n");
        t.write("net/enp1s0f1np1/mtu", "9000\n");
        t.write("net/enp1s0f1np1/speed", "-1\n");
        t.write("net/enp1s0f1np1/statistics/rx_bytes", "123\n");
        t.write("net/enp1s0f1np1/statistics/tx_dropped", "4\n");

        let devices = discover_rdma(&t.path().join("ib"));
        let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["mlx5_10", "roceP2p1s0f1", "rocep1s0f1"]);
        let rdma = sample_rdma(&devices, &t.path().join("net"));

        let d = &rdma.devices[2];
        assert_eq!(d.state.as_deref(), Some("4: ACTIVE"));
        assert_eq!(d.phys_state.as_deref(), Some("5: LinkUp"));
        assert_eq!(d.rate.as_deref(), Some("200 Gb/sec (2X NDR)"));
        assert_eq!(d.link_layer.as_deref(), Some("Ethernet"));
        assert_eq!(d.netdev.as_deref(), Some("enp1s0f1np1"));
        assert_eq!((d.rx_data, d.tx_data), (Some(1000), Some(2000)));
        assert_eq!(
            d.hw_counters,
            BTreeMap::from([("out_of_buffer".into(), 7), ("rnr_nak_retry_err".into(), 0)])
        );
        let empty = &rdma.devices[0];
        assert_eq!(
            (empty.state.as_deref(), empty.netdev.as_deref()),
            (None, None)
        );
        assert!(empty.hw_counters.is_empty());

        assert_eq!(rdma.netdevs.len(), 1);
        let n = &rdma.netdevs[0];
        assert_eq!(n.operstate.as_deref(), Some("up"));
        assert_eq!(
            (n.mtu, n.speed, n.rx_bytes),
            (Some(9000), Some(-1), Some(123))
        );
        assert_eq!((n.tx_bytes, n.tx_dropped), (None, Some(4)));

        let json = serde_json::to_value(&rdma).unwrap();
        assert_eq!(json["devices"][2]["hwCounters"]["out_of_buffer"], 7);
        assert_eq!(json["devices"][2]["physState"], "5: LinkUp");
        assert!(json["netdevs"][0]["txBytes"].is_null());
    }
}
