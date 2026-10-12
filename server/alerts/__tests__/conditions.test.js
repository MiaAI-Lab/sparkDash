/**
 * What the alert notifications watch: Health findings as HealthEvaluator
 * raises them, and the Overview strip's exceptions from the shared module —
 * no thresholds of their own.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { collectConditions, effectiveRuleConfig, RULES } from "../conditions.js";
import { fleetExceptions } from "../../../src/shared/fleetExceptions.js";
import { MAX_SUMMARY_CHARS, capText } from "../text.js";
import { findingsFor, hotUnit, unit } from "./fixtures.js";

const ids = (u) => collectConditions(u).conditions.map((c) => `${c.ruleId}:${c.severity}`);

test("a healthy online unit has no conditions and every rule is judged", () => {
  const r = collectConditions(unit());
  assert.deepEqual(r.conditions, []);
  assert.equal(r.judged("thermal"), true);
  assert.equal(r.judged("offline"), true);
});

test("GPU temperature follows HealthEvaluator exactly: nothing at 84, warn at 85, critical at 90", () => {
  assert.deepEqual(ids(hotUnit(84)), []);
  assert.deepEqual(ids(hotUnit(85)), ["thermal:warning"]);
  assert.deepEqual(ids(hotUnit(89)), ["thermal:warning"]);
  assert.deepEqual(ids(hotUnit(90)), ["thermal:critical"]);
  const [c] = collectConditions(hotUnit(91)).conditions;
  const [f] = findingsFor({ gpu: { temperature: 91 } });
  assert.equal(c.label, f.title);
  assert.equal(c.summary, f.detail);
});

test("unified memory follows HealthEvaluator: 3 GB warns, 1.5 GB is critical, ~7 GB headroom is fine", () => {
  const mem = (availableMb) => unit({ health: findingsFor({ unifiedMemory: { total: 124_610, available: availableMb } }) });
  assert.deepEqual(ids(mem(7_000)), [], "spark-1's usual ~7 GB headroom does not alert");
  assert.deepEqual(ids(mem(3_000)), ["memory:warning"]);
  assert.deepEqual(ids(mem(1_400)), ["memory:critical"]);
});

test("a Health finding the catalogue does not know still becomes a condition", () => {
  const u = unit({ health: [{ id: "new-rule", severity: "warn", title: "Something new", detail: "d", hint: "h" }] });
  const [c] = collectConditions(u).conditions;
  assert.equal(c.ruleId, "new-rule");
  assert.equal(c.ruleName, "Something new");
  assert.equal(effectiveRuleConfig("new-rule").enabled, true);
});

test("strip conditions are the Overview strip's: offline, thermal/hardware throttle, disk, LLM, tailnet", () => {
  const down = unit({ online: false, offlineReason: "ssh: connect timed out" });
  assert.deepEqual(ids(down), ["offline:critical"]);
  assert.equal(collectConditions(down).conditions[0].summary, "Unreachable: ssh: connect timed out");

  const thermal = unit({ metrics: { gpu: { temperature: 88, throttle: { active: true, reason: "thermal", thermal: true, hwSlowdown: false, powerCap: false, detail: "HW thermal slowdown", smClockMHz: 1200, smClockPct: 40 } } } });
  assert.deepEqual(ids(thermal), ["throttle:critical"]);
  assert.match(collectConditions(thermal).conditions[0].summary, /HW thermal slowdown · GPU at 88°C · SM clock 1\.2 GHz \(40% of max\)/);

  const disk = unit({ metrics: { storage: [{ device: "/dev/x", label: "/", total: 100, used: 91, percentage: 91 }] } });
  assert.deepEqual(ids(disk), ["disk:warning"]);

  const llmDown = unit({ metrics: { llm: [{ available: false, error: "ECONNREFUSED" }] } });
  assert.deepEqual(ids(llmDown), ["llm:warning"]);
  assert.deepEqual(ids({ ...llmDown, llmMonitoring: false }), [], "LLM monitoring off: no LLM alert");

  const tail = unit({ tailscaleMonitoring: true, metrics: { tailscale: { available: true, online: false } } });
  assert.deepEqual(ids(tail), ["tailnet:warning"]);

  // Same ids, severities and order as the strip computes.
  for (const u of [down, thermal, disk, llmDown, tail]) {
    assert.deepEqual(
      collectConditions(u).conditions.map((c) => [c.ruleId, c.severity]),
      fleetExceptions(u).map((e) => [e.id, e.severity])
    );
  }
});

test("the software power cap never alerts (main's strip ignores it too)", () => {
  const capped = unit({ metrics: { gpu: { throttle: { active: true, reason: "power", thermal: false, hwSlowdown: false, powerCap: true, detail: "SW power cap", smClockPct: 70 } } } });
  assert.deepEqual(ids(capped), []);
  const ours = ["gpu_throttle", "memory_headroom", "gpu_temperature", "kv_cache", "unit_offline", "disk_usage", "llm_unavailable"];
  assert.equal(RULES.some((r) => ours.includes(r.id)), false, "none of the old PR's own rules survive");
});

test("an offline unit only judges `offline`; its stale findings are held, not resolved", () => {
  const r = collectConditions(hotUnit(91, { online: false, offlineReason: "timeout" }));
  assert.deepEqual(r.conditions.map((c) => c.ruleId), ["offline"]);
  assert.equal(r.judged("offline"), true);
  assert.equal(r.judged("thermal"), false);
});

test("before the first liveness check (offline, no reason yet) nothing is judged", () => {
  const r = collectConditions(unit({ online: false, offlineReason: null }));
  assert.deepEqual(r.conditions, []);
  assert.equal(r.judged("offline"), false);
});

test("remote text is capped: SSH errors, kernel Xid lines, finding titles", () => {
  const long = "x".repeat(500);
  const down = collectConditions(unit({ online: false, offlineReason: long })).conditions[0];
  assert.equal([...down.summary].length, MAX_SUMMARY_CHARS);
  assert.ok(down.summary.endsWith("…"));
  const finding = { id: "xid", severity: "critical", title: `NVIDIA Xid error ${long}`, detail: `Latest: ${long}\nsecond line`, hint: "" };
  const [c] = collectConditions(unit({ health: [finding] })).conditions;
  assert.ok([...c.label].length <= MAX_SUMMARY_CHARS);
  assert.ok([...c.summary].length <= MAX_SUMMARY_CHARS);
  assert.ok(!c.summary.includes("\n"));
});

test("capText flattens control characters and keeps short text as is", () => {
  assert.equal(capText("a\r\nb\tc"), "a b c");
  assert.equal(capText("short"), "short");
  assert.equal(capText(null), "");
  assert.equal(capText("abcdef", 4), "abc…");
});
