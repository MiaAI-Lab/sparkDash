import test from "node:test";
import assert from "node:assert/strict";
import { ModelScheduler } from "../ModelScheduler.js";

/**
 * Scheduler tests use a fake registry/jobs/status so no host exec or wall
 * clock is involved — `tick(nowMs)` takes the instant explicitly.
 *
 * Reference instants (Europe/Prague, winter = UTC+1):
 *   weekday 2026-01-05, weekend 2026-01-03.
 */
const TZ = "Europe/Prague";

function at(y, mo, d, h, mi) {
  // Build a wall time in TZ by backing off the known winter offset (+1).
  return Date.UTC(y, mo - 1, d, h - 1, mi, 0);
}

function atSummer(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 2, mi, 0);
}

class FakeJobs {
  constructor() {
    this.calls = [];
    this.jobs = new Map();
  }
  start(modelId, action, meta) {
    this.calls.push({ modelId, action, source: meta?.source });
    const jobId = `job-${this.calls.length}`;
    const job = { id: jobId, done: Promise.resolve() };
    this.jobs.set(jobId, job);
    return { jobId };
  }
}

function makeScheduler({ models, status, enabled = true }) {
  const jobs = new FakeJobs();
  const registry = {
    models: models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      schedule: { enabled: m.enabled !== false, weekday: m.weekday || [], weekend: m.weekend || [] },
    })),
    getModel(id) {
      return this.models.find((m) => m.id === id) || null;
    },
  };
  const sched = new ModelScheduler({
    registry,
    jobs,
    status: () => status || {},
    getConfig: () => ({ enabled, tz: TZ }),
    statePath: `/tmp/nonexistent-sched-${Math.random()}.json`,
    tz: TZ,
    log: () => {},
  });
  return { sched, jobs };
}

const WEEKDAY_MON_0200 = at(2026, 1, 5, 2, 0); // inside a 18:00→08:00 night window
const WEEKDAY_NOON = at(2026, 1, 5, 12, 0); // outside it
const WEEKEND_SAT_0200 = at(2026, 1, 3, 2, 0);

const NIGHT = [{ start: "18:00", end: "08:00" }];
const DAY = [{ start: "08:00", end: "18:00" }];

test("gap with nothing running is idle (no calls)", async () => {
  const { sched, jobs } = makeScheduler({ models: [{ id: "glm", weekday: NIGHT }] });
  const d = await sched.runTick(WEEKDAY_NOON);
  assert.equal(d.action, "idle");
  assert.equal(jobs.calls.length, 0);
});

test("gap with a model running → stop it", async () => {
  const { sched, jobs } = makeScheduler({
    models: [{ id: "glm", weekday: NIGHT }],
    status: { glm: { running: true } },
  });
  const d = await sched.runTick(WEEKDAY_NOON); // noon → no window
  assert.equal(d.action, "stop");
  assert.deepEqual(jobs.calls, [{ modelId: "glm", action: "stop", source: "scheduler" }]);
});

test("window active + target down → self-heal start", async () => {
  const { sched, jobs } = makeScheduler({ models: [{ id: "glm", weekday: NIGHT }] });
  const d = await sched.runTick(WEEKDAY_MON_0200);
  assert.equal(d.action, "start");
  assert.equal(d.modelId, "glm");
  assert.deepEqual(jobs.calls, [{ modelId: "glm", action: "start", source: "scheduler" }]);
});

test("window active + target already running → idle", async () => {
  const { sched, jobs } = makeScheduler({
    models: [{ id: "glm", weekday: NIGHT }],
    status: { glm: { running: true } },
  });
  const d = await sched.runTick(WEEKDAY_MON_0200);
  assert.equal(d.action, "idle");
  assert.equal(jobs.calls.length, 0);
});

test("different incumbent → swap (stop then start)", async () => {
  const { sched, jobs } = makeScheduler({
    models: [
      { id: "glm", weekday: NIGHT },
      { id: "qwen", weekday: DAY },
    ],
    // Day window active at noon, target qwen, but glm somehow running.
    status: { glm: { running: true }, qwen: { running: false } },
  });
  const d = await sched.runTick(at(2026, 1, 5, 12, 0));
  assert.equal(d.action, "swap");
  assert.equal(d.modelId, "qwen");
  assert.deepEqual(
    jobs.calls.map((c) => `${c.action}:${c.modelId}`),
    ["stop:glm", "start:qwen"]
  );
});

test("manual override holds until the next boundary, then re-asserts", async () => {
  // Night window 18:00→08:00 owns glm. At 02:00 the schedule wants glm.
  const { sched, jobs } = makeScheduler({ models: [{ id: "glm", weekday: NIGHT }] });
  // User manually STOPS everything at 02:00 (override → null target).
  sched.noteManual(null, WEEKDAY_MON_0200);
  const held = await sched.runTick(WEEKDAY_MON_0200);
  assert.equal(held.action, "override");
  assert.equal(jobs.calls.length, 0, "override must not touch jobs");

  // Past the boundary (08:00) the override is stale; but 08:00 is a gap → stop,
  // and nothing runs → idle. Use a still-in-window instant with a running model
  // to prove the override released: advance to just before 08:00 boundary? No —
  // the boundary IS the release point. Test the release directly:
  const after = await sched.runTick(at(2026, 1, 5, 9, 0)); // past 08:00 → gap, nothing running
  assert.equal(after.action, "idle");
});

