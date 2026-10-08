import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
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

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-launch-"));
  fs.writeFileSync(path.join(tmp, "sparks.json"), "[]\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      HOME: tmp, // the launcher log directory lives under $HOME on the (local) Spark
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      GPU_HISTORY_JSON_PATH: path.join(tmp, "gpu-history.json"),
      LLM_LAUNCHERS_JSON_PATH: path.join(tmp, "llm-launchers.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 6_000)),
  ]);
  return { port, tmp };
}

async function api(port, pathname, init) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("timed out");
}

function script(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

test("register, start, stream, stop and remove an LLM through the HTTP API", async (t) => {
  const { port, tmp } = await startServer(t);
  const created = await api(port, "/api/sparks", {
    method: "POST",
    body: JSON.stringify({ id: "alpha", name: "alpha", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: "spark", auth: "key" } }),
  });
  assert.equal(created.status, 200);

  const base = "/api/sparks/alpha/llm-launchers";
  assert.equal((await api(port, "/api/sparks/nope/llm-launchers")).status, 404);
  assert.equal((await api(port, base, { method: "POST", body: JSON.stringify({ name: "x", dir: "relative" }) })).status, 400);
  assert.equal((await api(port, base, { method: "POST", body: JSON.stringify({ name: "x", dir: "/a;rm -rf /" }) })).status, 400);

  const llm = path.join(tmp, "glm");
  script(llm, "start.sh", 'echo "loading"; sleep 1; echo "ready"');
  script(llm, "stop.sh", 'echo "stopped it"');
  const add = await api(port, base, { method: "POST", body: JSON.stringify({ name: "GLM 5.3", dir: llm, port: 8888 }) });
  assert.equal(add.status, 201);
  const lid = add.body.launcher.id;
  assert.equal(lid, "glm-5-3");

  const listed = await api(port, `${base}?status=1`);
  assert.equal(listed.body.launchers.length, 1);
  assert.equal(listed.body.statuses[lid], "stopped");

  const start = await api(port, `${base}/${lid}/start`, { method: "POST" });
  assert.equal(start.status, 202);
  const jobId = start.body.job.id;

  const done = await until(async () => {
    const r = await api(port, `${base}/jobs/${jobId}?since=0`);
    return r.body.job?.status === "completed" ? r.body : null;
  });
  const texts = done.lines.map((l) => l.text);
  assert.ok(texts.includes("loading") && texts.includes("ready"), texts.join("|"));
  assert.equal(done.job.exitCode, 0);

  const stop = await api(port, `${base}/${lid}/stop`, { method: "POST" });
  assert.equal(stop.status, 202);
  const stopped = await until(async () => {
    const r = await api(port, `${base}/jobs/${stop.body.job.id}?since=0`);
    return r.body.job?.status === "completed" ? r.body : null;
  });
  assert.ok(stopped.lines.some((l) => l.text === "stopped it"));
  assert.equal((await api(port, `${base}/jobs/${jobId}`)).status, 404, "an older job is replaced by the newest");

  const upd = await api(port, `${base}/${lid}`, { method: "PUT", body: JSON.stringify({ name: "GLM", port: 9000 }) });
  assert.equal(upd.body.launcher.name, "GLM");
  assert.equal(upd.body.launcher.port, 9000);

  const events = await api(port, "/api/events?limit=50");
  assert.ok(events.body.events.some((e) => e.type === "llm.start.completed"));

  assert.equal((await api(port, `${base}/${lid}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(port, base)).body.launchers.length, 0);
  assert.equal((await api(port, `${base}/${lid}/start`, { method: "POST" })).status, 404);
});
