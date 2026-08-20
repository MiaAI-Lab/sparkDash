/**
 * DeepSeek Harness (dsh) occupancy collector: URL-mode helper payload → projector rows.
 *
 * Injected fetch — no live dsh web or helper.
 * Run: node --test server/collectors/__tests__/DshSessions.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  sanitizeDshRow,
  loadDshOccupancy,
  collectDshSessions,
  diagnoseDshSessions,
} from "../DshSessions.js";

const SESSION_ID = "session-97835b81-e7dd-4c3e-9ea2-82be60a235b6";

function helperRow(overrides = {}) {
  return {
    source: "dsh",
    id: SESSION_ID,
    handle: "Hi just set up dsh",
    lastUsedAt: 1787156529916,
    midTurn: "unknown",
    contextUsed: 78022,
    contextWindow: 1048576,
    contextApprox: false,
    agent: "john-remote/deepseek-v4-flash-dspark",
    ...overrides,
  };
}

function helperPayload(rows, found) {
  return { found: found ?? rows.length, rows };
}

function makeFetch(payload) {
  return async () => payload;
}

// T1: sanitizeDshRow keeps only PROJECTOR_ROW_KEYS and forces source
test("T1: sanitizeDshRow keeps allowed keys, forces source=dsh", () => {
  const row = sanitizeDshRow({
    source: "wrong",
    id: "abc",
    handle: "test",
    lastUsedAt: 1000,
    midTurn: "generating",
    gateway: "TheShop DSH",
    contextUsed: 500,
    contextWindow: 1000,
    contextApprox: false,
    agent: "john-remote/model",
    originHost: "100.120.26.16",
    originPort: 8888,
    extraField: "removed",
  });
  assert.equal(row.source, "dsh");
  assert.equal(row.id, "abc");
  assert.equal(row.handle, "test");
  assert.equal(row.midTurn, "generating");
  assert.equal(row.gateway, "TheShop DSH");
  assert.equal(row.contextUsed, 500);
  assert.equal(row.contextWindow, 1000);
  assert.equal(row.contextApprox, false);
  assert.equal(row.agent, "john-remote/model");
  assert.equal(row.originHost, "100.120.26.16");
  assert.equal(row.originPort, 8888);
  assert.equal(row.extraField, undefined);
});

// T2: sanitizeDshRow defaults midTurn to unknown
test("T2: sanitizeDshRow defaults midTurn to unknown", () => {
  const row = sanitizeDshRow({ id: "x", handle: "h" });
  assert.equal(row.midTurn, "unknown");
});

// T3: loadDshOccupancy with valid helper payload
test("T3: loadDshOccupancy returns sanitized rows from helper", async () => {
  const fetchJson = makeFetch(helperPayload([helperRow()]));
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8791/occupancy", id: "dsh", label: "TheShop DSH" },
    { fetchJson },
  );
  assert.equal(loaded.found, 1);
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0].source, "dsh");
  assert.equal(loaded.rows[0].handle, "Hi just set up dsh");
  assert.equal(loaded.rows[0].gateway, "TheShop DSH");
  assert.equal(loaded.rows[0].id, `dsh:${SESSION_ID}`);
});

// T4: loadDshOccupancy with empty URL returns empty
test("T4: loadDshOccupancy with empty URL returns empty", async () => {
  const loaded = await loadDshOccupancy({ enabled: true, mode: "url", url: "", id: "dsh" }, {});
  assert.equal(loaded.found, 0);
  assert.equal(loaded.rows.length, 0);
});

// T5: loadDshOccupancy with invalid payload marks invalidHelper
test("T5: loadDshOccupancy with non-object payload marks invalidHelper", async () => {
  const fetchJson = makeFetch("not an object");
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://x", id: "dsh" },
    { fetchJson },
  );
  assert.equal(loaded.invalidHelper, true);
  assert.equal(loaded.rows.length, 0);
});

// T6: loadDshOccupancy with missing rows array marks invalidHelper
test("T6: loadDshOccupancy with missing rows array marks invalidHelper", async () => {
  const fetchJson = makeFetch({ found: 5 });
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://x", id: "dsh" },
    { fetchJson },
  );
  assert.equal(loaded.invalidHelper, true);
});

// T7: collectDshSessions with disabled attach returns empty
test("T7: collectDshSessions with disabled attach returns []", async () => {
  const rows = await collectDshSessions({ enabled: false }, {});
  assert.deepEqual(rows, []);
});

// T8: collectDshSessions swallows fetch errors
test("T8: collectDshSessions swallows fetch errors", async () => {
  const fetchJson = async () => { throw new Error("network down"); };
  const rows = await collectDshSessions(
    { enabled: true, mode: "url", url: "http://x", id: "dsh" },
    { fetchJson },
  );
  assert.deepEqual(rows, []);
});

// T9: diagnoseDshSessions with disabled attach
test("T9: diagnoseDshSessions with disabled attach returns disabled", async () => {
  const diag = await diagnoseDshSessions({ enabled: false }, {});
  assert.equal(diag.status, "disabled");
});

// T10: diagnoseDshSessions with empty URL returns error
test("T10: diagnoseDshSessions with empty URL returns error", async () => {
  const diag = await diagnoseDshSessions({ enabled: true, mode: "url", url: "", id: "dsh" }, {});
  assert.equal(diag.status, "error");
  assert.equal(diag.error, "URL is required");
});

// T11: diagnoseDshSessions with valid helper returns ok
test("T11: diagnoseDshSessions with valid helper returns ok", async () => {
  const fetchJson = makeFetch(helperPayload([helperRow()]));
  const diag = await diagnoseDshSessions(
    { enabled: true, mode: "url", url: "http://x", id: "dsh" },
    { fetchJson },
  );
  assert.equal(diag.status, "ok");
  assert.equal(diag.found, 1);
});

// T12: diagnoseDshSessions with invalid helper returns error
test("T12: diagnoseDshSessions with invalid helper returns error", async () => {
  const fetchJson = makeFetch("bad");
  const diag = await diagnoseDshSessions(
    { enabled: true, mode: "url", url: "http://x", id: "dsh" },
    { fetchJson },
  );
  assert.equal(diag.status, "error");
  assert.equal(diag.error, "Invalid occupancy payload");
});

// T13: rows pass through originHost and originPort from helper
test("T13: dsh rows pass through originHost and originPort", async () => {
  const fetchJson = makeFetch(helperPayload([helperRow({ originHost: "100.120.26.16", originPort: 8888 })]));
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://x", id: "dsh", label: "DSH" },
    { fetchJson },
  );
  assert.equal(loaded.rows[0].originHost, "100.120.26.16");
  assert.equal(loaded.rows[0].originPort, 8888);
});

// T14: gateway passthrough stamps attach label
test("T14: gateway passthrough stamps attach label", async () => {
  const fetchJson = makeFetch(helperPayload([helperRow({ gateway: undefined })]));
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://x", id: "dsh", label: "TheShop DSH" },
    { fetchJson },
  );
  assert.equal(loaded.rows[0].gateway, "TheShop DSH");
});

// T15: helper payload as bare array works
test("T15: helper payload as bare array works", async () => {
  const fetchJson = makeFetch([helperRow()]);
  const loaded = await loadDshOccupancy(
    { enabled: true, mode: "url", url: "http://x", id: "dsh", label: "DSH" },
    { fetchJson },
  );
  assert.equal(loaded.found, 1);
  assert.equal(loaded.rows.length, 1);
});
