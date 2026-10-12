/**
 * Channel URLs in the real encrypted secrets store: round trip, ciphertext on
 * disk, and SparkRegistry's saves and the alert saves keeping each other's
 * sections. Migration from a plaintext alerts.json, end to end.
 */
import { test, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Paths are read when config.js is first imported; each test file is its own process.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-alert-secrets-"));
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
const { loadAlertChannelUrls, loadSecrets, saveAlertChannelUrls, saveSecrets } = await import("../../secretsStore.js");
const { createAlertsRuntime } = await import("../runtime.js");
const { quietLog } = await import("./fixtures.js");

after(() => fs.rmSync(TMPDIR, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true }));

const URL_A = "https://ntfy.example.com/sparkdash-topic-a1b2c3";
const URL_B = "http://192.168.1.50:8080/hook-secret";

test("alert channel URLs round-trip through the store and are ciphertext on disk", () => {
  saveAlertChannelUrls(new Map([["ch_a", URL_A], ["ch_b", URL_B]]));
  const raw = fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8");
  assert.ok(!raw.includes("sparkdash-topic"));
  assert.ok(!raw.includes("hook-secret"));
  assert.deepEqual(Object.keys(JSON.parse(raw).alertChannels).sort(), ["ch_a", "ch_b"]);
  const back = loadAlertChannelUrls();
  assert.equal(back.get("ch_a"), URL_A);
  assert.equal(back.get("ch_b"), URL_B);
});

test("SparkRegistry's saveSecrets keeps the alert URLs, and the alert save keeps passwords and API keys", () => {
  saveAlertChannelUrls(new Map([["ch_a", URL_A]]));
  saveSecrets(new Map([["spark-1", "pw-test"]]), new Map([["spark-1", { 8888: "sk-test-0000" }]]));
  assert.equal(loadAlertChannelUrls().get("ch_a"), URL_A, "passwords save did not drop the alert URL");
  saveAlertChannelUrls(new Map([["ch_b", URL_B]]));
  const { passwords, llmApiKeys } = loadSecrets();
  assert.equal(passwords.get("spark-1"), "pw-test");
  assert.equal(llmApiKeys.get("spark-1")["8888"], "sk-test-0000");
  assert.deepEqual([...loadAlertChannelUrls().keys()], ["ch_b"]);
  // Clearing the passwords leaves the alert URL (and the file) in place.
  saveSecrets(new Map(), new Map());
  assert.equal(loadAlertChannelUrls().get("ch_b"), URL_B);
  // Clearing everything removes the file, as before.
  saveAlertChannelUrls(new Map());
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), false);
});

test("a plaintext URL in alerts.json is moved into the encrypted store at startup", () => {
  const file = path.join(TMPDIR, "alerts.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, repeatIntervalMin: 0, rules: {}, channels: [{ id: "ch_old", name: "Old", type: "ntfy", url: URL_A, enabled: true, minSeverity: "warning" }], state: null }));
  const rt = createAlertsRuntime({ filePath: file, isEnabled: () => false, log: quietLog });
  assert.ok(!fs.readFileSync(file, "utf8").includes("sparkdash-topic"), "alerts.json no longer has it");
  assert.ok(!fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8").includes("sparkdash-topic"), "stored encrypted");
  assert.equal(loadAlertChannelUrls().get("ch_old"), URL_A);
  assert.equal(rt.publicConfig().channels[0].hasUrl, true);
  // A restart reads it back from the store.
  const again = createAlertsRuntime({ filePath: file, isEnabled: () => false, log: quietLog });
  assert.equal(again.publicConfig().channels[0].url, `https://ntfy.example.com…${URL_A.slice(-4)}`);
});
