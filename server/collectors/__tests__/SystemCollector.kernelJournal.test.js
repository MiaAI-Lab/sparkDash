import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

const boot = "bbcdd1fdecf34ccb9c894ecb6efbc6af";
function page(messages, cursor = "s=abc;i=1;b=" + boot) {
  return [boot, ...messages.map((MESSAGE) => JSON.stringify({ MESSAGE, _BOOT_ID: boot })), "-- cursor: " + cursor].join("\n");
}
function collector() {
  const c = new SystemCollector({ id: "journal-test", isLocal: true });
  c._hasHostProc = () => true;
  return c;
}

test("kernel counter callers share one in-flight journal read", async () => {
  // Given a host read that has not completed.
  const c = collector();
  let finish;
  let calls = 0;
  c._execOnHost = async () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  // When GPU and health counters are requested concurrently.
  const results = [c._nvErrNoMemory(), c._kernelErrors()];
  await Promise.resolve();
  const observed = calls;
  finish(page(["NVRM: Xid (PCI:0000:01:00): 43", "NV_ERR_NO_MEMORY", "oom-kill: test"]));
  // Then only one command was started.
  assert.equal(observed, 1);
  assert.deepEqual(await Promise.all(results), [1, { xid: 1, oomKills: 1, lastXid: "Xid 43" }]);
});

test("successful reads reuse cached totals for both counter families", async () => {
  // Given a completed journal read.
  const c = collector();
  let calls = 0;
  c._execOnHost = async () => { calls++; return page(["NV_ERR_NO_MEMORY"]); };
  await c._nvErrNoMemory();
  // When the health counters are requested next.
  const health = await c._kernelErrors();
  // Then they reuse the same snapshot.
  assert.equal(calls, 1);
  assert.deepEqual(health, { xid: 0, oomKills: 0, lastXid: null });
});
