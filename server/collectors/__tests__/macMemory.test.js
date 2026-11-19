import test from "node:test";
import assert from "node:assert/strict";
import { macMemoryFromOutput, macMemoryPressure } from "../macMemory.js";

export const MEMORY_OUTPUT = `hw.memsize: 17179869184
hw.pagesize: 16384
vm.page_pageable_internal_count: 327680
vm.page_pageable_external_count: 196608
vm.page_free_count: 262144
vm.page_wired_count: 131072
vm.page_purgeable_count: 32768
kern.memorystatus_vm_pressure_level: 1
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active: 900000.
Pages inactive: 900000.
Pages occupied by compressor: 65536.
Pages stored in compressor: 131072.
`;

test("native pressure is independent of RAM occupancy; unrecognised levels stay unknown", () => {
  assert.deepEqual([1, 2, 4, 0, 3, null, "bad"].map(macMemoryPressure), ["normal", "warning", "critical", "unknown", "unknown", "unknown", "unknown"]);
});

test("physical slices exclude purgeable pages from apps and count only physical compressor storage", () => {
  const m = macMemoryFromOutput(MEMORY_OUTPUT);
  assert.deepEqual(m.physical, { apps: 4608, wired: 2048, compressed: 1024, cached: 3584, free: 4096, other: 1024 });
  assert.equal(Object.values(m.physical).reduce((a, b) => a + b), 16384);
  assert.equal(m.used, 8704);
  assert.equal(m.available, 7680);
  assert.equal(m.memoryPressure, "normal");
  assert.equal(m.oomRisk, "low");
});

test("missing and overcommitted physical counters never become invented zero or free slices", () => {
  for (const out of ["", MEMORY_OUTPUT.replace(/^vm.page_free_count:.*\n/m, ""), MEMORY_OUTPUT.replace("262144", "1048576")]) {
    assert.equal(macMemoryFromOutput(out).physical, null);
    assert.equal(macMemoryFromOutput(out).used, undefined);
  }
  assert.equal(macMemoryFromOutput("").oomRisk, null);
});
