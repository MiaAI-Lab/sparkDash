// HTTP side of stopping scans and of admission: what the page is told.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";

const SCAN_OK = ["RESULT=ok\n100\td\t/", "@@RC=0", "@@UNREADABLE=0", ""].join("\0");
const sparks = Object.fromEntries(["s1", "s2", "s3"].map((id) => [id, { id, name: id.toUpperCase(), kind: "spark", ssh: { user: "me", host: `10.0.0.${id[1]}` } }]));

async function withApp(run, fn) {
  const app = express();
  app.use(express.json());
  const manager = new StorageManager({ run, holdMs: 0, reconcileMs: 5, stopGraceMs: 10, stopKillWaitMs: 10 });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => sparks[id] },
    recordEvent: () => {},
    allowRead: () => true,
    allowChange: () => true,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, manager);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

function gatedRun() {
  let open;
  const gate = new Promise((r) => { open = r; });
  const run = async (_s, _p, o) => {
    if (o.name === "job") return "RESULT=ok\nOUTCOME=terminated\nREASON=term\nLOCK=free\n";
    if (o.name === "scan") await gate;
    return o.name === "scan" ? SCAN_OK : "RESULT=ok\n";
  };
  return { run, open: () => open() };
}

test("DELETE /scan stops the scan on the unit; the Spark is busy until that is confirmed", async () => {
  const g = gatedRun();
  await withApp(g.run, async (base, manager) => {
    const started = await (await fetch(`${base}/s1/storage/scan`, json("POST", { path: "/" }))).json();
    assert.deepEqual([started.job.state, started.job.cancellable, started.job.holdsSpark], ["running", true, true]);
    const stop = await fetch(`${base}/s1/storage/scan`, json("DELETE"));
    assert.equal(stop.status, 200);
    const body = await stop.json();
    assert.deepEqual([body.job.state, body.job.stop.outcome], ["stopping", "pending"]);
    g.open(); // the stopped program's late answer is ignored
    await manager.settled("s1");
    const after = await (await fetch(`${base}/s1/storage/scan`)).json();
    assert.deepEqual([after.job.state, after.job.stop.outcome, after.job.holdsSpark], ["cancelled", "terminated", false]);
    assert.equal(after.session, null);
  });
});

test("an administrator scan cannot be stopped: 409 not-cancellable, with when it stops by itself", async () => {
  const g = gatedRun();
  await withApp(g.run, async (base) => {
    const started = await (await fetch(`${base}/s1/storage/scan`, json("POST", { path: "/", sudo: true }))).json();
    assert.equal(started.job.cancellable, false);
    assert.equal(typeof started.job.stopsByItselfAt, "number");
    const stop = await fetch(`${base}/s1/storage/scan`, json("DELETE"));
    assert.equal(stop.status, 409);
    const body = await stop.json();
    assert.equal(body.code, "not-cancellable");
    assert.match(body.error, /stops it by itself within \d+ minutes?/);
    // A change on that Spark waits for the scan.
    const del = await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/x" }));
    assert.deepEqual([del.status, (await del.json()).code], [409, "scan-running"]);
    g.open();
  });
});

test("a third scan across the fleet is refused with a try-later code", async () => {
  const g = gatedRun();
  await withApp(g.run, async (base) => {
    for (const id of ["s1", "s2"]) assert.equal((await fetch(`${base}/${id}/storage/scan`, json("POST", {}))).status, 202);
    const third = await fetch(`${base}/s3/storage/scan`, json("POST", {}));
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.code, "fleet-busy");
    assert.match(body.error, /Try again/);
    g.open();
  });
});
