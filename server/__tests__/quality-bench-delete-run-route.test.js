/**
 * DELETE /api/sparks/:id/llm/quality-bench/history/:benchId removes one saved run and
 * keeps the rest; the cancel route no longer answers 200 for a run that already ended.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const job = (benchId, port) => ({
  benchId,
  sparkId: "alpha",
  status: "completed",
  startedAt: 1_780_000_000_000 + port,
  completedAt: 1_780_000_060_000,
  config: { port, modelId: `m${port}`, label: "" },
  progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: 0, total: 0, message: "Done" },
  results: { overallPct: 50, categories: {}, items: [] },
});

test("one saved run can be deleted without touching the rest of the history", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-quality-delete-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(path.join(tmp, "sparks.json"), '{"sparks":[]}\n');
  const historyPath = path.join(tmp, "quality_bench_history_path.json");
  await writeFile(historyPath, JSON.stringify({ alpha: [job("a", 8888), job("b", 18891), job("c", 8888)] }));
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      ...isolatedConfigEnv(tmp),
      QUALITY_BENCH_HISTORY_PATH: historyPath,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      HOME: tmp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    const check = () => (output.includes("server listening") ? (clearTimeout(timer), resolve()) : setTimeout(check, 10));
    check();
  });

  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/sparks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "alpha", name: "alpha", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: os.userInfo().username, auth: "key" } }),
  });
  assert.equal(created.status, 200);

  const ids = async () => {
    const res = await fetch(`${base}/api/sparks/alpha/llm/quality-bench?historyPort=all`);
    assert.equal(res.status, 200);
    return (await res.json()).history.map((h) => h.benchId).sort();
  };
  assert.deepEqual(await ids(), ["a", "b", "c"]);

  const deleted = await fetch(`${base}/api/sparks/alpha/llm/quality-bench/history/b`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { success: true });
  assert.deepEqual(await ids(), ["a", "c"]);
  // The deleted run is gone for good, not just hidden from the list.
  assert.equal((await fetch(`${base}/api/sparks/alpha/llm/quality-bench/b`)).status, 404);
  assert.equal((await fetch(`${base}/api/sparks/alpha/llm/quality-bench/history/b`, { method: "DELETE" })).status, 404);
  assert.equal((await fetch(`${base}/api/sparks/nope/llm/quality-bench/history/a`, { method: "DELETE" })).status, 404);

  // Cancelling only applies to a run in flight: a finished one is refused instead of
  // answering 200 with its own record while nothing changes.
  const cancelFinished = await fetch(`${base}/api/sparks/alpha/llm/quality-bench/c`, { method: "DELETE" });
  assert.equal(cancelFinished.status, 409);
  assert.match((await cancelFinished.json()).error, /already finished/i);
  assert.deepEqual(await ids(), ["a", "c"]);
});
