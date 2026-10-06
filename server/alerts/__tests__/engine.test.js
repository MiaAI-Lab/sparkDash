/**
 * AlertEngine state machine: pending → firing after `for`, no flapping,
 * resolve only after the condition stays false for `for`, grouping, restore.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AlertEngine, HISTORY_LIMIT, STATE_MAX_AGE_MS } from "../engine.js";
import { clock, unit } from "./fixtures.js";

/** Only the given rules on; everything else disabled. */
function onlyRules(ruleOverrides) {
  const ids = ["unit_offline", "gpu_temperature", "gpu_throttle", "memory_headroom", "disk_usage", "llm_unavailable", "kv_cache"];
  const rules = {};
  for (const id of ids) rules[id] = { enabled: false };
  for (const [id, o] of Object.entries(ruleOverrides)) rules[id] = { enabled: true, ...o };
  return rules;
}

function setup(rules, extra = {}) {
  const now = clock();
  const sent = [];
  const notifier = { dispatch: (channels, group) => (sent.push(group), Promise.resolve([])) };
  const persisted = [];
  const config = { repeatIntervalMin: 0, rules: onlyRules(rules), channels: [{ id: "c", enabled: true }], ...extra };
  const engine = new AlertEngine({
    now,
    getConfig: () => config,
    notifier,
    persistState: (s) => persisted.push(s),
    log: { error() {}, warn() {} },
  });
  return { now, sent, persisted, engine, config };
}

test("offline: pending until `for` elapses, then firing exactly once", () => {
  const { now, sent, engine } = setup({ unit_offline: { forSec: 60 } });
  const down = unit({ online: false, offlineReason: "ssh: timeout" });

  engine.evaluate([down]);
  assert.equal(engine.active().length, 0);
  assert.equal(engine.pending().length, 1);
  assert.equal(engine.pending()[0].state, "pending");

  now.advance(59_000);
  engine.evaluate([down]);
  assert.equal(engine.active().length, 0, "not firing before 60 s");
  assert.equal(sent.length, 0);

  now.advance(1_000);
  engine.evaluate([down]);
  const active = engine.active();
  assert.equal(active.length, 1);
  assert.equal(active[0].ruleId, "unit_offline");
  assert.equal(active[0].severity, "critical");
  assert.equal(active[0].startsAt, 1_000_000, "startsAt is when the condition began");
  assert.match(active[0].summary, /ssh: timeout/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].firing.length, 1);

  now.advance(10_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 1, "no repeat while still firing (reminders off)");
});

test("a pending alert whose condition clears is dropped without a notification", () => {
  const { now, sent, engine } = setup({ unit_offline: { forSec: 60 } });
  engine.evaluate([unit({ online: false })]);
  now.advance(30_000);
  engine.evaluate([unit({ online: true })]);
  assert.equal(engine.pending().length, 0);
  now.advance(60_000);
  engine.evaluate([unit({ online: true })]);
  assert.equal(sent.length, 0);
  assert.equal(engine.recent().length, 0);
});

