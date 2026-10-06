/**
 * alerts.json — rule overrides, notification channels, and the firing set.
 *
 * Channel URLs are secrets (an ntfy topic, a Discord or Slack webhook is the
 * credential), so the file is written at mode 0600 and the API never returns a
 * URL whole: `maskUrl()` keeps scheme + host + the last four characters, and a
 * PUT that sends the masked value back keeps the stored URL.
 *
 * The firing set is persisted alongside so `startsAt` survives a restart — an
 * alert that has been firing for an hour must not read "0m" after a deploy.
 */
import fs from "fs";
import crypto from "crypto";
import { atomicWrite } from "../util/atomicWrite.js";
import { RULES, ruleById, SEVERITIES } from "./rules.js";

export const CHANNEL_TYPES = Object.freeze(["ntfy", "discord", "slack", "webhook"]);
export const MAX_CHANNELS = 20;
/** Repeat reminders: 0 = off, otherwise 5 minutes … 7 days. */
export const REPEAT_MIN_MINUTES = 5;
export const REPEAT_MAX_MINUTES = 7 * 24 * 60;
const MAX_FOR_SEC = 24 * 60 * 60;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Fresh config: no overrides, no channels, reminders off. */
export function defaultConfig() {
  return { version: 1, repeatIntervalMin: 0, rules: {}, channels: [] };
}

// ─── URLs ───────────────────────────────────────────────

/** http(s) URL or a ValidationError. Returns the normalised string. */
export function validateChannelUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new ValidationError("Channel URL is required");
  if (value.length > 2048) throw new ValidationError("Channel URL is too long");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Channel URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Channel URL must start with http:// or https://");
  }
  if (!url.hostname) throw new ValidationError("Channel URL needs a host");
  return value;
}

/**
 * `https://ntfy.sh…ab12` — enough to recognise which channel it is, never
 * enough to use it. Credentials in the URL (user:pass@) are never shown.
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
  return `${origin}…${raw.slice(-4)}`;
}

function isMasked(value) {
  return typeof value === "string" && value.includes("…");
}

// ─── Validation ─────────────────────────────────────────

function num(value, label, min, max) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ValidationError(`${label} must be a number`);
  if (n < min || n > max) throw new ValidationError(`${label} must be between ${min} and ${max}`);
  return n;
}

function validateRules(input) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("rules must be an object");
  const out = {};
  for (const [id, override] of Object.entries(input)) {
    const rule = ruleById(id);
    if (!rule) throw new ValidationError(`Unknown alert rule: ${id}`);
    if (override == null) continue;
    if (typeof override !== "object" || Array.isArray(override)) {
      throw new ValidationError(`Rule ${id} must be an object`);
    }
    const clean = {};
    if (override.enabled !== undefined) {
      if (typeof override.enabled !== "boolean") throw new ValidationError(`${rule.name}: enabled must be true or false`);
      clean.enabled = override.enabled;
    }
    if (override.forSec !== undefined) {
      clean.forSec = Math.round(num(override.forSec, `${rule.name}: duration`, 0, MAX_FOR_SEC));
    }
    for (const field of rule.fields) {
      if (override[field.key] === undefined) continue;
      clean[field.key] = num(override[field.key], `${rule.name}: ${field.label}`, field.min, field.max);
    }
    for (const key of Object.keys(override)) {
      if (key !== "enabled" && key !== "forSec" && !rule.fields.some((f) => f.key === key)) {
        throw new ValidationError(`${rule.name}: unknown setting ${key}`);
      }
    }
    // Ordering between the two thresholds of one rule, on the merged values.
    const merged = { ...rule.defaults, ...clean };
    if (id === "gpu_temperature" && merged.warningC > merged.criticalC) {
      throw new ValidationError("GPU temperature: warning must not be above critical");
    }
    if (id === "disk_usage" && merged.warningPct > merged.criticalPct) {
      throw new ValidationError("Disk usage: warning must not be above critical");
    }
    if (id === "memory_headroom") {
      if (merged.unifiedLowGb < merged.unifiedCriticalGb) {
        throw new ValidationError("Memory headroom: GB10 low must not be below GB10 critical");
      }
      if (merged.discreteLowGb < merged.discreteCriticalGb) {
        throw new ValidationError("Memory headroom: discrete low must not be below discrete critical");
      }
    }
    out[id] = clean;
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
  if (name.length > 60) throw new ValidationError("Channel name must be at most 60 characters");
  if (!CHANNEL_TYPES.includes(input.type)) {
    throw new ValidationError(`Channel type must be one of ${CHANNEL_TYPES.join(", ")}`);
  }
  let url;
  if (existing && (input.url === undefined || input.url === maskUrl(existing.url))) {
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
      defaults: { ...rule.defaults },
      fields: rule.fields.map((f) => ({ ...f })),
      overrides: { ...(config.rules?.[rule.id] || {}) },
    })),
    channels: (config.channels || []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      url: maskUrl(c.url),
      enabled: c.enabled,
      minSeverity: c.minSeverity,
      status: channelStatus.get(c.id) || { lastSentAt: null, lastError: null, lastErrorAt: null },
    })),
  };
}

// ─── File ───────────────────────────────────────────────

/**
 * Read alerts.json. A missing file is a fresh install; a corrupt one is logged
 * and treated as fresh (never thrown at startup — alerts are optional).
 */
export function loadAlertsFile(filePath, log = console) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") log.error?.(`[alerts] cannot read ${filePath}: ${err.message}`);
    return { config: defaultConfig(), state: null };
  }
  try {
    const data = JSON.parse(raw);
    let config;
    try {
      config = validateConfig(
        { repeatIntervalMin: data.repeatIntervalMin ?? 0, rules: data.rules ?? {}, channels: data.channels ?? [] },
        defaultConfig()
      );
    } catch (err) {
      log.error?.(`[alerts] ${filePath} has invalid settings (${err.message}); using defaults`);
      config = defaultConfig();
    }
    const state = data.state && typeof data.state === "object" ? data.state : null;
    return { config, state };
  } catch (err) {
    log.error?.(`[alerts] ${filePath} is not valid JSON (${err.message}); using defaults`);
    return { config: defaultConfig(), state: null };
  }
}

export function saveAlertsFile(filePath, config, state) {
  const body = {
    version: 1,
    repeatIntervalMin: config.repeatIntervalMin,
    rules: config.rules,
    channels: config.channels,
    state: state ?? null,
  };
  atomicWrite(filePath, JSON.stringify(body, null, 2) + "\n", 0o600);
}
