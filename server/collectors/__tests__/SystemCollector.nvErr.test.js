import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

const MEMINFO =
  "MemTotal:       8000000 kB\nMemFree:        1000000 kB\nMemAvailable:   2000000 kB\n";

function makeLocalCollector() {
  const c = new SystemCollector({ id: "gx10", isLocal: true });
  mock.method(c, "_readHostFile", async () => MEMINFO);
  mock.method(c, "_parseMemTotal", (raw) => {
    const m = raw.match(/MemTotal:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1], 10) : 0;
  });
  mock.method(c, "_readGpuMemoryFile", () => 0);
  mock.method(c, "_nvidiaSmi", async () => "");
  mock.method(c, "_hasHostProc", () => false);
  mock.method(c, "_exec", async () => "12");
  mock.method(c, "_execOnHost", async () => "12");
  return c;
}

test("nvErrNoMemory: local collection returns the journal count", async () => {
  const c = makeLocalCollector();
  const result = await c._getUnifiedMemory();
  assert.equal(typeof result.nvErrNoMemory, "number");
  assert.equal(result.nvErrNoMemory, 12);
});

test("nvErrNoMemory: defaults to 0 when the journal command fails", async () => {
  const c = makeLocalCollector();
  mock.method(c, "_hasHostProc", () => false);
  mock.method(c, "_exec", async () => {
    throw new Error("no journal");
  });
  const result = await c._getUnifiedMemory();
  assert.equal(result.nvErrNoMemory, 0);
});
