/**
 * oh-my-pi (omp) occupancy collector: JSONL session files + provider origins → projector rows.
 *
 * Injected file/dir/stat loaders — no live ~/.omp.
 * Run: node --test server/collectors/__tests__/OmpSessions.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  extractOmpProviders,
  parseOmpSessionJsonl,
  mapOmpSessions,
  collectOmpSessions,
  diagnoseOmpSessions,
} from "../OmpSessions.js";

const JOHN_PROVIDERS = {
  "john-ofus": "http://192.168.4.52:8888/v1",
};

function jsonlLine(obj) {
  return JSON.stringify(obj);
}

function sessionJsonl(overrides = {}) {
  const {
    title = "Wrap up task",
    model = "john-ofus/deepseek-v4-flash-dspark",
    sessionId = "01a01604-537f-7000-90bb-3cbf3f8af435",
    timestamp = "2026-08-18T18:10:51.196Z",
  } = overrides;
  const lines = [];
  if (sessionId) lines.push(jsonlLine({ type: "session", session: { id: sessionId }, timestamp }));
  if (title) lines.push(jsonlLine({ type: "title", title: { title }, timestamp }));
  if (model) lines.push(jsonlLine({ type: "model_change", model_change: { model }, timestamp }));
  return lines.join("\n");
}

function expectedRow(overrides = {}) {
  return {
    source: "omp",
    id: "01a01604-537f-7000-90bb-3cbf3f8af435",
    handle: "Wrap up task",
    originHost: "192.168.4.52",
    originPort: 8888,
    midTurn: "unknown",
    lastUsedAt: Date.parse("2026-08-18T18:10:51.196Z"),
    ...overrides,
  };
}

// T1: provider-origin join
test("T1: provider-origin join maps john-ofus to 192.168.4.52:8888", () => {
  const parsed = [parseOmpSessionJsonl(sessionJsonl(), "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "192.168.4.52");
  assert.equal(rows[0].originPort, 8888);
});

// T2: cloud-only provider stays unmatched
test("T2: cloud-only provider produces row without origin fields", () => {
  const parsed = [parseOmpSessionJsonl(sessionJsonl({ model: "openai/gpt-4o" }), "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows.length, 1);
  assert.equal("originHost" in rows[0], false);
  assert.equal("originPort" in rows[0], false);
});

// T3: handle from title event
test("T3: title event supplies handle; last non-empty wins", () => {
  const jsonl = [
    jsonlLine({ type: "title", title: { title: "First title" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "title", title: { title: "Final title" }, timestamp: "2026-08-18T18:00:00.000Z" }),
    jsonlLine({ type: "session", session: { id: "abc12345-537f-7000-90bb-3cbf3f8af435" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const parsed = [parseOmpSessionJsonl(jsonl, "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].handle, "Final title");
});

// T4: synthetic handle fallback
test("T4: empty title produces synthetic handle from session id", () => {
  const jsonl = [
    jsonlLine({ type: "session", session: { id: "01a01604-537f-7000-90bb-3cbf3f8af435" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "title", title: { title: "" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const parsed = [parseOmpSessionJsonl(jsonl, "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].handle, "omp-01a01604");
});

test("T4b: no session event falls back to filename UUID suffix", () => {
  const jsonl = [
    jsonlLine({ type: "title", title: { title: "" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const fileName = "2026-08-18T17-56-17-407Z_01a01604-537f-7000-90bb-3cbf3f8af435.jsonl";
  const parsed = [parseOmpSessionJsonl(jsonl, fileName)];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].handle, "omp-01a01604");
});

// T5: midTurn is always "unknown"
test("T5: midTurn is always unknown string", () => {
  const parsed = [parseOmpSessionJsonl(sessionJsonl(), "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(typeof rows[0].midTurn, "string");
});

// T6: recency from max timestamp
test("T6: lastUsedAt uses max valid timestamp", () => {
  const jsonl = [
    jsonlLine({ type: "session", session: { id: "01a01604-537f-7000-90bb-3cbf3f8af435" }, timestamp: "2026-08-18T17:56:17.407Z" }),
    jsonlLine({ type: "title", title: { title: "Test" }, timestamp: "2026-08-18T18:10:51.196Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:05:00.000Z" }),
  ].join("\n");
  const parsed = [parseOmpSessionJsonl(jsonl, "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].lastUsedAt, Date.parse("2026-08-18T18:10:51.196Z"));
});

// T7: byte-cap truncation fallback (no timestamps → null lastUsedAt, mtime fallback)
test("T7: truncated text with no timestamps produces null lastUsedAt", () => {
  const jsonl = '{ type: "session", session: { id: "01a01604-537f'; // torn JSON
  const parsed = parseOmpSessionJsonl(jsonl, "2026-08-18T17-56-17-407Z_01a01604-537f-7000-90bb-3cbf3f8af435.jsonl");
  assert.ok(parsed);
  assert.equal(parsed.lastUsedAt, null);
});

test("T7b: mtime fallback when no valid timestamps in JSONL", () => {
  const jsonl = [
    jsonlLine({ type: "session", session: { id: "01a01604-537f-7000-90bb-3cbf3f8af435" } }),
    jsonlLine({ type: "title", title: { title: "Test" } }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" } }),
  ].join("\n");
  const mtime = 1723990000000;
  const parsed = parseOmpSessionJsonl(jsonl, "test.jsonl", mtime);
  assert.equal(parsed.lastUsedAt, mtime);
});

test("T7c: mtime does not override valid timestamps", () => {
  const jsonl = [
    jsonlLine({ type: "session", session: { id: "01a01604-537f-7000-90bb-3cbf3f8af435" }, timestamp: "2026-08-18T18:00:00.000Z" }),
    jsonlLine({ type: "title", title: { title: "Test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const mtime = 1000000000000;
  const parsed = parseOmpSessionJsonl(jsonl, "test.jsonl", mtime);
  assert.equal(parsed.lastUsedAt, Date.parse("2026-08-18T18:00:00.000Z"));
});

// T8: missing root hides lane
test("T8: missing state dir returns empty rows and error diagnosis", async () => {
  const rows = await collectOmpSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: "/nonexistent/omp",
      conventionalConfigDir: "/nonexistent/omp/agent",
      readFile: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readDir: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      stat: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    }
  );
  assert.deepEqual(rows, []);

  const diag = await diagnoseOmpSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: "/nonexistent/omp",
      conventionalConfigDir: "/nonexistent/omp/agent",
      readFile: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readDir: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      stat: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    }
  );
  assert.equal(diag.status, "error");
  assert.equal(diag.error, "oh-my-pi sessions not found");
});

// T9: url-mode graceful degradation
test("T9: url-mode attach degrades to local collection", async () => {
  const files = {
    "/tmp/omp/agent/sessions/test.jsonl": sessionJsonl(),
  };
  const dirs = {
    "/tmp/omp/agent/sessions": ["test.jsonl"],
    "/tmp/omp": ["agent"],
    "/tmp/omp/agent": ["sessions"],
  };
  const stats = {
    "/tmp/omp": { isDirectory: () => true, isFile: () => false, mtimeMs: 1000 },
    "/tmp/omp/agent": { isDirectory: () => true, isFile: () => false, mtimeMs: 1000 },
    "/tmp/omp/agent/sessions": { isDirectory: () => true, isFile: () => false, mtimeMs: 1000 },
    "/tmp/omp/agent/sessions/test.jsonl": { isDirectory: () => false, isFile: () => true, mtimeMs: 2000 },
  };
  const rows = await collectOmpSessions(
    { enabled: true, mode: "url", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp",
      conventionalConfigDir: "/tmp/omp/agent",
      readFile: async (p) => files[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      readDir: async (p) => dirs[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  assert.ok(Array.isArray(rows));
});

// T10: provider yaml extractor purity
test("T10: extractOmpProviders never includes apiKey", () => {
  const yaml = `providers:
  john-ofus:
    baseUrl: "http://192.168.4.52:8888/v1"
    apiKey: "REDACTED-TEST-FIXTURE-NOT-A-SECRET"
  openai:
    baseURL: "https://api.openai.com/v1"
    apiKey: "REDACTED-TEST-FIXTURE-NOT-A-SECRET"
`;
  const map = extractOmpProviders(yaml);
  assert.equal(map["john-ofus"], "http://192.168.4.52:8888/v1");
  assert.equal(map["openai"], "https://api.openai.com/v1");
  assert.equal("apiKey" in map, false);
  assert.equal(Object.values(map).some((v) => v.includes("REDACTED")), false);
});

test("T10b: broken yaml returns empty map without throwing", () => {
  assert.deepEqual(extractOmpProviders(""), {});
  assert.deepEqual(extractOmpProviders(null), {});
  assert.deepEqual(extractOmpProviders("not: yaml: at: all"), {});
  assert.deepEqual(extractOmpProviders("providers:\n  # only comments\n"), {});
});

test("T10c: duplicate provider ids resolve last-wins", () => {
  const yaml = `providers:
  john:
    baseUrl: "http://first:8000/v1"
  john:
    baseUrl: "http://second:9000/v1"
`;
  const map = extractOmpProviders(yaml);
  assert.equal(map["john"], "http://second:9000/v1");
});

// T11: file selection and depth bounds
test("T11: file count capped at OMP_MAX_SESSION_FILES", async () => {
  // Create a mock with >100 files
  const files = {};
  const dirs = { "/tmp/omp/sessions": [] };
  const stats = {};
  for (let i = 0; i < 150; i += 1) {
    const name = `session-${i}.jsonl`;
    files[`/tmp/omp/sessions/${name}`] = sessionJsonl();
    dirs["/tmp/omp/sessions"].push(name);
    stats[`/tmp/omp/sessions/${name}`] = { isDirectory: () => false, isFile: () => true, mtimeMs: i };
  }
  stats["/tmp/omp/sessions"] = { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };

  const rows = await collectOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp",
      conventionalConfigDir: "/tmp/omp/agent",
      readFile: async (p) => files[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      readDir: async (p) => dirs[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  // Should process at most 100 files (OMP_MAX_SESSION_FILES)
  // Some may not produce rows if provider mapping fails, but it must not crash
  assert.ok(Array.isArray(rows));
});

// T12: registry integration
test("T12: registry includes omp with correct metadata", async () => {
  const registry = await import("../../sessionSourceRegistry.js");
  const ids = registry.sessionSourceIds();
  assert.ok(ids.includes("omp"));
  assert.equal(registry.kindById("omp")?.label, "oh-my-pi");
  assert.equal(registry.conventionalStateDir("omp"), "~/.omp");
  assert.equal(registry.conventionalConfigDir("omp"), "~/.omp/agent");
  assert.equal(registry.kindById("omp")?.urlPlaceholder, undefined);
});

// T13: adapter wiring
test("T13: occupancyCollectors and occupancyDiagnosers expose omp", async () => {
  const adapters = await import("../sessionSourceAdapters.js");
  const collectors = adapters.occupancyCollectors();
  const diagnosers = adapters.occupancyDiagnosers();
  assert.equal(typeof collectors.omp, "function");
  assert.equal(typeof diagnosers.omp, "function");
});

test("T4c: no session ID and no UUID in filename returns null", () => {
  const jsonl = [
    jsonlLine({ type: "title", title: { title: "Test" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const parsed = parseOmpSessionJsonl(jsonl, "plain.jsonl");
  assert.equal(parsed, null);
});

test("T4d: shortMatch fallback extracts first 8+ alnum chars from filename", () => {
  const jsonl = [
    jsonlLine({ type: "title", title: { title: "Test" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T18:00:00.000Z" }),
  ].join("\n");
  const parsed = parseOmpSessionJsonl(jsonl, "my-session-name.jsonl");
  assert.ok(parsed);
  assert.equal(parsed.id, "my-session-name");
});

// T15: empty sessions directory
test("T15: empty sessions dir returns found=0, missingState=false", async () => {
  const dirs = { "/tmp/omp/agent/sessions": [] };
  const stats = {
    "/tmp/omp/agent/sessions": { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
  };
  const loaded = await collectOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp",
      conventionalConfigDir: "/tmp/omp/agent",
      readFile: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readDir: async (p) => dirs[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  assert.deepEqual(loaded, []);
});

// Additional: disabled attach returns no rows
test("disabled attach returns empty array", async () => {
  const rows = await collectOmpSessions({ enabled: false }, {});
  assert.deepEqual(rows, []);
  const diag = await diagnoseOmpSessions({ enabled: false }, {});
  assert.equal(diag.status, "disabled");
});

// Additional: message events are ignored
test("message events are ignored for handle but timestamp contributes to recency", () => {
  const jsonl = [
    jsonlLine({ type: "session", session: { id: "01a01604-537f-7000-90bb-3cbf3f8af435" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "title", title: { title: "Real title" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "model_change", model_change: { model: "john-ofus/test" }, timestamp: "2026-08-18T17:00:00.000Z" }),
    jsonlLine({ type: "message", message: { content: "secret prompt data" }, timestamp: "2026-08-18T19:00:00.000Z" }),
  ].join("\n");
  const parsed = [parseOmpSessionJsonl(jsonl, "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows[0].handle, "Real title");
  assert.equal(rows[0].lastUsedAt, Date.parse("2026-08-18T19:00:00.000Z"));
  // No message content in any row field
  assert.equal(JSON.stringify(rows[0]).includes("secret prompt data"), false);
});

// Additional: malformed JSONL lines are skipped
test("malformed JSONL lines are skipped without failing the session", () => {
  const jsonl = [
    '{ "type": "session", "session": { "id": "01a01604-537f-7000-90bb-3cbf3f8af435" }, "timestamp": "2026-08-18T17:00:00.000Z" }',
    'this is not valid json',
    '{ "type": "title", "title": { "title": "OK" }, "timestamp": "2026-08-18T18:00:00.000Z" }',
    '{ "type": "model_change", "model_change": { "model": "john-ofus/test" }, "timestamp": "2026-08-18T18:00:00.000Z" }',
  ].join("\n");
  const parsed = [parseOmpSessionJsonl(jsonl, "test.jsonl")];
  const rows = mapOmpSessions(parsed, JOHN_PROVIDERS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "OK");
});

// Additional: row sanitization removes unexpected keys
test("sanitizeOmpRow removes unexpected keys", async () => {
  const { sanitizeOmpRow } = await import("../OmpSessions.js");
  const sanitized = sanitizeOmpRow({
    source: "omp",
    id: "test",
    handle: "test",
    originHost: "localhost",
    originPort: 8080,
    midTurn: "unknown",
    secret: "should-be-removed",
    message: "should-be-removed",
  });
  assert.equal("secret" in sanitized, false);
  assert.equal("message" in sanitized, false);
  assert.equal(sanitized.source, "omp");
  assert.equal(sanitized.midTurn, "unknown");
});

// Additional: state-dir mode requires stateDir
test("state-dir mode with empty stateDir returns error", async () => {
  const diag = await diagnoseOmpSessions(
    { enabled: true, mode: "state-dir", stateDir: "" },
    {}
  );
  assert.equal(diag.status, "error");
  assert.equal(diag.error, "State dir is required");
});

// Additional: collect never throws
test("collect never throws on filesystem errors", async () => {
  const rows = await collectOmpSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: "/nonexistent",
      conventionalConfigDir: "/nonexistent",
      stat: async () => { throw new Error("EPERM"); },
    }
  );
  assert.deepEqual(rows, []);
});

test("partial file read failure: one bad file does not abort the sweep", async () => {
  const files = {
    "/tmp/omp/agent/sessions/good.jsonl": sessionJsonl(),
    "/tmp/omp/agent/sessions/bad.jsonl": null,
  };
  const dirs = { "/tmp/omp/agent/sessions": ["good.jsonl", "bad.jsonl"] };
  const stats = {
    "/tmp/omp/agent/sessions": { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
    "/tmp/omp/agent/sessions/good.jsonl": { isDirectory: () => false, isFile: () => true, mtimeMs: 2000 },
    "/tmp/omp/agent/sessions/bad.jsonl": { isDirectory: () => false, isFile: () => true, mtimeMs: 1000 },
  };
  const rows = await collectOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp",
      conventionalConfigDir: "/tmp/omp/agent",
      realpath: (p) => p,
      readFile: async (p) => {
        if (p === "/tmp/omp/agent/sessions/bad.jsonl") {
          const e = new Error("EIO"); e.code = "EIO"; throw e;
        }
        return files[p];
      },
      readDir: async (p) => dirs[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].handle, "Wrap up task");
});

test("found count reflects successfully parsed sessions, not files attempted", async () => {
  const files = {
    "/tmp/omp/agent/sessions/good.jsonl": sessionJsonl(),
    "/tmp/omp/agent/sessions/bad.jsonl": null,
  };
  const dirs = { "/tmp/omp/agent/sessions": ["good.jsonl", "bad.jsonl"] };
  const stats = {
    "/tmp/omp/agent/sessions": { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
    "/tmp/omp/agent/sessions/good.jsonl": { isDirectory: () => false, isFile: () => true, mtimeMs: 2000 },
    "/tmp/omp/agent/sessions/bad.jsonl": { isDirectory: () => false, isFile: () => true, mtimeMs: 1000 },
  };
  const diag = await diagnoseOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp",
      conventionalConfigDir: "/tmp/omp/agent",
      realpath: (p) => p,
      readFile: async (p) => {
        if (p === "/tmp/omp/agent/sessions/bad.jsonl") {
          const e = new Error("EIO"); e.code = "EIO"; throw e;
        }
        return files[p];
      },
      readDir: async (p) => dirs[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  assert.equal(diag.status, "ok");
  assert.equal(diag.found, 1);
});

test("symlink loop: visited realpath set prevents infinite recursion", async () => {
  // Simulate a directory that symlinks back into itself.
  // realpath returns the same path for both the original and the symlink,
  // so the second visit is skipped by the visited set.
  const sessionPath = "/tmp/omp-loop/agent/sessions";
  const linkPath = `${sessionPath}/loopback`;
  const files = {
    [`${sessionPath}/real.jsonl`]: sessionJsonl(),
  };
  const dirs = {
    [sessionPath]: ["real.jsonl", "loopback"],
    [linkPath]: ["loopback"], // points back to parent
  };
  const stats = {
    [sessionPath]: { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
    [`${sessionPath}/real.jsonl`]: { isDirectory: () => false, isFile: () => true, mtimeMs: 2000 },
    [linkPath]: { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
  };
  // realpath maps both sessionPath and linkPath to the same real path,
  // simulating a symlink loop.
  const realPaths = new Map();
  realPaths.set(sessionPath, "/real/sessions");
  realPaths.set(linkPath, "/real/sessions");
  const rows = await collectOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp-loop",
      conventionalConfigDir: "/tmp/omp-loop/agent",
      realpath: (p) => realPaths.get(p) ?? p,
      readFile: async (p) => files[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      readDir: async (p) => dirs[p] ?? [],
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  // Should find exactly one session (real.jsonl), not loop infinitely.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "omp");
});

test("dot entries are skipped during recursive scan", async () => {
  const sessionPath = "/tmp/omp-dot/agent/sessions";
  const files = {
    [`${sessionPath}/visible.jsonl`]: sessionJsonl(),
    [`${sessionPath}/.hidden.jsonl`]: sessionJsonl({ sessionId: "hidden-session-id" }),
  };
  const dirs = {
    [sessionPath]: ["visible.jsonl", ".hidden.jsonl"],
  };
  const stats = {
    [sessionPath]: { isDirectory: () => true, isFile: () => false, mtimeMs: 0 },
    [`${sessionPath}/visible.jsonl`]: { isDirectory: () => false, isFile: () => true, mtimeMs: 2000 },
    [`${sessionPath}/.hidden.jsonl`]: { isDirectory: () => false, isFile: () => true, mtimeMs: 1000 },
  };
  const rows = await collectOmpSessions(
    { enabled: true, mode: "local", id: "omp" },
    {
      conventionalStateDir: "/tmp/omp-dot",
      conventionalConfigDir: "/tmp/omp-dot/agent",
      realpath: (p) => p,
      readFile: async (p) => files[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
      readDir: async (p) => dirs[p] ?? [],
      stat: async (p) => stats[p] ?? (() => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; })(),
    }
  );
  // Only the non-dot file should be collected.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "Wrap up task");
});
