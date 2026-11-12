// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

test("training route stays behind existing authentication, is GET-only, and exposes a read-only capability", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "training-route-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "synthetic-training-route-token";
  for (const enabled of [false, true]) {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const env = isolatedConfigEnv(dir);
    await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
    const child = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, ...env, PORT: String(port), BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: token,
        SPARKDASH_ALLOW_OPEN_REMOTE: "0", TRAINING_PROGRESS_ENABLED: enabled ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (value) => { output += value; });
    child.stderr.on("data", (value) => { output += value; });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(output);
        if (output.includes("server listening")) { ready = true; break; }
        await delay(20);
      }
      assert.ok(ready, output);
      const url = `http://127.0.0.1:${port}`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      assert.equal((await fetch(`${url}/api/training-progress`)).status, 401);
      const response = await fetch(`${url}/api/training-progress`, { headers });
      assert.equal(response.status, enabled ? 200 : 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (enabled) assert.deepEqual(await response.json(), { enabled: true, runs: [], units: [], truncated: false, error: null });
      const settings = await (await fetch(`${url}/api/settings`, { headers })).json();
      assert.equal(settings.trainingProgressEnabled, enabled);
      const saved = await (await fetch(`${url}/api/settings`, { method: "PUT", headers,
        body: JSON.stringify({ autoHideOffline: true, trainingProgressEnabled: !enabled }) })).json();
      assert.equal(saved.trainingProgressEnabled, enabled, "Settings cannot alter the environment capability");
      assert.equal((await fetch(`${url}/api/training-progress`, { method: "POST", headers, body: "{}" })).status, 404);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }
});
