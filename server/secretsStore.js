/**
 * Encrypted secrets store — survives process/Docker restarts.
 *
 * Secrets are NEVER written to sparks.json and NEVER returned by the API.
 * They live in:
 *   - memory (Maps) for SSH collectors / LLM probes
 *   - config/sparks-secrets.json (AES-256-GCM ciphertext, volume-mounted)
 *
 * File shape (v2):
 *   {
 *     version: 2,
 *     secrets: { [sparkId]: "<encrypted ssh password>" },
 *     llmApiKeys: { [sparkId]: "<encrypted JSON { \"8000\": \"sk-…\" }>" }
 *   }
 *
 * v1 files (secrets only) still load; rewritten as v2 on next save.
 *
 * Encryption key:
 *   - SPARKDASH_SECRETS_KEY env (passphrase or 64-char hex), or
 *   - auto-generated config/.secrets-key (persists with ./config volume)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { SPARKS_SECRETS_PATH, SECRETS_KEY_PATH } from "./config.js";
import { atomicWrite } from "./util/atomicWrite.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Cached key so we never regenerate mid-process. */
let _cachedKey = null;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function keyFromString(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  return crypto.createHash("sha256").update(t, "utf8").digest();
}

/**
 * Resolve a 32-byte key.
 * NEVER overwrites an existing key file (that would orphan encrypted secrets).
 * @returns {Buffer}
 */
