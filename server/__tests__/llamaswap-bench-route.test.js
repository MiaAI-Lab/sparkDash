import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

/** Minimal llama-swap: read-only state endpoints, and a chat endpoint that records what it was asked for. */
function fakeLlamaSwap(state) {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let model = null;
        try {
          model = JSON.parse(raw).model ?? null;
        } catch {}
        state.posts.push({ path: url.pathname, model });
        json({ error: "test fake does not generate" }, 500);
      });
      return;
    }
    if (url.pathname === "/v1/models") {
      return json({
        data: [
          { id: "audio/first-listed", owned_by: "llama-swap" },
          { id: "chat/loaded", owned_by: "llama-swap", context_length: 8192 },
        ],
      });
    }
    if (url.pathname === "/running") return json({ running: state.running });
    if (url.pathname === "/api/version") return json({ version: "v265" });
    if (url.pathname === "/api/metrics/activity") return json({ data: [] });
    return json({}, 404);
  });
}

test("benches on a llama-swap port never name a model that is not loaded", { timeout: 60000 }, async (t) => {
  const state = { running: [], posts: [] };
  const swap = fakeLlamaSwap(state);
  const swapPort = await listening(swap);
  t.after(() => {
    swap.closeAllConnections();
    swap.close();
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-llamaswap-"));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(
    sparksPath,
    JSON.stringify({ sparks: [{ id: "unit", name: "unit", isLocal: true, lanIp: "127.0.0.1", llmPorts: [swapPort] }] }) + "\n"
  );
  const reservation = createServer();
  const port = await listening(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...isolatedConfigEnv(tmp), PORT: String(port), BIND_HOST: "127.0.0.1", SPARKS_JSON_PATH: sparksPath, SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 15000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("isolated dashboard exited before startup"));
    });
    child.stdout.on("data", (data) => {
      if (String(data).includes("server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const post = (route, body) =>
    fetch(`${base}/api/sparks/unit/llm/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: swapPort, ...body }),
    });

  // Straight after start the monitor may not have classified the port yet: the route asks the port itself.
  let res = await post("bench", { concurrencies: [1], maxTokens: 64 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /No model is loaded/);

  // Wait until the probe has classified the port as llama-swap.
  for (let i = 0; i < 40; i++) {
    const snap = await (await fetch(`${base}/api/sparks/unit/metrics`)).json();
    if (snap?.metrics?.llm?.[0]?.backend === "llama-swap") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  for (const route of ["bench", "prefill-bench", "quality-bench"]) {
    res = await post(route, { concurrencies: [1], maxTokens: 64, contextSizes: [1024], categories: ["gsm8k"] });
    assert.equal(res.status, 409, `${route} with nothing loaded`);
  }
  state.running = [{ model: "chat/loaded", state: "ready", proxy: `http://127.0.0.1:${swapPort}` }];
  res = await post("bench", { concurrencies: [1], maxTokens: 64, modelId: "audio/first-listed" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /audio\/first-listed is not loaded/);
  assert.deepEqual(state.posts, [], "a refused bench sends nothing to llama-swap");

  // With a model loaded, an unnamed bench targets that model, not the first listed one.
  res = await post("bench", { concurrencies: [1], maxTokens: 64 });
  assert.equal(res.status, 202, await res.clone().text());
  const job = await res.json();
  assert.equal(job.config.modelId, "chat/loaded");
  for (let i = 0; i < 40 && state.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(state.posts.length > 0, "the bench reached llama-swap");
  for (const p of state.posts) assert.equal(p.model, "chat/loaded");
});
