/**
 * alerts.json — rule overrides, channel settings and the firing set. No URLs.
 *
 * A channel URL is the channel's credential (an ntfy topic, a Discord or Slack
 * webhook), so it lives in the encrypted secrets store next to SSH passwords and
 * LLM API keys (secretsStore.saveAlertChannelUrls); this file keeps only the
 * channel's id, name, type, switch and minimum severity. A file written by an
 * earlier build may still hold plaintext URLs: `loadAlertsFile` hands them back
 * as `legacyUrls` so the runtime can move them into the store and rewrite the
 * file without them.
 *
 * The API never returns a URL whole: `maskUrl()` keeps scheme + host and
 * replaces the rest with a fixed `/…`, and a PUT that sends the masked value
 * back keeps the stored URL.
 *
 * The firing set is persisted here too, so `startsAt` survives a restart.
 */
import fs from "fs";
import crypto from "crypto";
import { atomicWrite } from "../util/atomicWrite.js";
import { MAX_FOR_SEC, RULES, SEVERITIES, ruleById } from "./conditions.js";
import { channelUrlProblem } from "./outbound.js";
import { MAX_NAME_CHARS } from "./text.js";

export const CHANNEL_TYPES = Object.freeze(["ntfy", "discord", "slack", "webhook"]);
export const MAX_CHANNELS = 20;
/** Repeat reminders: 0 = off, otherwise 5 minutes … 7 days. */
export const REPEAT_MIN_MINUTES = 5;
export const REPEAT_MAX_MINUTES = 7 * 24 * 60;
const MAX_URL_CHARS = 2048;

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Fresh config: no overrides, no channels, reminders off. */
export function defaultConfig() {
  return { version: 2, repeatIntervalMin: 0, rules: {}, channels: [] };
}

// ─── URLs ───────────────────────────────────────────────

/** A channel URL the outbound policy allows, normalised, or a ValidationError. */
export function validateChannelUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new ValidationError("Channel URL is required");
  if (value.length > MAX_URL_CHARS) throw new ValidationError("Channel URL is too long");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Channel URL is not a valid URL");
  }
  const problem = channelUrlProblem(url);
  if (problem) throw new ValidationError(problem);
  return url.href;
}

/**
 * `https://ntfy.sh/…` — the host, to recognise the service, and a fixed mask for
 * the rest, so nothing of the topic or webhook token is shown (not even its
 * length or last characters). Credentials in the URL (user:pass@) are never shown.
 */
export function maskUrl(raw) {
  if (typeof raw !== "string" || !raw) return "";
  let origin = "";
  try {
    const url = new URL(raw);
    origin = `${url.protocol}//${url.host}`;
  } catch {
    origin = "";
  }
  return `${origin}/${URL_MASK}`;
}

const URL_MASK = "…";

function isMasked(value) {
  return typeof value === "string" && value.includes(URL_MASK);
}

// ─── Validation ─────────────────────────────────────────

function num(value, label, min, max) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${label} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${label} must be between ${min} and ${max}`);
  return n;
}

/**
 * Rule overrides: only `enabled` and `forSec` — thresholds belong to the Health
 * findings and the Overview strip. `lenient` (loading a file) drops what it
 * does not know instead of refusing, so a file from an earlier build loads.
 */
function validateRules(input, { lenient = false } = {}) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    if (lenient) return {};
    throw new ValidationError("rules must be an object");
  }
  const out = {};
  for (const [id, override] of Object.entries(input)) {
    const rule = ruleById(id);
    if (!rule) {
      if (lenient) continue;
      throw new ValidationError(`Unknown alert rule: ${id}`);
    }
    if (override == null) continue;
    if (typeof override !== "object" || Array.isArray(override)) {
      if (lenient) continue;
      throw new ValidationError(`Rule ${id} must be an object`);
    }
    const clean = {};
    for (const key of Object.keys(override)) {
      if (key === "enabled") {
        if (typeof override.enabled !== "boolean") {
          if (lenient) continue;
          throw new ValidationError(`${rule.name}: enabled must be true or false`);
        }
        clean.enabled = override.enabled;
      } else if (key === "forSec") {
        try {
          clean.forSec = Math.round(num(override.forSec, `${rule.name}: duration`, 0, MAX_FOR_SEC));
        } catch (err) {
          if (!lenient) throw err;
        }
      } else if (!lenient) {
        throw new ValidationError(`${rule.name}: unknown setting ${key}`);
      }
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

function newChannelId() {
  return `ch_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Validate one channel from a PUT. `existing` is the stored channel with the
 * same id, if any — a masked URL resolves to its stored URL, and only then.
 */
export function validateChannel(input, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Each channel must be an object");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ValidationError("Channel name is required");
  if (name.length > MAX_NAME_CHARS) throw new ValidationError(`Channel name must be at most ${MAX_NAME_CHARS} characters`);
  if (!CHANNEL_TYPES.includes(input.type)) {
    throw new ValidationError(`Channel type must be one of ${CHANNEL_TYPES.join(", ")}`);
  }
  let url;
  if (existing?.url && (input.url === undefined || input.url === maskUrl(existing.url))) {
    url = existing.url;
  } else if (isMasked(input.url)) {
    throw new ValidationError(`${name}: the URL is masked — enter the full URL again`);
  } else {
    url = validateChannelUrl(input.url);
  }
  const minSeverity = input.minSeverity === undefined ? "warning" : input.minSeverity;
  if (!SEVERITIES.includes(minSeverity)) throw new ValidationError("minSeverity must be warning or critical");
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") throw new ValidationError("Channel enabled must be true or false");
  const id = existing?.id ?? (typeof input.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(input.id) ? input.id : newChannelId());
  return { id, name, type: input.type, url, enabled, minSeverity };
}

