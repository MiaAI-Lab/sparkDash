import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector, parseClockCap } from "../SystemCollector.js";

const BOOT = "0f1e2d3c-4b5a-6978-8877-665544332211";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("parseClockCap: marker with matching boot_id", () => {
  assert.equal(parseClockCap(`1800 ${BOOT}\n${BOOT}`), 1800);
});

test("parseClockCap: marker without boot_id is trusted", () => {
  assert.equal(parseClockCap(`2200\n${BOOT}`), 2200);
});

test("parseClockCap: stale marker from a previous boot is ignored", () => {
  assert.equal(parseClockCap(`1800 ${OTHER}\n${BOOT}`), null);
});

test("parseClockCap: no marker / junk → null", () => {
  assert.equal(parseClockCap(BOOT), null);
  assert.equal(parseClockCap(""), null);
  assert.equal(parseClockCap("cap\n"), null);
  assert.equal(parseClockCap(`0 ${BOOT}\n${BOOT}`), null);
});

// Shaped like the real remote probe: named `__SECTION__` blocks.
function probeOutput(smLine, clockCap) {
  return [
    "__NVIDIA__",
    smLine,
    "__NVIDIA_VRAM__",
    "[N/A], [N/A]",
    "__NVIDIA_APPS__",
    "",
    "__MEMINFO__",
    "MemTotal:       125000000 kB\nMemAvailable:   60000000 kB",
    "__CLOCK_CAP__",
    clockCap,
  ].join("\n");
}

test("_getRemoteGpu: clock cap marker lands on throttle.clockCapMHz", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const output = probeOutput(
    "52, 96, 60.1, 140, 1794, 3003, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-abc",
    `1800 ${BOOT}\n${BOOT}`,
  );
  const gpu = await c._getRemoteGpu(async () => output);
  assert.equal(gpu.throttle.clockCapMHz, 1800);
  assert.equal(gpu.gpus[0].throttle.clockCapMHz, 1800);
  assert.match(gpu.throttle.detail, /Clock locked ≤ 1800 MHz/);
});

test("_getRemoteGpu: no marker → clockCapMHz null", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const output = probeOutput(
    "52, 96, 60.1, 140, 2418, 3003, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-abc",
    BOOT,
  );
  const gpu = await c._getRemoteGpu(async () => output);
  assert.equal(gpu.throttle.clockCapMHz, null);
  assert.equal(gpu.throttle.detail, "Clocks not limited");
});
