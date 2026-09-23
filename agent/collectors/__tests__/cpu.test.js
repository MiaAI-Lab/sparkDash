import test from "node:test";
import assert from "node:assert/strict";
import { collectCpu, resetCpuBaseline, parseCpuStat } from "../cpu.js";

const STAT_A = "cpu  100 0 50 800 50 0 0 0\n"; // total=1000, used=150
const STAT_B = "cpu  200 0 100 1600 100 0 0 0\n"; // total=2000, used=300

let statRaw = STAT_A;
const readFile = async (p) => {
  if (p === "/proc/stat") return statRaw;
  if (p === "/sys/class/thermal/thermal_zone0/temp") return "45000\n";
  if (p === "/proc/uptime") return "1000.0 500.0\n";
  throw new Error(`ENOENT: ${p}`);
};

test("parseCpuStat: field summing (ground truth)", () => {
  assert.deepEqual(parseCpuStat("cpu  100 5 50 800 50 10 20 5\n"), { total: 1040, used: 190 });
  assert.deepEqual(parseCpuStat(STAT_A), { total: 1000, used: 150 });
  assert.equal(parseCpuStat("nope\n"), null);
});

test("cpu: first call seeds baseline → usage 0, idle power estimate", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  const c = await collectCpu({ readFile });
  assert.equal(c.usage, 0);
  assert.equal(c.tdp, 65); // GB10 default (no powercap CPU entry in mock)
  assert.equal(c.draw, 5.2); // idle = 65 * 0.08
  assert.equal(c.temperature, 45); // 45000 mC
});

test("cpu: second call computes delta usage (ground truth: 15%)", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  await collectCpu({ readFile, now: () => 0 });
  statRaw = STAT_B;
  const c = await collectCpu({ readFile, now: () => 10_000 });
  assert.equal(c.usage, 15); // dUsed/dTotal = 150/1000
  assert.equal(c.tdp, 65);
  assert.equal(c.draw, 14.2); // 5.2 + (65−5.2)*0.15 = 14.17 → 14.2
  assert.equal(c.temperature, 45);
});

test("cpu: usage clamps to 100 on counter anomalies", async () => {
  resetCpuBaseline();
  statRaw = STAT_B; // total=2000
  await collectCpu({ readFile, now: () => 0 });
  statRaw = "cpu  100 0 0 0 0 0 0 0\n"; // total=100 < previous → no delta
  const c = await collectCpu({ readFile, now: () => 1000 });
  assert.equal(c.usage, 0); // counter went backwards → treated as reset, no negative usage
});

test("cpu: null when /proc/stat is unreadable", async () => {
  resetCpuBaseline();
  const readFileDeny = async () => {
    throw new Error("deny");
  };
  assert.equal(await collectCpu({ readFile: readFileDeny }), null);
});

test("cpu: null on all-zero counters", async () => {
  resetCpuBaseline();
  statRaw = "cpu 0 0 0 0 0 0 0 0\n";
  assert.equal(await collectCpu({ readFile }), null);
});
