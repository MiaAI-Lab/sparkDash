import test from "node:test";
import assert from "node:assert/strict";
import {
  HealthEvaluator,
  PI_RAM_FREE_CRITICAL_PCT,
  PI_RAM_FREE_WARN_PCT,
  PI_TEMP_CRITICAL_C,
  PI_TEMP_WARN_C,
} from "../HealthEvaluator.js";

const ids = (f) => f.map((x) => x.id);

test("Pi thermal uses the 75/80 bands and ignores GPU rules", () => {
  const h = new HealthEvaluator();
  assert.deepEqual(h.evaluate({ cpu: { temperature: PI_TEMP_WARN_C - 1 } }, "other", "pi"), []);
  assert.equal(h.evaluate({ cpu: { temperature: PI_TEMP_WARN_C } }, "other", "pi")[0].severity, "warn");
  assert.equal(h.evaluate({ cpu: { temperature: PI_TEMP_CRITICAL_C } }, "other", "pi")[0].severity, "critical");
  // A GPU temperature on a Pi is not a Pi finding.
  assert.deepEqual(h.evaluate({ gpu: { temperature: 95 } }, "gpu", "pi"), []);
});

test("Pi RAM warns and turns critical on the free percentage, not the GB10 absolute rule", () => {
  const h = new HealthEvaluator();
  const ram = (available) => ({ ram: { total: 8192, used: 8192 - available, available, percentage: ((8192 - available) / 8192) * 100 } });
  assert.deepEqual(h.evaluate(ram(2048), "other", "pi"), []);
  assert.equal(h.evaluate(ram((8192 * PI_RAM_FREE_WARN_PCT) / 100 - 1), "other", "pi")[0].severity, "warn");
  assert.equal(h.evaluate(ram((8192 * PI_RAM_FREE_CRITICAL_PCT) / 100 - 1), "other", "pi")[0].severity, "critical");
  // The unified-memory rule must not fire on a Pi even when the pool is unknown.
  assert.deepEqual(h.evaluate({ unifiedMemory: { total: 8192, available: 100 } }, "other", "pi"), []);
});

test("Pi firmware throttle flags become under-voltage and throttling findings", () => {
  const h = new HealthEvaluator();
  const now = h.evaluate({ pi: { throttle: { underVoltage: true, throttled: true } } }, "other", "pi");
  assert.deepEqual(ids(now), ["pi-under-voltage", "pi-throttle"]);
  assert.equal(now[0].severity, "critical");

  const occurred = h.evaluate({ pi: { throttle: { underVoltageOccurred: true } } }, "other", "pi");
  assert.equal(occurred[0].id, "pi-under-voltage");
  assert.equal(occurred[0].severity, "warn");

  const soft = h.evaluate({ pi: { throttle: { softTempLimit: true } } }, "other", "pi");
  assert.deepEqual(ids(soft), ["pi-throttle"]);

  // Unknown throttle state raises nothing.
  assert.deepEqual(h.evaluate({ pi: { throttle: null } }, "other", "pi"), []);
});

test("non-Pi units keep the GPU and unified-memory rules", () => {
  const h = new HealthEvaluator();
  assert.equal(h.evaluate({ gpu: { temperature: 86 } }, "gpu", "spark")[0].id, "thermal");
  assert.equal(h.evaluate({ unifiedMemory: { total: 8192, available: 100 } }, "other", "host")[0].id, "memory");
});
