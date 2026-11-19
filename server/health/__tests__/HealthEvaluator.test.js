import test from "node:test";
import assert from "node:assert/strict";
import { HealthEvaluator, LOW_POWER_STREAK, LOW_POWER_PROGRESS_MS, KERNEL_FINDING_TTL_MS, SWAP_STREAK } from "../HealthEvaluator.js";

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

// ─── Cold prefill ─────────────────────────────────────────
// Cumulative prompt counters as the probe reports them: every prompt token
// submitted, and the subset the engine's prompt cache served.
const prefillEndpoint = (submitted, cached, over = {}) =>
  llmEndpoint({ totalPromptTokens: submitted, totalCachedTokens: cached, ...over });

test("cold-prefill: one cold request of a new session does not fire", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm"); // baseline
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(80_000, 0)] }, "llm")), []);

  // A single 255k first turn is one request, still below the threshold.
  const one = new HealthEvaluator({ now: () => t });
  one.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  assert.deepEqual(ids(one.evaluate({ llm: [prefillEndpoint(255_000, 0)] }, "llm")), []);
});

test("cold-prefill: a session that misses the cache on every turn fires", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(255_000, 0)] }, "llm")), []);
  t += 60_000;
  const f = h.evaluate({ llm: [prefillEndpoint(510_000, 0)] }, "llm");
  assert.deepEqual(ids(f), ["cold-prefill"]);
  assert.equal(f[0].severity, "warn");
  assert.match(f[0].detail, /510,000 uncached prompt tokens in the last 10 minutes/);
  assert.match(f[0].detail, /0% of 510,000 submitted/);
  assert.match(f[0].detail, /m on port 8888/);
});

test("cold-prefill: a large volume that the cache mostly served stays silent", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  // 5M submitted, 4M served from cache: 1M uncached, but the cache is working.
  for (let i = 1; i <= 10; i++) {
    t += 30_000;
    assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(i * 500_000, i * 400_000)] }, "llm")), []);
  }
});

test("cold-prefill: a counter reset starts a new baseline, not a negative delta", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  h.evaluate({ llm: [prefillEndpoint(255_000, 0)] }, "llm");
  // The engine restarted: the counters go back to zero and the window is dropped.
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm")), []);
  // The next turn is measured from the new baseline, not from the old one.
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(255_000, 0)] }, "llm")), []);
});

test("cold-prefill: an engine with no cache split, or an unusable sample, raises nothing", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const noSplit = (submitted) => ({ llm: [llmEndpoint({ totalPromptTokens: submitted, totalCachedTokens: null })] });
  h.evaluate(noSplit(0), "llm");
  for (let i = 1; i <= 5; i++) {
    t += 60_000;
    assert.deepEqual(ids(h.evaluate(noSplit(i * 255_000), "llm")), []);
  }
  // An unavailable endpoint and an invalid measurement are not evidence either.
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(2_000_000, 0, { available: false })] }, "llm")), []);
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(4_000_000, 0, { measurementValid: false })] }, "llm")), []);
});

test("cold-prefill: cache hits and prompt tokens that arrive in different polls stay one turn", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  // A session with a large warm cache: 10M submitted, 9M of it served.
  let submitted = 10_000_000;
  let cached = 9_000_000;
  h.evaluate({ llm: [prefillEndpoint(submitted, cached)] }, "llm");
  // Some engines count cache hits when the request is scheduled and prompt
  // tokens when the first output token arrives, so one turn spans two polls.
  for (let turn = 0; turn < 2; turn++) {
    t += 30_000;
    cached += 250_000;
    assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(submitted, cached)] }, "llm")), []);
    t += 30_000;
    submitted += 255_000;
    assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(submitted, cached)] }, "llm")), []);
  }
  // The same deltas inside one poll are the same turn, and equally healthy.
  const one = new HealthEvaluator({ now: () => t });
  one.evaluate({ llm: [prefillEndpoint(10_000_000, 9_000_000)] }, "llm");
  for (let turn = 0; turn < 2; turn++) {
    t += 60_000;
    assert.deepEqual(ids(one.evaluate({ llm: [prefillEndpoint(10_255_000 + turn * 255_000, 9_250_000 + turn * 250_000)] }, "llm")), []);
  }
});

test("cold-prefill: a cold turn older than the window does not add to a later one", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  h.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(255_000, 0)] }, "llm")), []);
  // Eleven minutes later the first turn has left the ten-minute window.
  t += 11 * 60_000;
  assert.deepEqual(ids(h.evaluate({ llm: [prefillEndpoint(510_000, 0)] }, "llm")), []);
});

