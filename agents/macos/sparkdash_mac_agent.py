#!/usr/bin/env python3
"""sparkDash Mac node agent.

A small, dependency-light collector that turns an Apple Silicon Mac into a
sparkDash node: system vitals plus an honest picture of which local model
runtime, if any, is actually serving.

Design rules this file lives by
  * stdlib first. `psutil` is used when present (per-core CPU, interface
    addresses) and never required, so the agent runs on a stock macOS python3.
  * no invented numbers. Anything macOS only hands to root (`powermetrics`
    for GPU/ANE/CPU power, die temperature when the process is elevated) is
    reported in `unavailable` with a reason instead of being guessed or zeroed.
    An ordinary user still reports temperature unavailable plus pmset thermal
    pressure. Every external command has a hard timeout so one stuck probe
    cannot wedge /metrics.
  * data-driven runtime detection. Which engines exist, their ports, how to
    recognise them, and how to read the served model out of argv all come from
    the runtime inventory JSON (default: runtimes.json next to this file).
    Unknown listeners show up as `other-runtime` with their command basename.

Usage
  sparkdash_mac_agent.py --once                     # one JSON snapshot to stdout
  sparkdash_mac_agent.py --serve --port 8790        # HTTP: /metrics, /health, /control
  sparkdash_mac_agent.py --once --config my.json    # custom runtime inventory

/control is opt-in. It is refused until SPARKDASH_MAC_CONTROL_TOKEN is set,
and it never runs a start or stop command except on POST. /metrics is unchanged.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AGENT_VERSION = "1.0.0"
SCHEMA = "sparkdash.mac-agent/1"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8790
DEFAULT_INVENTORY = Path(__file__).resolve().with_name("runtimes.json")
DEFAULT_CONTROL = Path(__file__).resolve().with_name("control.json")
CONTROL_SCHEMA = "sparkdash.mac-control/1"

SAMPLE_TTL_S = 2.0            # share one sample across close-together requests
CMD_TIMEOUT_S = 4.0
MAX_CMD_TIMEOUT_S = 8.0    # one probe may be slow; it may not be unbounded
COLLECT_DEADLINE_S = 12.0  # /metrics must answer even if a probe ignores its timeout
MB = 1024 * 1024

# Cheap reachability probes: TCP connect only, no DNS, no external service
# assumptions beyond "can this Mac leave the link".
REACHABILITY_PROBES = (("1.1.1.1", 53), ("8.8.8.8", 53))

POWERMETRICS_CMD = [
    "powermetrics", "-n", "1", "-i", "250",
    "--samplers", "gpu_power,cpu_power,thermal",
]


# ─── small helpers ───────────────────────────────────────────────────────────

def _bounded_timeout(timeout: float | None) -> float:
    """Default missing or invalid timeouts and cap oversized values."""
    try:
        value = float(CMD_TIMEOUT_S if timeout is None else timeout)
    except (TypeError, ValueError):
        value = CMD_TIMEOUT_S
    if value != value or value <= 0:  # NaN or non-positive
        value = CMD_TIMEOUT_S
    return min(value, MAX_CMD_TIMEOUT_S)


def _kill_command(proc: subprocess.Popen) -> None:
    """Kill the command and anything it spawned. Do not wait here."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except (OSError, ProcessLookupError):
            pass


def _abandon(proc: subprocess.Popen) -> None:
    """Reap briefly, then drop the pipes. A stuck child must not block the caller."""
    try:
        proc.communicate(timeout=0.2)
    except (OSError, subprocess.SubprocessError):
        for stream in (proc.stdout, proc.stderr, proc.stdin):
            if stream is None:
                continue
            try:
                stream.close()
            except OSError:
                pass


def run(cmd: list[str], timeout: float | None = CMD_TIMEOUT_S) -> str:
    """Run a command, return stdout ('' on any failure). Never raises or waits forever.

    The timeout is a hard bound: the process group is killed, and a child that
    does not reap (a stuck `df`, a `top` with no tty) is abandoned. One probe
    cannot wedge the metrics handler.
    """
    limit = _bounded_timeout(timeout)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
    except (OSError, ValueError):
        return ""
    try:
        stdout, _stderr = proc.communicate(timeout=limit)
        return stdout or ""
    except subprocess.TimeoutExpired:
        _kill_command(proc)
        _abandon(proc)
        return ""
    except (OSError, subprocess.SubprocessError):
        _kill_command(proc)
        _abandon(proc)
        return ""


def parse_sysctl(text: str) -> dict[str, str]:
    """`name: value` lines from sysctl into a map (unreadable keys are skipped)."""
    out: dict[str, str] = {}
    for line in str(text or "").splitlines():
        idx = line.find(":")
        if idx <= 0 or "cannot be read" in line:
            continue
        out[line[:idx].strip()] = line[idx + 1:].strip()
    return out


def sysctl_read(names: list[str]) -> dict[str, str]:
    """`sysctl a.b c.d` -> {name: value} for the keys that answered."""
    if not names:
        return {}
    return parse_sysctl(run(["sysctl"] + list(names), timeout=2.0))


def sysctl_one(name: str) -> str | None:
    value = sysctl_read([name]).get(name)
    return value if value not in (None, "") else None


def parse_boot_time(value: str | None) -> int | None:
    """`kern.boottime` -> epoch seconds ("{ sec = 1790650919, usec = ... }")."""
    match = re.search(r"sec\s*=\s*(\d+)", str(value or ""))
    return int(match.group(1)) if match else None


def parse_swap_usage(value: str | None) -> dict[str, int]:
    """`vm.swapusage` -> {total, used, free} in MB."""
    text = str(value or "")

    def grab(key: str) -> int:
        match = re.search(rf"{key}\s*=\s*([\d.]+)([KMG])", text)
        if not match:
            return 0
        number = float(match.group(1))
        scale = match.group(2)
        if scale == "G":
            number *= 1024
        elif scale == "K":
            number /= 1024
        return int(round(number))

    return {"total": grab("total"), "used": grab("used"), "free": grab("free")}


