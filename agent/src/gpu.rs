//! GPU metrics through NVML. The library is loaded once at startup (dlopen of
//! libnvidia-ml.so.1) and the handle stays open, so a sample is a handful of
//! driver queries instead of an nvidia-smi process. NVML queries never create a
//! CUDA context, so the agent holds no GPU memory.
//!
//! GB10 reports some fields as not supported (e.g. framebuffer memory, since
//! the GPU shares system RAM); those come back as null.

use std::time::{Duration, Instant};

use nvml_wrapper::bitmasks::device::ThrottleReasons;
use nvml_wrapper::enum_wrappers::device::{Clock, TemperatureSensor};
use nvml_wrapper::enums::device::UsedGpuMemory;
use nvml_wrapper::Nvml;
use serde::Serialize;

use crate::procfs::round1;

const RETRY_INIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub index: u32,
    pub name: Option<String>,
    pub uuid: Option<String>,
    pub temp_c: Option<u32>,
    pub util_pct: Option<u32>,
    pub power_w: Option<f64>,
    pub power_limit_w: Option<f64>,
    pub sm_clock_mhz: Option<u32>,
    pub sm_clock_max_mhz: Option<u32>,
    pub fan_pct: Option<u32>,
    pub pcie: Option<Pcie>,
    pub mem_used_bytes: Option<u64>,
    pub mem_total_bytes: Option<u64>,
    pub throttle: Option<Throttle>,
    pub processes: Vec<GpuProcess>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pcie {
    pub gen: Option<u32>,
    pub gen_max: Option<u32>,
    pub width: Option<u32>,
    pub width_max: Option<u32>,
}

impl Pcie {
    /// None when the driver reports none of the four (GB10 has no PCIe link
    /// to the GPU).
    pub fn known(self) -> Option<Self> {
        let all = [self.gen, self.gen_max, self.width, self.width_max];
        all.iter().any(Option::is_some).then_some(self)
    }
}

/// The clock-limit reasons sparkDash shows. `raw` is NVML's bitmask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub hw_thermal: bool,
    pub sw_thermal: bool,
    pub hw_slowdown: bool,
    pub sw_power_cap: bool,
    pub hw_power_brake: bool,
    pub raw: u64,
}

impl From<ThrottleReasons> for Throttle {
    fn from(r: ThrottleReasons) -> Self {
        Throttle {
            hw_thermal: r.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN),
            sw_thermal: r.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN),
            hw_slowdown: r.contains(ThrottleReasons::HW_SLOWDOWN),
            sw_power_cap: r.contains(ThrottleReasons::SW_POWER_CAP),
            hw_power_brake: r.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN),
            raw: r.bits(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcess {
    pub pid: u32,
    /// Executable path (argv[0]) like nvidia-smi's process_name, else comm.
    pub name: String,
    /// Null where the driver can't attribute memory to a process.
    pub used_bytes: Option<u64>,
}

pub struct Gpus {
    nvml: Option<Nvml>,
    pub driver: Option<String>,
    pub error: Option<String>,
    last_attempt: Option<Instant>,
}

impl Gpus {
    pub fn open() -> Self {
        let mut g = Gpus {
            nvml: None,
            driver: None,
            error: None,
            last_attempt: None,
        };
        g.try_init();
        g
    }

    /// No GPU at boot (driver still loading, or a machine without one): retry
    /// at most once a minute, and only when someone asks for a sample.
    fn try_init(&mut self) {
        self.last_attempt = Some(Instant::now());
        match Nvml::builder()
            .lib_path("libnvidia-ml.so.1".as_ref())
            .init()
        {
            Ok(nvml) => {
                self.driver = nvml.sys_driver_version().ok();
                self.nvml = Some(nvml);
                self.error = None;
            }
            Err(e) => self.error = Some(format!("NVML unavailable: {e}")),
        }
    }

    pub fn sample(&mut self, proc_name: impl Fn(u32) -> String) -> Vec<GpuSample> {
        if self.nvml.is_none() && self.last_attempt.is_none_or(|t| t.elapsed() >= RETRY_INIT) {
            self.try_init();
        }
        let Some(nvml) = &self.nvml else {
            return Vec::new();
        };
        let count = match nvml.device_count() {
            Ok(n) => n,
            Err(e) => {
                self.error = Some(format!("NVML device count: {e}"));
                return Vec::new();
            }
        };
        self.error = None;
        (0..count)
            .filter_map(|index| {
                let d = nvml.device_by_index(index).ok()?;
                let util = d.utilization_rates().ok();
                let pcie = Pcie {
                    gen: d.current_pcie_link_gen().ok(),
                    gen_max: d.max_pcie_link_gen().ok(),
                    width: d.current_pcie_link_width().ok(),
                    width_max: d.max_pcie_link_width().ok(),
                };
                let mem = d.memory_info().ok();
                let processes = d
                    .running_compute_processes()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| GpuProcess {
                        pid: p.pid,
                        name: proc_name(p.pid),
                        used_bytes: match p.used_gpu_memory {
                            UsedGpuMemory::Used(b) => Some(b),
                            UsedGpuMemory::Unavailable => None,
                        },
                    })
                    .collect();
                Some(GpuSample {
                    index,
                    name: d.name().ok(),
                    uuid: d.uuid().ok(),
                    temp_c: d.temperature(TemperatureSensor::Gpu).ok(),
                    util_pct: util.map(|u| u.gpu),
                    power_w: d.power_usage().ok().map(|mw| round1(mw as f64 / 1000.0)),
                    power_limit_w: d
                        .enforced_power_limit()
                        .ok()
                        .map(|mw| round1(mw as f64 / 1000.0)),
                    sm_clock_mhz: d.clock_info(Clock::SM).ok(),
                    sm_clock_max_mhz: d.max_clock_info(Clock::SM).ok(),
                    fan_pct: d.fan_speed(0).ok(),
                    pcie: pcie.known(),
                    mem_used_bytes: mem.as_ref().map(|m| m.used),
                    mem_total_bytes: mem.as_ref().map(|m| m.total),
                    throttle: d.current_throttle_reasons().ok().map(Throttle::from),
                    processes,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_flags_map_from_the_bitmask() {
        let t =
            Throttle::from(ThrottleReasons::SW_POWER_CAP | ThrottleReasons::HW_THERMAL_SLOWDOWN);
        assert!(t.sw_power_cap && t.hw_thermal);
        assert!(!t.sw_thermal && !t.hw_slowdown && !t.hw_power_brake);
        assert_eq!(
            t.raw,
            (ThrottleReasons::SW_POWER_CAP | ThrottleReasons::HW_THERMAL_SLOWDOWN).bits()
        );
    }

    #[test]
    fn pcie_is_null_when_nothing_is_known() {
        let none = Pcie {
            gen: None,
            gen_max: None,
            width: None,
            width_max: None,
        };
        assert_eq!(none.known(), None);
        let some = Pcie {
            width: Some(16),
            ..none
        };
        assert_eq!(some.known(), Some(some));
        let json = serde_json::to_value(some).unwrap();
        assert_eq!(json["widthMax"], serde_json::Value::Null);
        assert_eq!(json["width"], 16);
    }
}
