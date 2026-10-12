import test from "node:test";
import assert from "node:assert/strict";
import {
  SystemCollector,
  parseCpuClockCaps,
  parseGpuClockLock,
} from "../SystemCollector.js";

test("parseCpuClockCaps groups cores into frequency domains", () => {
  const raw = [
    "cpu0:2808000:2808000",
    "cpu1:2808000:2808000",
    "cpu5:2600000:3900000",
    "cpu9:2600000:3900000",
    "cpu15:2600000:3900000",
    "cpu19:2600000:3900000",
  ].join("\n");
  const caps = parseCpuClockCaps(raw);
  assert.equal(caps.length, 2);
  // Sorted by max desc: X925 (3900) first, then A725 (2808).
  assert.deepEqual(caps[0], { label: "X925", capMHz: 2600, maxMHz: 3900, capped: true });
  assert.deepEqual(caps[1], { label: "A725", capMHz: 2808, maxMHz: 2808, capped: false });
});

test("parseCpuClockCaps marks a domain uncapped when cap == max", () => {
  const caps = parseCpuClockCaps("cpu0:3900000:3900000");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].capped, false);
});

test("parseCpuClockCaps keeps the strictest cap within a domain", () => {
  const caps = parseCpuClockCaps("cpu5:2600000:3900000\ncpu6:2400000:3900000");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].capMHz, 2400);
  assert.equal(caps[0].capped, true);
});

test("parseCpuClockCaps ignores malformed lines", () => {
  const caps = parseCpuClockCaps("garbage\ncpu0:abc:3900000\n\ncpu1:2600000:3900000");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].capMHz, 2600);
});

test("parseCpuClockCaps returns [] for empty input", () => {
  assert.deepEqual(parseCpuClockCaps(""), []);
  assert.deepEqual(parseCpuClockCaps(null), []);
});

test("parseGpuClockLock reads -lgc MIN,MAX", () => {
  const unit = [
    "[Unit]",
    "Description=Lock NVIDIA GPU graphics clocks to user range",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/bin/nvidia-smi -lgc 0,2200",
    "RemainAfterExit=yes",
  ].join("\n");
  assert.deepEqual(parseGpuClockLock(unit), { minMHz: 0, maxMHz: 2200 });
});

test("parseGpuClockLock handles spaces and a non-zero min", () => {
  assert.deepEqual(parseGpuClockLock("nvidia-smi -lgc 1000, 2400"), {
    minMHz: 1000,
    maxMHz: 2400,
  });
});

test("parseGpuClockLock returns null when no lock is present", () => {
  assert.equal(parseGpuClockLock("[Service]\nExecStart=/bin/true\n"), null);
  assert.equal(parseGpuClockLock(""), null);
  assert.equal(parseGpuClockLock(null), null);
});

test("remote clock-caps command dumps per-core caps then the lock unit", () => {
  const c = new SystemCollector({ id: "t", kind: "spark" });
  const cmd = c._buildRemoteClockCapsCommand();
  assert.match(cmd, /max_perf/);
  assert.match(cmd, /cpuinfo_max_freq/);
  // Default unit path is present and single-quoted (shell-safe).
  assert.match(cmd, /cat '\/etc\/systemd\/system\/gpu-clock-lock\.service' 2>\/dev\/null/);
  assert.equal((cmd.match(/echo '---'/g) || []).length, 1);
});

test("remote CPU collection carries clockCaps from the caps dump", async () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  // Stub the caps source so no real ssh/sysfs is touched.
  collector._getClockCaps = async () => ({
    at: Date.now(),
    cpuDomains: [{ label: "X925", capMHz: 2600, maxMHz: 3900, capped: true }],
    gpuLock: null,
  });
  const result = await collector._getRemoteCpu(async () =>
    ["cpu 100 0 40 860 0 0 0 0", "---", "CPU architecture: 8", "---", "70900"].join("\n")
  );
  assert.deepEqual(result.clockCaps, [
    { label: "X925", capMHz: 2600, maxMHz: 3900, capped: true },
  ]);
});
