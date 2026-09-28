import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoPowerManager } from "../AutoPowerManager.js";
import { busyReasons } from "../probe.js";

/**
 * All decisions are driven by an injected clock + injected probe/actions, so
 * no test waits, no test touches a real host, and — critically — no test can
 * ever reach a real Spark. Prague is UTC+1 in winter, UTC+2 in summer.
 */
const TZ = "Europe/Prague";

function at(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 1, mi, 0); // winter (CET, +1) → UTC
}
function atSummer(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 2, mi, 0); // summer (CEST, +2) → UTC
}

const IDLE_SOURCES = {
  proxy: { ok: true, streams: 0, requests: 0 },
  engine: { ok: true, slotsUsed: 0, ticketsActive: 0, plansActive: 0 },
};
const BUSY_SOURCES = {
  proxy: { ok: true, streams: 2, requests: 0 },
  engine: { ok: true, slotsUsed: 0, ticketsActive: 0, plansActive: 0 },
};

const SPARKS = [
  { id: "spark1-lan", name: "spark1.lan", role: "head" },
  { id: "spark2-lan", name: "spark2.lan", role: "worker" },
];

let _tmpN = 0;
function freshStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autopower-test-${process.pid}-`));
  return path.join(dir, `state-${_tmpN++}.json`);
}

/**
 * @param {{sources?: any, online?: string[], enabled?: boolean,
 *   overrides?: object}} [opts]
 */
function makeManager(opts = {}) {
  const calls = { shutdown: [], wake: [] };
  const online =
    opts.online instanceof Set ? opts.online : new Set(opts.online ?? ["spark1-lan", "spark2-lan"]);
  const config = {
    enabled: opts.enabled ?? true,
    tz: TZ,
    idleTimeoutMin: 30,
    watch: { weekday: [{ start: "22:00", end: "07:00" }], weekend: [{ start: "23:00", end: "08:00" }] },
    wake: { weekday: "08:00", weekend: "10:00" },
    ...(opts.overrides || {}),
  };
  const manager = new AutoPowerManager({
    probe: async () => (typeof opts.sources === "function" ? opts.sources() : (opts.sources ?? IDLE_SOURCES)),
    getSparks: () => SPARKS,
    isOnline: (id) => online.has(id),
    shutdownSpark: async (spark) => {
      calls.shutdown.push(spark.id);
      online.delete(spark.id);
      return "powering off";
    },
    wakeSpark: async (spark) => {
      calls.wake.push(spark.id);
      online.add(spark.id);
      return { mac: "aa:bb:cc:dd:ee:ff" };
    },
    getConfig: () => config,
    log: () => {},
    statePath: freshStatePath(),
  });
  return { manager, calls, online, config };
}

// 2026-01-05 is a Monday. 2026-01-03 is a Saturday.
const MON_0200 = at(2026, 1, 5, 2, 0); // inside weekday 22:00–07:00
const MON_1200 = at(2026, 1, 5, 12, 0); // outside it
const SAT_0200 = at(2026, 1, 3, 2, 0); // inside weekend 23:00–08:00

test("disabled config makes the tick fully inert (no probe, no actions)", async () => {
  const { manager, calls } = makeManager({ enabled: false });
  const d = await manager.runTick(MON_0200);
  assert.equal(d.action, "disabled");
  assert.deepEqual(calls.shutdown, []);
  assert.deepEqual(calls.wake, []);
});

test("busy sources reset the idle timer", async () => {
  const { manager } = makeManager({ sources: BUSY_SOURCES });
  await manager.runTick(MON_0200);
  const d = await manager.runTick(MON_0200 + 60_000);
  assert.equal(d.action, "busy");
  assert.match(d.reason, /streaming request/);
  const st = manager.statusBlock(MON_0200 + 60_000);
  assert.equal(st.idleSince, null);
});

test("unreachable source counts as busy, never idle", async () => {
  const { manager } = makeManager({
    sources: { proxy: { ok: true, streams: 0, requests: 0 }, engine: { ok: false, error: "ECONNREFUSED" } },
  });
  const d = await manager.runTick(MON_0200);
  assert.equal(d.action, "busy");
  assert.match(d.reason, /dev engine unreachable/);
});

test("idle outside the watch window only counts — no shutdown", async () => {
  const { manager, calls } = makeManager();
  await manager.runTick(MON_1200);
  const d = await manager.runTick(at(2026, 1, 5, 13, 0));
  assert.equal(d.action, "idle");
  assert.match(d.reason, /outside the weekday watch window/);
  assert.deepEqual(calls.shutdown, []);
});

test("idle inside the window but under the timeout → watching", async () => {
  const { manager, calls } = makeManager();
  await manager.runTick(MON_0200);
  const d = await manager.runTick(MON_0200 + 10 * 60_000);
  assert.equal(d.action, "watching");
  assert.match(d.reason, /10 min \/ 30 min within 22:00–07:00/);
  assert.deepEqual(calls.shutdown, []);
});

test("idle ≥ timeout inside the window → shutdown, worker first, head last", async () => {
  const { manager, calls } = makeManager();
  await manager.runTick(MON_0200); // idle starts
  const d = await manager.runTick(MON_0200 + 31 * 60_000);
  assert.equal(d.action, "shutdown");
  // head goes last: the AI proxy runs on it
  assert.deepEqual(calls.shutdown, ["spark2-lan", "spark1-lan"]);
  const st = manager.statusBlock(MON_0200 + 31 * 60_000);
  assert.equal(st.lastAction.kind, "shutdown");
  assert.equal(st.lastAction.results.length, 2);
});

test("no double shutdown: offline sparks end the sweep, no re-fire", async () => {
  // One shared liveness set: the fake proxy source mirrors reality — it runs
  // on spark1 and goes unreachable once that spark is off.
  const online = new Set(["spark1-lan", "spark2-lan"]);
  const { manager, calls } = makeManager({
    online,
    sources: () => ({
      proxy: online.has("spark1-lan")
        ? { ok: true, streams: 0, requests: 0 }
        : { ok: false, error: "fetch failed" },
      engine: IDLE_SOURCES.engine,
    }),
  });
  await manager.runTick(MON_0200); // idle starts
  const d = await manager.runTick(MON_0200 + 31 * 60_000);
  assert.equal(d.action, "shutdown");
  assert.equal(calls.shutdown.length, 2);
  const d2 = await manager.runTick(MON_0200 + 32 * 60_000);
  assert.equal(d2.action, "busy"); // unreachable proxy counts as busy
  assert.equal(calls.shutdown.length, 2); // still no third action
});

test("weekend window governs Saturday, not the weekday one", async () => {
  const { manager, calls } = makeManager();
  await manager.runTick(SAT_0200);
  const d = await manager.runTick(SAT_0200 + 31 * 60_000);
  // 02:31 Sat is inside weekend 23:00–08:00 but OUTSIDE weekday 22:00–07:00?
  // No — it is inside both shapes; the point is the weekend list is consulted.
  assert.equal(d.action, "shutdown");
  assert.match(d.reason, /23:00–08:00/);
  assert.equal(calls.shutdown.length, 2);
});

test("weekday window does NOT cover a weekday 08:30 morning (gap)", async () => {
  const { manager, calls } = makeManager();
  await manager.runTick(at(2026, 1, 5, 8, 30));
  const d = await manager.runTick(at(2026, 1, 5, 9, 0));
  assert.equal(d.action, "idle");
  assert.deepEqual(calls.shutdown, []);
});

test("wrap-around window covers a summer 02:00 with correct DST offset", async () => {
  const { manager, calls } = makeManager();
  const summer2 = atSummer(2026, 7, 6, 2, 0); // Monday 02:00 CEST
  await manager.runTick(summer2);
  const d = await manager.runTick(summer2 + 31 * 60_000);
  assert.equal(d.action, "shutdown");
  assert.equal(calls.shutdown.length, 2);
});

test("wake fires at the scheduled minute, only for offline sparks, once", async () => {
  const { manager, calls } = makeManager({
    online: [], // both sparks are off (they were shut down overnight)
    sources: () => ({
      proxy: { ok: false, error: "down" },
      engine: IDLE_SOURCES.engine,
    }),
  });
  const d = await manager.runTick(at(2026, 1, 5, 8, 0)); // Mon 08:00 sharp
  assert.equal(d.action, "wake");
  // head wakes first so the proxy comes back up
  assert.deepEqual(calls.wake, ["spark1-lan", "spark2-lan"]);
  // a second tick inside the grace window must not re-fire
  const d2 = await manager.runTick(at(2026, 1, 5, 8, 5));
  assert.equal(d2.action, "busy"); // sources are still failing this tick
  assert.deepEqual(calls.wake, ["spark1-lan", "spark2-lan"]); // unchanged
});

test("wake outside the grace window (hours later) does not fire", async () => {
  const { manager, calls } = makeManager({
    online: [],
    sources: { proxy: { ok: false, error: "down" }, engine: IDLE_SOURCES.engine },
  });
  const d = await manager.runTick(at(2026, 1, 5, 11, 0)); // 08:00 wake + 3 h
  assert.equal(d.action, "busy");
  assert.deepEqual(calls.wake, []);
});

test("wake skipped when all sparks are already online", async () => {
  const { manager, calls } = makeManager();
  const d = await manager.runTick(at(2026, 1, 5, 8, 0, 30));
  assert.equal(d.action, "wake-skip");
  assert.deepEqual(calls.wake, []);
});

test("weekend wake time governs Saturday", async () => {
  const { manager, calls } = makeManager({
    online: [],
    sources: { proxy: { ok: false, error: "down" }, engine: IDLE_SOURCES.engine },
  });
  const d = await manager.runTick(at(2026, 1, 3, 9, 0)); // Sat 09:00 — weekend wake is 10:00
  assert.equal(d.action, "busy");
  assert.deepEqual(calls.wake, []);
  const d2 = await manager.runTick(at(2026, 1, 3, 10, 0, 20));
  assert.equal(d2.action, "wake");
  assert.equal(calls.wake.length, 2);
});

test("idle timer survives a manager restart (persisted state)", async () => {
  const { manager, calls } = makeManager();
  const p = manager.statePath;
  await manager.runTick(MON_0200); // starts the idle timer
  const revived = new AutoPowerManager({
    probe: async () => IDLE_SOURCES,
    getSparks: () => SPARKS,
    isOnline: () => true,
    shutdownSpark: async (s) => calls.shutdown.push(s.id),
    wakeSpark: async () => ({}),
    getConfig: () => manager.getConfig(),
    log: () => {},
    statePath: p,
  });
  // 31 min after the ORIGINAL tick — only persisted state can bridge the gap
  const d = await revived.runTick(MON_0200 + 31 * 60_000);
  assert.equal(d.action, "shutdown");
  assert.equal(calls.shutdown.length, 2);
});

test("statusBlock exposes live watch/wake/idle view", async () => {
  const { manager } = makeManager({ online: ["spark1-lan"] });
  await manager.runTick(MON_0200);
  const st = manager.statusBlock(MON_0200 + 5 * 60_000);
  assert.equal(st.watching, true);
  assert.equal(st.window.start, "22:00");
  assert.equal(st.idleMin, 5);
  assert.equal(st.shutdownInMs, 25 * 60_000);
  assert.equal(st.targets.length, 2);
  assert.deepEqual(
    st.targets.map((t) => `${t.id}:${t.online}`),
    ["spark1-lan:true", "spark2-lan:false"]
  );
  // Monday 02:05 status → next weekday wake is Monday 08:00
  assert.equal(st.nextWakeAt, MON_0200 + 6 * 3_600_000);
});

test("busyReasons: pure matrix of source shapes", () => {
  assert.deepEqual(busyReasons(IDLE_SOURCES), []);
  assert.equal(busyReasons(BUSY_SOURCES).length, 1);
  assert.equal(busyReasons({ proxy: { ok: false }, engine: { ok: false } }).length, 2);
  assert.equal(
    busyReasons({ proxy: { ok: false }, engine: IDLE_SOURCES.engine }).length,
    1
  );
  assert.equal(
    busyReasons({
      proxy: IDLE_SOURCES.proxy,
      engine: { ok: true, slotsUsed: 0, ticketsActive: 3, plansActive: 0 },
    }).length,
    1
  );
  assert.equal(
    busyReasons({
      proxy: IDLE_SOURCES.proxy,
      engine: { ok: true, slotsUsed: 0, ticketsActive: 0, plansActive: 1 },
    }).length,
    1
  );
});
