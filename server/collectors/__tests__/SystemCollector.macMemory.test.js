import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector, MACMON_CMD } from "../SystemCollector.js";

const output = `hw.memsize: 17179869184
hw.pagesize: 16384
vm.page_pageable_internal_count: 327680
vm.page_pageable_external_count: 196608
vm.page_free_count: 262144
vm.page_wired_count: 131072
vm.page_purgeable_count: 32768
kern.memorystatus_vm_pressure_level: 1
Pages occupied by compressor: 65536.
"In use system memory"=1073741824
{"memory":{"ram_total":17179869184,"ram_usage":16106127360}}
`;

test("Mac host uses physical counters instead of inflated macmon occupancy across RAM, GPU and unified views", async () => {
  const c = new SystemCollector({ id: "mac", isLocal: false, platform: "darwin", ssh: {} });
  const sample = SystemCollector.prototype._macmonSample;
  c._macmonSample = () => sample.call(c, async () => output);
  const [ram, gpu, um] = await Promise.all([c.collectRam(), c.collectGpu(), c.collectUnifiedMemory()]);
  assert.equal(um.used, 8704);
  assert.equal(ram.used, 8704);
  assert.equal(gpu.vram.available, 7680);
  assert.equal(um.oomRisk, "low");
  assert.equal(um.memoryPressure, "normal");
  assert.equal(um.physical.cached, 3584);
  assert.equal(um.gpuUsed, 1024);
  assert.match(MACMON_CMD, /kern\.memorystatus_vm_pressure_level/);
  assert.match(MACMON_CMD, /vm\.page_pageable_internal_count/);
});
