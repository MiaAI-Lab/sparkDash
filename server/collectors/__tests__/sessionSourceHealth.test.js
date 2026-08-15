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
  assert.deepEqual(result.openclaw, { status: "disabled", found: 0, mapped: 0, error: null });
  assert.deepEqual(result.hermes, { status: "disabled", found: 0, mapped: 0, error: null });
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
  assert.equal(result.hermes.status, "error");
  assert.equal(result.hermes.error, "URL is required");
  assert.equal(JSON.stringify(result).includes("token"), false);
});
