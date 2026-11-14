import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../../collectors/SystemCollector.js";
import { extractSample } from "../historySample.js";

async function reading(meminfo) {
  const c = new SystemCollector({ id: "fixture", isLocal: true });
  c._readHostFile = async () => meminfo;
  c._readGpuMemoryFile = () => 0;
  c._nvidiaSmi = async () => "";
  return c._getUnifiedMemory();
}

test("Linux availability provenance distinguishes measured zero from absent MemAvailable", async () => {
  const zero = await reading("MemTotal: 65536000 kB\nMemAvailable: 0 kB\n");
  const absent = await reading("MemTotal: 65536000 kB\n");
  assert.equal(zero.availableSource, "linux-memavailable");
  assert.equal(zero.available, 0);
  assert.equal(absent.availableSource, null);
});

test("strict MemAvailable history has no free-memory fallback and respects freshness", () => {
  const snapshot = { kind: "spark", online: true, metrics: {
    unifiedMemory: { total: 128000, available: 20000, gpuUsed: 90000, cpuUsed: 10000 },
    gpu: { vram: { total: 128000, used: 90000, available: 38000 } },
  } };
  assert.equal(extractSample(snapshot).memAvailableMB, undefined);
  snapshot.metrics.unifiedMemory.availableSource = "linux-memavailable";
  assert.equal(extractSample(snapshot).memAvailableMB, 20000);
  assert.equal(extractSample(snapshot, (domain) => domain !== "memory").memAvailableMB, undefined);
  snapshot.metrics.unifiedMemory.available = 0;
  assert.equal(extractSample(snapshot).memAvailableMB, 0);
});