def parse_vm_stat(text: str) -> dict[str, int]:
    """`vm_stat` -> page counts plus the page size in bytes."""
    size_match = re.search(r"page size of (\d+) bytes", text)
    page_size = int(size_match.group(1)) if size_match else 16384

    def pages(label: str) -> int:
        match = re.search(rf"{label}:\s+(\d+)", text)
        return int(match.group(1)) if match else 0

    return {
        "pageSize": page_size,
        "free": pages("Pages free"),
        "active": pages("Pages active"),
        "inactive": pages("Pages inactive"),
        "speculative": pages("Pages speculative"),
        "wired": pages("Pages wired down"),
        "compressed": pages("Pages occupied by compressor"),
        "purgeable": pages("Pages purgeable"),
        "anonymous": pages("Anonymous pages"),
        "fileBacked": pages("File-backed pages"),
    }


def unified_memory(vm: dict[str, int], memsize_bytes: int) -> dict[str, object]:
    """Unified memory in MB, counted like Activity Monitor's "Memory Used".

    Same arithmetic and field names as the SSH Mac collector
    (MacSystemCollector.unifiedMemoryFromVmStat) so a node reads identically
    over either transport: app memory (anonymous pages minus purgeable) + wired
    (what Metal pins, incl. MLX weights and KV cache) + compressor pages;
    file-backed cache counts as available.
    """
    def to_mb(count: int) -> int:
        return int(round(count * vm["pageSize"] / MB))

    total = int(round((memsize_bytes or 0) / MB))
    if vm["anonymous"] > 0:
        app_pages = max(0, vm["anonymous"] - vm["purgeable"])
    else:  # older vm_stat without an "Anonymous pages" line: fall back to active
        app_pages = vm["active"]
    gpu_used = to_mb(vm["wired"])
    cpu_used = to_mb(app_pages + vm["compressed"])
    used = min(total or float("inf"), gpu_used + cpu_used)
    available = max(0, total - used)
    percentage = int(round(used / total * 100)) if total > 0 else 0
    oom_risk = "high" if percentage > 85 else "medium" if percentage > 60 else "low"
    return {
        "total": total,
        "gpuUsed": gpu_used,
        "cpuUsed": cpu_used,
        "used": int(used),
        "available": available,
        "percentage": percentage,
        "oomRisk": oom_risk,
    }


def cpu_sample_psutil() -> dict[str, object] | None:
    """Instantaneous CPU busy percentages from psutil (optional dependency)."""
    try:
        import psutil
    except ImportError:
        return None
    try:
        per_core = list(psutil.cpu_percent(interval=0.25, percpu=True))
    except (OSError, ValueError):
        return None
    if not per_core:
        return None
    return {
        "usagePercent": round(sum(per_core) / len(per_core), 1),
        "perCorePercent": per_core,
        "source": "psutil",
    }


def cpu_sample_top(seconds: int = 1) -> dict[str, object] | None:
    """CPU busy percentage from `top` — a last resort, kept for machines where iostat differs.

    macOS `top` blocks forever when sampled from a pipe with no controlling
    terminal (launchd, SSH, a subprocess pipe), so it is tried last and given a
    short timeout. `-s` only accepts whole seconds, and the first sample
    averages since boot, so the second sample is the meaningful one.
    """
    text = run(["top", "-l", "2", "-n", "0", "-s", str(int(seconds))],
               timeout=seconds + 2)
    lines = [ln for ln in text.splitlines() if "CPU usage" in ln]
    if not lines:
        return None
    match = re.search(r"([\d.]+)%\s+idle", lines[-1])
    if not match:
        return None
    return {
        "usagePercent": max(0.0, min(100.0, round(100.0 - float(match.group(1)), 1))),
        "perCorePercent": None,
        "source": "top",
    }


def cpu_sample_iostat(seconds: int = 1) -> dict[str, object] | None:
    """Instantaneous CPU busy percentage from `iostat -w 1 -c 2`.

    iostat is the stock-macOS choice here: unlike `top` it needs no controlling
    terminal, so it behaves the same from launchd, SSH, and a pipe. The first
    sample averages since boot, so the second sample is the one that is read.
    """
    text = run(["iostat", "-w", str(int(seconds)), "-c", "2"], timeout=seconds + CMD_TIMEOUT_S)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    header = next((ln for ln in lines if re.search(r"\bus\b.*\bsy\b.*\bid\b", ln)), None)
    if header is None:
        return None
    tokens = header.split()
    idx = {name: tokens.index(name) for name in ("us", "sy", "id")}
    rows = [row.split() for row in lines[lines.index(header) + 1:]]
    rows = [row for row in rows if len(row) > idx["id"] and re.fullmatch(r"\d+", row[idx["id"]])]
    if not rows:
        return None
    idle = float(rows[-1][idx["id"]])
    return {
        "usagePercent": max(0.0, min(100.0, round(100.0 - idle, 1))),
        "perCorePercent": None,
        "source": "iostat",
    }


class CpuProbe:
    """Keeps a recent CPU sample in the background so requests never wait for the meter."""

    def __init__(self, interval: float = SAMPLE_TTL_S):
        self._interval = max(1.0, interval)
        self._lock = threading.Lock()
        self._sample: dict[str, object] | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="cpu-probe", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self._refresh()

    def _refresh(self) -> None:
        sample = cpu_sample_psutil() or cpu_sample_iostat() or cpu_sample_top()
        if sample is not None:
            with self._lock:
                self._sample = sample

    def sample(self) -> dict[str, object] | None:
        with self._lock:
            if self._sample is not None:
                return self._sample
        sample = cpu_sample_psutil() or cpu_sample_iostat() or cpu_sample_top()
        if sample is not None:
            with self._lock:
                self._sample = sample
        return sample

    def stop(self) -> None:
        self._stop.set()



def disk_stats() -> list[dict[str, object]]:
    """Mounted volumes in MB from `df -k` (the sealed system volume yields to the data volume)."""
    text = run(["df", "-k", "/", "/System/Volumes/Data"], timeout=3.0)
    disks: list[dict[str, object]] = []
    seen_data = "/System/Volumes/Data" in text
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        fsys, size, used, avail, pct = parts[0], parts[1], parts[2], parts[3], parts[4]
        mount = " ".join(parts[8:]) if len(parts) > 8 else parts[-1]
        if not mount.startswith("/"):
            continue
        if mount == "/" and seen_data:
            continue
        try:
            total_mb = int(round(int(size) / 1024))
            used_mb = int(round(int(used) / 1024))
            avail_mb = int(round(int(avail) / 1024))
            percentage = int(pct.rstrip("%"))
        except ValueError:
            continue
        disks.append({
            "device": fsys.split("/")[-1] or fsys,
            "label": mount,
            "total": total_mb,
            "used": used_mb,
            "available": avail_mb,
            "percentage": percentage,
        })
    return disks