test("weekend schedule is chosen on Saturday, not the weekday one", async () => {
  const { sched, jobs } = makeScheduler({
    models: [{ id: "glm", weekday: [], weekend: NIGHT }],
  });
  const d = await sched.runTick(WEEKEND_SAT_0200);
  assert.equal(d.action, "start");
  assert.equal(d.modelId, "glm");
});

test("enabled:false config makes the tick fully inert", async () => {
  const { sched, jobs } = makeScheduler({
    models: [{ id: "glm", weekday: NIGHT }],
    status: { glm: { running: false } },
    enabled: false,
  });
  const d = await sched.runTick(WEEKDAY_MON_0200);
  assert.equal(d.action, "disabled");
  assert.equal(jobs.calls.length, 0);
});

// ─── The "don't touch manual models" guard ─────────────────
// Regression: flipping Auto ON before anyone defines windows must never stop a
// model that is running by hand (schedule disabled). That model is not the
// scheduler's business.
test("gap does NOT stop an unscheduled (manual) model", async () => {
  const { sched, jobs } = makeScheduler({
    // glm has a schedule but it is disabled → manual-only, running at noon.
    models: [{ id: "glm", enabled: false, weekday: NIGHT }],
    status: { glm: { running: true } },
  });
  const d = await sched.runTick(WEEKDAY_NOON); // no active window
  assert.equal(d.action, "idle");
  assert.equal(jobs.calls.length, 0, "a manual model must never be stopped by the scheduler");
});

test("window wants glm but a manual model holds the GPU → blocked, no calls", async () => {
  const { sched, jobs } = makeScheduler({
    models: [
      { id: "glm", weekday: NIGHT }, // scheduled target for the night window
      { id: "qwen", enabled: false, weekday: [] }, // manual, running now
    ],
    status: { glm: { running: false }, qwen: { running: true } },
  });
  const d = await sched.runTick(WEEKDAY_MON_0200); // night → target glm
  assert.equal(d.action, "blocked");
  assert.equal(d.modelId, "glm");
  assert.deepEqual(d.blockedBy, ["qwen"]);
  assert.match(d.reason, /qwen/i);
  assert.equal(jobs.calls.length, 0, "must not double-book or kill the manual model");
});

test("a managed incumbent in a gap IS stopped (guard is scoped to managed)", async () => {
  const { sched, jobs } = makeScheduler({
    models: [{ id: "glm", weekday: NIGHT }], // enabled schedule
    status: { glm: { running: true } },
  });
  const d = await sched.runTick(WEEKDAY_NOON); // noon → gap
  assert.equal(d.action, "stop");
  assert.equal(jobs.calls.length, 1);
});

test("statusBlock carries no Date.now()-derived field (diff-cache safe)", async () => {
  const { sched } = makeScheduler({ models: [{ id: "glm", weekday: NIGHT }] });
  const a = sched.statusBlock(WEEKDAY_MON_0200);
  const b = sched.statusBlock(at(2026, 1, 5, 2, 30)); // 30 min later, same window
  // nextBoundary.epochMs is absolute (fixed); everything else is clock-free,
  // so the serialized block is byte-identical between ticks in one window.
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.nextBoundary.epochMs > WEEKDAY_MON_0200);
});

test("statusBlock.nextModelId is the model starting at the next boundary", async () => {
  // qwen owns the day (08:00→18:00), glm the night (18:00→08:00). At noon the
  // active model is qwen, but the NEXT one to start (at the 18:00 boundary) is glm.
  const { sched } = makeScheduler({
    models: [
      { id: "glm", weekday: NIGHT },
      { id: "qwen", weekday: DAY },
    ],
    status: { qwen: { running: true } },
  });
  const s = sched.statusBlock(WEEKDAY_NOON);
  assert.equal(s.activeModelId, "qwen");
  assert.equal(s.nextModelId, "glm");
  assert.equal(s.nextWindow.owner, "glm");
  // Stable between boundaries (diff-cache safe).
  assert.equal(
    JSON.stringify(sched.statusBlock(at(2026, 1, 5, 14, 0))),
    JSON.stringify(s)
  );
});

test("statusBlock.nextModelId is null when the boundary leads into a gap", async () => {
  // glm owns only the night window; at 06:00 the night window ends into an
  // unowned gap (no day schedule), so nothing is scheduled to start next.
  const { sched } = makeScheduler({ models: [{ id: "glm", weekday: NIGHT }] });
  const s = sched.statusBlock(at(2026, 1, 5, 6, 0));
  assert.equal(s.activeModelId, "glm");
  assert.equal(s.nextModelId, null);
  assert.equal(s.nextWindow, null);
});

test("statusBlock skips same-model weekend continuation", () => {
  const { sched } = makeScheduler({
    models: [
      { id: "qwen", weekday: [{ start: "08:40", end: "18:00" }] },
      {
        id: "deepseek",
        weekday: [{ start: "18:00", end: "08:40" }],
        weekend: [{ start: "00:00", end: "00:00" }],
      },
    ],
  });

  const fridayEvening = atSummer(2026, 9, 4, 18, 30);
  const mondayMorning = atSummer(2026, 9, 7, 8, 40);
  const s = sched.statusBlock(fridayEvening);

  assert.equal(s.activeModelId, "deepseek");
  assert.equal(s.nextModelId, "qwen");
  assert.equal(s.nextBoundary.epochMs, mondayMorning);
  assert.equal(s.nextBoundary.clock, "08:40");
});
