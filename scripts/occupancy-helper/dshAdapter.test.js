import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDsh, mapDshSession } from "./dshAdapter.js";

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

test("an unreachable DSH web API is unavailable", async () => {
  const failed = await loadDsh({
    webUrl: "http://127.0.0.1:9",
    readProfiles: false,
    fetchFn: async () => { throw new Error("connect refused"); },
  });
  assert.equal(failed.coverage, "unavailable");
  assert.equal(failed.rows.length, 0);
  assert.match(failed.error, /connect refused/);
});

test("running is the only generating signal and a models failure keeps the session", async () => {
  const calls = [];
  const loaded = await loadDsh({
    webUrl: "http://127.0.0.1:3080",
    readProfiles: false,
    fetchFn: async (url) => {
      calls.push(url);
      if (String(url).endsWith("/api/session.list")) {
        return response({
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: "blank", blank: true },
                {
                  sessionId: "live",
                  running: true,
                  updatedAt: 1_700_000_000,
                  projections: { values: { title: "Live", contextPressure: { pressureTokens: 1200, contextWindow: 8000 } } },
                },
                { sessionId: "idle", running: false, updatedAt: 1_700_000_000_000 },
              ],
            },
          },
        });
      }
      return response({ result: { ok: false } }, true);
    },
  });
  assert.equal(loaded.coverage, "supported");
  assert.equal(loaded.rows.length, 2);
  const live = loaded.rows.find((row) => row.sessionId === "live");
  assert.equal(live.activity, "generating");
  assert.equal(live.activityProvenance, "native");
  assert.equal(live.contextUsed, 1200);
  assert.equal(live.updatedAt, new Date(1_700_000_000 * 1000).toISOString());
  const idle = loaded.rows.find((row) => row.sessionId === "idle");
  assert.equal(idle.activity, "unknown");
  assert.equal(idle.updatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(calls.some((url) => String(url).includes("session.models")), true);
});

test("a provider base URL becomes a native origin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-dsh-"));
  fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(
    path.join(dir, "work", "cordis.patch.yml"),
    "providers:\n  deepseek:\n    baseURL: http://10.0.0.8:8000/v1\n"
  );
  const row = mapDshSession(
    { sessionId: "s", running: false, updatedAt: 10, projections: { values: { title: "S" } } },
    { provider: "deepseek", model: "chat" },
    new Map([["deepseek", { host: "10.0.0.8", port: 8000 }]])
  );
  assert.equal(row.originProvenance, "native");
  assert.deepEqual(row.origin, { host: "10.0.0.8", port: 8000 });
  assert.equal(row.activity, "unknown");
  const loaded = loadDsh({ webUrl: "not a url", profileDir: dir });
  return loaded.then((result) => assert.equal(result.coverage, "unavailable"));
});
