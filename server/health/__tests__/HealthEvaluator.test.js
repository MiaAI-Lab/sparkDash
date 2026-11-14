import test from "node:test";
import assert from "node:assert/strict";
import { HealthEvaluator, LOW_POWER_STREAK, LOW_POWER_PROGRESS_MS, KERNEL_FINDING_TTL_MS } from "../HealthEvaluator.js";

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

const nv = (temperature, usage, draw) => ({ vendor: "nvidia", temperature, usage, power: { draw, limit: 200 } });
const intelCard = (temperature, usage, draw) => ({ vendor: "intel", temperature, usage, power: { draw, limit: 200 } });
const hostOf = (gpus) => ({
  temperature: Math.max(...gpus.map((g) => g.temperature)),
  usage: Math.max(...gpus.map((g) => g.usage)),
  power: { draw: gpus.reduce((n, g) => n + g.power.draw, 0), limit: 400 },
  gpus,
});

test("intel card is not judged by the NVIDIA thresholds (hot, or 100% at a low draw)", () => {
  const h = new HealthEvaluator();
  // Intel-only host: hot and "stuck" by NVIDIA rules, but silent
  const only = { gpu: hostOf([intelCard(95, 100, 5)]) };
  for (let i = 0; i < LOW_POWER_STREAK + 2; i++) assert.deepEqual(h.evaluate(only, "gpu"), []);
  // Mixed host: healthy NVIDIA card plus a hot, busy, low-power Intel card
  const mixed = { gpu: hostOf([nv(60, 50, 40), intelCard(95, 100, 5)]) };
  for (let i = 0; i < LOW_POWER_STREAK + 2; i++) assert.deepEqual(h.evaluate(mixed, "gpu"), []);
});

test("mixed host: the Intel draw does not hide a stuck NVIDIA card, and NVIDIA findings are unchanged", () => {
  const h = new HealthEvaluator();
  // aggregate draw is 5 + 150 W, but the NVIDIA card alone is stuck at 5 W
  const m = { gpu: hostOf([nv(88, 99, 5), intelCard(50, 10, 150)]) };
  let f = [];
  for (let i = 0; i < LOW_POWER_STREAK; i++) f = h.evaluate(m, "gpu");
  assert.deepEqual(ids(f).sort(), ["low-power", "thermal"]);
  assert.equal(f.find((x) => x.id === "thermal").severity, "warn");
});

