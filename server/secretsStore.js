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
 *     llmApiKeys: { [sparkId]: "<encrypted JSON { \"8000\": \"sk-…\" }>" },
 *     alertChannels: { [channelId]: "<encrypted alert channel URL>" },   (optional)
 *     helperTokens: { [helperId]: "<encrypted helper bearer>" }          (optional)
 *   }
 *
 * Alert channel URLs (an ntfy topic, a Discord or Slack webhook) are the
 * channel's credential, so they live here too, written by their own save
 * function. Harness helper bearer tokens live in helperTokens, written by
 * saveHelperTokens. Each save keeps the other sections exactly as they are
 * on disk, including ciphertext this process cannot decrypt.
 *
 * v1 files (secrets only) still load; rewritten as v2 on next save.
 * A save replaces only the namespaces the caller supplies. An empty map clears
 * that namespace. The file is removed only when every namespace is empty.
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
 *   helperTokens: Map<string, string>,
 * }}
 */
export function loadSecrets() {
  /** @type {Map<string, string>} */
  const passwords = new Map();
  /** @type {Map<string, Record<string, string>>} */
  const llmApiKeys = new Map();
  /** @type {Map<string, string>} */
  const helperTokens = new Map();

  if (!fs.existsSync(SPARKS_SECRETS_PATH)) {
    return { passwords, llmApiKeys, helperTokens };
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

    const helperEntries = data?.helperTokens || {};
    if (typeof helperEntries === "object" && helperEntries !== null && !Array.isArray(helperEntries)) {
      let failedHelpers = 0;
      for (const [id, blob] of Object.entries(helperEntries)) {
        if (!id || typeof blob !== "string") continue;
        try {
          const token = decrypt(blob, key);
          if (token) helperTokens.set(id, token);
        } catch {
          failedHelpers += 1;
          console.error(
            `[secretsStore] Failed to decrypt helper token for ${id} (wrong/missing key?)`
          );
        }
      }
      if (helperTokens.size > 0) {
        console.log(`[secretsStore] Loaded ${helperTokens.size} helper token(s) from encrypted store`);
      }
      if (failedHelpers > 0) {
        console.warn(
          `[secretsStore] ${failedHelpers} helper token(s) could not be decrypted — re-enter in the harness wizard`
        );
      }
    }
  } catch (err) {
    console.error(`[secretsStore] Failed to load secrets: ${err.message}`);
  }

  return { passwords, llmApiKeys, helperTokens };
}

/**
 * Persist SSH passwords + per-port LLM API keys (encrypted).
 * Alert channel URLs and helper tokens already on disk are kept.
 * The file is removed only when every namespace is empty.
 *
 * @param {Map<string, string>} passwords
 * @param {Map<string, Record<string, string>>} [llmApiKeys]
 */