def default_interface() -> str | None:
    text = run(["route", "-n", "get", "default"], timeout=3.0)
    match = re.search(r"interface:\s*(\S+)", text)
    return match.group(1) if match else None


def parse_netstat_bytes(text: str) -> dict[str, object] | None:
    """Byte counters for the link-level row of `netstat -ib -I <iface>`."""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 11 and re.fullmatch(r"<Link#\d+>", parts[2]):
            try:
                return {
                    "name": parts[0],
                    "rxBytes": int(parts[6]),
                    "txBytes": int(parts[9]),
                }
            except ValueError:
                return None
    return None


def network_stats() -> tuple[dict[str, object] | None, list[str]]:
    """Primary interface counters + address, or None when the Mac has no route."""
    notes: list[str] = []
    iface = default_interface()
    if not iface:
        notes.append("no default route")
        return None, notes
    text = run(["netstat", "-ib", "-I", iface], timeout=3.0)
    counters = parse_netstat_bytes(text)
    if counters is None:
        notes.append(f"no link counters for {iface}")
        return None, notes
    ip = run(["ipconfig", "getifaddr", iface], timeout=2.0).strip() or None
    interfaces = [{
        "name": iface,
        "rxBytes": counters["rxBytes"],
        "txBytes": counters["txBytes"],
        "ip": ip,
        "operstate": "up",
    }]
    if not ip:
        notes.append(f"no IPv4 address on {iface}")
    return {"primaryInterface": iface, "interfaces": interfaces}, notes


def probe_reachability(probes=REACHABILITY_PROBES) -> list[dict[str, object]]:
    """TCP connect probes (no DNS) so 'network up' means 'can leave the link'."""
    results: list[dict[str, object]] = []
    for host, port in probes:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.4)
        started = time.monotonic()
        ok = False
        try:
            sock.connect((host, port))
            ok = True
        except OSError:
            ok = False
        finally:
            sock.close()
        results.append({
            "target": f"{host}:{port}",
            "ok": ok,
            "rttMs": int(round((time.monotonic() - started) * 1000)),
        })
    return results


def parse_powermetrics(text: str) -> dict[str, object]:
    src = text or ""

    def num(pattern: str) -> float | None:
        match = re.search(pattern, src)
        return float(match.group(1)) if match else None

    def watts(pattern: str) -> float | None:
        value = num(pattern)
        return None if value is None else round(value / 1000, 1)

    pressure = re.search(r"Current pressure level:\s*(\w+)", src)
    return {
        "gpuActivePct": num(r"GPU HW active residency:\s*([\d.]+)%"),
        "gpuFreqMHz": num(r"GPU HW active frequency:\s*([\d.]+)\s*MHz"),
        "gpuW": watts(r"GPU Power:\s*([\d.]+)\s*mW"),
        "cpuW": watts(r"CPU Power:\s*([\d.]+)\s*mW"),
        "aneW": watts(r"ANE Power:\s*([\d.]+)\s*mW"),
        "combinedW": watts(r"Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW"),
        "thermalPressure": pressure.group(1) if pressure else None,
    }


# powermetrics text format, from the tool itself: `CPU die temperature: %.2f C%s`.
_DIE_TEMPERATURE_RE = re.compile(
    r"^(CPU|GPU) die temperature:\s*([\d.]+)\s*°?\s*C\b",
    re.IGNORECASE | re.MULTILINE,
)
_SMC_CPU_PREFIXES = ("Tp", "Te", "Ts")
_SMC_GPU_PREFIX = "Tg"
_SMC_KEYS: tuple[list[str], list[str]] | None = None
_SMC_READ_LOCK = threading.Lock()
_SMC_READ = None


def parse_powermetrics_temperatures(text: str) -> dict[str, object]:
    """Parse CPU and GPU die temperatures from powermetrics text.

    This is the only interpreter of that text. Missing lines stay None; nothing
    is invented. Units are celsius when a line is present. The optional suffix
    after `C` (the tool's `%s`) is ignored.
    """
    cpu = gpu = None
    unit = None
    for match in _DIE_TEMPERATURE_RE.finditer(text or ""):
        try:
            value = round(float(match.group(2)), 2)
        except ValueError:
            continue
        if not 0 < value <= 150:
            continue
        unit = "celsius"
        if match.group(1).lower() == "cpu":
            cpu = value
        else:
            gpu = value
    return {"cpuCelsius": cpu, "gpuCelsius": gpu, "unit": unit}


