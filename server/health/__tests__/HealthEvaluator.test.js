import test from "node:test";
import assert from "node:assert/strict";
import { HealthEvaluator, LOW_POWER_STREAK, KERNEL_FINDING_TTL_MS } from "../HealthEvaluator.js";

const ids = (f) => f.map((x) => x.id);

test("a healthy node raises nothing", () => {
  const h = new HealthEvaluator();
  const f = h.evaluate({
    gpu: { temperature: 60, usage: 90, power: { draw: 40 } },
    unifiedMemory: { total: 124000, available: 30000, percentage: 50 },
    network: { linkSpeedMbps: 10000 },
    llm: [{ available: true, modelId: "a" }],
  }, "gpu");
  assert.deepEqual(f, []);
});

test("thermal: warns at 85, critical at 90, silent below and when unknown", () => {
  const h = new HealthEvaluator();
  assert.deepEqual(h.evaluate({ gpu: { temperature: 84 } }), []);
  assert.equal(h.evaluate({ gpu: { temperature: 86 } })[0].severity, "warn");
  assert.equal(h.evaluate({ gpu: { temperature: 91 } })[0].severity, "critical");
  assert.deepEqual(h.evaluate({ gpu: {} }), []);
});

test("low power needs a streak of consecutive gpu samples and resets", () => {
  const h = new HealthEvaluator();
  const m = { gpu: { usage: 97, power: { draw: 9 } } };
  for (let i = 0; i < LOW_POWER_STREAK - 1; i++) assert.deepEqual(h.evaluate(m, "gpu"), []);
  assert.deepEqual(ids(h.evaluate(m, "gpu")), ["low-power"]);
  // non-gpu ticks neither advance nor reset it
  assert.deepEqual(ids(h.evaluate(m, "other")), ["low-power"]);
  // normal decode power (e.g. 37 W at 95%) resets it
  h.evaluate({ gpu: { usage: 95, power: { draw: 37 } } }, "gpu");
  assert.deepEqual(h.evaluate(m, "other"), []);
});

test("memory: warn below 3 GB available, critical below 1.5 GB", () => {
  const h = new HealthEvaluator();
  const mk = (available) => ({ unifiedMemory: { total: 124000, available, percentage: 97 } });
  assert.deepEqual(h.evaluate(mk(8000)), []);
  assert.equal(h.evaluate(mk(2500))[0].severity, "warn");
  assert.deepEqual(h.evaluate(mk(3500)), []);
  assert.equal(h.evaluate(mk(1000))[0].severity, "critical");
  assert.deepEqual(h.evaluate({ unifiedMemory: { total: 0, available: 0 } }), []);
});

test("kernel errors: first sample is a baseline, a rise raises an event and a finding for an hour", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const g = (xid, oomKills, lastXid) => ({ gpu: { kernelErrors: { xid, oomKills, lastXid } } });
  assert.deepEqual(h.evaluate(g(3, 0)), []);
  assert.equal(h.pendingEvents.length, 0);
  t += 1000;
  const f = h.evaluate(g(4, 0, "Xid 79"));
  assert.deepEqual(ids(f), ["xid"]);
  assert.equal(h.pendingEvents.length, 1);
  assert.match(h.pendingEvents[0].message, /1 new/);
  assert.match(f[0].detail, /Xid 79/);
  // unchanged count: finding persists, no new event
  t += 1000;
  assert.deepEqual(ids(h.evaluate(g(4, 0))), ["xid"]);
  assert.equal(h.pendingEvents.length, 0);
  // expires
  t += KERNEL_FINDING_TTL_MS;
  assert.deepEqual(h.evaluate(g(4, 0)), []);
  // oom independently
  assert.deepEqual(ids(h.evaluate(g(4, 1))), ["oom"]);
});

test("concurrency: only with two different models and busy memory", () => {
  const h = new HealthEvaluator();
  const llm = [{ available: true, modelId: "a" }, { available: true, modelId: "b" }];
  assert.deepEqual(h.evaluate({ llm, unifiedMemory: { total: 1, available: 99999, percentage: 40 } }), []);
  assert.deepEqual(ids(h.evaluate({ llm, unifiedMemory: { total: 1, available: 99999, percentage: 80 } })), ["concurrency"]);
  assert.deepEqual(h.evaluate({ llm: [llm[0], { ...llm[0] }], unifiedMemory: { percentage: 90 } }), []);
});

test("link speed: warns under 1 Gb/s only when known and positive", () => {
  const h = new HealthEvaluator();
  assert.deepEqual(ids(h.evaluate({ network: { linkSpeedMbps: 100, primaryInterface: "enP7s7" } })), ["link-speed"]);
  assert.deepEqual(h.evaluate({ network: { linkSpeedMbps: null } }), []);
  assert.deepEqual(h.evaluate({ network: { linkSpeedMbps: -1 } }), []);
  assert.deepEqual(h.evaluate({ network: { linkSpeedMbps: 1000 } }), []);
});

test("garbage input never throws", () => {
  const h = new HealthEvaluator();
  assert.deepEqual(h.evaluate(null), []);
  assert.deepEqual(h.evaluate({ gpu: "x", llm: "y", network: 3 }), []);
});

import { parseKernelErrors } from "../../collectors/SystemCollector.js";

test("parseKernelErrors reads counters and the latest Xid code", () => {
  const r = parseKernelErrors("xid=3 oom=4\nOct 07 kernel: NVRM: Xid (PCI:000f:01:00): 43, pid=1, name=x\n");
  assert.deepEqual(r, { xid: 3, oomKills: 4, lastXid: "Xid 43" });
  assert.deepEqual(parseKernelErrors("xid=0 oom=0\n\n"), { xid: 0, oomKills: 0, lastXid: null });
  assert.equal(parseKernelErrors("garbage"), null);
  assert.equal(parseKernelErrors(undefined), null);
});
