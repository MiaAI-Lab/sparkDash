import assert from "node:assert/strict";
import test from "node:test";

import { SystemCollector } from "../SystemCollector.js";

function localSpark() {
  return { id: "local-test", name: "Local Test", isLocal: true, lanIp: "127.0.0.1" };
}

/** A /proc/vmstat excerpt with the two swap counters and unrelated neighbours. */
const vmstat = (pswpin, pswpout) =>
  [
    "nr_free_pages 1234567",
    `pswpin ${pswpin}`,
    `pswpout ${pswpout}`,
    "pgalloc_normal 987654321",
  ].join("\n");

test("_swapRates: the first read seeds the baseline and reports no rate", () => {
  const collector = new SystemCollector(localSpark());
  assert.equal(collector._swapRates(vmstat(1000, 2000), 1_000_000), null);
});

test("_swapRates: pages per second since the previous read", () => {
  const collector = new SystemCollector(localSpark());
  collector._swapRates(vmstat(1000, 2000), 1_000_000);
  // 2000 pages in and 500 out over 2 s.
  assert.deepEqual(collector._swapRates(vmstat(3000, 2500), 1_002_000), {
    inPagesPerSec: 1000,
    outPagesPerSec: 250,
  });
  // Idle: the counters stand still, so the rate is a measured zero, not unknown.
  assert.deepEqual(collector._swapRates(vmstat(3000, 2500), 1_004_000), {
    inPagesPerSec: 0,
    outPagesPerSec: 0,
  });
});

test("_swapRates: a counter that went backwards reseeds instead of reporting a negative rate", () => {
  const collector = new SystemCollector(localSpark());
  collector._swapRates(vmstat(900_000, 900_000), 1_000_000);
  // The unit rebooted: both counters restart at zero.
  assert.equal(collector._swapRates(vmstat(10, 20), 1_002_000), null);
  assert.deepEqual(collector._swapRates(vmstat(1010, 1020), 1_004_000), {
    inPagesPerSec: 500,
    outPagesPerSec: 500,
  });
});

test("_swapRates: a missing or malformed counter is unknown, not zero", () => {
  const collector = new SystemCollector(localSpark());
  assert.equal(collector._swapRates("nr_free_pages 10\npswpin 5\n", 1_000_000), null);
  assert.equal(collector._swapRates("", 1_000_000), null);
  assert.equal(collector._swapRates(undefined, 1_000_000), null);
  // A read that failed drops the baseline, so the next good read seeds again.
  collector._swapRates(vmstat(100, 100), 1_000_000);
  assert.equal(collector._swapRates("pswpin notanumber\npswpout 5\n", 1_002_000), null);
  assert.equal(collector._swapRates(vmstat(200, 200), 1_004_000), null);
});

test("_getRemoteUnifiedMemory: swap counters ride the existing batched command", async (t) => {
  const collector = new SystemCollector({ id: "spark-1", name: "Spark 1", lanIp: "192.0.2.10" });
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const commands = [];
  let counters = ["pswpin 4000", "pswpout 1000"];
  collector._sshExec = async (_spark, cmd) => {
    commands.push(cmd);
    return [
      "MemTotal:       131072000 kB",
      "MemAvailable:    8388608 kB",
      ...counters,
      "---",
      "1234, python, 2048",
    ].join("\n");
  };

  const first = await collector._getRemoteUnifiedMemory();
  assert.equal(commands.length, 1);
  assert.match(commands[0], /\/proc\/vmstat/);
  assert.equal(first.swap, null); // baseline only

  now += 2000;
  counters = ["pswpin 6000", "pswpout 3000"];
  const second = await collector._getRemoteUnifiedMemory();
  assert.equal(commands.length, 2);
  assert.deepEqual(second.swap, { inPagesPerSec: 1000, outPagesPerSec: 1000 });
});

test("_getRemoteUnifiedMemory: a unit without /proc/vmstat reports swap as unknown", async () => {
  const collector = new SystemCollector({ id: "spark-1", name: "Spark 1", lanIp: "192.0.2.10" });
  collector._sshExec = async () => "MemTotal: 131072000 kB\nMemAvailable: 8388608 kB\n---\n";
  const mem = await collector._getRemoteUnifiedMemory();
  assert.equal(mem.swap, null);
});

test("_getUnifiedMemory: the local unit reads swap counters from /proc/vmstat", async (t) => {
  const collector = new SystemCollector(localSpark());
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const reads = [];
  let counters = vmstat(4000, 1000);
  collector._readHostFile = async (hostPath) => {
    reads.push(hostPath);
    if (hostPath === "/proc/meminfo") {
      return "MemTotal:       131072000 kB\nMemAvailable:    8388608 kB\n";
    }
    if (hostPath === "/proc/vmstat") return counters;
    throw new Error(`unexpected read ${hostPath}`);
  };
  collector._nvidiaSmi = async () => "";

  const first = await collector._getUnifiedMemory();
  assert.ok(reads.includes("/proc/vmstat"));
  assert.equal(first.swap, null); // baseline only

  now += 2000;
  counters = vmstat(6000, 3000);
  const second = await collector._getUnifiedMemory();
  assert.deepEqual(second.swap, { inPagesPerSec: 1000, outPagesPerSec: 1000 });
});
