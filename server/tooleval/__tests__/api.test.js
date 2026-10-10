import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { installFakeTool } from "./fakeTool.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-te-"));
  fs.writeFileSync(path.join(tmp, "sparks.json"), "[]\n");
  installFakeTool(tmp);
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      HOME: tmp,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      LLM_TOKEN_JSON_PATH: path.join(tmp, "llm-tokens.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
      FLEET_ENERGY_MONTHLY_JSON_PATH: path.join(tmp, "fleet-energy-monthly.json"),
      EVENTS_JSON_PATH: path.join(tmp, "events.json"),
      GPU_HISTORY_JSON_PATH: path.join(tmp, "gpu-history.json"),
      LLM_LAUNCHERS_JSON_PATH: path.join(tmp, "llm-launchers.json"),
      TOOL_EVAL_RUNS_PATH: path.join(tmp, "tool-eval-runs.json"),
      TOOL_EVAL_RESULTS_DIR: path.join(tmp, "tool-eval-results"),
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

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("timed out");
}

test("Tool Eval over HTTP: spec, status, preview, validation, a streamed run, its result, and delete", async (t) => {
  const { port } = await startServer(t);
  const created = await api(port, "/api/sparks", {
    method: "POST",
    body: JSON.stringify({ id: "alpha", name: "alpha", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: os.userInfo().username, auth: "key" } }),
  });
  assert.equal(created.status, 200);
  const base = "/api/sparks/alpha/tool-eval";

  const spec = await api(port, "/api/tool-eval/spec");
  assert.ok(spec.body.args.length > 70);
  assert.ok(spec.body.types["tool-eval"] && spec.body.types.throughput);
  assert.ok(spec.body.groups.some((g) => g.id === "throughput"));

  assert.equal((await api(port, "/api/sparks/nope/tool-eval/status")).status, 404);
  const status = await api(port, `${base}/status`);
  assert.equal(status.body.installed, true);
  assert.match(status.body.version, /9\.9\.9/);

  const cmd = await api(port, `${base}/install-command?extras=perf`);
  assert.match(cmd.body.command, /tool-eval-bench\[perf\]/);

  // Validation errors come back as 400 with readable messages.
  const bad = await api(port, `${base}/runs`, { method: "POST", body: JSON.stringify({ type: "tool-eval", options: { seed: "abc", temperature: 9 } }) });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.length >= 2);
  assert.equal((await api(port, `${base}/runs`, { method: "POST", body: JSON.stringify({ type: "nonsense", options: {} }) })).status, 400);
  assert.equal((await api(port, `${base}/runs`, { method: "POST", body: JSON.stringify({ type: "tool-eval", options: { extra: ["--json-file", "/x"] } }) })).status, 400);

  // Preview shows the exact command and can ask the tool for a dry run.
  const prev = await api(port, `${base}/preview`, {
    method: "POST",
    body: JSON.stringify({ type: "tool-eval", options: { short: true, "api-key": "sk-NOPE" }, dryRun: true }),
  });
  assert.equal(prev.status, 200);
  assert.match(prev.body.command, /--short/);
  assert.ok(!JSON.stringify(prev.body).includes("sk-NOPE"));
  assert.match(prev.body.dryRun.output, /TC-01/);
  assert.equal(prev.body.usesSavedKey, false, "a key typed by hand is not a saved key");

  const probe = await api(port, `${base}/probe`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(probe.body.ok, true);

  // A real run.
  const start = await api(port, `${base}/runs`, {
    method: "POST",
    body: JSON.stringify({ type: "tool-eval", options: { short: true, label: "ci", "api-key": "sk-XYZ" } }),
  });
  assert.equal(start.status, 202);
  const rid = start.body.run.id;
  assert.ok(!JSON.stringify(start.body).includes("sk-XYZ"), "secrets are never echoed");
  assert.equal(start.body.run.status, "running");

  const busy = await api(port, `${base}/runs`, { method: "POST", body: JSON.stringify({ type: "tool-eval", options: {} }) });
  assert.equal(busy.status, 409);

  let sawProgress = false;
  const done = await until(async () => {
    const s = await api(port, `${base}/runs/${rid}/stream?lineSince=0&eventSince=0`);
    if (s.body.live?.progress?.done > 0) sawProgress = true;
    return s.body.live?.job?.status === "completed" ? s.body : null;
  });
  assert.equal(sawProgress, true, "progress was visible while running");
  assert.deepEqual(done.live.progress.counts, { pass: 1, partial: 1, fail: 1, other: 0 });
  assert.ok(done.live.lines.some((l) => l.text === "got-key:6"));

  const fin = await until(async () => {
    const r = await api(port, `${base}/runs/${rid}`);
    return r.body.run.summary ? r.body.run : null;
  });
  assert.equal(fin.status, "completed");
  assert.equal(fin.summary.finalScore, 50);
  assert.ok(!JSON.stringify(fin).includes("sk-XYZ"));

  const result = await api(port, `${base}/runs/${rid}/result`);
  assert.equal(result.body.result.final_score, 50);
  assert.equal(result.body.result.config.label, "ci");

  const list = await api(port, `${base}/runs?type=tool-eval`);
  assert.equal(list.body.runs.length, 1);
  assert.equal((await api(port, `${base}/runs?type=throughput`)).body.runs.length, 0);

  const events = await api(port, "/api/events?limit=20");
  assert.ok(events.body.events.some((e) => e.type === "tooleval.run.completed"));

  assert.equal((await api(port, `${base}/runs/${rid}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(port, `${base}/runs/${rid}`)).status, 404);
  assert.equal((await api(port, `${base}/runs/not-a-run-id`)).status, 404);
});
