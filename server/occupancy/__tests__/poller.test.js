import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-poller-"));
const helpersFile = path.join(root, "helpers.json");
process.env.OCCUPANCY_HELPERS_JSON_PATH = helpersFile;
process.env.SPARKS_SECRETS_PATH = path.join(root, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(root, ".secrets-key");
process.env.SPARKDASH_SECRETS_KEY = "poller-test-key";
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { createOccupancyPoller } = await import("../poller.js");
const { saveHelperTokens } = await import("../../secretsStore.js");

function writeHelpers(helpers) {
  fs.writeFileSync(helpersFile, JSON.stringify({ helpers }));
}

const goodRow = {
  harness: "opencode",
  sessionId: "s",
  title: "Kept",
  cwd: "",
  updatedAt: new Date().toISOString(),
  activity: "unknown",
  activityProvenance: "none",
};

function payload(rows, coverage = "supported") {
  return {
    schemaVersion: 1,
    observedAt: 10,
    stale: false,
    adapters: { opencode: { coverage, stale: false, rows: rows.length, error: null } },
    rows,
  };
}

describe("occupancy poller", { concurrency: 1 }, () => {
  test("a failed refresh keeps the last good rows and an empty success replaces them", async () => {
    writeHelpers([{ id: "mac", enabled: true, url: "http://127.0.0.1/occupancy", harnesses: ["opencode"], routes: [] }]);
    let mode = "good";
    const poller = createOccupancyPoller({
      fetchImpl: async () => {
        if (mode === "good") return payload([goodRow], "partial");
        if (mode === "empty") return payload([]);
        throw new Error("down");
      },
      intervalMs: 5000,
    });
    await poller.tick();
    assert.equal(poller.caches().get("mac").rows.length, 1);
    assert.equal(poller.caches().get("mac").stale, false);
    assert.equal(poller.health().get("mac").coverage, "supported");
    assert.equal(poller.health().get("mac").adapters.opencode.coverage, "partial");

    mode = "down";
    await poller.tick();
    assert.equal(poller.caches().get("mac").rows.length, 1);
    assert.equal(poller.caches().get("mac").rows[0].title, "Kept");
    assert.equal(poller.caches().get("mac").stale, true);
    assert.equal(poller.health().get("mac").coverage, "partial");

    mode = "empty";
    await poller.tick();
    assert.equal(poller.caches().get("mac").rows.length, 0);
    assert.equal(poller.caches().get("mac").stale, false);
    assert.equal(poller.health().get("mac").coverage, "supported");
    await poller.stop();
  });

  test("the first failure does not invent an empty healthy list", async () => {
    writeHelpers([{ id: "mac", enabled: true, url: "http://127.0.0.1/occupancy", harnesses: ["opencode"], routes: [] }]);
    const poller = createOccupancyPoller({
      fetchImpl: async () => {
        throw new Error("down");
      },
      intervalMs: 5000,
    });
    await poller.tick();
    assert.equal(poller.caches().has("mac"), false);
    assert.equal(poller.health().get("mac").coverage, "unavailable");
    await poller.stop();
  });

  test("stop and reconfigure drop a late response", async () => {
    writeHelpers([{ id: "mac", enabled: true, url: "http://127.0.0.1/occupancy", harnesses: ["omp"], routes: [] }]);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const poller = createOccupancyPoller({ fetchImpl: () => gate, intervalMs: 5000 });
    const pending = poller.tick();
    await poller.stop();
    release(payload([goodRow]));
    await pending;
    assert.equal(poller.caches().size, 0);

    writeHelpers([{ id: "mac", enabled: true, url: "http://127.0.0.1/occupancy", harnesses: ["omp"], routes: [] }]);
    let releaseAgain;
    const again = new Promise((resolve) => {
      releaseAgain = resolve;
    });
    const restarted = createOccupancyPoller({ fetchImpl: () => again, intervalMs: 5000 });
    const inflight = restarted.tick();
    writeHelpers([]);
    restarted.reconfigure();
    releaseAgain(payload([goodRow]));
    await inflight;
    assert.equal(restarted.caches().size, 0);
    await restarted.stop();
  });

  test("each helper is fetched with its own token", async () => {
    writeHelpers([
      { id: "mac", enabled: true, url: "http://127.0.0.1/occupancy", harnesses: ["opencode"], routes: [] },
      { id: "other", enabled: true, url: "http://127.0.0.2/occupancy", harnesses: ["opencode"], routes: [] },
    ]);
    saveHelperTokens(new Map([["mac", "tok-a"], ["other", "tok-b"]]));
    const seen = [];
    const poller = createOccupancyPoller({
      fetchImpl: async (url, opts) => {
        seen.push({ url, token: opts.token });
        return payload([]);
      },
      intervalMs: 5000,
    });
    await poller.tick();
    assert.deepEqual(
      seen.map((item) => item.token).sort(),
      ["tok-a", "tok-b"]
    );
    assert.equal(seen.find((item) => item.url.includes("127.0.0.1")).token, "tok-a");
    await poller.stop();
  });
});
