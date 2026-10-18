/**
 * GET /api/sparks/:id/llm/quality-bench: `port` picks the endpoint of the current
 * run view, `historyPort` (a port or "all") scopes the saved-run list on its own,
 * so runs from other ports on the same unit stay reachable for comparison.
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
  config: { port, modelId: `m${port}`, label: "" },
  results: { overallPct: 50, categories: {}, items: [] },
});

test("quality bench history can be listed for all ports or one, independent of `port`", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-quality-history-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(path.join(tmp, "sparks.json"), '{"sparks":[]}\n');
  const historyPath = path.join(tmp, "quality_bench_history_path.json");
  await writeFile(historyPath, JSON.stringify({ alpha: [job("a", 8888), job("b", 18891), job("c", 8888), job("d", 8000)] }));
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

  const ids = async (query) => {
    const res = await fetch(`${base}/api/sparks/alpha/llm/quality-bench${query}`);
    assert.equal(res.status, 200);
    return (await res.json()).history.map((h) => h.benchId).sort();
  };
  // Unchanged: without historyPort the list still follows `port`.
  assert.deepEqual(await ids("?port=18891"), ["b"]);
  assert.deepEqual(await ids(""), ["a", "b", "c", "d"]);
  // The endpoint selected for a new run no longer hides other ports' runs.
  assert.deepEqual(await ids("?port=18891&historyPort=all"), ["a", "b", "c", "d"]);
  assert.deepEqual(await ids("?port=18891&historyPort=8888"), ["a", "c"]);
  assert.equal((await fetch(`${base}/api/sparks/alpha/llm/quality-bench?historyPort=nope`)).status, 400);
});
