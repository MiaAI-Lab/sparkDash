import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-secrets-"));
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");
process.env.SPARKDASH_SECRETS_KEY = "test-only-secrets-key";

const { loadSecrets, saveSecrets, saveHelperTokens } = await import("../../secretsStore.js");

describe("secret namespaces", { concurrency: 1 }, () => {
test("clearing LLM keys does not resurrect them and keeps helper tokens", () => {
  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map([["spark", { "8000": "sk-test" }]]));
  saveHelperTokens(new Map([["mama", "helper-token"]]));
  saveSecrets(new Map(), new Map());
  const loaded = loadSecrets();
  assert.equal(loaded.passwords.size, 0);
  assert.equal(loaded.llmApiKeys.size, 0);
  assert.equal(loaded.helperTokens.get("mama"), "helper-token");
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), true);
});

test("helper token updates preserve SSH and LLM secrets", () => {
  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map([["spark", { "8000": "sk-test" }]]));
  saveHelperTokens(new Map([["mama", "one"]]));
  saveHelperTokens(new Map([["mama", "two"]]));
  const loaded = loadSecrets();
  assert.equal(loaded.passwords.get("spark"), "ssh-secret");
  assert.equal(loaded.llmApiKeys.get("spark")["8000"], "sk-test");
  assert.equal(loaded.helperTokens.get("mama"), "two");
});

test("deleting the last secret in each order removes only that namespace", () => {
  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map([["spark", { "8000": "sk-test" }]]));
  saveHelperTokens(new Map([["mama", "helper-token"]]));

  saveSecrets(new Map(), new Map([["spark", { "8000": "sk-test" }]]));
  let loaded = loadSecrets();
  assert.equal(loaded.passwords.size, 0);
  assert.equal(loaded.llmApiKeys.get("spark")["8000"], "sk-test");
  assert.equal(loaded.helperTokens.get("mama"), "helper-token");

  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map());
  loaded = loadSecrets();
  assert.equal(loaded.passwords.get("spark"), "ssh-secret");
  assert.equal(loaded.llmApiKeys.size, 0);
  assert.equal(loaded.helperTokens.get("mama"), "helper-token");

  saveHelperTokens(new Map());
  loaded = loadSecrets();
  assert.equal(loaded.helperTokens.size, 0);
  assert.equal(loaded.passwords.get("spark"), "ssh-secret");
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), true);

  saveSecrets(new Map(), new Map());
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), false);
});

test("a wrong key skips the blob and a helper save keeps the original ciphertext", () => {
  saveSecrets(new Map(), new Map([["spark", { "8000": "sk-test" }]]));
  const before = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8"));
  before.llmApiKeys.spark = Buffer.from("not-a-real-ciphertext").toString("base64");
  fs.writeFileSync(process.env.SPARKS_SECRETS_PATH, JSON.stringify(before));
  const loaded = loadSecrets();
  assert.equal(loaded.llmApiKeys.size, 0);
  saveHelperTokens(new Map([["mama", "helper-token"]]));
  const after = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8"));
  assert.equal(after.llmApiKeys.spark, before.llmApiKeys.spark);
  assert.equal(loadSecrets().helperTokens.get("mama"), "helper-token");
});

test("corrupt secrets are not overwritten", () => {
  fs.writeFileSync(process.env.SPARKS_SECRETS_PATH, "{not json");
  const before = fs.readFileSync(process.env.SPARKS_SECRETS_PATH);
  assert.throws(() => saveHelperTokens(new Map([["mama", "helper-token"]])), /corrupt/);
  assert.deepEqual(fs.readFileSync(process.env.SPARKS_SECRETS_PATH), before);
  assert.equal(loadSecrets().helperTokens.size, 0);
});

test("atomic write failure leaves the previous secrets file", () => {
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map());
  const before = fs.readFileSync(process.env.SPARKS_SECRETS_PATH);
  fs.chmodSync(tmp, 0o500);
  try {
    assert.throws(() => saveHelperTokens(new Map([["mama", "helper-token"]])), /Failed to write/);
  } finally {
    fs.chmodSync(tmp, 0o700);
  }
  assert.deepEqual(fs.readFileSync(process.env.SPARKS_SECRETS_PATH), before);
});

test("a missing encryption key refuses to replace the secrets file", () => {
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  saveSecrets(new Map([["spark", "ssh-secret"]]), new Map([["spark", { "8000": "sk-test" }]]));
  const before = fs.readFileSync(process.env.SPARKS_SECRETS_PATH);
  fs.rmSync(process.env.SECRETS_KEY_PATH, { force: true });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { saveHelperTokens, loadSecrets } = await import(${JSON.stringify(path.join(process.cwd(), "server/secretsStore.js"))});
       const loaded = loadSecrets();
       if (loaded.passwords.size || loaded.llmApiKeys.size) process.exit(2);
       try { saveHelperTokens(new Map([["mama", "x"]])); process.exit(3); }
       catch (err) { if (!/key file is missing|Cannot read secrets key/.test(err.message)) { console.error(err); process.exit(4); } }`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SPARKDASH_SECRETS_KEY: "",
        SPARKS_SECRETS_PATH: process.env.SPARKS_SECRETS_PATH,
        SECRETS_KEY_PATH: process.env.SECRETS_KEY_PATH,
      },
      encoding: "utf8",
    }
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(fs.readFileSync(process.env.SPARKS_SECRETS_PATH), before);
});
});
