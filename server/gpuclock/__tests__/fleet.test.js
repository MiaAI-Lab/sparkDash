import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerGpuClockFleetRoute } from "../routes.js";
import { GpuClockManager } from "../GpuClockManager.js";

async function withApp({ run, allow = () => true }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  registerGpuClockFleetRoute(app, {
    manager: new GpuClockManager({ run }),
    registry: {
      sparks: [
        { id: "s1", name: "S1", kind: "spark" },
        { id: "s2", name: "S2", kind: "spark" },
        { id: "h1", name: "H1", kind: "host" },
      ],
    },
    recordEvent: (e) => events.push(e),
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("fleet cap applies to every spark, reports the hosts it leaves alone, and records one event per unit", async () => {
  const seen = [];
  // One Spark takes the boot service, the other keeps it with its own @reboot
  // job: the report carries which hook each took, not just "kept".
  await withApp({ run: async (spark) => { seen.push(spark.id); return `RESULT=ok\nCAP=2000\nPERSIST=1\nPERSIST_KIND=${spark.id === "s2" ? "cron" : "unit"}`; } }, async (base, events) => {
    const res = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 2000, persist: true }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.results, [
      { id: "s1", ok: true, capMHz: 2000, persistKind: "unit" },
      { id: "s2", ok: true, capMHz: 2000, persistKind: "cron" },
      { id: "h1", ok: true, supported: false, reason: "GPU clock caps are only supported on Spark units" },
    ]);
    // The batch never runs on a host.
    assert.deepEqual(seen, ["s1", "s2"]);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === "gpu.clock.set" && e.sparkId.startsWith("s")));
    assert.match(events.find((e) => e.sparkId === "s1").message, /kept after reboot by the boot service/);
    assert.match(events.find((e) => e.sparkId === "s2").message, /kept after reboot by the @reboot cron job/);
  });
});

test("fleet reset clears every cap and reports the hosts it leaves alone", async () => {
  await withApp({ run: async () => "RESULT=ok" }, async (base, events) => {
    const res = await fetch(`${base}/gpu-clock-all`, json("POST", { reset: true }));
    const body = await res.json();
    assert.deepEqual(body.results, [
      { id: "s1", ok: true, capMHz: null, persistKind: "none" },
      { id: "s2", ok: true, capMHz: null, persistKind: "none" },
      { id: "h1", ok: true, supported: false, reason: "GPU clock caps are only supported on Spark units" },
    ]);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === "gpu.clock.reset"));
  });
});

test("body validation: exactly one of maxMHz / reset", async () => {
  await withApp({ run: async () => "RESULT=ok" }, async (base) => {
    const both = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 2000, reset: true }));
    assert.equal(both.status, 400);
    const neither = await fetch(`${base}/gpu-clock-all`, json("POST", {}));
    assert.equal(neither.status, 400);
    const bad = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: "2000" }));
    assert.equal(bad.status, 400);
    const low = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 200 }));
    assert.equal(low.status, 400);
    const high = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 12000 }));
    assert.equal(high.status, 400);
  });
});

test("a unit without a GPU is a normal result, other failures are per-unit errors", async () => {
  const run = async (spark) => spark.id === "s1" ? "RESULT=error\nCODE=no-nvidia\nMSG=nvidia-smi was not found on this unit" : "RESULT=ok\nCAP=1800\nPERSIST=0";
  await withApp({ run }, async (base) => {
    const res = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 1800 }));
    const body = await res.json();
    // A skipped unit does not make the batch unsuccessful.
    assert.equal(body.success, true);
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].supported, false);
    assert.equal(body.results[1].ok, true);
    assert.equal(body.results[1].capMHz, 1800);
  });
  // Removing a cap is the same answer for a unit that never had one to give.
  await withApp({ run }, async (base) => {
    const res = await fetch(`${base}/gpu-clock-all`, json("POST", { reset: true }));
    const body = await res.json();
    assert.deepEqual(body.results, [
      { id: "s1", ok: true, supported: false, reason: "nvidia-smi was not found on this unit" },
      { id: "s2", ok: true, capMHz: null, persistKind: "none" },
      { id: "h1", ok: true, supported: false, reason: "GPU clock caps are only supported on Spark units" },
    ]);
  });
  // A GPU whose maximum clock cannot be read is not "skipped": something is wrong.
  await withApp({ run: async () => { throw Object.assign(new Error("could not read the GPU maximum clock"), { code: "no-gpu" }); } }, async (base) => {
    const body = await (await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 1800 }))).json();
    assert.equal(body.results[0].ok, false);
    assert.match(body.results[0].error, /maximum clock/);
    assert.equal(body.results[2].id, "h1");
  });
  await withApp({ run: async () => { throw Object.assign(new Error("ssh down"), { code: "no-sudo" }); } }, async (base) => {
    const res = await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 1800 }));
    const body = await res.json();
    assert.ok(body.results.filter((r) => r.id !== "h1").every((r) => r.ok === false && r.error));
    // Every unit failing is not a successful batch for an API client.
    assert.equal(body.success, false);
  });
});

test("rate-limited callers are refused before anything runs", async () => {
  let ran = 0;
  await withApp({ allow: () => false, run: async () => { ran += 1; return "RESULT=ok"; } }, async (base) => {
    assert.equal((await fetch(`${base}/gpu-clock-all`, json("POST", { maxMHz: 1800 }))).status, 429);
    assert.equal(ran, 0);
  });
});
