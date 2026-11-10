import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";

import { SystemCollector, collectionWasSuccessful } from "../SystemCollector.js";
import { FakeChild } from "./fixtures/fakeChild.js";

// The GPU fields (fan [N/A] and a PCIe link on a GB10), then memory.used,memory.total.
const GB10_LINE =
  "45, 3, 11.20, [N/A], 2405, 3003, Not Active, Not Active, Not Active, Not Active, 0, NVIDIA GB10, GPU-abc, [N/A], 1, 1, 1, 16, [N/A], [N/A]";
const APP_LINES = "4242, /usr/bin/python3, 2048, GPU-abc";

/** A local collector whose non-NVIDIA probes and host reads are stubbed out. */
function localCollector(t, { hostProc = true } = {}) {
  const collector = new SystemCollector({ id: "stream-test", kind: "spark", isLocal: true });
  collector._hasHostProc = () => hostProc;
  collector._probeLocalAmd = async () => ({ devices: [] });
  collector._readLocalClockCap = async () => null;
  collector._probeIntelLocal = async () => null;
  collector._getCPUPower = async () => ({ draw: 10 });
  collector._nvErrNoMemory = async () => 0;
  collector._kernelErrors = async () => null;
  collector._readMeminfoMB = async () => ({ totalMB: 120_000, availMB: 100_000 });
  collector._readGpuMemoryFileFull = () => ({ used: 0, total: 0, processes: [] });
  collector._readHostFile = async () => "MemTotal: 122880000 kB\nMemAvailable: 102400000 kB\n";
  const smiCalls = [];
  collector._nvidiaSmi = async (args) => {
    smiCalls.push(args);
    if (args.startsWith("--query-compute-apps")) return APP_LINES;
    throw new Error(`unexpected per-call nvidia-smi ${args}`);
  };
  const spawned = [];
  t.mock.method(childProcess, "spawn", (file, args) => {
    const child = new FakeChild();
    spawned.push({ file, args, child });
    return child;
  });
  t.after(() => collector.dispose());
  return { collector, smiCalls, spawned };
}

test("streams off (one-shot users): nothing long-lived is spawned", async (t) => {
  const { collector, spawned } = localCollector(t);
  collector._nvidiaSmi = async () => "";
  await collector._getGPUAll();
  assert.equal(spawned.length, 0);
});

test("GPU metrics and memory come from one long-lived -lms process in the host mount namespace", async (t) => {
  const { collector, smiCalls, spawned } = localCollector(t);
  collector.useNvidiaSmiStreams({ gpu: 2000, memory: 2000 });

  const first = collector._getGPUAll();
  assert.equal(spawned.length, 1);
  const { file, args, child } = spawned[0];
  assert.equal(file, "nsenter");
  assert.match(args[0], /^--mount=.*\/1\/ns\/mnt$/);
  assert.deepEqual(args.slice(1, 4), ["--", "sh", "-c"]);
  assert.match(args[4], /^exec \S*nvidia-smi --query-gpu=temperature\.gpu,.*,index,name,uuid,fan\.speed,.*,pcie\.link\.width\.max,memory\.used,memory\.total --format=csv,noheader,nounits -lms 2000 2>\/dev\/null$/);

  child.write(`${GB10_LINE}\n${GB10_LINE.replace("45,", "46,")}\n`);
  const gpu = await first;
  assert.equal(gpu.temperature, 46);
  assert.equal(gpu.usage, 3);
  assert.equal(gpu.gpus[0].name, "NVIDIA GB10");
  assert.equal(gpu.vram.used, 2048, "GB10 memory.used is N/A: compute-apps still supplies it");
  assert.equal(gpu.processes[0].pid, 4242);

  await collector._getGPUAll();
  await collector._getGPUAll();
  assert.equal(spawned.length, 1, "no spawn per poll");
  assert.deepEqual(smiCalls, ["--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid --format=csv,noheader,nounits"], "compute-apps is throttled");
});

test("discrete GPU memory fields are read from the streamed line", async (t) => {
  const { collector, spawned } = localCollector(t);
  collector.spark.kind = "host";
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  const pending = collector._getGPUAll();
  const line = GB10_LINE.replace(/\[N\/A\], \[N\/A\]$/, "13234, 16303");
  spawned[0].child.write(`${line}\n${line}\n`);
  const gpu = await pending;
  assert.equal(gpu.vram.total, 16303);
  assert.equal(gpu.vram.used, 13234);
  assert.deepEqual(gpu.gpus[0].pcie, { gen: 1, genMax: 1, width: 1, widthMax: 16 }, "the fan/PCIe fields ride in the same stream");
});

test("a stale GPU stream makes the collection unsuccessful instead of repeating the last reading", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { collector, spawned } = localCollector(t);
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  const pending = collector.collectGpu();
  spawned[0].child.write(`${GB10_LINE}\n${GB10_LINE}\n`);
  assert.equal(collectionWasSuccessful(await pending), true);

  t.mock.timers.tick(3001);
  const stale = await collector.collectGpu();
  assert.equal(collectionWasSuccessful(stale), false);
  assert.equal(stale.gpus.length, 0);
  assert.equal(stale.temperature, 0, "default, not the 45 °C seen 3 s ago");
});