function resolveKey() {
  if (_cachedKey) return _cachedKey;

  const fromEnv = process.env.SPARKDASH_SECRETS_KEY;
  if (fromEnv && String(fromEnv).trim()) {
    _cachedKey = keyFromString(fromEnv);
    return _cachedKey;
  }

  if (fs.existsSync(SECRETS_KEY_PATH)) {
    try {
      const raw = fs.readFileSync(SECRETS_KEY_PATH, "utf8").trim();
      if (!raw) throw new Error("key file is empty");
      _cachedKey = keyFromString(raw);
      return _cachedKey;
    } catch (err) {
      throw new Error(
        `Cannot read secrets key at ${SECRETS_KEY_PATH}: ${err.message}. ` +
          `Fix permissions or set SPARKDASH_SECRETS_KEY.`
      );
    }
  }

  if (fs.existsSync(SPARKS_SECRETS_PATH)) {
    throw new Error(
      `Encrypted secrets exist at ${SPARKS_SECRETS_PATH} but key file is missing (${SECRETS_KEY_PATH}). ` +
        `Restore .secrets-key or re-enter passwords after deleting sparks-secrets.json.`
    );
  }

  const key = crypto.randomBytes(KEY_LEN);
  ensureDir(SECRETS_KEY_PATH);
  try {
    fs.writeFileSync(SECRETS_KEY_PATH, key.toString("hex") + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(SECRETS_KEY_PATH, 0o600);
    } catch {
      /* best-effort */
    }
    console.log(`[secretsStore] Generated encryption key at ${SECRETS_KEY_PATH}`);
  } catch (err) {
    throw new Error(`Failed to write secrets key: ${err.message}`);
  }
  _cachedKey = key;
  return key;
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(blobB64, key) {
  const buf = Buffer.from(blobB64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * @returns {{
 *   passwords: Map<string, string>,
 *   llmApiKeys: Map<string, Record<string, string>>,
 * }}
 */
export function loadSecrets() {
  /** @type {Map<string, string>} */
  const passwords = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const llmApiKeys = new Map();

  if (!fs.existsSync(SPARKS_SECRETS_PATH)) {
    return { passwords, llmApiKeys };
  }

  try {
    const key = resolveKey();
    const raw = fs.readFileSync(SPARKS_SECRETS_PATH, "utf8");
    const data = JSON.parse(raw);
    const entries = data?.secrets || {};
    if (typeof entries === "object" && entries !== null) {
      let failed = 0;
      for (const [id, blob] of Object.entries(entries)) {
        if (!id || typeof blob !== "string") continue;
        try {
          const pw = decrypt(blob, key);
          if (pw) passwords.set(id, pw);
        } catch {
          failed += 1;
          console.error(
            `[secretsStore] Failed to decrypt password for ${id} (wrong/missing key?)`
          );
        }
      }
      if (passwords.size > 0) {
        console.log(`[secretsStore] Loaded ${passwords.size} SSH password(s) from encrypted store`);
      }
      if (failed > 0) {
        console.warn(
          `[secretsStore] ${failed} password(s) could not be decrypted — re-enter via Edit Spark`
        );
      }
    }

    const keyEntries = data?.llmApiKeys || {};
    if (typeof keyEntries === "object" && keyEntries !== null) {
      let failed = 0;
      let portCount = 0;
      for (const [id, blob] of Object.entries(keyEntries)) {
        if (!id || typeof blob !== "string") continue;
        try {
          const json = decrypt(blob, key);
          const parsed = JSON.parse(json);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          /** @type {Record<string, string>} */
          const ports = {};
          for (const [port, apiKey] of Object.entries(parsed)) {
            if (!apiKey || typeof apiKey !== "string") continue;
            ports[String(port)] = apiKey;
            portCount += 1;
          }
          if (Object.keys(ports).length > 0) llmApiKeys.set(id, ports);
        } catch {
          failed += 1;
          console.error(
            `[secretsStore] Failed to decrypt LLM API keys for ${id} (wrong/missing key?)`
          );
        }
      }
      if (portCount > 0) {
        console.log(`[secretsStore] Loaded ${portCount} LLM API key(s) from encrypted store`);
      }
      if (failed > 0) {
        console.warn(
          `[secretsStore] ${failed} LLM API key bundle(s) could not be decrypted — re-enter via LLM Settings`
        );
      }
    }
  } catch (err) {
    console.error(`[secretsStore] Failed to load secrets: ${err.message}`);
  }

  return { passwords, llmApiKeys };
}

/**
 * Persist SSH passwords + per-port LLM API keys (encrypted).
 * Empty maps remove the file when both are empty.
 *
 * @param {Map<string, string>} passwords
 * @param {Map<string, Record<string, string>>} [llmApiKeys]
 */
export function saveSecrets(passwords, llmApiKeys = new Map()) {
  const hasPasswords = passwords && passwords.size > 0;
  let hasKeys = false;
  if (llmApiKeys) {
    for (const ports of llmApiKeys.values()) {
      if (ports && Object.keys(ports).length > 0) {
        hasKeys = true;
        break;
      }
    }
  }

  if (!hasPasswords && !hasKeys) {
    if (fs.existsSync(SPARKS_SECRETS_PATH)) {
      try {
        fs.accessSync(SPARKS_SECRETS_PATH, fs.constants.W_OK);
        fs.unlinkSync(SPARKS_SECRETS_PATH);
      } catch (err) {
        throw new Error(
          `Failed to clear secrets file (permission?): ${err.message}. ` +
            `Run: sudo chown -R $(id -u):$(id -g) config/sparks-secrets.json`
        );
      }
    }
    return;
  }

  const key = resolveKey();
  const secrets = {};
  if (passwords) {
    for (const [id, pw] of passwords.entries()) {
      if (pw) secrets[id] = encrypt(pw, key);
    }
  }

  /** @type {Record<string, string>} */
  const llmOut = {};
  if (llmApiKeys) {
    for (const [id, ports] of llmApiKeys.entries()) {
      if (!ports || typeof ports !== "object") continue;
      const clean = {};
      for (const [port, apiKey] of Object.entries(ports)) {
        if (apiKey) clean[String(port)] = String(apiKey);
      }
      if (Object.keys(clean).length === 0) continue;
      llmOut[id] = encrypt(JSON.stringify(clean), key);
    }
  }

  const payload =
    JSON.stringify({ version: 2, secrets, llmApiKeys: llmOut }, null, 2) + "\n";
  atomicWrite(SPARKS_SECRETS_PATH, payload, 0o644);
  const keyCount = Object.keys(llmOut).length;
  console.log(
    `[secretsStore] Saved ${Object.keys(secrets).length} SSH password(s)` +
      (keyCount ? `, ${keyCount} LLM API key bundle(s)` : "")
  );
}