def _smc_temperature_text_from_reader() -> str:
    """Read AppleSMC float keys and render them as powermetrics die lines.

    Apple Silicon powermetrics has no die-temperature format strings. The same
    OS power controller still exposes Tp/Te/Ts (CPU) and Tg (GPU) floats. Those
    averages are printed in the powermetrics text shape so
    `parse_powermetrics_temperatures` remains the only parser. Failures return
    "" — never a guessed number.
    """
    global _SMC_KEYS
    try:
        import ctypes
        import ctypes.util
    except ImportError:
        return ""
    try:
        iokit_path = ctypes.util.find_library("IOKit")
        if not iokit_path:
            return ""
        iokit = ctypes.cdll.LoadLibrary(iokit_path)
    except OSError:
        return ""

    class KeyDataVer(ctypes.Structure):
        _fields_ = [
            ("major", ctypes.c_uint8), ("minor", ctypes.c_uint8),
            ("build", ctypes.c_uint8), ("reserved", ctypes.c_uint8),
            ("release", ctypes.c_uint16),
        ]

    class PLimitData(ctypes.Structure):
        _fields_ = [
            ("version", ctypes.c_uint16), ("length", ctypes.c_uint16),
            ("cpu_p_limit", ctypes.c_uint32), ("gpu_p_limit", ctypes.c_uint32),
            ("mem_p_limit", ctypes.c_uint32),
        ]

    class KeyInfo(ctypes.Structure):
        _fields_ = [
            ("data_size", ctypes.c_uint32), ("data_type", ctypes.c_uint32),
            ("data_attributes", ctypes.c_uint8),
        ]

    class KeyData(ctypes.Structure):
        _fields_ = [
            ("key", ctypes.c_uint32), ("vers", KeyDataVer), ("p_limit_data", PLimitData),
            ("key_info", KeyInfo), ("result", ctypes.c_uint8), ("status", ctypes.c_uint8),
            ("data8", ctypes.c_uint8), ("data32", ctypes.c_uint32),
            ("bytes", ctypes.c_uint8 * 32),
        ]

    iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
    iokit.IOServiceMatching.restype = ctypes.c_void_p
    iokit.IOServiceGetMatchingService.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    iokit.IOServiceGetMatchingService.restype = ctypes.c_uint
    iokit.IOServiceOpen.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint)]
    iokit.IOServiceOpen.restype = ctypes.c_int
    iokit.IOServiceClose.argtypes = [ctypes.c_uint]
    iokit.IOServiceClose.restype = ctypes.c_int
    iokit.IOObjectRelease.argtypes = [ctypes.c_uint]
    iokit.IOConnectCallStructMethod.argtypes = [
        ctypes.c_uint, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_size_t,
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
    ]
    iokit.IOConnectCallStructMethod.restype = ctypes.c_int
    try:
        task = ctypes.c_uint.in_dll(iokit, "mach_task_self_")
        task_port = task.value
    except ValueError:
        return ""

    service = iokit.IOServiceGetMatchingService(0, iokit.IOServiceMatching(b"AppleSMC"))
    if not service:
        return ""
    conn = ctypes.c_uint(0)
    if iokit.IOServiceOpen(service, task_port, 0, ctypes.byref(conn)) != 0:
        iokit.IOObjectRelease(service)
        return ""

    def call(data: KeyData) -> KeyData | None:
        out = KeyData()
        olen = ctypes.c_size_t(ctypes.sizeof(KeyData))
        err = iokit.IOConnectCallStructMethod(
            conn.value, 2, ctypes.byref(data), ctypes.sizeof(data), ctypes.byref(out), ctypes.byref(olen)
        )
        if err or out.result:
            return None
        return out

    def key_id(name: str) -> int:
        return int.from_bytes(name.encode("ascii"), "big")

    def read_info(name: str) -> KeyInfo | None:
        out = call(KeyData(data8=9, key=key_id(name)))
        return None if out is None else out.key_info

    def read_bytes(name: str, info: KeyInfo) -> bytes | None:
        out = call(KeyData(data8=5, key=key_id(name), key_info=info))
        if out is None:
            return None
        return bytes(out.bytes[: info.data_size])

    try:
        cpu_keys, gpu_keys = _SMC_KEYS or ([], [])
        if not cpu_keys and not gpu_keys:
            count_info = read_info("#KEY")
            raw_count = read_bytes("#KEY", count_info) if count_info else None
            count = int.from_bytes(raw_count, "big") if raw_count else 0
            found_cpu: list[str] = []
            found_gpu: list[str] = []
            for index in range(count):
                named = call(KeyData(data8=8, data32=index))
                if named is None:
                    continue
                name = named.key.to_bytes(4, "big").decode("latin1")
                if len(name) != 4:
                    continue
                info = read_info(name)
                if info is None or info.data_size != 4 or info.data_type.to_bytes(4, "big") != b"flt ":
                    continue
                if name.startswith(_SMC_CPU_PREFIXES):
                    found_cpu.append(name)
                elif name.startswith(_SMC_GPU_PREFIX):
                    found_gpu.append(name)
            cpu_keys, gpu_keys = found_cpu, found_gpu
            if cpu_keys or gpu_keys:
                _SMC_KEYS = (cpu_keys, gpu_keys)

        import struct

        def average_floats(keys: list[str]) -> float | None:
            values: list[float] = []
            for name in keys:
                info = read_info(name)
                raw = read_bytes(name, info) if info is not None else None
                if raw is None or len(raw) < 4:
                    continue
                value = struct.unpack("<f", raw[:4])[0]
                if 0 < value <= 150:
                    values.append(value)
            if not values:
                return None
            return round(sum(values) / len(values), 2)

        cpu = average_floats(cpu_keys)
        gpu = average_floats(gpu_keys)
    except Exception:
        cpu = gpu = None
    finally:
        try:
            iokit.IOServiceClose(conn.value)
            iokit.IOObjectRelease(service)
        except OSError:
            pass

    lines = []
    if cpu is not None:
        lines.append(f"CPU die temperature: {cpu:.2f} C")
    if gpu is not None:
        lines.append(f"GPU die temperature: {gpu:.2f} C")
    return "\n".join(lines)


def read_smc_temperature_text(timeout: float = 4.0) -> str:
    """Bound the SMC read so a stuck controller cannot wedge collection.

    The first sample enumerates keys and can take a couple of seconds. Later
    samples reuse the key list and stay inside the same collection cadence.
    """
    global _SMC_READ
    with _SMC_READ_LOCK:
        if _SMC_READ is None:
            box: dict[str, str] = {}

            def work() -> None:
                try:
                    box["text"] = _smc_temperature_text_from_reader()
                except Exception:
                    box["text"] = ""

            thread = threading.Thread(target=work, name="smc-temp", daemon=True)
            _SMC_READ = (thread, box)
            thread.start()
        else:
            thread, box = _SMC_READ
    thread.join(_bounded_timeout(timeout))
    with _SMC_READ_LOCK:
        if thread.is_alive():
            return ""
        if _SMC_READ is not None and _SMC_READ[0] is thread:
            _SMC_READ = None
        return box.get("text", "")


def resolve_die_temperatures(powermetrics_text: str, *, elevated: bool,
                             smc_text: str | None = None) -> dict[str, object]:
    """Publish die temperatures only for an elevated collector.

    An ordinary user keeps nulls. Root uses powermetrics text first, then SMC
    text rendered in that same shape. Both paths go through
    `parse_powermetrics_temperatures`.
    """
    empty = {
        "cpuCelsius": None, "gpuCelsius": None, "unit": None,
        "cpuSource": None, "gpuSource": None,
    }
    if not elevated:
        return empty
    parsed = parse_powermetrics_temperatures(powermetrics_text)
    cpu_source = "powermetrics" if parsed["cpuCelsius"] is not None else None
    gpu_source = "powermetrics" if parsed["gpuCelsius"] is not None else None
    if parsed["cpuCelsius"] is None or parsed["gpuCelsius"] is None:
        fallback_text = smc_text if smc_text is not None else read_smc_temperature_text()
        fallback = parse_powermetrics_temperatures(fallback_text)
        if parsed["cpuCelsius"] is None and fallback["cpuCelsius"] is not None:
            parsed["cpuCelsius"] = fallback["cpuCelsius"]
            cpu_source = "smc"
        if parsed["gpuCelsius"] is None and fallback["gpuCelsius"] is not None:
            parsed["gpuCelsius"] = fallback["gpuCelsius"]
            gpu_source = "smc"
        if parsed["unit"] is None:
            parsed["unit"] = fallback["unit"]
    parsed["cpuSource"] = cpu_source
    parsed["gpuSource"] = gpu_source
    return parsed


