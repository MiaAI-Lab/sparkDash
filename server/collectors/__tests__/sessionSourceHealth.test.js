/**
 * Session source Settings probe: counts only, no transcripts.
 * Run: node --test server/collectors/__tests__/sessionSourceHealth.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { testSessionSources } from "../sessionSourceHealth.js";

test("disabled sources return disabled without requiring a live attach", async () => {
  const result = await testSessionSources(
    { openclaw: { enabled: false }, hermes: { enabled: false } },
    {
      loadSessionSources: () => ({
        openclaw: { enabled: false, mode: "local", url: "", stateDir: "" },
        hermes: { enabled: false, mode: "local", url: "", stateDir: "" },
      }),
      loadSessionSourceTokens: () => ({ openclaw: "", hermes: "" }),
      getSparks: () => [],
    }
  );
  assert.deepEqual(result.openclaw, [
    { id: "openclaw", status: "disabled", found: 0, mapped: 0, error: null },
  ]);
  assert.deepEqual(result.hermes, [
    { id: "hermes", status: "disabled", found: 0, mapped: 0, error: null },
  ]);
});

test("blank enabled URL is an error, not a conventional fallback", async () => {
  const result = await testSessionSources(
    { hermes: { enabled: true, mode: "url", url: "  " } },
    {
      loadSessionSources: () => ({
        openclaw: { enabled: false, mode: "local", url: "", stateDir: "" },
        hermes: { enabled: false, mode: "local", url: "", stateDir: "" },
      }),
      loadSessionSourceTokens: () => ({ openclaw: "", hermes: "" }),
      getSparks: () => [],
    }
  );
  assert.equal(result.hermes[0].status, "error");
  assert.equal(result.hermes[0].error, "URL is required");
  assert.equal(JSON.stringify(result).includes("token"), false);
});

const DISABLED = { enabled: false, mode: "local", url: "", stateDir: "" };
const HERMES_SAVED = {
  enabled: true,
  mode: "url",
  url: "http://127.0.0.1:8787",
  stateDir: "",
};

test("stored token is not reused after the probed URL origin changes", async () => {
  let seenToken = "unset";
  await testSessionSources(
    { hermes: { enabled: true, mode: "url", url: "http://10.0.0.2:8787" } },
    {
      loadSessionSources: () => ({ openclaw: DISABLED, hermes: HERMES_SAVED }),
      loadSessionSourceTokens: () => ({ openclaw: "", hermes: "old-password" }),
      getSparks: () => [],
      fetchJson: async (_url, opts = {}) => {
        seenToken = opts.token ?? "";
        return { sessions: [] };
      },
    }
  );
  assert.equal(seenToken, "");
});

test("stored token is reused when the probed URL origin is unchanged", async () => {
  let seenToken = "unset";
  await testSessionSources(
    { hermes: { enabled: true, mode: "url", url: "http://127.0.0.1:8787" } },
    {
      loadSessionSources: () => ({ openclaw: DISABLED, hermes: HERMES_SAVED }),
      loadSessionSourceTokens: () => ({ openclaw: "", hermes: "old-password" }),
      getSparks: () => [],
      fetchJson: async (_url, opts = {}) => {
        seenToken = opts.token ?? "";
        return { sessions: [] };
      },
    }
  );
  assert.equal(seenToken, "old-password");
});

test("health probe reads the source once", async () => {
  let sessionCalls = 0;
  await testSessionSources(
    { hermes: { enabled: true, mode: "url", url: "http://127.0.0.1:8787" } },
    {
      loadSessionSources: () => ({ openclaw: DISABLED, hermes: HERMES_SAVED }),
      loadSessionSourceTokens: () => ({ openclaw: "", hermes: "" }),
      getSparks: () => [],
      fetchJson: async (url) => {
        if (String(url).includes("/api/sessions")) sessionCalls += 1;
        if (String(url).includes("/api/sessions")) return { sessions: [] };
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(sessionCalls, 1);
});

test("health probe returns one result per OpenClaw attach", async () => {
  const result = await testSessionSources(
    {
      openclaw: [
        { id: "openclaw", enabled: false },
        { id: "openclaw-2", enabled: true, mode: "url", url: "  " },
      ],
    },
    {
      loadSessionSources: () => ({
        openclaw: [
          { id: "openclaw", enabled: false, mode: "local", url: "", stateDir: "" },
          { id: "openclaw-2", enabled: false, mode: "url", url: "", stateDir: "" },
        ],
        hermes: DISABLED,
      }),
      loadSessionSourceTokens: () => ({}),
      getSparks: () => [],
    }
  );
  assert.equal(result.openclaw.length, 2);
  assert.equal(result.openclaw[0].status, "disabled");
  assert.equal(result.openclaw[1].id, "openclaw-2");
  assert.equal(result.openclaw[1].status, "error");
  assert.equal(result.openclaw[1].error, "URL is required");
});