test("regression: an NVIDIA-only gpus list gives the same findings as the bare aggregate", () => {
  const bare = { temperature: 91, usage: 97, power: { draw: 9 } };
  const listed = { ...bare, gpus: [nv(91, 97, 9)] };
  const a = new HealthEvaluator();
  const b = new HealthEvaluator();
  let fa = [];
  let fb = [];
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    fa = a.evaluate({ gpu: bare }, "gpu");
    fb = b.evaluate({ gpu: listed }, "gpu");
  }
  assert.deepEqual(fb, fa);
  assert.deepEqual(ids(fa).sort(), ["low-power", "thermal"]);
  assert.equal(fa.find((x) => x.id === "thermal").severity, "critical");
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

// An integrated GPU draws about as much at idle as it does while stalled in a
// collective, so a ceiling written for discrete cards flags ordinary decode.
test("low-power: a stall at well-above-idle draw does not fire", () => {
  const h = new HealthEvaluator();
  // GB10 measured: ~10 W idle, ~14 W stalled in an all-gather, 34-55 W decoding.
  for (let i = 0; i < LOW_POWER_STREAK * 4; i++) {
    assert.deepEqual(h.evaluate({ gpu: { usage: 96, power: { draw: 14.1 } } }, "gpu"), []);
  }
  for (let i = 0; i < LOW_POWER_STREAK * 4; i++) {
    assert.deepEqual(h.evaluate({ gpu: { usage: 96, power: { draw: 45 } } }, "gpu"), []);
  }
});

test("low-power: busy at idle-level draw still fires after the streak", () => {
  const h = new HealthEvaluator();
  const idleBusy = { gpu: { usage: 96, power: { draw: 10.3 } } };
  for (let i = 0; i < LOW_POWER_STREAK - 1; i++) assert.deepEqual(h.evaluate(idleBusy, "gpu"), []);
  assert.deepEqual(ids(h.evaluate(idleBusy, "gpu")), ["low-power"]);
});

const llmEndpoint = (over = {}) => ({
  port: 8888,
  available: true,
  backend: "tensorfold",
  modelId: "m",
  totalOutputTokens: 100,
  totalPromptTokens: 50,
  prefillProgressTokens: null,
  generationProgressTokens: null,
  generationTps: 0,
  prefillTps: 0,
  ...over,
});

test("low-power: measured token progress suppresses the warning and expiry restores it", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { temperature: 88, usage: 96, power: { draw: 9 } } };
  let out = 100;
  const llm = () => [llmEndpoint({ totalOutputTokens: out })];
  h.evaluate({ ...gpu, llm: llm() }, "llm"); // baseline
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    t += 1000;
    h.evaluate({ ...gpu, llm: llm() }, "gpu");
  }
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "gpu")).sort(), ["low-power", "thermal"]);
  // real decode: the counter rises on a fresh LLM poll
  t += 1000;
  out += 10;
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "llm")), ["thermal"]);
  assert.equal(h.lowPowerProgressing, true);
  assert.equal(h.llmProgressAt, t);
  // the same snapshot on a GPU poll does not renew the evidence
  t += 1000;
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "gpu")), ["thermal"]);
  // once the evidence is older than the window, the sustained streak warns again
  t += LOW_POWER_PROGRESS_MS;
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "gpu")).sort(), ["low-power", "thermal"]);
  assert.equal(h.lowPowerProgressing, false);
});

test("low-power: prefill progress counts even when decode is idle", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { usage: 96, power: { draw: 9 } } };
  let position = 2048;
  const llm = () => [llmEndpoint({ prefillProgressTokens: position, generationTps: 0, prefillTps: 0 })];
  h.evaluate({ ...gpu, llm: llm() }, "llm");
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    t += 1000;
    h.evaluate({ ...gpu, llm: llm() }, "gpu");
  }
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "gpu")), ["low-power"]);
  t += 1000;
  position += 2048;
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "llm")), []);
  assert.equal(h.lowPowerProgressing, true);
});

test("low-power: generation progress counts when decode tokens are not reported", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { usage: 96, power: { draw: 9 } } };
  let produced = 0;
  const llm = () => [llmEndpoint({ totalOutputTokens: null, generationProgressTokens: produced })];
  h.evaluate({ ...gpu, llm: llm() }, "llm");
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    t += 1000;
    h.evaluate({ ...gpu, llm: llm() }, "gpu");
  }
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "gpu")), ["low-power"]);
  t += 1000;
  produced += 64;
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: llm() }, "llm")), []);
  assert.equal(h.lowPowerProgressing, true);
});

test("low-power: rates, active flags and unavailable endpoints are not progress", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { usage: 96, power: { draw: 9 } } };
  const busy = () => [llmEndpoint({
    generationTps: 42,
    prefillTps: 900,
    generationTpsSource: "slot-mean",
    prefillTpsSource: "live",
    decodeActive: true,
    prefillActive: true,
    requestsRunning: 4,
    requestsWaiting: 2,
    lastActiveAt: t,
  })];
  h.evaluate({ ...gpu, llm: busy() }, "llm");
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    t += 1000;
    h.evaluate({ ...gpu, llm: busy() }, "gpu");
  }
  assert.equal(h.lowPowerProgressing, false);
  assert.deepEqual(ids(h.evaluate({ ...gpu, llm: busy() }, "gpu")), ["low-power"]);
  h.evaluate({ ...gpu, llm: [llmEndpoint({ measurementValid: false, totalOutputTokens: 1000 })] }, "llm");
  assert.equal(h.lowPowerProgressing, false);
  h.evaluate({ ...gpu, llm: busy() }, "llm"); // fresh baseline after an invalid measurement
  // an endpoint that goes unavailable cannot keep progress alive
  t += 1000;
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: 110 })] }, "llm");
  assert.equal(h.lowPowerProgressing, true);
  t += 1000;
  h.evaluate({ ...gpu, llm: [llmEndpoint({ available: false, totalOutputTokens: 120 })] }, "gpu");
  assert.equal(h.lowPowerProgressing, false);
  assert.equal(h.llmProgressAt, null);
});