def gpu_stats(allow_powermetrics: bool) -> tuple[dict[str, object], list[dict[str, str]]]:
    """GPU/ANE/power block plus explicit `unavailable` entries for what we can't read.

    powermetrics is the only source for GPU residency, GPU/CPU/ANE power and
    thermal pressure, and it needs root. Without it these fields stay null and
    are listed as unavailable — the dashboard renders "n/a", not 0.
    """
    unavailable: list[dict[str, str]] = []
    block: dict[str, object] = {
        "powermetrics": "not-attempted",
        "activePercent": None,
        "freqMHz": None,
        "powerW": None,
        "anePowerW": None,
        "combinedPowerW": None,
        "thermalPressure": None,
    }
    if not allow_powermetrics:
        reason = "powermetrics requires root (run as a LaunchDaemon, or grant sudo -n)"
        unavailable.append({"metric": "gpu.utilization", "reason": reason})
        unavailable.append({"metric": "gpu.power", "reason": reason})
        unavailable.append({"metric": "ane.power", "reason": reason})
        block["powermetrics"] = "requires-root"
        return block, unavailable

    command = POWERMETRICS_CMD if os.geteuid() == 0 else ["sudo", "-n"] + POWERMETRICS_CMD
    text = run(command, timeout=8.0)
    # Kept off the published snapshot. collect_snapshot parses temperatures from
    # this same call so a root sample does not shell out a second time.
    block["_powermetricsText"] = text
    parsed = parse_powermetrics(text)
    if parsed["gpuActivePct"] is None and parsed["combinedW"] is None:
        reason = "powermetrics returned no samples (not permitted, or unsupported on this Mac)"
        unavailable.append({"metric": "gpu.utilization", "reason": reason})
        unavailable.append({"metric": "gpu.power", "reason": reason})
        unavailable.append({"metric": "ane.power", "reason": reason})
        block["powermetrics"] = "failed"
        return block, unavailable

    block.update({
        "powermetrics": "ok",
        "activePercent": parsed["gpuActivePct"],
        "freqMHz": parsed["gpuFreqMHz"],
        "powerW": parsed["gpuW"],
        "anePowerW": parsed["aneW"],
        "combinedPowerW": parsed["combinedW"],
        "thermalPressure": parsed["thermalPressure"],
    })
    return block, unavailable


# ─── runtime detection (data-driven) ─────────────────────────────────────────

def load_inventory(path: Path) -> dict[str, object]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as err:
        raise SystemExit(f"sparkdash-mac-agent: cannot read runtime inventory {path}: {err}")
    if not isinstance(data, dict) or not isinstance(data.get("runtimes"), list):
        raise SystemExit(f"sparkdash-mac-agent: {path} has no 'runtimes' array")
    return data


def list_processes() -> dict[int, dict[str, object]]:
    """pid -> process identity, from `ps` (argv survives, unlike lsof's 16-char command)."""
    text = run(["ps", "-Ao", "pid=,ppid=,uid=,args="], timeout=3.0)
    procs: dict[int, dict[str, object]] = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 4:
            continue
        try:
            pid, ppid, uid = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        argv_text = parts[3]
        argv = argv_text.split()
        procs[pid] = {
            "pid": pid,
            "ppid": ppid,
            "uid": uid,
            "argv": argv,
            "argvText": argv_text,
            "comm": _basename(argv[0]) if argv else "",
            "script": _script_identity(argv),
        }
    return procs


def _basename(token: str) -> str:
    return os.path.basename(token.split(" ")[0]) if token else ""


def _script_identity(argv: list[str]) -> str:
    """For an interpreter, the script it is running ("python3 server.py" -> "server.py")."""
    for token in argv[1:]:
        if token.startswith("-"):
            continue
        name = os.path.basename(token)
        if name.endswith((".py", ".sh", ".js")):
            return name
        return name or ""
    return ""


def listening_sockets() -> dict[int, list[dict[str, object]]]:
    """pid -> [{port, address}] for TCP listeners, via lsof (same user, no root)."""
    text = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], timeout=4.0)
    out: dict[int, list[dict[str, object]]] = {}
    pid: int | None = None
    for line in text.splitlines():
        if line.startswith("p"):
            try:
                pid = int(line[1:])
            except ValueError:
                pid = None
        elif line.startswith("n") and pid is not None:
            name = line[1:]
            port = _name_to_port(name)
            if port:
                out.setdefault(pid, []).append({"port": port, "address": name})
    return out


def _name_to_port(name: str) -> int | None:
    """lsof address ("127.0.0.1:8300", "*.8100", "[::1]:8201") -> port."""
    tail = name.rsplit(")", 1)[-1]
    match = re.search(r":(\d+)$", tail)
    return int(match.group(1)) if match else None


def extract_model(argv: list[str], spec: dict[str, object]) -> str | None:
    """Served model, read out of argv: a configured flag first, then a positional
    OWNER/REPO-ish token."""
    for flag in spec.get("flags") or []:
        for index, token in enumerate(argv):
            if token == flag and index + 1 < len(argv):
                return _display_model(argv[index + 1])
            if token.startswith(flag + "="):
                return _display_model(token.split("=", 1)[1])
    if spec.get("positional"):
        for token in argv[1:]:
            if token.startswith("-"):
                continue
            if re.fullmatch(r"[\w.\-]+/[\w.\-]+", token):
                return token
    return None


def _display_model(value: str) -> str:
    """Show an id as-is; collapse an absolute model directory path to its last two parts."""
    value = value.strip().strip("'\"")
    if not value.startswith(("/", "./", "~/")):
        return value
    parts = [part for part in value.rstrip("/").split(os.sep) if part]
    return os.path.join(*parts[-2:]) if len(parts) >= 2 else value


