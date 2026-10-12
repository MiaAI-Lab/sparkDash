/**
 * AlertEngine over HealthEvaluator findings and the strip's exceptions:
 * pending → firing after `for`, no flapping, resolve only after the condition
 * stays clear, grouping, severity changes, restore.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AlertEngine, MIN_CLEAR_MS, STATE_MAX_AGE_MS } from "../engine.js";
import { RULES } from "../conditions.js";
import { clock, hotUnit, quietLog, unit } from "./fixtures.js";

/** Only the given rules on; everything else off. */
function onlyRules(ruleOverrides) {
  const rules = {};
  for (const r of RULES) rules[r.id] = { enabled: false };
  for (const [id, o] of Object.entries(ruleOverrides)) rules[id] = { enabled: true, ...o };
  return rules;
}

function setup(rules, extra = {}) {
  const now = clock();
  const sent = [];
  const notifier = { dispatch: (_channels, group) => (sent.push(group), Promise.resolve([])) };
  const persisted = [];
  const config = { repeatIntervalMin: 0, rules: onlyRules(rules), channels: [{ id: "c", enabled: true }], ...extra };
  const engine = new AlertEngine({ now, getConfig: () => config, notifier, persistState: (s) => persisted.push(s), log: quietLog });
  return { now, sent, persisted, engine, config };
}

test("a HealthEvaluator thermal finding: pending until `for`, then firing exactly once", () => {
  const { now, sent, engine } = setup({ thermal: { forSec: 60 } });
  engine.evaluate([hotUnit(87)]);
  assert.equal(engine.active().length, 0);
  assert.equal(engine.pending().length, 1);

  now.advance(59_000);
  engine.evaluate([hotUnit(87)]);
  assert.equal(engine.active().length, 0, "not firing before 60 s");
  assert.equal(sent.length, 0);

  now.advance(1_000);
  engine.evaluate([hotUnit(87)]);
  const [a] = engine.active();
  assert.equal(a.key, "spark-1:thermal");
  assert.equal(a.ruleId, "thermal");
  assert.equal(a.severity, "warning");
  assert.equal(a.label, "GPU is running hot");
  assert.equal(a.startsAt, 1_000_000, "startsAt is when the condition began");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].firing.length, 1);

  now.advance(10_000);
  engine.evaluate([hotUnit(87)]);
  assert.equal(sent.length, 1, "no repeat while still firing (reminders off)");
});

test("a pending alert whose condition clears is dropped without a notification", () => {
  const { now, sent, engine } = setup({ thermal: { forSec: 60 } });
  engine.evaluate([hotUnit(87)]);
  now.advance(30_000);
  engine.evaluate([hotUnit(70)]);
  assert.equal(engine.pending().length, 0);
  now.advance(60_000);
  engine.evaluate([hotUnit(70)]);
  assert.equal(sent.length, 0);
  assert.equal(engine.recent().length, 0);
});

test("firing does not flap: brief recoveries do not resolve, a full `for` of clear does", () => {
  const { now, sent, engine } = setup({ offline: { forSec: 60 } });
  const down = unit({ online: false, offlineReason: "timeout" });
  const up = unit();
  engine.evaluate([down]);
  now.advance(60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 1);

  for (let i = 0; i < 5; i++) {
    now.advance(30_000);
    engine.evaluate([up]);
    now.advance(30_000);
    engine.evaluate([down]);
  }
  assert.equal(engine.active().length, 1, "still one firing alert");
  assert.equal(sent.length, 1, "no resolved/firing churn");

  now.advance(1_000);
  engine.evaluate([up]);
  const clearAt = now();
  now.advance(59_000);
  engine.evaluate([up]);
  assert.equal(engine.active().length, 1, "59 s clear is not enough");
  now.advance(1_000);
  engine.evaluate([up]);
  assert.equal(engine.active().length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].resolved.length, 1);
  assert.equal(sent[1].resolved[0].endsAt, clearAt, "endsAt is when it actually cleared");
  const [resolved, fired] = engine.recent();
  assert.equal(resolved.status, "resolved");
  assert.equal(fired.status, "firing");
});

test("a rule with `for` 0 still needs MIN_CLEAR_MS of clear before it resolves", () => {
  const { now, sent, engine } = setup({ "low-power": { forSec: 0 } });
  const stuck = unit({ health: [{ id: "low-power", severity: "warn", title: "GPU looks stuck in a low-power state", detail: "d", hint: "" }] });
  engine.evaluate([stuck]);
  assert.equal(sent.length, 1, "fires at once");
  for (let i = 0; i < 4; i++) {
    now.advance(5_000);
    engine.evaluate([unit()]);
    now.advance(5_000);
    engine.evaluate([stuck]);
  }
  assert.equal(sent.length, 1, "flapping every 5 s neither resolves nor re-fires");
  now.advance(5_000);
  engine.evaluate([unit()]);
  now.advance(MIN_CLEAR_MS);
  engine.evaluate([unit()]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].resolved.length, 1);
});

