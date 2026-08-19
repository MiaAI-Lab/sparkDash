import test from "node:test";
import assert from "node:assert/strict";
import { SparkRegistry } from "../SparkRegistry.js";

const r = Object.create(SparkRegistry.prototype);
const n = (partial) =>
  r._normalizeConfig({ id: "s6", name: "S6", lanIp: "10.0.0.6", ...partial });

test("roles derive workerNode and llmMonitoring", () => {
  assert.equal(n({ role: "head" }).workerNode, false);
  assert.equal(n({ role: "head" }).llmMonitoring, true);
  assert.equal(n({ role: "worker" }).workerNode, true);
  assert.equal(n({ role: "worker" }).llmMonitoring, false);
  assert.equal(n({ role: "standalone" }).llmMonitoring, true);
  assert.equal(n({ role: "standalone", llmMonitoring: false }).llmMonitoring, false);
});

test("comfyMonitoring is opt-in for all roles; comfyPort defaults to 8188", () => {
  assert.equal(n({ role: "head" }).comfyMonitoring, false);
  assert.equal(n({ role: "worker" }).comfyMonitoring, false);
  assert.equal(n({ role: "standalone" }).comfyMonitoring, false);
  assert.equal(n({ role: "standalone", comfyMonitoring: true }).comfyMonitoring, true);
  assert.equal(n({ role: "worker", comfyMonitoring: true }).comfyMonitoring, true);
  assert.equal(n({}).comfyPort, 8188);
  assert.equal(n({ comfyPort: 9000 }).comfyPort, 9000);
  assert.equal(n({ comfyPort: 0 }).comfyPort, 8188);
  assert.equal(n({ comfyPort: "8190" }).comfyPort, 8190);
});

test("tailscaleMonitoring is opt-in for all roles", () => {
  assert.equal(n({ role: "head" }).tailscaleMonitoring, false);
  assert.equal(n({ role: "worker" }).tailscaleMonitoring, false);
  assert.equal(n({ role: "standalone" }).tailscaleMonitoring, false);
  assert.equal(n({ role: "standalone", tailscaleMonitoring: true }).tailscaleMonitoring, true);
  assert.equal(n({ role: "worker", tailscaleMonitoring: true }).tailscaleMonitoring, true);
  assert.equal(n({ tailscaleMonitoring: "yes" }).tailscaleMonitoring, true);
  assert.equal(n({ tailscaleMonitoring: 0 }).tailscaleMonitoring, false);
});

test("legacy workerNode-only becomes worker", () => {
  const out = n({ workerNode: true, workerLabel: "  DS  ", workerHeadId: "s5" });
  assert.equal(out.role, "worker");
  assert.equal(out.workerLabel, "DS");
  assert.equal(out.workerHeadId, "s5");
});

test("non-workers clear worker fields; self head rejected", () => {
  assert.equal(n({ role: "head", workerLabel: "x", workerHeadId: "s5" }).workerLabel, null);
  assert.equal(n({ role: "worker", workerHeadId: "s6" }).workerHeadId, null);
});

test("invalid role falls back via workerNode", () => {
  assert.equal(n({ role: "nope", workerNode: true }).role, "worker");
  assert.equal(n({ role: "nope" }).role, "standalone");
});

test("coerceRole trims and lowercases", () => {
  assert.equal(r._coerceRole(" Worker "), "worker");
  assert.equal(r._coerceRole("HEAD"), "head");
  assert.equal(r._coerceRole(""), null);
  assert.equal(r._coerceRole(null), null);
});

test("null/invalid role in a patch must not flip worker → standalone", () => {
  const prev = n({ role: "worker", workerNode: true, workerLabel: "DS" });

  // Mirrors updateSpark: drop invalid role, keep prev.role through merge
  for (const bad of [null, undefined, "", "nope", "Worker "]) {
    /** @type {Record<string, unknown>} */
    const safeUpdates = { role: bad, storagePollDisabled: true };
    const coerced = r._coerceRole(safeUpdates.role);
    if (coerced) safeUpdates.role = coerced;
    else delete safeUpdates.role;
    if (
      Object.prototype.hasOwnProperty.call(safeUpdates, "workerNode") &&
      !Object.prototype.hasOwnProperty.call(safeUpdates, "role") &&
      safeUpdates.workerNode
    ) {
      safeUpdates.role = "worker";
    }
    const out = r._normalizeConfig({ ...prev, ...safeUpdates, id: prev.id });
    assert.equal(out.role, "worker", `bad role=${JSON.stringify(bad)}`);
    assert.equal(out.workerNode, true);
  }
});

test("workerNode:true without role promotes to worker", () => {
  const prev = n({ role: "standalone" });
  /** @type {Record<string, unknown>} */
  const safeUpdates = { workerNode: true };
  if (
    Object.prototype.hasOwnProperty.call(safeUpdates, "workerNode") &&
    !Object.prototype.hasOwnProperty.call(safeUpdates, "role") &&
    safeUpdates.workerNode
  ) {
    safeUpdates.role = "worker";
  }
  const out = r._normalizeConfig({ ...prev, ...safeUpdates, id: prev.id });
  assert.equal(out.role, "worker");
  assert.equal(out.workerNode, true);
});
