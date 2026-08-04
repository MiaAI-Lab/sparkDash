import test from "node:test";
import assert from "node:assert/strict";
import { SparkRegistry } from "../SparkRegistry.js";
import { SparkMonitor } from "../SparkMonitor.js";

const r = Object.create(SparkRegistry.prototype);
const n = (partial) =>
  r._normalizeConfig({ id: "s6", name: "S6", lanIp: "10.0.0.6", ...partial });

const m = Object.create(SparkMonitor.prototype);
const ports = (spark) => m._videoPorts(spark);

// Unlike llmPorts, videoPorts has NO default: Sparks that predate ComfyUI
// monitoring must not start probing a port that isn't there.
test("videoPorts defaults to empty, never to a port", () => {
  assert.deepEqual(n({}).videoPorts, []);
  assert.deepEqual(n({ videoPorts: null }).videoPorts, []);
  assert.deepEqual(n({ videoPorts: [] }).videoPorts, []);
});

test("videoPorts validates range and dedupes preserving order", () => {
  assert.deepEqual(n({ videoPorts: [8188, "8189", 8188, 0, 70000, "x"] }).videoPorts, [
    8188, 8189,
  ]);
});

test("videoPorts accepts a bare single value", () => {
  assert.deepEqual(n({ videoPorts: 8188 }).videoPorts, [8188]);
});

test("comfyLogPath is trimmed, absent → null", () => {
  assert.equal(n({ comfyLogPath: "  /var/log/comfy.log " }).comfyLogPath, "/var/log/comfy.log");
  assert.equal(n({}).comfyLogPath, null);
});

test("monitor mirrors registry validation", () => {
  assert.deepEqual(ports({ videoPorts: [8188, 8188, -1] }), [8188]);
  assert.deepEqual(ports({}), []);
  assert.deepEqual(ports(null), []);
});

test("workers never probe ComfyUI even if ports are configured", () => {
  assert.deepEqual(ports({ role: "worker", videoPorts: [8188] }), []);
  assert.deepEqual(ports({ workerNode: true, videoPorts: [8188] }), []);
  assert.deepEqual(ports({ role: "head", videoPorts: [8188] }), [8188]);
});
