import test, { describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sources-"));
const secretsDir = path.join(root, "secrets");
const helpersDir = path.join(root, "helpers");
fs.mkdirSync(secretsDir);
fs.mkdirSync(helpersDir);
process.env.SPARKS_SECRETS_PATH = path.join(secretsDir, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(secretsDir, ".secrets-key");
process.env.SPARKDASH_SECRETS_KEY = "sources-test-key";
process.env.OCCUPANCY_HELPERS_JSON_PATH = path.join(helpersDir, "helpers.json");
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");
delete process.env.SPARKDASH_TOKEN;

const { replaceHelpers, publicHelpers, loadHelpers, removeHelper } = await import("../sources.js");
const { loadHelperTokens } = await import("../../secretsStore.js");
const { registerOccupancyRoutes } = await import("../routes.js");
const { createAuthMiddleware } = await import("../../auth.js");
const { fetchHelper } = await import("../policy.js");

const sparks = [{ id: "mama", name: "mama", llmPorts: [8000] }];

function helperBody(extra = {}) {
  return {
    id: "mac",
    label: "Mac",
    url: "http://127.0.0.1:8791/occupancy",
    enabled: true,
    harnesses: ["opencode"],
    routes: [{ harness: "opencode", sparkId: "mama", port: 8000, cwdPrefix: "/work" }],
    ...extra,
  };
}

describe("helper config and routes", { concurrency: 1 }, () => {
  test("tokens stay out of the config file and a new origin clears the old token", () => {
    const saved = replaceHelpers([helperBody({ token: "secret-token" })], { sparks });
    assert.equal(saved[0].hasToken, true);
    assert.equal(JSON.stringify(loadHelpers()).includes("secret-token"), false);
    const onDisk = fs.readFileSync(process.env.OCCUPANCY_HELPERS_JSON_PATH, "utf8");
    assert.equal(onDisk.includes("secret-token"), false);
    assert.equal(loadHelperTokens().get("mac"), "secret-token");

    const kept = replaceHelpers([helperBody()], { sparks });
    assert.equal(kept[0].hasToken, true);

    const cleared = replaceHelpers([helperBody({ url: "http://127.0.0.1:8792/occupancy" })], { sparks });
    assert.equal(cleared[0].hasToken, false);
    assert.equal(loadHelperTokens().has("mac"), false);

    replaceHelpers([helperBody({ url: "http://127.0.0.1:8792/occupancy", token: "next" })], { sparks });
    const removed = removeHelper("mac");
    assert.equal(removed.length, 0);
    assert.equal(loadHelperTokens().has("mac"), false);
  });

  test("a config write failure rolls the token write back", () => {
    replaceHelpers([helperBody({ token: "kept" })], { sparks });
    const helpersBefore = fs.readFileSync(process.env.OCCUPANCY_HELPERS_JSON_PATH);
    fs.chmodSync(helpersDir, 0o500);
    try {
      assert.throws(
        () => replaceHelpers([helperBody({ token: "rotated" })], { sparks }),
        /Failed to write/
      );
    } finally {
      fs.chmodSync(helpersDir, 0o700);
    }
    assert.equal(loadHelperTokens().get("mac"), "kept");
    assert.deepEqual(fs.readFileSync(process.env.OCCUPANCY_HELPERS_JSON_PATH), helpersBefore);
    assert.equal(publicHelpers()[0].hasToken, true);
  });

  test("routes must name an enabled harness and a configured Spark port", () => {
    assert.throws(
      () => replaceHelpers([helperBody({ routes: [{ harness: "hermes", sparkId: "mama", port: 8000 }] })], { sparks }),
      /not enabled/
    );
    assert.throws(
      () => replaceHelpers([helperBody({ routes: [{ harness: "opencode", sparkId: "missing", port: 8000 }] })], { sparks }),
      /does not exist/
    );
    assert.throws(
      () => replaceHelpers([helperBody({ routes: [{ harness: "opencode", sparkId: "mama", port: 1 }] })], { sparks }),
      /not configured/
    );
    assert.throws(() => replaceHelpers([helperBody({ url: "http://user:pw@127.0.0.1/occupancy" })], { sparks }), /userinfo/);
  });

  test("dashboard auth allows a loopback read and denies a mutation without the token", async () => {
    process.env.SPARKDASH_TOKEN = "dashboard-token";
    process.env.BIND_HOST = "127.0.0.1";
    const app = express();
    app.use(express.json());
    app.use(createAuthMiddleware());
    registerOccupancyRoutes(app, {
      poller: { health: () => new Map(), reconfigure() {} },
      listSparks: () => sparks,
      fetchImpl: fetchHelper,
    });
    const open = await request(app, "GET", "/api/occupancy/helpers");
    assert.equal(open.status, 200);
    const denied = await request(app, "POST", "/api/occupancy/helpers/check", { url: "http://127.0.0.1/occupancy" });
    assert.equal(denied.status, 401);
    const allowed = await request(
      app,
      "POST",
      "/api/occupancy/helpers/check",
      { url: "http://user:pw@127.0.0.1/occupancy" },
      { authorization: "Bearer dashboard-token" }
    );
    assert.equal(allowed.status, 400);
    assert.match(allowed.body.error, /userinfo/);
    delete process.env.SPARKDASH_TOKEN;
  });

  test("a check returns coverage and a row count, never session titles", async () => {
    const app = express();
    app.use(express.json());
    let fetches = 0;
    registerOccupancyRoutes(app, {
      poller: {
        health: () => new Map([["mac", { coverage: "supported", error: null, observedAt: 3, adapters: {} }]]),
        reconfigure() {},
      },
      listSparks: () => sparks,
      fetchImpl: async () => {
        fetches += 1;
        return {
          observedAt: 9,
          adapters: { opencode: { coverage: "supported", stale: false, rows: 1, error: null } },
          rows: [{ title: "SECRET-TITLE", sessionId: "s", cwd: "/secret" }],
        };
      },
    });
    const checked = await request(app, "POST", "/api/occupancy/helpers/check", {
      url: "http://127.0.0.1:8791/occupancy",
      token: "t",
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.rowCount, 1);
    assert.equal(checked.body.adapters.opencode.coverage, "supported");
    assert.equal(JSON.stringify(checked.body).includes("SECRET-TITLE"), false);
    assert.equal(JSON.stringify(checked.body).includes("/secret"), false);
    const health = await request(app, "GET", "/api/occupancy/health");
    assert.equal(health.body.helpers[0].id, "mac");
    assert.equal(health.body.helpers[0].coverage, "supported");

    const limited = [];
    for (let i = 0; i < 31; i += 1) {
      limited.push(await request(app, "POST", "/api/occupancy/helpers/check", { url: "http://127.0.0.1:8791/occupancy" }));
    }
    assert.equal(limited.filter((item) => item.status === 429).length >= 1, true);
    assert.equal(fetches <= 30, true);
  });
});

function request(app, method, urlPath, body, headers = {}) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: urlPath,
          method,
          headers: {
            host: "127.0.0.1",
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (body) req.end(JSON.stringify(body));
      else req.end();
    });
  });
}
