import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../../events/EventLog.js";
import { benchEvent } from "../../events/eventFormat.js";
import { SparkMonitor } from "../SparkMonitor.js";
import { COLLECTION_SUCCESS } from "../../collectors/SystemCollector.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evlog-")), "events.json");
const ev = (type, sparkId = "a", message = "m") => ({ type, severity: "info", sparkId, sparkName: sparkId, message });

function clock() {
  const c = { t: 1_000_000 };
  c.now = () => c.t;
  return c;
}

test("caps the ring and lists newest first with sinceId", () => {
  const c = clock();
  const log = new EventLog({ max: 3, now: c.now });
  for (let i = 0; i < 5; i++) {
    c.t += 10_000;
    log.record(ev(`t${i}`));
  }
  const all = log.list();
  assert.deepEqual(all.map((e) => e.type), ["t4", "t3", "t2"]);
  assert.deepEqual(all.map((e) => e.id), [5, 4, 3]);
  assert.deepEqual(log.list({ sinceId: 4 }).map((e) => e.id), [5]);
  assert.equal(log.list({ limit: 1 }).length, 1);
  assert.equal(log.list({ sparkId: "zzz" }).length, 0);
});

test("dedupes same type+spark within 5s only", () => {
  const c = clock();
  const log = new EventLog({ now: c.now });
  assert.ok(log.record(ev("x")));
  c.t += 1000;
  assert.equal(log.record(ev("x")), null);
  assert.ok(log.record(ev("x", "b")));
  c.t += 6000;
  assert.ok(log.record(ev("x")));
});

test("a real offline -> online -> offline flip inside 5s is not deduped", () => {
  const c = clock();
  const log = new EventLog({ now: c.now });
  const e = (type, message) => ({ type, sparkId: "a", message });
  assert.ok(log.record(e("spark.offline", "a went offline")));
  c.t += 500;
  assert.ok(log.record(e("spark.online", "a came online")));
  c.t += 500;
  assert.ok(log.record(e("spark.offline", "a went offline")));
  c.t += 500;
  assert.equal(log.record(e("spark.offline", "a went offline")), null);
  assert.ok(log.record(e("spark.offline", "different text")));
});

test("persists, restores ids across restart, and tolerates corrupt files", () => {
  const file = tmp();
  const a = new EventLog({ file });
  a.record(ev("one"));
  a.record(ev("two"));
  a.flush();
  const b = new EventLog({ file });
  assert.equal(b.list().length, 2);
  assert.equal(b.record(ev("three")).id, 3);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new EventLog({ file }).list(), []);
  assert.deepEqual(new EventLog({ file: path.join(path.dirname(file), "missing.json") }).list(), []);
});

test("subscribe delivers events and unsubscribes; bad subscriber cannot throw", () => {
  const log = new EventLog();
  const seen = [];
  const off = log.subscribe((e) => seen.push(e.type));
  log.subscribe(() => {
    throw new Error("boom");
  });
  log.record(ev("p"));
  off();
  log.record(ev("q"));
  assert.deepEqual(seen, ["p"]);
});

test("benchEvent formats finished/failed/cancelled", () => {
  assert.equal(
    benchEvent("quality", { status: "completed", results: { overallPct: 86.24 } }, "spark-01").message,
    "Quality bench finished on spark-01: 86.2%"
  );
  assert.equal(benchEvent("decode", { status: "cancelled" }, "s").type, "bench.decode.cancelled");
  assert.equal(benchEvent("prefill", { status: "failed", error: "boom" }, "s").severity, "error");
  assert.equal(benchEvent("prefill", { status: "running" }, "s"), null);
});

test("thermal throttle emits one event per transition and none on baseline", () => {
  const events = [];
  const mon = new SparkMonitor(
    { id: "s3", name: "spark-03", isLocal: true, lanIp: "127.0.0.1" },
    { onEvent: (e) => events.push(e) }
  );
  const gpu = (thermal, temperature = 84) => ({
    ...mon.collector._defaultGpu(),
    temperature,
    throttle: mon.collector._buildThrottle({ hwThermal: thermal }),
  });
  const ok = (g) => Object.defineProperty(g, COLLECTION_SUCCESS, { value: true });
  mon._noteThrottle(gpu(false)); // failed collection: ignored entirely
  mon._noteThrottle(ok(gpu(true))); // baseline: throttled at boot, silent
  assert.equal(events.length, 0);
  mon._noteThrottle(ok(gpu(true)));
  assert.equal(events.length, 0);
  mon._noteThrottle(ok(gpu(false, 70)));
  mon._noteThrottle(ok(gpu(false, 70)));
  mon._noteThrottle(ok(gpu(true, 85)));
  assert.deepEqual(
    events.map((e) => e.type),
    ["gpu.throttle.cleared", "gpu.throttle.thermal"]
  );
  assert.match(events[1].message, /spark-03 started thermal throttling \(85°C\)/);
});

test("online/offline emits only on transitions", () => {
  const events = [];
  const mon = new SparkMonitor({ id: "a", name: "A", isLocal: true }, { onEvent: (e) => events.push(e.type) });
  mon._noteOnline(false);
  mon._noteOnline(false);
  mon._noteOnline(true);
  mon._noteOnline(true);
  mon._noteOnline(false);
  assert.deepEqual(events, ["spark.online", "spark.offline"]);
});

test("EventLog.list pages backwards with beforeId and reports the oldest retained id", () => {
  const log = new EventLog({ file: null, max: 50 });
  for (let i = 1; i <= 10; i++) log.record({ type: `t${i}`, severity: "info", sparkId: "s", message: `m${i}` });
  const page1 = log.list({ limit: 4 });
  assert.deepEqual(page1.map((e) => e.id), [10, 9, 8, 7]);
  const page2 = log.list({ limit: 4, beforeId: page1.at(-1).id });
  assert.deepEqual(page2.map((e) => e.id), [6, 5, 4, 3]);
  assert.deepEqual(log.list({ limit: 4, beforeId: 3 }).map((e) => e.id), [2, 1]);
  assert.equal(log.oldestId(), 1);
  assert.equal(new EventLog({ file: null }).oldestId(), null);
});

test("clear() removes all or only old events, keeps ids increasing and persists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-"));
  const file = path.join(dir, "events.json");
  let t = 10_000_000;
  const log = new EventLog({ file, max: 50, now: () => t });
  log.record({ type: "a", message: "old", sparkId: "s1" });
  t += 3 * 86_400_000;
  log.record({ type: "b", message: "new", sparkId: "s1" });
  assert.equal(log.clear({ olderThanMs: 86_400_000 }), 1);
  assert.deepEqual(log.list({}).map((e) => e.message), ["new"]);
  assert.equal(log.clear({ olderThanMs: 86_400_000 }), 0);
  assert.equal(log.clear(), 1);
  assert.deepEqual(log.list({}), []);
  // an identical event right after a clear is recorded again (dedupe memory was reset)
  const e = log.record({ type: "b", message: "new", sparkId: "s1" });
  assert.ok(e && e.id === 3, "ids keep counting up");
  log.flush();
  const again = new EventLog({ file, max: 50 });
  assert.deepEqual(again.list({}).map((x) => x.id), [3]);
  fs.rmSync(dir, { recursive: true, force: true });
});
