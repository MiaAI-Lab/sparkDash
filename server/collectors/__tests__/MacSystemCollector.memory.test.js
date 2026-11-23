import test from "node:test";
import assert from "node:assert/strict";
import { MacSystemCollector } from "../MacSystemCollector.js";
import { MacAgentCollector } from "../MacAgentCollector.js";

const sys = `hw.memsize: 17179869184
hw.pagesize: 16384
vm.page_pageable_internal_count: 327680
vm.page_pageable_external_count: 196608
vm.page_free_count: 262144
vm.page_wired_count: 131072
vm.page_purgeable_count: 32768
kern.memorystatus_vm_pressure_level: 1`;

test("Mac-node SSH collection carries the same physical slices and native pressure", async () => {
  const c = new MacSystemCollector({ id: "mac", kind: "mac", ssh: {} }, { exec: async () => `__SPARKDASH_SECTION__sysctl\n${sys}\n__SPARKDASH_SECTION__vm_stat\nPages occupied by compressor: 65536.\n` });
  const [ram, um] = await Promise.all([c.collectRam(), c.collectUnifiedMemory()]);
  assert.equal(um.used, 8704);
  assert.equal(um.physical.cached, 3584);
  assert.equal(ram.physical.cached, 3584);
  assert.equal(um.memoryPressure, "normal");
  assert.equal(um.oomRisk, "low");
});

test("Mac agent preserves physical details, derives risk from pressure, and treats old pressure as unknown", async () => {
  const c = new MacAgentCollector({ id: "mac", kind: "mac", agent: { url: "http://127.0.0.1:8790" }, ssh: {} });
  const physical = { apps: 4608, wired: 2048, compressed: 1024, cached: 3584, free: 4096, other: 1024 };
  c._agentSnapshot = async () => ({ memory: { total: 16384, used: 8704, physical, memoryPressure: "normal", oomRisk: "high" } });
  assert.deepEqual((await c.collectRam()).physical, physical);
  assert.deepEqual((await c.collectUnifiedMemory()).physical, physical);
  assert.equal((await c.collectUnifiedMemory()).oomRisk, "low");
  c._agentSnapshot = async () => ({ memory: { total: 16384, used: 16000, oomRisk: "high" } });
  assert.equal((await c.collectUnifiedMemory()).memoryPressure, "unknown");
  assert.equal((await c.collectUnifiedMemory()).oomRisk, null);
});
