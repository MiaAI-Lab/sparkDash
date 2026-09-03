import { test, mock } from "node:test";
import { strict as assert } from "node:assert";

// The remote unified-memory path calls the module-level sshExec() imported by
// SystemCollector.js. ESM namespace bindings are non-configurable, so we mock
// the whole ssh.js module via mock.module() (requires --experimental-test-module-mocks).
let journalCount = 0;
let failSsh = false;
mock.module("../ssh.js", {
  exports: {
    sshExec: async (_spark, cmd) => {
      if (failSsh) throw new Error("ssh exec failed");
      if (cmd.includes("journalctl")) {
        journalCount += 1;
        return "43";
      }
      return "MemTotal:       16000000 kB\nMemAvailable:   4000000 kB\n---\n";
    },
  },
});

// Import after registering the mock so SystemCollector picks up the stubbed sshExec.
const { SystemCollector } = await import("../SystemCollector.js");

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

test("nvErrNoMemory: remote collection includes the count over SSH", async () => {
  journalCount = 0;

  const c = new SystemCollector({ id: "gx11", isLocal: false, lanIp: "10.200.0.2" });
  const result = await c._getRemoteUnifiedMemory();

  assert.ok(journalCount === 1, "journalctl count command should be issued once");
  assert.equal(typeof result.nvErrNoMemory, "number");
  assert.equal(result.nvErrNoMemory, 43);
});

test("nvErrNoMemory: defaults to 0 when the remote SSH journal call throws", async () => {
  failSsh = true;

  const c = new SystemCollector({ id: "gx11", isLocal: false, lanIp: "10.200.0.2" });
  const result = await c._getRemoteUnifiedMemory();

  failSsh = false;
  assert.equal(result.nvErrNoMemory, 0);
});