test("firing does not flap: brief recoveries do not resolve, a full `for` of clear does", () => {
  const { now, sent, engine } = setup({ unit_offline: { forSec: 60 } });
  const down = unit({ online: false });
  const up = unit({ online: true });
  engine.evaluate([down]);
  now.advance(60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 1);

  // Flap: up 30 s, down again, up 30 s …
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

test("alerts that fire in the same evaluation are grouped into one dispatch", () => {
  const { now, sent, engine } = setup({ unit_offline: { forSec: 60 } });
  const a = unit({ id: "a", name: "A", online: false });
  const b = unit({ id: "b", name: "B", online: false });
  engine.evaluate([a, b]);
  now.advance(60_000);
  engine.evaluate([a, b]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].firing.map((x) => x.unitName).sort(), ["A", "B"]);
});

test("a unit that cannot be judged holds its alerts (offline does not resolve temperature)", () => {
  const { now, sent, engine } = setup({ gpu_temperature: { forSec: 120 } });
  const hot = unit({ metrics: { gpu: { temperature: 90 } } });
  engine.evaluate([hot]);
  now.advance(120_000);
  engine.evaluate([hot]);
  assert.equal(engine.active().length, 1);
  assert.equal(engine.active()[0].severity, "warning");

  now.advance(600_000);
  engine.evaluate([unit({ online: false, metrics: { gpu: { temperature: 0 } } })]);
  assert.equal(engine.active().length, 1, "held while unknown");
  assert.equal(sent.length, 1);
});

test("escalation to critical must hold for `for`, then notifies once; de-escalation is silent", () => {
  const { now, sent, engine } = setup({ gpu_temperature: { forSec: 120 } });
  const at = (t) => unit({ metrics: { gpu: { temperature: t } } });
  engine.evaluate([at(88)]);
  now.advance(120_000);
  engine.evaluate([at(88)]);
  assert.equal(sent.length, 1);

  now.advance(10_000);
  engine.evaluate([at(96)]);
  assert.equal(engine.active()[0].severity, "warning", "a spike does not escalate immediately");
  now.advance(120_000);
  engine.evaluate([at(96)]);
  assert.equal(engine.active()[0].severity, "critical");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].firing[0].severity, "critical");

  now.advance(120_000);
  engine.evaluate([at(90)]);
  now.advance(120_000);
  engine.evaluate([at(90)]);
  assert.equal(engine.active()[0].severity, "warning");
  now.advance(10_000);
  engine.evaluate([at(97)]);
  now.advance(120_000);
  engine.evaluate([at(97)]);
  assert.equal(sent.length, 2, "re-escalating to an already-notified severity stays quiet");
});

test("repeat reminders while firing when configured", () => {
  const { now, sent, engine } = setup({ unit_offline: { forSec: 0 } }, { repeatIntervalMin: 240 });
  const down = unit({ online: false });
  engine.evaluate([down]);
  assert.equal(sent.length, 1);
  now.advance(239 * 60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 1);
  now.advance(60_000);
  engine.evaluate([down]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].reminder, true);
});

test("disabling a rule or removing a unit ends its alerts with a resolved event", () => {
  const { sent, engine, config } = setup({ unit_offline: { forSec: 0 } });
  engine.evaluate([unit({ id: "a", online: false }), unit({ id: "b", online: false })]);
  assert.equal(engine.active().length, 2);
  engine.evaluate([unit({ id: "a", online: false })]);
  assert.equal(engine.active().length, 1);
  assert.match(sent[1].resolved[0].summary, /unit removed/);
  config.rules.unit_offline.enabled = false;
  engine.evaluate([unit({ id: "a", online: false })]);
  assert.equal(engine.active().length, 0);
  assert.match(sent[2].resolved[0].summary, /rule disabled/);
});

test("history keeps the newest 200 events", () => {
  const { now, engine } = setup({ unit_offline: { forSec: 0 } });
  for (let i = 0; i < 150; i++) {
    engine.evaluate([unit({ online: false })]);
    now.advance(1_000);
    engine.evaluate([unit({ online: true })]);
    now.advance(1_000);
  }
  assert.equal(engine.recent().length, HISTORY_LIMIT);
  assert.ok(engine.recent()[0].id > engine.recent()[1].id, "newest first");
});

test("the firing set is persisted on transitions and restored with its startsAt", () => {
  const { now, persisted, engine } = setup({ unit_offline: { forSec: 60 } });
  const down = unit({ online: false });
  engine.evaluate([down]);
  assert.equal(persisted.length, 0, "pending is not persisted");
  now.advance(60_000);
  engine.evaluate([down]);
  assert.equal(persisted.length, 1);
  const state = persisted[0];
  assert.equal(state.firing[0].startsAt, 1_000_000);

  // "Restart": a fresh engine resumes without notifying again.
  const second = setup({ unit_offline: { forSec: 60 } });
  second.now.set(now() + 30_000);
  assert.equal(second.engine.restore(state), 1);
  second.engine.evaluate([down]);
  assert.equal(second.engine.active()[0].startsAt, 1_000_000, "duration survives the restart");
  assert.equal(second.sent.length, 0, "no duplicate firing notification");

  const stale = setup({ unit_offline: { forSec: 60 } });
  stale.now.set(state.savedAt + STATE_MAX_AGE_MS + 1);
  assert.equal(stale.engine.restore(state), 0, "too old to trust");
});

test("a rule that throws is contained", () => {
  const { engine } = setup({ unit_offline: { forSec: 0 } });
  const weird = unit({ online: false });
  Object.defineProperty(weird, "offlineReason", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => engine.evaluate([weird]));
});