test("low-power: counter resets and model replacement start a new baseline, not progress", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { usage: 96, power: { draw: 9 } } };
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: 1000 })] }, "llm");
  t += 1000;
  // a lower counter is a reset, not progress
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: 10 })] }, "llm");
  assert.equal(h.lowPowerProgressing, false);
  assert.equal(h.llmProgressAt, null);
  // a different model is a different endpoint with no inherited progress
  t += 1000;
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: 5000, modelId: "other" })] }, "llm");
  assert.equal(h.lowPowerProgressing, false);
  assert.equal(h.llmProgressAt, null);
  // Invalid counters must not turn a later zero into apparent work.
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: -1, modelId: "other" })] }, "llm");
  h.evaluate({ ...gpu, llm: [llmEndpoint({ totalOutputTokens: 0, modelId: "other" })] }, "llm");
  assert.equal(h.lowPowerProgressing, false);
});

test("low-power: head progress suppresses the warning only while it is recent", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const gpu = { gpu: { usage: 96, power: { draw: 9 } } };
  for (let i = 0; i < LOW_POWER_STREAK; i++) {
    t += 1000;
    h.evaluate(gpu, "gpu");
  }
  assert.deepEqual(ids(h.evaluate(gpu, "gpu")), ["low-power"]);
  const headAt = t;
  assert.deepEqual(ids(h.evaluate({ ...gpu, headLlmProgressAt: headAt }, "gpu")), []);
  assert.equal(h.lowPowerProgressing, true);
  assert.equal(h.llmProgressAt, null);
  // future and invalid timestamps are not evidence
  assert.deepEqual(ids(h.evaluate({ ...gpu, headLlmProgressAt: headAt + 1 }, "gpu")), ["low-power"]);
  assert.deepEqual(ids(h.evaluate({ ...gpu, headLlmProgressAt: NaN }, "gpu")), ["low-power"]);
  // the head's evidence expires with the same window
  assert.deepEqual(ids(h.evaluate({ ...gpu, headLlmProgressAt: headAt }, "gpu")), []);
  t += LOW_POWER_PROGRESS_MS;
  assert.deepEqual(ids(h.evaluate({ ...gpu, headLlmProgressAt: headAt }, "gpu")), ["low-power"]);
});

test("thermal: configured thresholds move the finding and its text, and apply without a new evaluator", () => {
  let t = { warnC: 78, criticalC: 88 };
  const h = new HealthEvaluator({ thresholds: () => t });
  assert.deepEqual(h.evaluate({ gpu: { temperature: 77 } }), []);
  const warn = h.evaluate({ gpu: { temperature: 80 } })[0];
  assert.equal(warn.severity, "warn");
  assert.match(warn.detail, /warns at 78°C, critical at 88°C/);
  assert.equal(h.evaluate({ gpu: { temperature: 88 } })[0].severity, "critical");
  t = { warnC: 92, criticalC: 100 };
  assert.deepEqual(h.evaluate({ gpu: { temperature: 91 } }), []);
});

test("thermal: unusable thresholds fall back to 85/90", () => {
  for (const bad of [{ warnC: 90, criticalC: 85 }, { warnC: NaN, criticalC: 90 }, { warnC: 85 }, null]) {
    const h = new HealthEvaluator({ thresholds: () => bad });
    assert.deepEqual(h.evaluate({ gpu: { temperature: 84 } }), []);
    assert.equal(h.evaluate({ gpu: { temperature: 85 } })[0].severity, "warn");
    assert.equal(h.evaluate({ gpu: { temperature: 90 } })[0].severity, "critical");
  }
});
