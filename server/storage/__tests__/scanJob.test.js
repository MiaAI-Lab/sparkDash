// Scan jobs in StorageManager with a fake runner: stopping, what keeps a Spark busy, and how a scan the dashboard
// lost track of is reconciled. The real unit-side programs are exercised in scanCancel.test.js.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StorageManager } from "../StorageManager.js";
import { ELEVATED_SCAN_CAP_SECONDS, parseJobOutput, scanLimits, scanPlan } from "../scanJob.js";

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };
const sparkB = { ...spark, id: "s2", ssh: { user: "me", host: "10.0.0.6" } };
const sparkC = { ...spark, id: "s3", ssh: { user: "me", host: "10.0.0.7" } };

const SCAN_OK = ["RESULT=ok\n100\td\t/\0" + "60\td\t/home", "@@RC=0", "@@UNREADABLE=0", ""].join("\0");
const CANCEL = (outcome, reason = "term") => `RESULT=ok\nOUTCOME=${outcome}\nREASON=${reason}\nLOCK=free\n`;
const STATUS = (state, lock = "free", reason = "x") => `RESULT=ok\nSTATE=${state}\nREASON=${reason}\nLOCK=${lock}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

/**
 * A manager whose runner answers per program: `scan` waits for its gate (or throws `scanError`), `job` answers
 * come from `jobAnswers` (a value or a function; an Error is thrown as a transport failure).
 */
function make({ scanAnswer = SCAN_OK, scanError = null, jobAnswers = {}, ...opts } = {}) {
  const calls = [];
  const scanGate = gate();
  const m = new StorageManager({
    run: async (_s, program, o) => {
      calls.push({ name: o.name, args: o.args, program });
      if (o.name === "job") {
        const action = o.args[0];
        let a = jobAnswers[action];
        if (typeof a === "function") a = await a();
        if (a instanceof Error) throw a;
        return a ?? "RESULT=error\nCODE=failed\nMSG=no answer\n";
      }
      if (o.name === "scan") {
        await scanGate.p;
        if (scanError) throw scanError;
        return scanAnswer;
      }
      return "RESULT=ok\n";
    },
    holdMs: 0,
    reconcileMs: 5,
    stopGraceMs: 10,
    stopKillWaitMs: 10,
    ...opts,
  });
  return { m, calls, open: scanGate.open };
}

async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("an ordinary scan can be stopped: it runs as a recorded job under the unit lock", async () => {
  const { m, calls, open } = make();
  const job = m.startScan(spark, { path: "/", depth: 2 });
  assert.equal(job.cancellable, true);
  assert.equal(job.cancelBestEffort, false);
  assert.equal(job.stopsByItselfAt, null);
  assert.equal(job.holdsSpark, true);
  assert.equal(job.holdReason, "running");
  const scan = calls.find((c) => c.name === "scan");
  assert.deepEqual(scan.args, ["/", 2, 900, 4000, 8, 1000], "soft limit, rows, parallel jobs, hard deadline");
  assert.match(scan.program, new RegExp(`SPARKDASH_JOB=${job.id}`));
  assert.match(scan.program, /setsid -w/);
  assert.match(scan.program, /sd_lock 5/);
  assert.doesNotMatch(scan.program, /timeout -k 10/);
  open();
  await m.settled("s1");
  const done = m.snapshot(spark).job;
  assert.equal(done.state, "done");
  assert.equal(done.holdsSpark, false);
  assert.equal(calls.length, 1, "a normal scan needs no extra trips to the unit");
});

test("an administrator scan is not stoppable from here; the unit ends it by itself and the job says when", async () => {
  const now = 1_000_000;
  const { m, calls, open } = make({ now: () => now });
  const job = m.startScan(spark, { sudo: true });
  assert.equal(job.cancellable, false);
  const limits = scanLimits({ capped: true });
  assert.equal(limits.hardLimitSeconds, ELEVATED_SCAN_CAP_SECONDS);
  assert.equal(job.stopsByItselfAt, now + (ELEVATED_SCAN_CAP_SECONDS + 10) * 1000 + 30_000);
  assert.equal(job.holdUntil, job.stopsByItselfAt);
  const scan = calls.find((c) => c.name === "scan");
  assert.match(scan.program, /timeout -k 10 300 bash/);
  assert.deepEqual(scan.args.slice(2), [200, 4000, 8, 290], "every step ends before the hard limit");
  assert.throws(() => m.cancelScan(spark), (e) => e.status === 409 && e.code === "not-cancellable" && /within 6 minutes/.test(e.message));
  open();
  await m.settled("s1");
  assert.equal(m.snapshot(spark).job.holdsSpark, false);
});

test("where the account is root no sudo is used, so the scan can be stopped; in a container it is best effort", () => {
  assert.deepEqual(scanPlan({ kind: "ssh", accountIsRoot: true }, true).cancellable, true);
  assert.equal(scanPlan({ kind: "ssh", accountIsRoot: true }, true).limits.hardLimitSeconds, 0);
  assert.equal(scanPlan({ kind: "ssh", accountIsRoot: false }, true).cancellable, false);
  const { m, open } = make({ jobContext: () => ({ kind: "container-local", accountIsRoot: true }) });
  const job = m.startScan(spark, { sudo: true });
  assert.deepEqual([job.cancellable, job.cancelBestEffort, job.stopsByItselfAt], [true, true, null]);
  open();
});

test("Stop scan: the Spark stays busy until the unit confirms, then is free at once", async () => {
  const reply = gate();
  const { m, calls, open } = make({ jobAnswers: { cancel: () => reply.p } });
  m.startScan(spark, {});
  const stopping = m.cancelScan(spark);
  assert.equal(stopping.state, "stopping");
  assert.deepEqual([stopping.stop.outcome, stopping.holdsSpark, stopping.holdReason], ["pending", true, "stopping"]);
  // Asking twice sends one request.
  m.cancelScan(spark);
  assert.equal(calls.filter((c) => c.name === "job").length, 1);
  assert.deepEqual(calls.find((c) => c.name === "job").args.slice(0, 1), ["cancel"]);
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.code === "scan-running" && /being stopped/.test(e.message));
  assert.throws(() => m.startScan(spark, {}), (e) => e.code === "scan-running");

  reply.open(CANCEL("terminated"));
  open(); // the killed program's late answer is ignored
  await m.settled("s1");
  const job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.stop.outcome, job.holdsSpark], ["cancelled", "terminated", false]);
  assert.match(job.stop.message, /Nothing of the scan is left/);
  assert.equal(m.snapshot(spark).session, null, "a stopped scan leaves no result");
  await m.delete(spark, { path: "/home/me/x" });
});

test("a stop that cannot be confirmed keeps the Spark busy until the unit says the scan is gone", async () => {
  const statuses = [STATUS("running", "held"), STATUS("gone")];
  const { m, open } = make({ jobAnswers: { cancel: CANCEL("not-terminated", "still-running"), status: () => statuses.shift() ?? STATUS("gone") } });
  m.startScan(spark, {});
  m.cancelScan(spark);
  await until(() => m.snapshot(spark).job.stop.outcome !== "pending", "the stop answer");
  let job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.stop.outcome, job.holdsSpark, job.holdReason], ["stopping", "not-terminated", true, "unconfirmed"]);
  assert.match(job.stop.message, /Could not confirm it stopped — the Spark stays busy until it does\./);
  assert.match(job.stop.message, /still running after being told to stop/);
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.code === "scan-running" && /could not be confirmed stopped/.test(e.message));

  open();
  await until(() => !m.snapshot(spark).job.holdsSpark, "the reconcile");
  job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.stop.outcome], ["cancelled", "terminated"]);
  assert.match(job.stop.message, /confirmed/);
  assert.equal(statuses.length, 0, "it asked until the unit said gone");
});

test("lost contact during a scan: busy until reconciled with the unit, not for a fixed time", async () => {
  const statuses = [new Error("ssh: connection refused"), STATUS("running", "held"), STATUS("gone")];
  const { m, open } = make({ scanError: new Error("ssh: Connection reset"), jobAnswers: { status: () => statuses.shift() ?? STATUS("gone") } });
  m.startScan(spark, {});
  open();
  await m.settled("s1");
  let job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.error.code, job.holdsSpark, job.holdReason], ["error", "unreachable", true, "unreachable"]);
  assert.equal(job.holdUntil, job.startedAt + 1000 * 1000 + 30_000, "at the latest the unit's own deadline ends it");
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.code === "scan-running" && /lost contact/.test(e.message));
  await until(() => !m.snapshot(spark).job.holdsSpark, "the reconcile");
  assert.equal(statuses.length, 0);
  job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.error.code], ["error", "unreachable"], "the failure stays on record");
});

test("after lost contact the scan can still be stopped", async () => {
  const { m, open } = make({ scanError: new Error("ssh: timeout"), jobAnswers: { status: STATUS("running", "held"), cancel: CANCEL("terminated") } });
  m.startScan(spark, {});
  open();
  await m.settled("s1");
  assert.equal(m.snapshot(spark).job.holdsSpark, true);
  m.cancelScan(spark);
  await m.settled("s1");
  const job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.stop.outcome, job.holdsSpark], ["error", "terminated", false]);
});

test("never heard back again: the scan's own deadline on the unit ends the hold", async () => {
  let now = 1_000_000;
  const { m, open } = make({ now: () => now, scanError: new Error("ssh: timeout"), jobAnswers: { status: new Error("ssh: no route to host") } });
  m.startScan(spark, {});
  open();
  await m.settled("s1");
  await sleep(40);
  assert.equal(m.snapshot(spark).job.holdsSpark, true, "unreachable, and before the deadline");
  now = m.snapshot(spark).job.holdUntil + 1;
  await until(() => !m.snapshot(spark).job.holdsSpark, "the deadline", 5000);
});

test("an unknown answer frees the Spark only when nothing holds the unit lock", async () => {
  const statuses = [STATUS("unknown", "held", "no-process-check"), STATUS("unknown", "free", "no-process-check")];
  const { m, open } = make({ scanError: new Error("ssh: reset"), jobAnswers: { status: () => statuses.shift() } });
  m.startScan(spark, {});
  open();
  await until(() => statuses.length < 2, "the first check");
  assert.equal(m.snapshot(spark).job.holdsSpark, true);
  await until(() => !m.snapshot(spark).job.holdsSpark, "the second check");
});

test("a failed stop request (unreachable) is unknown: busy until the unit confirms", async () => {
  const { m, open } = make({ jobAnswers: { cancel: new Error("ssh: refused"), status: STATUS("gone") } });
  m.startScan(spark, {});
  m.cancelScan(spark);
  await until(() => m.snapshot(spark).job.stop.outcome !== "pending", "the stop answer");
  const job = m.snapshot(spark).job;
  assert.deepEqual([job.stop.outcome, job.holdsSpark], ["unknown", true]);
  assert.match(job.stop.message, /could not be reached/);
  open();
  await until(() => !m.snapshot(spark).job.holdsSpark, "the reconcile");
  assert.equal(m.snapshot(spark).job.state, "cancelled");
});

test("an administrator scan that lost contact is held until it has stopped by itself", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  const { m, open } = make({ now: () => now, scanError: new Error("ssh: reset") });
  m.startScan(spark, { sudo: true });
  open();
  await m.settled("s1");
  t.mock.timers.tick(5); // first reconcile: nothing to ask, wait for the limit
  await new Promise((r) => setImmediate(r));
  const { stopsByItselfAt } = m.snapshot(spark).job;
  assert.equal(m.snapshot(spark).job.holdsSpark, true);
  now = stopsByItselfAt + 1;
  t.mock.timers.tick(stopsByItselfAt - 1_000_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.snapshot(spark).job.holdsSpark, false);
});

test("at most two scans across the fleet; a change elsewhere does not count", async () => {
  const a = make();
  const { m } = a;
  m.startScan(spark, {});
  m.startScan(sparkB, {});
  assert.throws(() => m.startScan(sparkC, {}), (e) => e.status === 429 && e.code === "fleet-busy");
  await m.delete(sparkC, { path: "/home/me/x" });
  a.open();
  await m.settled("s1");
  await m.settled("s2");
  assert.equal(m.startScan(sparkC, {}).state, "running");
});

test("another dashboard holding the unit is reported, and this one's Spark is free again", async () => {
  const { m, open } = make({ scanAnswer: "RESULT=error\nCODE=unit-busy\nMSG=Another dashboard is using this Spark's storage\n" });
  m.startScan(spark, {});
  open();
  await m.settled("s1");
  const job = m.snapshot(spark).job;
  assert.deepEqual([job.state, job.error.code, job.holdsSpark], ["error", "unit-busy", false]);
});

test("changes take the unit lock; reads do not", async () => {
  const seen = [];
  const m = new StorageManager({ run: async (_s, program, o) => { seen.push([o.name, /sd_lock \d/.test(program)]); return o.name === "dockerList" ? "RESULT=ok\nIMAGES=ok\nCONTAINERS=ok\n" : "RESULT=ok\n"; }, holdMs: 0 });
  await m.delete(spark, { path: "/home/me/x" });
  await m.removeImages(spark, { ids: [`sha256:${"a".repeat(64)}`] });
  await m.removeContainers(spark, { ids: ["b".repeat(64)] });
  await m.docker(spark, {});
  const byName = Object.fromEntries(seen);
  assert.deepEqual(
    [byName.delete, byName.dockerRemove, byName.dockerRemoveContainers, byName.dockerList],
    [true, true, true, false]
  );
});

test("parseJobOutput never reads an odd answer as stopped", () => {
  assert.deepEqual(parseJobOutput("cancel", CANCEL("terminated")), { ok: true, outcome: "terminated", reason: "term", lock: "free" });
  assert.equal(parseJobOutput("cancel", "RESULT=ok\nOUTCOME=yes\n").outcome, "unknown");
  assert.equal(parseJobOutput("cancel", "RESULT=ok\nOUTCOME=terminated\nREASON=$(rm)\nLOCK=maybe\n").reason, "unknown");
  assert.equal(parseJobOutput("cancel", "RESULT=ok\nOUTCOME=terminated\nLOCK=maybe\n").lock, "unknown");
  assert.equal(parseJobOutput("status", "RESULT=ok\nSTATE=done\n").state, "unknown");
  assert.equal(parseJobOutput("status", "garbage").code, "bad-output");
  assert.equal(parseJobOutput("status", "RESULT=error\nCODE=no-state\nMSG=x\n").code, "no-state");
});