def _entry_matches(entry: dict[str, object], proc: dict[str, object]) -> bool:
    exe = entry.get("exe")
    if exe:
        identity = f"{proc['comm']} {proc['script']}"
        if not (re.search(str(exe), str(proc["comm"])) or re.search(str(exe), str(proc["script"]))
                or re.search(str(exe), identity)):
            return False
    for pattern in entry.get("argvAll") or []:
        if not re.search(str(pattern), str(proc["argvText"])):
            return False
    return bool(entry.get("argvAll") or exe)


def health_check(port: int, path: str, timeout_ms: int) -> dict[str, object]:
    """GET the entry's health path on loopback: proves 'serving', and often names the model."""
    url = f"http://127.0.0.1:{port}{path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout_ms / 1000) as response:
            body = response.read(65536).decode("utf-8", "replace")
            status = int(getattr(response, "status", 200))
    except (urllib.error.URLError, OSError, ValueError):
        return {"ok": False, "url": url}
    model = None
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if isinstance(data, dict):
        for key in ("data", "models"):
            rows = data.get(key)
            if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                model = rows[0].get("id") or rows[0].get("model") or None
                break
        model = model or data.get("model")
    return {"ok": 200 <= status < 400, "url": url, "model": model}


def detect_runtimes(inventory: dict[str, object], procs: dict[int, dict[str, object]],
                    listeners: dict[int, list[dict[str, object]]]) -> list[dict[str, object]]:
    if os.geteuid() == 0:
        try:
            console_uid = os.stat("/dev/console").st_uid
        except OSError:
            return []
        if console_uid == 0:
            return []
        procs = {pid: proc for pid, proc in procs.items() if proc.get("uid") == console_uid}
    procs = {
        pid: proc for pid, proc in procs.items()
        if pid != os.getpid() and not any(
            os.path.basename(token) == "sparkdash_mac_agent.py" for token in proc["argv"]
        )
    }
    defaults = inventory.get("defaults") or {}
    default_health = defaults.get("health") or {"path": "/v1/models", "timeoutMs": 750}
    default_model = defaults.get("model") or {"flags": ["--model"], "positional": False}
    entries = [e for e in inventory.get("runtimes") or [] if isinstance(e, dict)]

    found: list[dict[str, object]] = []
    claimed: set[int] = set()

    for entry in entries:
        role = str(entry.get("role") or "server")
        wanted_ports = [int(p) for p in entry.get("ports") or []]
        for pid, proc in procs.items():
            if pid in claimed or not _entry_matches(entry, proc):
                continue
            owned = listeners.get(pid) or []
            port = None
            if role != "watchdog":
                if wanted_ports:
                    port = next((row["port"] for row in owned if row["port"] in wanted_ports), None)
                    if port is None:
                        continue
                elif owned:
                    port = owned[0]["port"]
            record: dict[str, object] = {
                "name": entry.get("name"),
                "label": entry.get("label") or entry.get("name"),
                "role": role,
                "pid": pid,
                "command": proc["comm"],
                "script": proc["script"] or None,
                "port": port,
                "model": extract_model(list(proc["argv"]), entry.get("model") or default_model),
                "state": "running" if role == "watchdog" else "listening",
                "detectedBy": "inventory",
            }
            if role != "watchdog" and port:
                spec = entry.get("health") or default_health
                health = health_check(int(port), str(spec.get("path", "/v1/models")),
                                      int(spec.get("timeoutMs", 750)))
                record["health"] = {"ok": health["ok"], "url": health["url"]}
                if health.get("model"):
                    record["model"] = health["model"]
                if health["ok"]:
                    record["state"] = "serving"
            claimed.add(pid)
            found.append(record)

    other = defaults.get("otherRuntime") or {}
    if other.get("enabled", True):
        interpreter = str(other.get("interpreter") or "^(python|python3)$")
        serve_hint = str(other.get("serveArgv") or "")
        for pid, owned in listeners.items():
            if pid in claimed:
                continue
            proc = procs.get(pid)
            if not proc:
                continue
            if not re.search(interpreter, str(proc["comm"])):
                continue
            if serve_hint and not re.search(serve_hint, str(proc["argvText"])):
                continue
            argv = list(proc["argv"])
            found.append({
                "name": str(other.get("label") or "other-runtime"),
                "label": proc["script"] or proc["comm"],
                "role": "server",
                "pid": pid,
                "command": proc["comm"],
                "script": proc["script"] or None,
                "port": owned[0]["port"],
                "model": extract_model(argv, default_model),
                "state": "listening",
                "detectedBy": "listener",
            })
            claimed.add(pid)

    found.sort(key=lambda row: (row.get("port") is None, row.get("port") or 0, str(row.get("name"))))
    return found


# ─── snapshot assembly ───────────────────────────────────────────────────────

def host_info() -> dict[str, object]:
    mac_os, mac_version, _machine = platform.mac_ver()
    sys = sysctl_read([
        "hw.model", "hw.ncpu", "hw.memsize", "machdep.cpu.brand_string",
        "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu",
        "kern.osproductversion",
    ])
    cores = sys.get("hw.ncpu")
    perf = sys.get("hw.perflevel0.physicalcpu")
    eff = sys.get("hw.perflevel1.physicalcpu")
    mem = sys.get("hw.memsize")
    return {
        "platform": "macos",
        "hostname": socket.gethostname(),
        "osVersion": f"macOS {sys.get('kern.osproductversion')}" if sys.get("kern.osproductversion")
                     else (f"macOS {mac_version}" if mac_version else mac_os),
        "arch": platform.machine(),
        "model": sys.get("hw.model"),
        "chip": sys.get("machdep.cpu.brand_string"),
        "cpuCores": int(cores) if cores and cores.isdigit() else None,
        "performanceCores": int(perf) if perf and perf.isdigit() else None,
        "efficiencyCores": int(eff) if eff and eff.isdigit() else None,
        "totalMemoryMB": int(round(int(mem) / MB)) if mem and mem.isdigit() else None,
    }