export function saveSecrets(passwords, llmApiKeys = new Map()) {
  const alertChannels = readRawSection("alertChannels");
  const helperTokens = readRawSection("helperTokens");
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

  if (
    !hasPasswords &&
    !hasKeys &&
    Object.keys(alertChannels).length === 0 &&
    Object.keys(helperTokens).length === 0
  ) {
    clearSecretsFile();
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

  writeSecretsFile({ secrets, llmApiKeys: llmOut, alertChannels, helperTokens });
  const keyCount = Object.keys(llmOut).length;
  console.log(
    `[secretsStore] Saved ${Object.keys(secrets).length} SSH password(s)` +
      (keyCount ? `, ${keyCount} LLM API key bundle(s)` : "")
  );
}

/** Helper bearers currently decryptable with this process's key. */
export function loadHelperTokens() {
  return loadSecrets().helperTokens;
}

/**
 * Replace only helper-attach bearers. SSH passwords, LLM keys and alert
 * channel URLs stay as stored, including ciphertext that cannot be decrypted.
 * A file that cannot be parsed is left untouched.
 * @param {Map<string, string>} helperTokens
 */
export function saveHelperTokens(helperTokens) {
  let secrets;
  let llmApiKeys;
  let alertChannels;
  try {
    secrets = readRawSection("secrets");
    llmApiKeys = readRawSection("llmApiKeys");
    alertChannels = readRawSection("alertChannels");
  } catch (err) {
    throw new Error(`secrets file is corrupt: ${err.message}`);
  }
  const entries = helperTokens ? [...helperTokens.entries()].filter(([id, token]) => id && token) : [];
  const key = entries.length > 0 ? resolveKey() : null;
  /** @type {Record<string, string>} */
  const helpers = {};
  for (const [id, token] of entries) helpers[String(id)] = encrypt(String(token), key);
  if (
    Object.keys(secrets).length === 0 &&
    Object.keys(llmApiKeys).length === 0 &&
    Object.keys(alertChannels).length === 0 &&
    Object.keys(helpers).length === 0
  ) {
    clearSecretsFile();
    return;
  }
  writeSecretsFile({ secrets, llmApiKeys, alertChannels, helperTokens: helpers });
}

// ─── File sections ───────────────────────────────────────

/**
 * One section of the file as stored (still encrypted); {} when the file or the section is absent.
 * Throws when the file exists but cannot be parsed: callers that go on to rewrite the file
 * must not treat that as "nothing stored", or the other sections would be lost.
 */
function readRawSection(name) {
  if (!fs.existsSync(SPARKS_SECRETS_PATH)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SPARKS_SECRETS_PATH, "utf8"));
  } catch (err) {
    throw new Error(
      `${SPARKS_SECRETS_PATH} exists but cannot be read (${err.message}); not overwriting it. ` +
        "Fix or move the file aside to continue."
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${SPARKS_SECRETS_PATH} is not a JSON object; not overwriting it. Fix or move the file aside to continue.`);
  }
  const section = data[name];
  if (!section || typeof section !== "object" || Array.isArray(section)) return {};
  return Object.fromEntries(Object.entries(section).filter(([id, blob]) => id && typeof blob === "string"));
}

function clearSecretsFile() {
  if (!fs.existsSync(SPARKS_SECRETS_PATH)) return;
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

/** Write every section. Empty alertChannels and helperTokens sections are left out of the file. */
function writeSecretsFile({ secrets, llmApiKeys, alertChannels, helperTokens }) {
  const body = { version: 2, secrets, llmApiKeys };
  if (alertChannels && Object.keys(alertChannels).length > 0) body.alertChannels = alertChannels;
  if (helperTokens && Object.keys(helperTokens).length > 0) body.helperTokens = helperTokens;
  atomicWrite(SPARKS_SECRETS_PATH, JSON.stringify(body, null, 2) + "\n", 0o644);
}

// ─── Alert channel URLs ──────────────────────────────────

/**
 * Decrypted alert channel URLs, channel id → URL. A URL that cannot be
 * decrypted is left out (and logged); never throws.
 * @returns {Map<string, string>}
 */
export function loadAlertChannelUrls() {
  /** @type {Map<string, string>} */
  const urls = new Map();
  let section;
  try {
    section = readRawSection("alertChannels");
  } catch (err) {
    console.error(`[secretsStore] Failed to load alert channel URLs: ${err.message}`);
    return urls;
  }
  if (Object.keys(section).length === 0) return urls;
  let failed = 0;
  try {
    const key = resolveKey();
    for (const [id, blob] of Object.entries(section)) {
      try {
        const url = decrypt(blob, key);
        if (url) urls.set(id, url);
      } catch {
        failed += 1;
      }
    }
  } catch (err) {
    console.error(`[secretsStore] Failed to load alert channel URLs: ${err.message}`);
    return urls;
  }
  if (failed > 0) {
    console.warn(`[secretsStore] ${failed} alert channel URL(s) could not be decrypted — enter them again under Settings → Alerts`);
  }
  return urls;
}

/**
 * Replace the stored alert channel URLs (encrypted). SSH passwords, LLM API
 * keys and helper tokens stay exactly as they are on disk. Throws when the file cannot be read or written.
 * A stored URL that cannot be decrypted (for example after a key change) is kept as is
 * while its channel is still configured, so entering the key again brings it back.
 * @param {Map<string, string>} urls channel id → URL
 * @param {{ keepIds?: Iterable<string> }} [opts] ids of the channels that are still configured
 */
export function saveAlertChannelUrls(urls, opts = {}) {
  const secrets = readRawSection("secrets");
  const llmApiKeys = readRawSection("llmApiKeys");
  const helperTokens = readRawSection("helperTokens");
  const existing = readRawSection("alertChannels");
  /** @type {Record<string, string>} */
  const alertChannels = {};
  const entries = urls ? [...urls.entries()].filter(([id, url]) => id && url) : [];
  const keep = new Set(opts.keepIds || []);
  const needKey = entries.length > 0 || Object.keys(existing).length > 0;
  const key = needKey ? resolveKey() : null;
  for (const [id, url] of entries) alertChannels[id] = encrypt(String(url), key);
  for (const [id, blob] of Object.entries(existing)) {
    if (alertChannels[id] || !keep.has(id)) continue;
    try {
      decrypt(blob, key);
    } catch {
      alertChannels[id] = blob;
    }
  }
  if (
    Object.keys(secrets).length === 0 &&
    Object.keys(llmApiKeys).length === 0 &&
    Object.keys(alertChannels).length === 0 &&
    Object.keys(helperTokens).length === 0
  ) {
    clearSecretsFile();
    return;
  }
  writeSecretsFile({ secrets, llmApiKeys, alertChannels, helperTokens });
}