test("alerts that fire in the same evaluation are grouped into one dispatch", () => {
  const { now, sent, engine } = setup({ offline: { forSec: 60 }, disk: { forSec: 60 } });
  const a = unit({ id: "a", name: "A", online: false, offlineReason: "x" });
  const b = unit({ id: "b", name: "B", metrics: { storage: [{ device: "/d", total: 1, percentage: 95 }] } });
  engine.evaluate([a, b]);
  now.advance(60_000);
  engine.evaluate([a, b]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].firing.map((x) => x.key).sort(), ["a:offline", "b:disk"]);
});

test("a severity escalation must hold for `for`, then notifies once; a de-escalation does not", () => {
  const { now, sent, engine } = setup({ thermal: { forSec: 60 } });
  engine.evaluate([hotUnit(86)]);
  now.advance(60_000);
  engine.evaluate([hotUnit(86)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].firing[0].severity, "warning");

  now.advance(1_000);
  engine.evaluate([hotUnit(92)]);
  now.advance(30_000);
  engine.evaluate([hotUnit(92)]);
  assert.equal(sent.length, 1, "escalation not held long enough yet");
  now.advance(30_000);
  engine.evaluate([hotUnit(92)]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].firing[0].severity, "critical");

  now.advance(61_000);
  engine.evaluate([hotUnit(86)]);
  now.advance(61_000);
  engine.evaluate([hotUnit(86)]);
  assert.equal(sent.length, 2, "dropping back to warning is not news");
  assert.equal(engine.active()[0].severity, "warning");
  assert.equal(engine.active()[0].peakSeverity, "critical");
});

test("an offline unit does not resolve its thermal alert", () => {
  const { now, sent, engine } = setup({ thermal: { forSec: 0 }, offline: { forSec: 0 } });
  engine.evaluate([hotUnit(91)]);
  assert.equal(engine.active().length, 1);
  now.advance(5 * 60_000);
  engine.evaluate([hotUnit(91, { online: false, offlineReason: "timeout" })]);
  now.advance(5 * 60_000);
  engine.evaluate([hotUnit(91, { online: false, offlineReason: "timeout" })]);
  assert.deepEqual(engine.active().map((a) => a.ruleId).sort(), ["offline", "thermal"]);
  assert.equal(sent.flatMap((g) => g.resolved).length, 0);
});

test("turning a rule off ends its alerts; removing a unit ends its alerts", () => {
  const { now, sent, engine, config } = setup({ thermal: { forSec: 0 }, offline: { forSec: 0 } });
  engine.evaluate([hotUnit(91), unit({ id: "b", name: "B", online: false, offlineReason: "x" })]);
  assert.equal(engine.active().length, 2);
  config.rules.thermal = { enabled: false };
  now.advance(1_000);
  engine.evaluate([hotUnit(91), unit({ id: "b", name: "B", online: false, offlineReason: "x" })]);
  assert.deepEqual(engine.active().map((a) => a.key), ["b:offline"]);
  assert.match(sent.at(-1).resolved[0].summary, /rule turned off/);
  now.advance(1_000);
  engine.evaluate([hotUnit(91)]);
  assert.equal(engine.active().length, 0);
  assert.match(sent.at(-1).resolved[0].summary, /unit removed/);
});

test("reminders repeat while firing at the configured interval", () => {
  const { now, sent, engine } = setup({ offline: { forSec: 0 } }, { repeatIntervalMin: 60 });
  const down = unit({ online: false, offlineReason: "x" });
  engine.evaluate([down]);
  now.advance(59 * 60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 1);
  now.advance(60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].reminder, true);
});

test("the firing set survives a restart: no new notification, startsAt kept", () => {
  const first = setup({ thermal: { forSec: 0 } });
  first.engine.evaluate([hotUnit(91)]);
  const saved = first.persisted.at(-1);
  assert.equal(saved.firing.length, 1);

  const second = setup({ thermal: { forSec: 0 } });
  second.now.set(first.now() + 60_000);
  assert.equal(second.engine.restore(saved), 1);
  second.engine.evaluate([hotUnit(91)]);
  assert.equal(second.sent.length, 0, "already notified before the restart");
  assert.equal(second.engine.active()[0].startsAt, 1_000_000);

  const stale = setup({ thermal: { forSec: 0 } });
  stale.now.set(saved.savedAt + STATE_MAX_AGE_MS + 1);
  assert.equal(stale.engine.restore(saved), 0, "too old to trust");
});

test("unit names and summaries in alerts are capped", () => {
  const { engine } = setup({ offline: { forSec: 0 } });
  engine.evaluate([unit({ name: "n".repeat(300), online: false, offlineReason: "r".repeat(300) })]);
  const [a] = engine.active();
  assert.ok([...a.unitName].length <= 60);
  assert.ok([...a.summary].length <= 120);
});