def parse_pmset_therm(text: str) -> dict[str, object]:
    """Expose pmset's last recorded events, never a Celsius measurement."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    state = "unknown"
    # pmset reports historical warning events as well as explicit no-event notes.
    levels = re.findall(r"(?:Thermal_Level(?:_Warning)?|thermal warning level)\s*[:=]\s*(\d+)", text, re.I)
    if levels:
        level = int(levels[-1])
        state = "nominal" if level == 0 else "slow" if level in (5, 100) else "trapped" if level in (10, 110) else "unknown"
    elif "No thermal warning level has been recorded" in text:
        state = "nominal"
    limits = re.findall(r"CPU_(?:Speed|Scheduler)_Limit\s*=\s*(\d+)", text)
    if state == "nominal" and any(int(limit) < 100 for limit in limits):
        state = "slow"
    return {"pressureState": state, "lastRecordedEvents": lines, "source": "pmset -g therm"}


def collect_snapshot(inventory: dict[str, object], *, allow_powermetrics: bool,
                     cpu_probe: CpuProbe | None = None,
                     procs: dict[int, dict[str, object]] | None = None,
                     listeners: dict[int, list[dict[str, object]]] | None = None,
                     elevated: bool | None = None,
                     smc_temperature_text: str | None = None) -> dict[str, object]:
    unavailable: list[dict[str, str]] = []
    started = time.time()

    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = None
    cpu = (cpu_probe.sample() if cpu_probe else
           (cpu_sample_psutil() or cpu_sample_iostat() or cpu_sample_top())) or {}
    usage = cpu.get("usagePercent")
    if usage is None:
        unavailable.append({"metric": "cpu.usage", "reason": "no CPU sample (top/psutil unavailable)"})
    per_core = cpu.get("perCorePercent")
    if per_core is None:
        unavailable.append({"metric": "cpu.perCore", "reason": "install psutil for per-core readings"})

    vm = parse_vm_stat(run(["vm_stat"], timeout=3.0))
    memsize = sysctl_read(["hw.memsize", "vm.swapusage"])
    memory = unified_memory(vm, int(memsize.get("hw.memsize") or 0))
    memory["swap"] = parse_swap_usage(memsize.get("vm.swapusage"))
    memory["source"] = "vm_stat"

    network, network_notes = network_stats()
    for note in network_notes:
        unavailable.append({"metric": "network", "reason": note})
    reachability = probe_reachability()
    if network is not None:
        network["reachability"] = reachability

    gpu, gpu_unavailable = gpu_stats(allow_powermetrics)
    unavailable.extend(gpu_unavailable)
    power_text = str(gpu.pop("_powermetricsText", "") or "")
    if elevated is None:
        elevated = os.geteuid() == 0
    # Ordinary users stay on the honesty path even if SMC is readable without
    # root. Only an elevated process (the LaunchDaemon) publishes die temperatures.
    temps = resolve_die_temperatures(
        power_text, elevated=elevated, smc_text=smc_temperature_text,
    )
    cpu_temp = temps["cpuCelsius"] if elevated else None
    gpu_temp = temps["gpuCelsius"] if elevated else None
    if not elevated:
        temperature_reason = "requires root for powermetrics" if not allow_powermetrics else "temperature is not reported by powermetrics"
        for metric in ("cpu.temperature", "gpu.temperature"):
            unavailable.append({"metric": metric, "reason": temperature_reason})
    else:
        if cpu_temp is None:
            unavailable.append({"metric": "cpu.temperature", "reason": "temperature is not reported by powermetrics"})
        if gpu_temp is None:
            unavailable.append({"metric": "gpu.temperature", "reason": "temperature is not reported by powermetrics"})
    thermal = parse_pmset_therm(run(["pmset", "-g", "therm"], timeout=3.0))
    if thermal["pressureState"] == "unknown":
        unavailable.append({"metric": "thermal.pressureState", "reason": "pmset returned no recognized thermal state"})

    runtimes = detect_runtimes(
        inventory,
        procs if procs is not None else list_processes(),
        listeners if listeners is not None else listening_sockets(),
    )

    boot = parse_boot_time(sysctl_read(["kern.boottime"]).get("kern.boottime"))
    uptime = int(max(0, time.time() - boot)) if boot else None
    if uptime is None:
        unavailable.append({"metric": "uptime", "reason": "kern.boottime unreadable"})

    return {
        "schema": SCHEMA,
        "agentVersion": AGENT_VERSION,
        "collectedAt": int(started),
        "collectMs": int(round((time.time() - started) * 1000)),
        "uptimeSeconds": uptime,
        "bootTime": boot,
        "host": host_info(),
        "cpu": {
            "usagePercent": usage,
            "temperature": cpu_temp,
            "temperatureUnit": "celsius" if cpu_temp is not None else None,
            "temperatureSource": temps["cpuSource"] if cpu_temp is not None else None,
            "perCorePercent": per_core,
            "loadAverage": [load1, load5, load15],
            "source": cpu.get("source"),
        },
        "memory": memory,
        "disks": disk_stats(),
        "network": network,
        "gpu": {
            **gpu,
            "temperature": gpu_temp,
            "temperatureUnit": "celsius" if gpu_temp is not None else None,
            "temperatureSource": temps["gpuSource"] if gpu_temp is not None else None,
        },
        "thermal": thermal,
        "runtimes": runtimes,
        "unavailable": unavailable,
    }


# ─── serving ─────────────────────────────────────────────────────────────────

def collecting_snapshot() -> dict[str, object]:
    return {
        "status": "pending",
        "reason": "metrics collection still running or unavailable",
    }


class SampleCache:
    """One sample shared by all requests inside the TTL, so a poll storm costs one `top`.

    Collection does not hold the request lock. A probe that is still running
    serves the previous sample (or a short collecting snapshot) so /metrics
    cannot wedge behind one blocked command.
    """

    def __init__(self, inventory: dict[str, object], allow_powermetrics: bool,
                 cpu_probe: CpuProbe | None = None, ttl: float = SAMPLE_TTL_S):
        self._inventory = inventory
        self._allow_powermetrics = allow_powermetrics
        self._cpu_probe = cpu_probe
        self._ttl = ttl
        self._lock = threading.Lock()
        self._sample: dict[str, object] | None = None
        self._at = 0.0
        self._worker = None

    def _response(self) -> dict[str, object]:
        if self._sample is None:
            return collecting_snapshot()
        age = max(0, time.monotonic() - self._at)
        stale = age >= self._ttl
        response = {**self._sample, "sampleAgeSeconds": age, "sampleStale": stale}
        if stale:
            response["unavailable"] = [
                *self._sample.get("unavailable", []),
                {"metric": "agent.sample", "reason": "last sample is stale; refresh running or unavailable"},
            ]
        return response

    def _collect(self) -> None:
        try:
            sample = collect_snapshot(
                self._inventory,
                allow_powermetrics=self._allow_powermetrics,
                cpu_probe=self._cpu_probe,
            )
        except Exception:
            sample = None
        with self._lock:
            if isinstance(sample, dict):
                self._sample = sample
                self._at = time.monotonic()
            self._worker = None

    def get(self, force: bool = False) -> dict[str, object]:
        with self._lock:
            now = time.monotonic()
            fresh = self._sample is not None and now - self._at < self._ttl
            if not force and fresh:
                return self._response()
            if self._worker is not None:
                return self._response()
            worker = threading.Thread(target=self._collect, name="metrics-collect", daemon=True)
            self._worker = worker
            worker.start()

        worker.join(COLLECT_DEADLINE_S)
        with self._lock:
            return self._response()


class Handler(BaseHTTPRequestHandler):
    cache: SampleCache  # set on the subclass below
    control = None  # RuntimeControl, or None when the catalog module is absent
    server_version = "sparkdash-mac-agent/" + AGENT_VERSION

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/metrics":
            payload = self.cache.get()
            self._json(payload, status=200 if payload.get("schema") == SCHEMA else 503)
        elif path == "/health":
            self._json({"ok": True, "schema": SCHEMA, "agentVersion": AGENT_VERSION})
        elif path == "/control":
            self._control_status()
        else:
            self.send_error(404, "unknown path")

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/control/start":
            self._control_action("start")
        elif path == "/control/stop":
            self._control_action("stop")
        else:
            self.send_error(404, "unknown path")

    def _root_control_refusal(self) -> dict[str, object] | None:
        # The privileged collector is the same script. It must not launch
        # anything, even if a control object was injected by mistake.
        if os.geteuid() != 0:
            return None
        reason = "privileged collector cannot launch user runtimes"
        return {
            "schema": CONTROL_SCHEMA,
            "ok": False,
            "control": "denied",
            "reason": reason,
            "error": reason,
            "serving": None,
            "servingError": None,
            "targets": [],
        }

    def _control_status(self) -> None:
        refused = self._root_control_refusal()
        if refused is not None:
            self._json(refused)
            return
        if self.control is None:
            reason = "runtime control is not installed on this agent"
            self._json({
                "schema": CONTROL_SCHEMA,
                "control": "disabled",
                "reason": reason,
                "serving": None,
                "servingError": None,
                "targets": [],
            })
            return
        self._json(self.control.status())

    def _control_action(self, action: str) -> None:
        refused = self._root_control_refusal()
        if refused is not None:
            self._json(refused, status=403)
            return
        if self.control is None:
            reason = "runtime control is not installed on this agent"
            self._json({
                "schema": CONTROL_SCHEMA,
                "ok": False,
                "control": "disabled",
                "reason": reason,
                "error": reason,
                "serving": None,
                "servingError": None,
                "targets": [],
            }, status=403)
            return
        body, error = self._read_json_object()
        if error:
            self._json({
                "schema": CONTROL_SCHEMA,
                "ok": False,
                "control": "ready",
                "reason": error,
                "error": error,
                "serving": None,
                "servingError": None,
                "targets": [],
            }, status=400)
            return
        status, payload = self.control.act(action, self.headers, body)
        self._json(payload, status=status)

    def _read_json_object(self) -> tuple[dict | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return None, "control request has a bad Content-Length"
        if length < 0 or length > 8192:
            return None, "control request body is too large"
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}, None
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            return None, f"control request is not JSON: {exc}"
        if not isinstance(data, dict):
            return None, "control request must be a JSON object"
        return data, None

    def _json(self, payload: dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence request logging
        return


def make_handler(cache: SampleCache, control=None):
    return type("SparkdashHandler", (Handler,), {"cache": cache, "control": control})


def build_runtime_control(inventory: dict[str, object], catalog_path: Path):
    """User-agent control object. Import failure leaves metrics serving intact."""
    try:
        from runtime_control import RuntimeControl, load_control_catalog, run_control_command
    except ImportError:
        return None
    catalog, load_error = load_control_catalog(catalog_path)

    def probe():
        return detect_runtimes(inventory, list_processes(), listening_sockets())

    return RuntimeControl(
        catalog,
        token=os.environ.get("SPARKDASH_MAC_CONTROL_TOKEN", ""),
        euid=os.geteuid(),
        load_error=load_error,
        probe_serving=probe,
        runner=run_control_command,
    )


def serve(host: str, port: int, cache: SampleCache, control=None) -> None:
    httpd = ThreadingHTTPServer((host, port), make_handler(cache, control))
    print(f"sparkdash-mac-agent listening on http://{host}:{port}/metrics", file=sys.stderr, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="sparkDash Mac node agent")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="print one JSON snapshot and exit")
    mode.add_argument("--serve", action="store_true", help="serve /metrics over HTTP (launchd)")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind address for --serve")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port for --serve")
    parser.add_argument("--config", default=os.environ.get("SPARKDASH_RUNTIMES", str(DEFAULT_INVENTORY)),
                        help="runtime inventory JSON")
    parser.add_argument("--control", default=os.environ.get("SPARKDASH_MAC_CONTROL", str(DEFAULT_CONTROL)),
                        help="runtime control catalog JSON; missing means control is unavailable")
    parser.add_argument("--powermetrics", action="store_true",
                        help="attempt powermetrics even when not root (needs sudo -n)")
    parser.add_argument("--sample-interval", type=float, default=SAMPLE_TTL_S,
                        help="background CPU sampling interval for --serve")
    parser.add_argument("--pretty", action="store_true", help="indent --once output")
    args = parser.parse_args(argv)

    inventory = load_inventory(Path(args.config))
    allow_powermetrics = args.powermetrics or os.geteuid() == 0

    if args.serve:
        probe = CpuProbe(interval=args.sample_interval)
        probe.start()
        try:
            serve(
                args.host,
                args.port,
                SampleCache(inventory, allow_powermetrics, probe),
                build_runtime_control(inventory, Path(args.control)),
            )
        finally:
            probe.stop()
        return 0

    snapshot = collect_snapshot(inventory, allow_powermetrics=allow_powermetrics)
    json.dump(snapshot, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
