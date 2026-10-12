import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("optional activity route respects dashboard auth, private-source isolation and server-only configuration", { timeout: 30000 }, async (t) => {
  let sourceReads = 0;
  const source = createServer((req, res) => {
    sourceReads += 1;
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      available: true, generatedAt: new Date().toISOString(),
      active: [
        { principal: "service-a", model: "model-a", count: 300, oldestAgeMs: 200, newestAgeMs: 100, prompt: "private-prompt" },
        { principal: "service-a", model: "model-a", count: 7, oldestAgeMs: 500, newestAgeMs: 400 },
      ],
      recent: [], headers: "private-header", key: "private-key",
    }));
  });
  const sourcePort = await listening(source);
  t.after(() => { source.closeAllConnections(); source.close(); });
  for (const enabled of [false, true]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-activity-"));
    const sparksPath = path.join(tmp, "sparks.json");
    await writeFile(sparksPath, '{"sparks":[]}\n');
    const reservation = createServer();
    const port = await listening(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env, ...isolatedConfigEnv(tmp), PORT: String(port), BIND_HOST: "0.0.0.0",
        SPARKS_JSON_PATH: sparksPath, SPARKDASH_TOKEN: "dashboard-test-token",
        SPARKDASH_INFERENCE_ACTIVITY_URL: enabled ? `http://127.0.0.1:${sourcePort}/activity` : "",
        SPARKDASH_INFERENCE_ACTIVITY_LABELS: "service-a",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        // Cold imports over Windows/Docker bind mounts need a bounded startup allowance.
        const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 10000);
        child.once("exit", () => { clearTimeout(timer); reject(new Error("isolated dashboard exited before startup")); });
        child.stdout.on("data", (data) => {
          if (String(data).includes("server listening")) { clearTimeout(timer); resolve(); }
        });
      });
      const base = `http://127.0.0.1:${port}`;
      const headers = { Authorization: "Bearer dashboard-test-token" };
      assert.equal((await fetch(`${base}/api/inference/activity`)).status, 401);
      assert.equal((await fetch(`${base}/api/inference/activity`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      const response = await fetch(`${base}/api/inference/activity`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.enabled, enabled);
      assert.equal(body.available, enabled);
      assert.equal(body.active.length, enabled ? 1 : 0);
      if (enabled) {
        const { principal, model, count, oldestAgeMs, newestAgeMs } = body.active[0];
        assert.deepEqual({ principal, model, count }, { principal: "service-a", model: "model-a", count: 307 });
        assert.ok(oldestAgeMs >= 500 && newestAgeMs >= 100);
        assert.equal(oldestAgeMs - newestAgeMs, 400);
      }
      assert.doesNotMatch(JSON.stringify(body), /private-|http:\/\/|dashboard-test-token/);
      const settings = await (await fetch(`${base}/api/settings`, { headers })).json();
      assert.equal(settings.inferenceActivityEnabled, enabled);
      const put = await (await fetch(`${base}/api/settings`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ inferenceActivityEnabled: !enabled, SPARKDASH_INFERENCE_ACTIVITY_URL: "http://8.8.8.8" }),
      })).json();
      assert.equal(put.inferenceActivityEnabled, enabled);
      assert.equal(sourceReads, enabled ? 1 : 0);
    } finally {
      if (child.exitCode == null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  }
});