test("cold-prefill: each endpoint is judged on its own window", () => {
  let t = 1_000_000;
  const h = new HealthEvaluator({ now: () => t });
  const two = (a, b) => ({
    llm: [prefillEndpoint(a, 0, { port: 8000 }), prefillEndpoint(b, 0, { port: 8001 })],
  });
  h.evaluate(two(0, 0), "llm");
  t += 60_000;
  // One cold turn on each engine is one turn each, not two on one.
  assert.deepEqual(ids(h.evaluate(two(255_000, 255_000), "llm")), []);
  t += 60_000;
  // A second cold turn on port 8000 alone crosses the threshold there.
  const f = h.evaluate(two(510_000, 255_000), "llm");
  assert.deepEqual(ids(f), ["cold-prefill"]);
  assert.match(f[0].detail, /510,000 uncached prompt tokens/);
  assert.match(f[0].detail, /m on port 8000/);
  assert.doesNotMatch(f[0].detail, /port 8001/);
});

test("cold-prefill: a cached share of exactly half is not a miss", () => {
  let t = 1_000_000;
  const half = new HealthEvaluator({ now: () => t });
  half.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  // 300k uncached of 600k submitted: the boundary itself stays silent.
  assert.deepEqual(ids(half.evaluate({ llm: [prefillEndpoint(600_000, 300_000)] }, "llm")), []);

  const below = new HealthEvaluator({ now: () => t });
  below.evaluate({ llm: [prefillEndpoint(0, 0)] }, "llm");
  t += 60_000;
  // One token less cached crosses both the share and the uncached threshold.
  const f = below.evaluate({ llm: [prefillEndpoint(600_000, 299_999)] }, "llm");
  assert.deepEqual(ids(f), ["cold-prefill"]);
  assert.match(f[0].detail, /300,001 uncached prompt tokens/);
});

// ─── Swap traffic ─────────────────────────────────────────
const swapMem = (inPagesPerSec, outPagesPerSec) => ({
  unifiedMemory: { total: 124000, available: 8000, percentage: 50, swap: { inPagesPerSec, outPagesPerSec } },
});

test("swap-traffic: sustained swapping fires after the streak, static swap does not", () => {
  const h = new HealthEvaluator();
  // Swap occupied but idle reads 0 pages/s, so it never fires however long it sits there.
  for (let i = 0; i < SWAP_STREAK * 2; i++) assert.deepEqual(ids(h.evaluate(swapMem(0, 0), "memory")), []);
  // One burst is not sustained traffic.
  assert.deepEqual(ids(h.evaluate(swapMem(5000, 0), "memory")), []);
  assert.deepEqual(ids(h.evaluate(swapMem(0, 0), "memory")), []);
  for (let i = 0; i < SWAP_STREAK - 1; i++) assert.deepEqual(ids(h.evaluate(swapMem(0, 1200), "memory")), []);
  const f = h.evaluate(swapMem(0, 1200), "memory");
  assert.deepEqual(ids(f), ["swap-traffic"]);
  assert.equal(f[0].severity, "warn");
  assert.match(f[0].detail, /swap-out 1200 pages\/s/);
});

test("swap-traffic: only memory samples advance the streak", () => {
  const h = new HealthEvaluator();
  for (let i = 0; i < SWAP_STREAK - 1; i++) h.evaluate(swapMem(5000, 5000), "memory");
  // Network polls carry the same memory object but are not a new memory sample.
  for (let i = 0; i < SWAP_STREAK * 2; i++) assert.deepEqual(ids(h.evaluate(swapMem(5000, 5000), "other")), []);
  assert.deepEqual(ids(h.evaluate(swapMem(5000, 5000), "memory")), ["swap-traffic"]);
});

test("swap-traffic: a unit with no swap counters resets the streak and raises nothing", () => {
  const h = new HealthEvaluator();
  for (let i = 0; i < SWAP_STREAK - 1; i++) h.evaluate(swapMem(5000, 5000), "memory");
  // macOS and Windows report no swap rate. That is unknown, not healthy, and it
  // must not let a stale streak fire on the next sample.
  const unknown = { unifiedMemory: { total: 124000, available: 8000, percentage: 50, swap: null } };
  assert.deepEqual(ids(h.evaluate(unknown, "memory")), []);
  assert.deepEqual(ids(h.evaluate(swapMem(5000, 5000), "memory")), []);
});

test("swap-traffic: swap-in alone is enough to fire", () => {
  const h = new HealthEvaluator();
  for (let i = 0; i < SWAP_STREAK - 1; i++) assert.deepEqual(ids(h.evaluate(swapMem(500, 0), "memory")), []);
  const f = h.evaluate(swapMem(500, 0), "memory");
  assert.deepEqual(ids(f), ["swap-traffic"]);
  assert.match(f[0].detail, /Swap-in 500 pages\/s and swap-out 0 pages\/s for 15 samples in a row/);
});

test("swap-traffic: the finding clears once the swapping stops", () => {
  const h = new HealthEvaluator();
  for (let i = 0; i < SWAP_STREAK; i++) h.evaluate(swapMem(500, 0), "memory");
  assert.deepEqual(ids(h.evaluate(swapMem(500, 0), "memory")), ["swap-traffic"]);
  // The pages are still in swap, but nothing is moving them: the streak resets.
  assert.deepEqual(ids(h.evaluate(swapMem(0, 0), "memory")), []);
  assert.deepEqual(ids(h.evaluate(swapMem(0, 0), "memory")), []);
});
