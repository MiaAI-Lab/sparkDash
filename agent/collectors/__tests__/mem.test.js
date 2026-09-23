import test from "node:test";
import assert from "node:assert/strict";
import { collectMem } from "../mem.js";

const MEMINFO = [
  "MemTotal:       131072000 kB", // 128000 MB
  "MemFree:         5120000 kB",
  "MemAvailable:   31457280 kB", // 30720 MB
].join("\n");

test("mem: computes used/total/available/percentage (ground truth)", async () => {
  const m = await collectMem({ readFile: async () => MEMINFO });
  assert.deepEqual(m, {
    usedMB: 97280, // 128000 − 30720
    totalMB: 128000,
    availableMB: 30720,
    percentage: 76, // 97280/128000 = 0.76
  });
});

test("mem: clamps percentage to 0-100", async () => {
  const m = await collectMem({
    readFile: async () =>
      ["MemTotal: 1024 kB", "MemAvailable: 0 kB", "MemFree: 0 kB"].join("\n"),
  });
  assert.equal(m.percentage, 100);
  assert.equal(m.usedMB, 1);
});

test("mem: returns null on read failure", async () => {
  const readFile = async () => {
    throw new Error("ENOENT: /proc/meminfo");
  };
  assert.equal(await collectMem({ readFile }), null);
});

test("mem: returns null when MemTotal is missing", async () => {
  assert.equal(await collectMem({ readFile: async () => "nothing here\n" }), null);
});

test("mem: returns null when MemTotal is zero", async () => {
  assert.equal(
    await collectMem({
      readFile: async () => "MemTotal:       0 kB\nMemAvailable:  0 kB\n",
    }),
    null
  );
});
