/**
 * Each built-in rule's condition, including memory headroom on both memory
 * models with the exact thresholds the VRAM bar uses.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RULES, effectiveRuleConfig, ruleById } from "../rules.js";
import { HEADROOM_THRESHOLDS_MB, headroomTone } from "../../../src/shared/memoryHeadroom.js";
import { unit } from "./fixtures.js";

function run(id, u, overrides, ctx) {
  const rule = ruleById(id);
  const seen = new Set();
  const c = ctx || {
    markSeen: (unitId, sub) => seen.add(`${unitId}:${sub}`),
    wasSeen: (unitId, sub) => seen.has(`${unitId}:${sub}`),
  };
  return rule.evaluate(u, effectiveRuleConfig(rule, overrides), c);
}

test("every rule has defaults with enabled + forSec, and the spec durations", () => {
  const forSec = Object.fromEntries(RULES.map((r) => [r.id, r.defaults.forSec]));
  assert.deepEqual(forSec, {
    unit_offline: 60,
    gpu_temperature: 120,
    gpu_throttle: 60,
    memory_headroom: 120,
    disk_usage: 300,
    llm_unavailable: 120,
    kv_cache: 120,
  });
  for (const r of RULES) assert.equal(r.defaults.enabled, true, r.id);
});

test("unit_offline", () => {
  assert.deepEqual(run("unit_offline", unit()), []);
  const [c] = run("unit_offline", unit({ online: false, offlineReason: "No route to host" }));
  assert.equal(c.severity, "critical");
  assert.match(c.summary, /No route to host/);
});

test("gpu_temperature uses the junction thresholds (85 / 95)", () => {
  const t = (temperature) => run("gpu_temperature", unit({ metrics: { gpu: { temperature } } }));
  assert.deepEqual(t(84), []);
  assert.equal(t(85)[0].severity, "warning");
  assert.equal(t(94)[0].severity, "warning");
  assert.equal(t(95)[0].severity, "critical");
  assert.equal(t(95)[0].value, 95);
  assert.equal(run("gpu_temperature", unit({ online: false })), null, "offline: cannot judge");
  assert.equal(
    run("gpu_temperature", unit({ metrics: { gpu: { temperature: 0, usage: 0, vram: { total: 0, used: 0 } } } })),
    null,
    "collector default zeros: cannot judge"
  );
  assert.equal(run("gpu_temperature", unit({ metrics: { gpu: { temperature: 80 } } }), { warningC: 75 })[0].severity, "warning");
});

test("gpu_throttle: thermal/hw critical, power cap warning", () => {
  const th = (throttle) => run("gpu_throttle", unit({ metrics: { gpu: { throttle } } }));
  assert.deepEqual(th({ active: false, reason: "ok" }), []);
  assert.equal(th({ active: true, reason: "thermal", detail: "HW thermal slowdown", smClockPct: 40 })[0].severity, "critical");
  assert.equal(th({ active: true, reason: "hw", detail: "HW slowdown" })[0].severity, "critical");
  const [p] = th({ active: true, reason: "power", detail: "SW power cap", smClockPct: 70 });
  assert.equal(p.severity, "warning");
  assert.match(p.summary, /SW power cap.*70%/);
  assert.equal(th(null), null);
});

test("memory_headroom on a GB10 (unified): unifiedMemory.available, amber < 8 GB, red < 4 GB", () => {
  const free = (available) => run("memory_headroom", unit({ kind: "spark", metrics: { unifiedMemory: { available } } }));
  assert.deepEqual(free(8 * 1024), [], "exactly 8 GB is ok");
  const [low] = free(7.2 * 1024);
  assert.equal(low.severity, "warning");
  assert.match(low.summary, /7\.2 GB unified memory free/);
  assert.equal(free(4 * 1024)[0].severity, "warning", "exactly 4 GB is low, not critical");
  assert.equal(free(3.9 * 1024)[0].severity, "critical");
  // Same answer as the bar's classifier for a sweep of values.
  for (let mb = 0; mb < 12 * 1024; mb += 256) {
    const tone = headroomTone(mb, "unified");
    const got = free(mb);
    const expected = tone === "ok" ? [] : [tone === "critical" ? "critical" : "warning"];
    assert.deepEqual(got.map((c) => c.severity), expected, `${mb} MB`);
  }
});

test("memory_headroom on a discrete host: VRAM total − used, amber < 2 GB, red < 1 GB", () => {
  const host = (used, extra = {}) =>
    run("memory_headroom", unit({
      kind: "host",
      // available is system RAM on a host while no GPU process runs — must be ignored.
      metrics: { gpu: { vram: { total: 97_887, used, available: 500_000, percentage: 0 }, ...extra } },
    }));
  assert.deepEqual(host(97_887 - 3.2 * 1024), [], "RTX PRO 6000 with 3.2 GB free is ok");
  assert.equal(host(97_887 - 1.5 * 1024)[0].severity, "warning");
  assert.equal(host(97_887 - 0.5 * 1024)[0].severity, "critical");
  assert.match(host(97_887 - 0.5 * 1024)[0].summary, /VRAM free/);
  assert.equal(HEADROOM_THRESHOLDS_MB.discrete.low, 2048);

  // Multi-card: judged per card.
  const cards = run("memory_headroom", unit({
    kind: "host",
    metrics: {
      gpu: {
        vram: { total: 40_000, used: 20_000, available: 0 },
        gpus: [
          { index: 0, vram: { total: 16_000, used: 15_500, available: 0 } },
          { index: 1, vram: { total: 24_000, used: 4_500, available: 0 } },
        ],
      },
    },
  }));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].sub, "gpu0");
  assert.equal(cards[0].severity, "critical");
});

test("memory_headroom thresholds are tunable and unknown data cannot be judged", () => {
  const u = unit({ metrics: { unifiedMemory: { available: 10 * 1024 } } });
  assert.deepEqual(run("memory_headroom", u), []);
  assert.equal(run("memory_headroom", u, { unifiedLowGb: 12, unifiedCriticalGb: 4 })[0].severity, "warning");
  assert.equal(
    run("memory_headroom", unit({ metrics: { unifiedMemory: { total: 0 }, gpu: { vram: { total: 0, used: 0 }, temperature: 40 } } })),
    null
  );
});

test("disk_usage: per disk, 90 warning / 95 critical, disabled disks ignored", () => {
  const disks = [
    { device: "/dev/a", label: "/", total: 100, used: 50, percentage: 50 },
    { device: "/dev/b", label: "/data", total: 100, used: 91, percentage: 91 },
    { device: "/dev/c", label: "/scratch", total: 100, used: 96, percentage: 96 },
    { device: "/dev/d", label: "/old", total: 100, used: 99, percentage: 99, disabled: true },
  ];
  const out = run("disk_usage", unit({ metrics: { storage: disks } }));
  assert.deepEqual(out.map((c) => [c.sub, c.severity]), [["/dev/b", "warning"], ["/dev/c", "critical"]]);
  assert.equal(run("disk_usage", unit({ metrics: { storage: [] } })), null);
});

test("llm_unavailable: only endpoints seen available, only head/standalone", () => {
  const seen = new Set();
  const ctx = { markSeen: (u, s) => seen.add(`${u}:${s}`), wasSeen: (u, s) => seen.has(`${u}:${s}`) };
  const down = unit({ metrics: { llm: [{ available: false, error: "ECONNREFUSED" }] } });
  assert.deepEqual(run("llm_unavailable", down, undefined, ctx), [], "never seen up: not an outage");
  run("llm_unavailable", unit(), undefined, ctx);
  const [c] = run("llm_unavailable", down, undefined, ctx);
  assert.equal(c.sub, "8888");
  assert.match(c.summary, /port 8888.*ECONNREFUSED/);
  assert.equal(run("llm_unavailable", unit({ role: "worker", workerNode: true }), undefined, ctx), null);
  assert.equal(run("llm_unavailable", unit({ role: "standalone", llmMonitoring: false }), undefined, ctx), null);
});

test("kv_cache: ≥ 90% where reported", () => {
  const kv = (kvCacheUsage, available = true) => run("kv_cache", unit({ metrics: { llm: [{ available, kvCacheUsage, modelId: "m" }] } }));
  assert.deepEqual(kv(0.89), []);
  const [c] = kv(0.93);
  assert.equal(c.severity, "warning");
  assert.equal(c.value, 93);
  assert.deepEqual(kv(null), [], "unknown fill: no alert");
  assert.deepEqual(kv(0.99, false), [], "endpoint down: not this rule's business");
});
