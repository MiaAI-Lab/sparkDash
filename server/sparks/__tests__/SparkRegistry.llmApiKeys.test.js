/**
 * SparkRegistry LLM API key sync guard (follow-up to #25/#26).
 *
 * An out-of-band sparks.json edit can rename llmPorts without touching the
 * encrypted secrets store; PATCH /api/sparks/:id was the other bypass. Result:
 * the registry kept an orphaned key on the old port (probe then hit the host
 * without auth → 401s). Covered here:
 *   - load-time reconcile: unambiguous single-port rename MOVES the key
 *   - load-time reconcile: every other mismatch shape is warn-only and NEVER
 *     deletes stored key material at load
 *   - syncLlmApiKeysToPorts: rename move + prune semantics (the rails the
 *     PATCH llmPorts path and PUT /api/sparks/:id/llm-ports drive)
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Env must be set before the first import of config.js (paths are captured as
// consts at module evaluation); each node --test file runs in its own process.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-registry-keys-"));
process.env.SPARKS_JSON_PATH = path.join(TMPDIR, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
process.env.LLM_PORT = "8888";

const { SparkRegistry } = await import("../SparkRegistry.js");
const { saveSecrets } = await import("../../secretsStore.js");

/** Synthetic test key only — never real key material. */
const TEST_KEY = "sk-test-0000";

const SPARK_ID = "t";

/**
 * Seed sparks.json + the encrypted secrets store, then construct the registry
 * through its real load path so the load-time reconcile provably runs.
 * @param {number[]} llmPorts configured ports
 * @param {Record<string, string>} llmApiKeys port -> key in the secrets store
 * @param {{ reset?: boolean }} [opts] reset wipes seeded state first
 */
function loadRegistry(llmPorts, llmApiKeys = {}, { reset = false } = {}) {
  if (reset) {
    fs.rmSync(process.env.SPARKS_JSON_PATH, { force: true });
    fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  }
  fs.writeFileSync(
    process.env.SPARKS_JSON_PATH,
    JSON.stringify({
      sparks: [{ id: SPARK_ID, name: "T", lanIp: "127.0.0.1", llmPorts }],
    })
  );
  saveSecrets(
    new Map(),
    new Map([[SPARK_ID, Object.fromEntries(Object.entries(llmApiKeys))]])
  );
  return new SparkRegistry();
}

/** Capture `[SparkRegistry]` warns for the duration of fn(). */
function captureRegistryWarns(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("[SparkRegistry]")) {
      lines.push(args[0]);
    }
  };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

// ─── Load-time reconcile ─────────────────────────────────

test("load reconcile: unambiguous single-port rename moves the key", () => {
  const r = loadRegistry([8899], { "8888": TEST_KEY });
  assert.deepEqual(r.llmApiKeyPorts(SPARK_ID), [8899]);
  assert.equal(r.hasLlmApiKey(SPARK_ID, 8888), false);
  assert.equal(r.getSpark(SPARK_ID).llmApiKeys["8899"], TEST_KEY);
});

test("load reconcile: single-port rename warns with migration message", () => {
  const warns = captureRegistryWarns(() => loadRegistry([8899], { "8888": TEST_KEY }));
  assert.equal(warns.length, 1);
  assert.equal(
    warns[0],
    "[SparkRegistry] migrated LLM API key for spark t: port 8888 -> port 8899 after out-of-band config change"
  );
});

test("load reconcile: ambiguous shape never prunes — key on 8888 survives", () => {
  const r = loadRegistry([8015, 8899], { "8888": TEST_KEY });
  // No destructive load path: the orphaned key must still exist, unmoved.
  assert.equal(r.hasLlmApiKey(SPARK_ID, 8888), true);
  assert.deepEqual(r.llmApiKeyPorts(SPARK_ID), [8888]);
  assert.equal(r.getSpark(SPARK_ID).llmApiKeys["8888"], TEST_KEY);
});

test("load reconcile: ambiguous shape warns listing port numbers only", () => {
  const warns = captureRegistryWarns(() => loadRegistry([8015, 8899], { "8888": TEST_KEY }));
  assert.equal(warns.length, 1);
  assert.equal(
    warns[0],
    "[SparkRegistry] spark t LLM key/port mismatch: keyed=<8888> missing=<8015, 8899>"
  );
  assert.doesNotMatch(warns[0], /sk-test-0000/);
});

test("load reconcile: aligned shape stays silent and unchanged", () => {
  const warns = captureRegistryWarns(() => loadRegistry([8899], { "8899": TEST_KEY }));
  assert.deepEqual(warns, []);
  const r = loadRegistry([8899], { "8899": TEST_KEY });
  assert.deepEqual(r.llmApiKeyPorts(SPARK_ID), [8899]);
});

// ─── syncLlmApiKeysToPorts (PATCH llmPorts / PUT llm-ports rails) ──

function registryWithKey() {
  const r = loadRegistry([8899], { "8899": TEST_KEY }, { reset: true });
  r.addSpark({ id: "sp", name: "SP", lanIp: "127.0.0.1", llmPorts: [8888] });
  r.setLlmApiKey("sp", 8888, TEST_KEY);
  return r;
}

test("syncLlmApiKeysToPorts: single rename moves the key with value intact", () => {
  const r = registryWithKey();
  r.syncLlmApiKeysToPorts("sp", [8888], [8899]);
  assert.deepEqual(r.llmApiKeyPorts("sp"), [8899]);
  assert.equal(r.getSpark("sp").llmApiKeys["8899"], TEST_KEY);
  assert.equal(r.hasLlmApiKey("sp", 8888), false);
});

test("syncLlmApiKeysToPorts: no-shape change is a no-op", () => {
  const r = registryWithKey();
  r.syncLlmApiKeysToPorts("sp", [8888], [8888]);
  assert.equal(r.hasLlmApiKey("sp", 8888), true);
  assert.equal(r.getSpark("sp").llmApiKeys["8888"], TEST_KEY);
});

test("syncLlmApiKeysToPorts: removed port without rename is pruned", () => {
  const r = registryWithKey();
  r.setLlmApiKey("sp", 9001, TEST_KEY);
  r.syncLlmApiKeysToPorts("sp", [8888, 9001], [8888]);
  assert.deepEqual(r.llmApiKeyPorts("sp"), [8888]);
});
