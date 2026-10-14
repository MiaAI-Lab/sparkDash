/**
 * Reconcile-loop tests. Pure drift detection plus a controller run against
 * fake nodes — no hardware, no SSH. Covers the three drift causes: a stale
 * marker after a reboot, an out-of-band nvidia-smi -rgc, and a mismatched MHz
 * marker; plus the gpu.clockcap.reapplied event and the no-target / auto guards.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { capDrifts, FleetClockCapReconciler } from "../clockCapReconcile.js";

function status(overrides = {}) {
  return { mhz: null, stale: false, markerMhz: null, graphicsClockMHz: 2400, tempC: 50, ...overrides };
}

test("capDrifts: fixed target — stale marker (reboot), missing marker (-rgc) and wrong MHz all drift", () => {
  const target = { mode: "fixed", mhz: 2000 };
  assert.equal(capDrifts(status({ mhz: 2000 }), target), false);
  // Reboot: the old marker no longer matches the current boot_id → resolved stock.
  assert.equal(capDrifts(status({ mhz: null, stale: true, markerMhz: 2000 }), target), true);
  // Out-of-band -rgc: no marker at all.
  assert.equal(capDrifts(status(), target), true);
  // Someone capped at a different MHz.
  assert.equal(capDrifts(status({ mhz: 1800 }), target), true);
});

test("capDrifts: an auto target never drifts — fleet Auto owns the caps", () => {
  assert.equal(capDrifts(status({ mhz: 2400 }), { mode: "auto", mhz: 2000 }), false);
  assert.equal(capDrifts(status({ mhz: null, stale: true, markerMhz: 2000 }), { mode: "auto", mhz: 2000 }), false);
});

test("capDrifts: unlocked target — any cap or stale marker drifts", () => {
  const target = { mode: "unlocked", mhz: null };
  assert.equal(capDrifts(status(), target), false);
  assert.equal(capDrifts(status({ mhz: 1800 }), target), true);
  // Stale marker from a previous boot still sits on disk — reapply removes it.
  assert.equal(capDrifts(status({ mhz: null, stale: true, markerMhz: 1800 }), target), true);
});

test("capDrifts: no target never drifts (the loop stands down)", () => {
  assert.equal(capDrifts(status({ mhz: 2400 }), null), false);
});

function harness({ nodes = {}, target = { mode: "fixed", mhz: 2000 } } = {}) {
  const state = {
    applied: [],
    reverted: [],
    events: [],
  };
  const deps = {
    sparks: () => Object.keys(nodes).map((id) => ({ id, name: id.toUpperCase() })),
    target: () => target,
    readStatus: async (spark) => nodes[spark.id].status,
    apply: async (spark, mhz) => {
      nodes[spark.id].status = { ...status(), mhz };
      state.applied.push([spark.id, mhz]);
    },
    revert: async (spark) => {
      nodes[spark.id].status = status();
      state.reverted.push(spark.id);
    },
    recordEvent: (event) => state.events.push(event),
  };
  return { deps, state, nodes };
}

test("reconciler re-applies the cap on a drifted node and records gpu.clockcap.reapplied", async () => {
  const { deps, state } = harness({
    nodes: {
      // spark2 rebooted: the marker holds the previous boot's boot_id.
      spark1: { status: status({ mhz: 2000 }) },
      spark2: { status: status({ mhz: null, stale: true, markerMhz: 2000 }) },
    },
  });
  await new FleetClockCapReconciler(deps).tick();
  assert.deepEqual(state.applied, [["spark2", 2000]]);
  assert.deepEqual(state.reverted, []);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, "gpu.clockcap.reapplied");
  assert.equal(state.events[0].sparkId, "spark2");
  assert.equal(state.events[0].severity, "info");
  assert.match(state.events[0].message, /2000 MHz re-applied on SPARK2/);
});

test("reconciler reverts a node that gained a cap while the target is Unlocked", async () => {
  const { deps, state } = harness({
    target: { mode: "unlocked", mhz: null },
    nodes: { spark2: { status: status({ mhz: 1800 }) } },
  });
  await new FleetClockCapReconciler(deps).tick();
  assert.deepEqual(state.reverted, ["spark2"]);
  assert.deepEqual(state.applied, []);
  assert.equal(state.events[0].type, "gpu.clockcap.reapplied");
});

test("reconciler does nothing when every node matches the target", async () => {
  const { deps, state } = harness({
    nodes: { spark1: { status: status({ mhz: 2000 }) }, spark2: { status: status({ mhz: 2000 }) } },
  });
  await new FleetClockCapReconciler(deps).tick();
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.reverted, []);
  assert.deepEqual(state.events, []);
});

test("reconciler stands down with no target", async () => {
  const { deps, state } = harness({ target: null, nodes: { spark2: { status: status({ mhz: 2400 }) } } });
  await new FleetClockCapReconciler(deps).tick();
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.events, []);
});

test("reconciler records a throttled failure when a node is unreachable", async () => {
  const { deps, state } = harness({
    nodes: { spark2: { status: null } },
  });
  deps.readStatus = async () => {
    throw new Error("ssh: connect refused");
  };
  const c = new FleetClockCapReconciler(deps);
  await c.tick();
  await c.tick(); // second pass inside the throttle window → no repeat
  const failures = state.events.filter((e) => e.type === "gpu.clockcap.reconcile.failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].severity, "error");
  assert.match(failures[0].message, /connect refused/);
});

test("reconciler skips a node whose previous read is still in flight", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, state } = harness({ nodes: { spark2: { status: status() } } });
  deps.readStatus = async () => {
    await gate;
    return status({ mhz: 2000 });
  };
  const c = new FleetClockCapReconciler(deps);
  const first = c.tick();
  await c.tick(); // overlapping pass must not double-apply
  release({ mhz: 2000 });
  await first;
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.events, []);
});
