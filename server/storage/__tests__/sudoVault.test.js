import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SudoVault } from "../sudoVault.js";

// A reversible stand-in for the real cipher: the point here is what is stored where, not the AES.
const crypt = { encrypt: (p) => `enc:${Buffer.from(p).toString("base64")}`, decrypt: (b) => Buffer.from(b.replace(/^enc:/, ""), "base64").toString() };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sudovault-"));

test("a remembered password survives a new vault on the same file, and the file holds no plaintext", () => {
  const dir = tmp();
  const file = path.join(dir, "storage-sudo.json");
  try {
    const a = new SudoVault({ file, ...crypt });
    assert.equal(a.has("me@10.0.0.5:22"), false);
    a.set("me@10.0.0.5:22", "hunter2-secret");
    assert.equal(a.get("me@10.0.0.5:22"), "hunter2-secret");
    assert.ok(!fs.readFileSync(file, "utf8").includes("hunter2-secret"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const b = new SudoVault({ file, ...crypt });
    assert.equal(b.has("me@10.0.0.5:22"), true);
    assert.equal(b.get("me@10.0.0.5:22"), "hunter2-secret");
    assert.equal(b.get("someone@else:22"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("forgetting removes it from memory and from the file (the file goes when it is empty)", () => {
  const dir = tmp();
  const file = path.join(dir, "v.json");
  try {
    const v = new SudoVault({ file, ...crypt });
    v.set("a", "pw1");
    v.set("b", "pw2");
    assert.equal(v.delete("a"), true);
    assert.equal(v.delete("a"), false);
    assert.equal(new SudoVault({ file, ...crypt }).has("a"), false);
    assert.equal(new SudoVault({ file, ...crypt }).get("b"), "pw2");
    v.delete("b");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable file or a password that cannot be decrypted is treated as nothing remembered", () => {
  const dir = tmp();
  const file = path.join(dir, "v.json");
  try {
    fs.writeFileSync(file, "{ not json");
    assert.equal(new SudoVault({ file, ...crypt }).has("a"), false);
    const v = new SudoVault({ file: null, encrypt: crypt.encrypt, decrypt: () => { throw new Error("bad key"); } });
    v.set("a", "pw");
    assert.equal(v.has("a"), true);
    assert.equal(v.get("a"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure to write is reported and nothing is kept in memory either", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "blocked", "v.json");
    fs.writeFileSync(path.join(dir, "blocked"), "a file where a folder is needed");
    const v = new SudoVault({ file, ...crypt });
    assert.throws(() => v.set("a", "pw"));
    assert.equal(v.has("a"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real cipher round-trips through the secrets key", async () => {
  const dir = tmp();
  process.env.SECRETS_KEY_PATH = path.join(dir, ".secrets-key");
  process.env.SPARKS_SECRETS_PATH = path.join(dir, "sparks-secrets.json");
  try {
    const { encryptSecret, decryptSecret } = await import(`../../secretsStore.js?vault=${Date.now()}`);
    const blob = encryptSecret("correct horse");
    assert.ok(!blob.includes("correct"));
    assert.equal(decryptSecret(blob), "correct horse");
    assert.throws(() => decryptSecret(blob.slice(0, -4) + "AAAA"));
  } finally {
    delete process.env.SECRETS_KEY_PATH;
    delete process.env.SPARKS_SECRETS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
