import test from "node:test";
import assert from "node:assert/strict";
import { fleetExceptions } from "../../../src/shared/fleetExceptions.js";
import { collectConditions } from "../conditions.js";

const pi = (throttle, health = []) => ({
  id: "luffy-1",
  name: "luffy-1",
  kind: "pi",
  online: true,
  offlineReason: null,
  llmMonitoring: false,
  tailscaleMonitoring: false,
  metrics: { pi: { throttle }, storage: [] },
  health,
});

test("Pi under-voltage and throttling appear in the fleet strip", () => {
  const now = fleetExceptions(pi({ underVoltage: true, throttled: true }));
  assert.deepEqual(now.map((e) => e.id), ["pi-under-voltage", "pi-throttle"]);
  assert.equal(now[0].severity, "critical");
  assert.equal(now[1].severity, "warning");

  const occurred = fleetExceptions(pi({ underVoltageOccurred: true }));
  assert.deepEqual(occurred.map((e) => [e.id, e.severity]), [["pi-under-voltage", "warning"]]);
});

test("Pi units never inherit the GPU throttle condition", () => {
  const snapshot = {
    ...pi(null),
    metrics: { pi: { throttle: null }, gpu: { throttle: { thermal: true } }, storage: [] },
  };
  assert.deepEqual(fleetExceptions(snapshot).map((e) => e.id), []);
});

test("a Pi under-voltage health finding is de-duplicated against the strip rule", () => {
  const snapshot = pi(
    { underVoltage: true },
    [
      {
        id: "pi-under-voltage",
        severity: "critical",
        title: "Under-voltage detected",
        detail: "The Pi's firmware reports an active under-voltage condition.",
        hint: "Check the supply.",
      },
    ]
  );
  const { conditions } = collectConditions(snapshot);
  assert.deepEqual(conditions.map((c) => c.ruleId), ["pi-under-voltage"]);
});
