/**
 * The fleet auto-mode routes expose controller state and validate server-side:
 * a non-boolean `enabled` or an out-of-range cap is a 400, and the enable /
 * disable round trip answers with the full status (thresholds, range, presets).
 * Runs the real server against an empty fleet (state is in-memory, no nodes).
 */
import assert from "node:assert/strict";
import { isolatedConfigEnv } from "./isolatedEnv.js";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForListening(output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes("server listening")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`server did not start:\n${output()}`);
}

async function startServer(t, { settings } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-clockcap-auto-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, '{"sparks":[]}\n');
  const env = isolatedConfigEnv(tmp);
  const settingsPath = env.SETTINGS_JSON_PATH;
  // Optional prewritten settings: used to prove the persisted fleet clock-cap
  // state is restored on boot.
  if (settings) await writeFile(settingsPath, JSON.stringify(settings) + "\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      ...env,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKS_JSON_PATH: sparksPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await waitForListening(() => output, 15_000);
  return { base: `http://127.0.0.1:${port}`, settingsPath };
}

test("GET /api/sparks/clock-cap/auto answers the default disabled state", async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/api/sparks/clock-cap/auto`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.enabled, false);
  assert.equal(body.holdTempC, 72);
  assert.equal(body.releaseTempC, 67);
  assert.deepEqual(body.range, { min: 1800, max: 2200 });
  assert.deepEqual(body.presets, [1800, 1900, 2000, 2100, 2200]);
  assert.deepEqual(body.sparks, []);
});

test("POST /api/sparks/clock-cap/auto rejects non-boolean enabled and out-of-range caps", async (t) => {
  const { base } = await startServer(t);
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }]) {
    const res = await fetch(`${base}/api/sparks/clock-cap/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
  }
  for (const capMhz of [1700, 2300, 2000.5, "abc"]) {
    const res = await fetch(`${base}/api/sparks/clock-cap/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, capMhz }),
    });
    assert.equal(res.status, 400, `capMhz ${String(capMhz)}`);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);
  }
});

test("POST /api/sparks/clock-cap/auto enables and disables the controller", async (t) => {
  const { base } = await startServer(t);

  const enable = await fetch(`${base}/api/sparks/clock-cap/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, capMhz: 2100 }),
  });
  assert.equal(enable.status, 200);
  const enabled = await enable.json();
  assert.equal(enabled.success, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.capMhz, 2100);

  // GET reflects the running state, not just the POST response.
  const check = await fetch(`${base}/api/sparks/clock-cap/auto`);
  assert.equal((await check.json()).enabled, true);

  const disable = await fetch(`${base}/api/sparks/clock-cap/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).enabled, false);
});

test("POST /api/sparks/clock-cap/auto persists the fleet state to config", async (t) => {
  const { base, settingsPath } = await startServer(t);

  const enable = await fetch(`${base}/api/sparks/clock-cap/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, capMhz: 2000 }),
  });
  assert.equal(enable.status, 200);

  // The persisted settings file carries the mode + cap, so a restart can
  // restore the toggle and hold cap.
  const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(persisted.fleetClockAutoEnabled, true);
  assert.equal(persisted.fleetClockAutoCapMhz, 2000);
  assert.deepEqual(persisted.clockCapTarget, { mode: "auto", mhz: 2000 });

  const disable = await fetch(`${base}/api/sparks/clock-cap/auto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200);
  const persistedOff = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(persistedOff.fleetClockAutoEnabled, false);
  assert.equal(persistedOff.clockCapTarget, null);
});

test("GET /api/sparks/clock-cap/auto answers the persisted state after a restart", async (t) => {
  const { base } = await startServer(t, {
    settings: { fleetClockAutoEnabled: true, fleetClockAutoCapMhz: 2000 },
  });
  const res = await fetch(`${base}/api/sparks/clock-cap/auto`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true, "the saved Auto toggle must be restored on boot");
  assert.equal(body.capMhz, 2000, "the saved hold cap must be restored on boot");
});