/**
 * Validate a whole PUT body against the stored config. Omitted top-level keys
 * keep their stored value; `channels`, when sent, is the complete list.
 */
export function validateConfig(body, current = defaultConfig()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be an object");
  const next = { ...defaultConfig(), ...current };
  if (body.repeatIntervalMin !== undefined) {
    const n = Math.round(num(body.repeatIntervalMin, "Repeat interval", 0, REPEAT_MAX_MINUTES));
    if (n !== 0 && n < REPEAT_MIN_MINUTES) {
      throw new ValidationError(`Repeat interval must be 0 (off) or at least ${REPEAT_MIN_MINUTES} minutes`);
    }
    next.repeatIntervalMin = n;
  }
  if (body.rules !== undefined) next.rules = validateRules(body.rules);
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels)) throw new ValidationError("channels must be an array");
    if (body.channels.length > MAX_CHANNELS) throw new ValidationError(`At most ${MAX_CHANNELS} channels`);
    const byId = new Map((current.channels || []).map((c) => [c.id, c]));
    const seen = new Set();
    next.channels = body.channels.map((c) => {
      const existing = typeof c?.id === "string" ? byId.get(c.id) : undefined;
      const clean = validateChannel(c, existing);
      if (seen.has(clean.id)) throw new ValidationError(`Duplicate channel id ${clean.id}`);
      seen.add(clean.id);
      return clean;
    });
  }
  return next;
}

/** The config as the API shows it: URLs masked. */
export function publicConfig(config, channelStatus = new Map()) {
  return {
    repeatIntervalMin: config.repeatIntervalMin,
    rules: RULES.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      source: rule.source,
      defaults: { ...rule.defaults },
      overrides: { ...(config.rules?.[rule.id] || {}) },
    })),
    channels: (config.channels || []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      url: maskUrl(c.url),
      hasUrl: Boolean(c.url),
      enabled: c.enabled,
      minSeverity: c.minSeverity,
      status: channelStatus.get(c.id) || { lastSentAt: null, lastError: null, lastErrorAt: null },
    })),
  };
}

// ─── File ───────────────────────────────────────────────

/** A stored channel (no URL), or null when it is not usable. */
function storedChannel(c) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(c.id)) return null;
  if (!CHANNEL_TYPES.includes(c.type)) return null;
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, MAX_NAME_CHARS) : c.id;
  return {
    id: c.id,
    name,
    type: c.type,
    url: "",
    enabled: c.enabled !== false,
    minSeverity: c.minSeverity === "critical" ? "critical" : "warning",
  };
}

/**
 * Read alerts.json. A missing file is a fresh install; a corrupt one is logged
 * and treated as fresh (never thrown at startup — alerts are optional).
 * Channels come back with `url: ""`; the runtime fills them from the secrets
 * store. `legacyUrls` holds plaintext URLs an earlier build wrote here.
 * @returns {{ config: object, state: object|null, legacyUrls: Map<string, string> }}
 */
export function loadAlertsFile(filePath, log = console) {
  const legacyUrls = new Map();
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") log.error?.(`[alerts] cannot read ${filePath}: ${err.message}`);
    return { config: defaultConfig(), state: null, legacyUrls };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    log.error?.(`[alerts] ${filePath} is not valid JSON (${err.message}); using defaults`);
    return { config: defaultConfig(), state: null, legacyUrls };
  }
  const config = defaultConfig();
  const repeat = Number(data?.repeatIntervalMin);
  if (Number.isFinite(repeat) && (repeat === 0 || (repeat >= REPEAT_MIN_MINUTES && repeat <= REPEAT_MAX_MINUTES))) {
    config.repeatIntervalMin = Math.round(repeat);
  }
  config.rules = validateRules(data?.rules, { lenient: true });
  const seen = new Set();
  for (const c of Array.isArray(data?.channels) ? data.channels.slice(0, MAX_CHANNELS) : []) {
    const channel = storedChannel(c);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    config.channels.push(channel);
    if (typeof c.url === "string" && c.url) {
      try {
        legacyUrls.set(channel.id, validateChannelUrl(c.url));
      } catch (err) {
        log.warn?.(`[alerts] channel "${channel.name}" in ${filePath} has an unusable URL (${err.message}); enter it again`);
      }
    }
  }
  const state = data?.state && typeof data.state === "object" ? data.state : null;
  return { config, state, legacyUrls };
}

/** Write alerts.json — never a URL. */
export function saveAlertsFile(filePath, config, state) {
  const body = {
    version: 2,
    repeatIntervalMin: config.repeatIntervalMin,
    rules: config.rules,
    channels: (config.channels || []).map(({ id, name, type, enabled, minSeverity }) => ({ id, name, type, enabled, minSeverity })),
    state: state ?? null,
  };
  atomicWrite(filePath, JSON.stringify(body, null, 2) + "\n", 0o600);
}
