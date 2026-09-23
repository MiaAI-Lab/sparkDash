import test from "node:test";
import assert from "node:assert/strict";
import { collectGpu } from "../gpu.js";

const MEMINFO = [
  "MemTotal:        131072000 kB", // 128000 MB
  "MemFree:          51200000 kB",
  "MemAvailable:     40960000 kB", // 40000 MB
].join("\n");

const readFile = async (p) => {
  if (p === "/proc/meminfo") return MEMINFO;
  throw new Error(`ENOENT: ${p}`);
};

/** Mock exec: first call = GPU query, subsequent = compute-apps. */
function mockExec(gpuLine, appsRaw) {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return calls === 1 ? gpuLine : appsRaw;
  };
  return exec;
}

test("gpu: parses nvidia-smi csv into GpuMetrics (ground truth)", async () => {
  const g = await collectGpu({
    exec: mockExec("42, 15, 12.5, 100, 8192, 65536", "123,python,1024\n456,vllm,4096"),
    readFile,
  });
  assert.deepEqual(g, {
    temperature: 42,
    usage: 15,
    powerDraw: 12.5,
    powerLimit: 100,
    vramUsedMB: 8192,
    vramTotalMB: 65536,
    vramPercentage: 13, // 8192/65536 = 12.5 → 13
    vramAvailableMB: 40000, // MemAvailable
    processes: [
      { pid: 456, name: "vllm", vramMB: 4096 },
      { pid: 123, name: "python", vramMB: 1024 },
    ],
  });
});

test("gpu: GB10 [N/A] memory falls back to meminfo + compute-apps sum", async () => {
  const g = await collectGpu({
    exec: mockExec("55, 90, 20.2, 90.0, [N/A], [N/A]", "789,sglang,51200"),
    readFile,
  });
  assert.equal(g.vramUsedMB, 51200);
  assert.equal(g.vramTotalMB, 128000); // MemTotal fallback
  assert.equal(g.vramAvailableMB, 40000);
  assert.equal(g.vramPercentage, 40); // 51200/128000
  assert.deepEqual(g.processes, [{ pid: 789, name: "sglang", vramMB: 51200 }]);
});

test("gpu: clamps vramPercentage to 100 when apps exceed pool", async () => {
  const g = await collectGpu({
    exec: mockExec("55, 5, 10, 65, [N/A], [N/A]", "1,a,200000\n2,b,200000"),
    readFile,
  });
  assert.equal(g.vramPercentage, 100);
  assert.equal(g.processes.length, 2);
});

test("gpu: keeps only top 5 processes by VRAM", async () => {
  const apps = Array.from({ length: 7 }, (_, i) => `${i + 1},proc${i},${i + 1}`).join("\n");
  const g = await collectGpu({ exec: mockExec("55, 5, 10, 65, 0, 65536", apps), readFile });
  assert.equal(g.processes.length, 5);
  assert.equal(g.processes[0].pid, 7); // highest VRAM first
});

test("gpu: usage clamped to 0-100", async () => {
  const g = await collectGpu({ exec: mockExec("42, 150, 12.5, 100, 0, 65536", ""), readFile });
  assert.equal(g.usage, 100);
  assert.equal(g.vramUsedMB, 0);
  assert.deepEqual(g.processes, []);
});

test("gpu: returns null when nvidia-smi is unavailable", async () => {
  const exec = async () => {
    throw new Error("nvidia-smi: command not found");
  };
  assert.equal(await collectGpu({ exec, readFile }), null);
});

test("gpu: returns null on empty/unparseable output", async () => {
  assert.equal(await collectGpu({ exec: async () => "", readFile }), null);
  assert.equal(await collectGpu({ exec: async () => "garbage", readFile }), null);
});

test("gpu: [N/A] temperature → null overall", async () => {
  assert.equal(
    await collectGpu({ exec: mockExec("[N/A], 15, 12.5, 100, 0, 65536", ""), readFile }),
    null
  );
});
