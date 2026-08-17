/**
 * Occupancy helper: projector-input JSON for sparkDash URL attach.
 * Run: node --test scripts/opencode-occupancy-helper/index.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createOccupancyHelper, loadOccupancy, publicOccupancyRow } from "./index.js";

const JOHN = {
  spark: { options: { baseURL: "http://john:8888/v1" } },
};

function sessionRow() {
  return {
    id: "ses_local",
    title: "spark occupancy",
    model: JSON.stringify({ id: "gpt-oss", providerID: "spark" }),
    time_updated: 1_700_000_000_000,
  };
}

function sessionColumns() {
  return ["id", "title", "model", "time_updated"].map((name, cid) => ({ cid, name, type: "TEXT" }));
}

function fakeDb(rows) {
  return {
    prepare(sql) {
      const text = String(sql);
      if (/table_info\s*\(\s*session\s*\)/i.test(text)) {
        return { all: () => sessionColumns() };
      }
      if (/\bfrom\s+session\b/i.test(text)) return { all: () => rows };
      throw new Error(`unexpected sql: ${text}`);
    },
    close() {},
  };
}

const localDeps = {
  conventionalStateDir: "/tmp/opencode-data",
  conventionalConfigDir: "/tmp/opencode-config",
  readFile: async (filePath) => {
    if (String(filePath).endsWith("opencode.json")) {
      return JSON.stringify({ provider: JOHN });
    }
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  },
  openDatabase: () => fakeDb([sessionRow()]),
};

test("helper maps a fixture db the same as local collect", async () => {
  const payload = await loadOccupancy(localDeps);
  assert.equal(payload.found, 1);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].handle, "spark occupancy");
  assert.equal(payload.rows[0].originHost, "john");
  assert.equal(payload.rows[0].originPort, 8888);
  assert.equal(payload.rows[0].midTurn, "unknown");
  assert.equal(payload.rows[0].source, "opencode");
});

test("missing db is 503, not an empty list", async () => {
  await assert.rejects(
    () =>
      loadOccupancy({
        conventionalStateDir: "/no/such/opencode",
        conventionalConfigDir: "/no/such/config",
        readFile: async () => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        },
        openDatabase: () => {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        },
      }),
    (err) => err.status === 503
  );

  const helper = createOccupancyHelper({
    token: "",
    ttlMs: 0,
    load: async () => {
      const err = new Error("missing");
      err.status = 503;
      throw err;
    },
  });
  const res = mockRes();
  await helper.onRequest({ method: "GET", url: "/occupancy", headers: {} }, res);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(Array.isArray(body), false);
  assert.equal(body.error, "OpenCode state not found");
});

test("occupancy JSON has no transcript table keys", () => {
  const row = publicOccupancyRow({
    source: "opencode",
    handle: "t",
    originHost: "john",
    originPort: 8888,
    midTurn: "unknown",
    title: "should-drop",
    directory: "/home/art",
  });
  const dumped = JSON.stringify(row);
  assert.equal(Object.hasOwn(row, "title"), false);
  assert.equal(Object.hasOwn(row, "directory"), false);
  assert.match(dumped, /"handle":"t"/);
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      this.body = String(chunk ?? "");
    },
  };
}