test("rootless EPERM from nsenter switches the reader into the container", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { collector, spawned } = localCollector(t);
  t.mock.method(console, "warn", () => {});
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  const stream = collector._nvidiaGpuStream();
  await stream.read();
  spawned[0].child.stderr.emit("data", "nsenter: reassociate to namespace 'ns/mnt' failed: Operation not permitted");
  spawned[0].child.exit(1);
  assert.equal(collector._nsenterBroken, true);
  t.mock.timers.tick(1000);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].file, "sh");
  assert.match(spawned[1].args[1], /^exec \S*nvidia-smi --query-gpu=/);
});

test("compute-apps: refreshed after its interval, and a failure is not answered from the last result", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { collector } = localCollector(t);
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  let calls = 0;
  let fail = false;
  collector._nvidiaSmi = async () => {
    calls += 1;
    if (fail) throw new Error("nvidia-smi failed");
    return APP_LINES;
  };
  assert.equal(await collector._computeAppsOut(), APP_LINES);
  assert.equal(await collector._computeAppsOut(), APP_LINES);
  assert.equal(calls, 1);
  t.mock.timers.tick(5000);
  fail = true;
  await assert.rejects(collector._computeAppsOut());
  await assert.rejects(collector._computeAppsOut(), "no cached answer after a failure");
  assert.equal(calls, 3);
});

test("bandwidth comes from a continuous dmon and disappears when it goes stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { collector, spawned } = localCollector(t);
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  const pending = collector._getUnifiedMemory();
  await new Promise((resolve) => setImmediate(resolve)); // past the meminfo read
  const dmon = spawned.find((s) => /dmon/.test(s.args.at(-1)));
  assert.match(dmon.args.at(-1), /^exec \S*nvidia-smi dmon -d 2 -s B 2>\/dev\/null$/);
  assert.doesNotMatch(dmon.args.at(-1), / -c /);
  dmon.child.write("# gpu  rxpci  txpci\n# Idx   MB/s   MB/s\n    0   1024   1024\n");
  assert.equal((await pending).bandwidth.current, 2);

  t.mock.timers.tick(6001);
  assert.equal((await collector._getUnifiedMemory()).bandwidth.current, null, "stale: not measured, not 0");
});

test("dmon -s B unsupported (GB10 / driver 580): three quick failures stop the reader, bandwidth stays unavailable", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const { collector, spawned } = localCollector(t);
  const warn = t.mock.method(console, "warn", () => {});
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  const dmonSpawns = () => spawned.filter((s) => /dmon/.test(s.args.at(-1)));
  for (const delay of [1000, 2000, 0]) {
    const pending = collector._getUnifiedMemory();
    await new Promise((resolve) => setImmediate(resolve));
    const { child } = dmonSpawns().at(-1);
    child.write("Invalid combination of input arguments. Please run 'nvidia-smi -h' for help.\n");
    child.exit(255);
    assert.equal((await pending).bandwidth.current, null);
    t.mock.timers.tick(delay);
  }
  assert.equal(dmonSpawns().length, 3);
  t.mock.timers.tick(10 * 60_000);
  const um = await collector._getUnifiedMemory();
  assert.equal(um.bandwidth.current, null, "unavailable, not 0");
  assert.equal(dmonSpawns().length, 3, "not restarted");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /not restarting/);
});

test("per-call dmon failure (streams off) is unavailable, not 0", async (t) => {
  const { collector } = localCollector(t);
  collector._nvidiaSmi = async () => {
    throw new Error("Command failed: nvidia-smi dmon -c 1 -d 1 -s B");
  };
  assert.equal((await collector._getUnifiedMemory()).bandwidth.current, null);
  collector._nvidiaSmi = async () => "# gpu  rxpci  txpci\n# Idx   MB/s   MB/s\n    0      -      -";
  assert.equal((await collector._getUnifiedMemory()).bandwidth.current, null, "N/A columns are not 0");
});

test("per-call dmon output (streams off) parses as before", async (t) => {
  const { collector, spawned } = localCollector(t);
  collector._nvidiaSmi = async () => "# gpu  rxpci  txpci\n# Idx   MB/s   MB/s\n    0   1024   1024";
  assert.equal((await collector._getUnifiedMemory()).bandwidth.current, 2);
  assert.equal(spawned.length, 0);
});

test("a changed interval restarts the readers; dispose stops them", async (t) => {
  const { collector, spawned } = localCollector(t);
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  collector._nvidiaGpuStream().read();
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  assert.deepEqual(spawned[0].child.signals, [], "same intervals: untouched");
  collector.useNvidiaSmiStreams({ gpu: 5000, memory: 5000 });
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  collector._nvidiaGpuStream().read();
  assert.match(spawned[1].args.at(-1), / -lms 5000 /);
  collector.dispose();
  assert.deepEqual(spawned[1].child.signals, ["SIGTERM"]);
  assert.equal(collector._nvidiaGpuStream(), null, "back to per-call reads");
});

test("remote units never start local readers", (t) => {
  const collector = new SystemCollector({ id: "remote", isLocal: false, lanIp: "192.0.2.1" });
  collector.useNvidiaSmiStreams({ gpu: 1000, memory: 2000 });
  assert.equal(collector._nvidiaGpuStream(), null);
  assert.equal(collector._nvidiaDmonStream(), null);
});
