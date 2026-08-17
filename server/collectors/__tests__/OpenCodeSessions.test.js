/**
 * OpenCode conversation collector: sqlite session rows + provider origins → projector rows.
 *
 * Injected db/config loaders — no live ~/.local/share/opencode.
 * Run: node --test server/collectors/__tests__/OpenCodeSessions.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseJsonc,
  mapOpenCodeSessions,
  collectOpenCodeSessions,
  diagnoseOpenCodeSessions,
} from "../OpenCodeSessions.js";

const MODULE_PATH = fileURLToPath(new URL("../OpenCodeSessions.js", import.meta.url));

const JOHN_PROVIDERS = {
  spark: { options: { baseURL: "http://john:8888/v1" } },
};

function session(overrides = {}) {
  return {
    id: "ses_local",
    title: "spark occupancy",
    model: JSON.stringify({ id: "gpt-oss", providerID: "spark" }),
    time_updated: 1_700_000_000_000,
    ...overrides,
  };
}

function expectedRow(overrides = {}) {
  return {
    source: "opencode",
    id: "ses_local",
    handle: "spark occupancy",
    originHost: "john",
    originPort: 8888,
    midTurn: "unknown",
    lastUsedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function sessionColumns() {
  return ["id", "title", "model", "time_updated", "tokens_input"].map((name, cid) => ({
    cid,
    name,
    type: "TEXT",
  }));
}

function fakeDb({ tables = { session: sessionColumns() }, rows = [], queries = [] } = {}) {
  return {
    prepare(sql) {
      queries.push(sql);
      const text = String(sql);
      if (/table_info\s*\(\s*session\s*\)/i.test(text)) {
        return { all: () => tables.session ?? [] };
      }
      if (/\bfrom\s+session\b/i.test(text)) {
        return { all: () => rows };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
    close() {},
  };
}

const JSONC_CONFIG = `{
  // occupancy fixture
  "provider": {
    "spark": { "options": { "baseURL": "http://john:8888/v1" } }
  }
}
`;

test("fixture session with providerID maps origin john:8888 and title handle", () => {
  const rows = mapOpenCodeSessions([session()], JOHN_PROVIDERS);
  assert.deepEqual(rows, [expectedRow()]);
});

test("cloud baseURL still emits a row", () => {
  const rows = mapOpenCodeSessions(
    [session({ model: JSON.stringify({ id: "opus", providerID: "anthropic" }) })],
    { anthropic: { options: { baseURL: "https://api.anthropic.com/v1" } } }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "api.anthropic.com");
  assert.equal(rows[0].originPort, 443);
});

test("recent time_updated with no in-flight field is midTurn unknown", () => {
  const rows = mapOpenCodeSessions(
    [session({ time_updated: Date.now() })],
    JOHN_PROVIDERS
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].midTurn, "unknown");
});

test("malformed model JSON is skipped without failing the batch", () => {
  const rows = mapOpenCodeSessions(
    [
      session({ id: "bad", model: "{not-json" }),
      session({ id: "empty", model: "" }),
      session({ id: "null-model", model: null }),
      session({ id: "ok", title: "kept" }),
    ],
    JOHN_PROVIDERS
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "ok");
  assert.equal(rows[0].handle, "kept");
});

test("parseJsonc strips comments and keeps strings that look like comments", () => {
  const parsed = parseJsonc(`{
    // line
    "provider": { "spark": { "options": { "baseURL": "http://john:8888/v1" } } },
    "note": "http://example.com/path" /* block */
  }`);
  assert.equal(parsed.provider.spark.options.baseURL, "http://john:8888/v1");
  assert.equal(parsed.note, "http://example.com/path");
});

test("local collect reads JSONC-only provider config and sqlite session rows", async () => {
  const queries = [];
  const files = {
    "/tmp/opencode-config/opencode.jsonc": JSONC_CONFIG,
  };
  const rows = await collectOpenCodeSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: "/tmp/opencode-data",
      conventionalConfigDir: "/tmp/opencode-config",
      readFile: async (filePath) => {
        if (files[filePath]) return files[filePath];
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
      openDatabase: (dbPath) => {
        assert.equal(dbPath, "/tmp/opencode-data/opencode.db");
        return fakeDb({
          queries,
          rows: [session()],
        });
      },
    }
  );
  assert.deepEqual(rows, [expectedRow()]);
  assert.equal(queries.some((sql) => /message|part/i.test(sql)), false);
  assert.equal(queries.some((sql) => /table_info\s*\(\s*session\s*\)/i.test(sql)), true);
  assert.equal(queries.some((sql) => /\bfrom\s+session\b/i.test(sql)), true);
});

test("injected db that only exposes message is never queried", async () => {
  const queries = [];
  const rows = await collectOpenCodeSessions(
    { enabled: true, mode: "state-dir", stateDir: "/tmp/opencode-data" },
    {
      conventionalConfigDir: "/tmp/opencode-config",
      readFile: async (filePath) => {
        if (filePath.endsWith("opencode.json")) {
          return JSON.stringify({ provider: JOHN_PROVIDERS });
        }
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
      openDatabase: () =>
        fakeDb({
          queries,
          tables: { session: [] },
          rows: [{ id: "secret", body: "transcript" }],
        }),
    }
  );
  assert.deepEqual(rows, []);
  assert.equal(queries.some((sql) => /message|part/i.test(sql)), false);
  assert.equal(queries.some((sql) => /\bfrom\s+session\b/i.test(sql)), false);
});

test("missing db collects [] and diagnose is error", async () => {
  const deps = {
    conventionalStateDir: "/no/such/opencode",
    conventionalConfigDir: "/no/such/opencode-config",
    readFile: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    openDatabase: (dbPath) => {
      const err = new Error(`ENOENT: ${dbPath}`);
      err.code = "ENOENT";
      throw err;
    },
  };
  const collected = await collectOpenCodeSessions({ enabled: true, mode: "local" }, deps);
  assert.deepEqual(collected, []);
  const diagnosed = await diagnoseOpenCodeSessions({ enabled: true, mode: "local" }, deps);
  assert.equal(diagnosed.status, "error");
  assert.equal(diagnosed.found, 0);
  assert.equal(diagnosed.mapped, 0);
  assert.equal(typeof diagnosed.error, "string");
  assert.ok(diagnosed.error);
});

test("URL mode maps helper JSON through stampAttachRows; fetch failure is [] / error", async () => {
  const helperRows = [expectedRow({ id: "remote-1", handle: "laptop" })];
  const mapped = await collectOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy", id: "opencode" },
    {
      fetchJson: async (url, opts) => {
        assert.equal(url, "http://127.0.0.1:8788/occupancy");
        assert.equal(opts.token, "secret");
        return helperRows;
      },
      token: "secret",
    }
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].handle, "laptop");
  assert.equal(mapped[0].id, "opencode:remote-1");
  assert.equal(mapped[0].source, "opencode");

  const envelope = await diagnoseOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy", id: "opencode" },
    {
      fetchJson: async () => ({ found: 4, rows: helperRows }),
    }
  );
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.found, 4);
  assert.equal(envelope.mapped, 1);
  assert.equal("handle" in envelope, false);

  const failedCollect = await collectOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy" },
    {
      fetchJson: async () => {
        throw new Error("ECONNREFUSED");
      },
    }
  );
  assert.deepEqual(failedCollect, []);
  const failedDiagnose = await diagnoseOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy" },
    {
      fetchJson: async () => {
        const err = new Error("connect");
        err.code = "ECONNREFUSED";
        throw err;
      },
    }
  );
  assert.equal(failedDiagnose.status, "error");
  assert.equal(failedDiagnose.found, 0);
});

test("helper payload over 500 rows is skipped for collect and diagnose error", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => expectedRow({ id: `s${i}`, handle: `h${i}` }));
  const collected = await collectOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy" },
    { fetchJson: async () => rows }
  );
  assert.deepEqual(collected, []);
  const diagnosed = await diagnoseOpenCodeSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8788/occupancy" },
    { fetchJson: async () => rows }
  );
  assert.equal(diagnosed.status, "error");
});

test("module never queries message or part", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/\bmessage\b|\bpart\b/.test(src), false);
});
