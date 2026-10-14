/**
 * Fleet auto-mode tests: fake temperatures and recorded applies/reverts — no
 * hardware, no SSH. Covers the 72/67 °C hold/release, the 1800–2200 range,
 * skipped nodes without a fresh reading, failures, disable and cap adoption.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FleetClockAuto,
  parseFleetAutoCap,
  AUTO_RANGE,
  AUTO_CAP_PRESETS,
  AUTO_HOLD_TEMP_C,
  AUTO_RELEASE_TEMP_C,
  DEFAULT_AUTO_CAP_MHZ,
} from "../clockCapAuto.js";

function spark(id, name = id) {
  return { id, name };
}

/** Two-node fleet with mutable temps; applies/reverts are recorded, not executed. */
function harness({ temps = {}, sparks = [spark("a"), spark("b")], applyError = null } = {}) {
  const events = [];
  const calls = [];
  const controller = new FleetClockAuto({
    sparks: () => sparks,
    readTemp: (s) => temps[s.id] ?? null,
    readStatus: async () => ({ mhz: null }),
    apply: async (s, mhz) => {
      calls.push(["apply", s.id, mhz]);
      if (applyError) throw applyError;
      return { mhz };
    },
    revert: async (s) => {
      calls.push(["revert", s.id]);
      if (applyError) throw applyError;
      return { mhz: null };
    },
    recordEvent: (event) => events.push(event),
  });
  return { controller, events, calls };
}

test("parseFleetAutoCap accepts exactly the presets inside the auto range and nothing else", () => {
  assert.deepEqual(AUTO_CAP_PRESETS, [1800, 1900, 2000, 2100, 2200]);
  assert.deepEqual(AUTO_RANGE, { min: 1800, max: 2200 });
  assert.equal(parseFleetAutoCap(1800), 1800);
  assert.equal(parseFleetAutoCap("2200"), 2200);
  for (const bad of [1700, 2300, 2000.5, "abc"]) {
    assert.throws(() => parseFleetAutoCap(bad));
  }
});

test("holds the cap at the hold temperature and releases at the release temperature", async () => {
  const temps = { a: 71, b: 30 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);

  temps.a = AUTO_HOLD_TEMP_C; // exactly at hold: cap
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", DEFAULT_AUTO_CAP_MHZ]]);

  temps.a = 68; // hysteresis band: keep holding, no calls
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", DEFAULT_AUTO_CAP_MHZ]]);

  temps.a = AUTO_RELEASE_TEMP_C; // exactly at release: revert
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "a", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "a"],
  ]);

  temps.a = 68; // released stays released in the band
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "a", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "a"],
  ]);
});

test("uses the configured auto cap and validates it against the range", async () => {
  const temps = { a: 80 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true, 2200);
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", 2200]]);

  await assert.rejects(() => controller.setEnabled(true, 2400), /Auto cap must be between/);
  // The invalid request must not have changed the running cap.
  temps.a = 30;
  await controller.tick();
  assert.deepEqual(calls, [["apply", "a", 2200], ["revert", "a"]]);
});

test("nodes without a fresh reading are skipped, not reverted", async () => {
  const temps = { a: null, b: 90 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);
  await controller.tick();
  assert.deepEqual(calls, [["apply", "b", DEFAULT_AUTO_CAP_MHZ]]);
  // b cools below release but a is still unreadable — b reverts, a untouched.
  temps.a = 40;
  temps.b = 20;
  await controller.tick();
  assert.deepEqual(calls, [
    ["apply", "b", DEFAULT_AUTO_CAP_MHZ],
    ["revert", "b"],
  ]);
});

test("set failure records an error event and keeps the node unheld for a retry", async () => {
  const { controller, events, calls } = harness({
    applyError: new Error("nvidia-smi failed"),
    temps: { a: 85 },
  });
  await controller.setEnabled(true);
  await controller.tick();
  assert.equal(calls.length, 1);
  assert.equal(events.filter((e) => e.type === "gpu.clockcap.auto.failed").length, 1);

  // Still unheld: the next tick retries the apply instead of waiting for release.
  await controller.tick();
  assert.equal(calls.length, 2);
  const status = controller.status();
  assert.equal(status.sparks.find((s) => s.id === "a").lastError, "nvidia-smi failed");
});

test("disabling stops the loop and clears per-node state without touching caps", async () => {
  const temps = { a: 85 };
  const { controller, calls } = harness({ temps });
  await controller.setEnabled(true);
  await controller.tick();
  assert.equal(calls.length, 1);

  await controller.setEnabled(false);
  assert.equal(controller.status().enabled, false);
  assert.deepEqual(controller.status().sparks.map((s) => s.holding), [false, false]);
  await controller.tick();
  assert.equal(calls.length, 1); // no further actuation after disable
});

test("enabling adopts existing caps so auto releases what it holds", async () => {
  const sparks = [spark("a"), spark("b")];
  const calls = [];
  const controller = new FleetClockAuto({
    sparks: () => sparks,
    readTemp: () => 30, // cool: auto would revert held caps
    readStatus: async (s) => ({ mhz: s.id === "a" ? 2200 : null }),
    apply: async () => assert.fail("must not apply on a cool fleet"),
    revert: async (s) => {
      calls.push(["revert", s.id]);
      return { mhz: null };
    },
    recordEvent: () => {},
  });
  await controller.setEnabled(true);
  await controller.tick();
  // a had a cap (adopted, so released); b never had one (left alone).
  assert.deepEqual(calls, [["revert", "a"]]);
});

test("status exposes thresholds, range, and per-node holding state", async () => {
  const temps = { a: 90, b: 40 };
  const { controller } = harness({ temps });
  await controller.setEnabled(true, 2100);
  await controller.tick();
  const status = controller.status();
  assert.equal(status.enabled, true);
  assert.equal(status.capMhz, 2100);
  assert.equal(status.holdTempC, 72);
  assert.equal(status.releaseTempC, 67);
  assert.deepEqual(status.presets, [1800, 1900, 2000, 2100, 2200]);
  assert.deepEqual(
    status.sparks.map((s) => [s.id, s.holding]),
    [["a", true], ["b", false]]
  );
});
