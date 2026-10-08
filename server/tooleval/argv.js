import { ARG_SPEC, specByName } from "./spec.js";

/**
 * Turn the options a user set in the UI into the argument list for `tool-eval-bench`.
 *
 * Nothing here is ever interpolated into a shell string: arguments travel as separate,
 * NUL-delimited items (see commands.js), so values need no quoting. Values are still
 * validated hard (types, ranges, choices, patterns) so a bad form fails fast with a
 * readable message instead of a confusing tool error. Secrets (API key, header values)
 * are returned separately and reach the tool through its environment, not argv.
 */

const MAX_TEXT = 32 * 1024;
const LINK_LOCAL = /^(169\.254\.|fe80:|\[fe80:)/i;
const SAFE_EXTRA_VALUE = /^[A-Za-z0-9._:/@+=,~%-]{1,300}$/;
const SAFE_EXTRA_FLAG = /^--[a-z0-9][a-z0-9-]{0,60}$/;
/** Flags the server controls; a user may not pass them, not even through "additional arguments". */
const MANAGED = new Set([
  "json", "json-file", "no-live", "version", "probe", "dry-run", "history", "leaderboard", "export", "export-output",
  "compare", "redact-url", "spec-live", "decision-live", "spec-live-interval", "decision-live-interval", "skip-coherence",
]);

const hasBad = (s) => /[\0\r\n]/.test(s);

function validatePath(v, label) {
  if (typeof v !== "string" || !/^(~\/|\/)[A-Za-z0-9._@+=,/ -]{0,300}$/.test(v)) {
    return `${label} must be an absolute path (or start with ~/)`;
  }
  if (v.split("/").some((seg) => seg === "..")) return `${label} must not contain ..`;
  return null;
}

export function validateBaseUrl(v, label = "URL") {
  let u;
  try {
    u = new URL(v);
  } catch {
    return `${label} is not a valid URL`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${label} must start with http:// or https://`;
  if (u.username || u.password) return `${label} must not contain credentials (use the API key field)`;
  if (LINK_LOCAL.test(u.hostname)) return `${label} points at a link-local address, which is not allowed`;
  if (v.length > 500) return `${label} is too long`;
  return null;
}

/** @returns {string|null} error */
function validateOne(spec, value) {
  const label = spec.label;
  switch (spec.kind) {
    case "bool":
      return typeof value === "boolean" ? null : `${label} must be on or off`;
    case "int": {
      if (!Number.isInteger(value)) return `${label} must be a whole number`;
      if (spec.min != null && value < spec.min) return `${label} must be at least ${spec.min}`;
      if (spec.max != null && value > spec.max) return `${label} must be at most ${spec.max}`;
      return null;
    }
    case "float": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a number`;
      if (spec.min != null && value < spec.min) return `${label} must be at least ${spec.min}`;
      if (spec.max != null && value > spec.max) return `${label} must be at most ${spec.max}`;
      return null;
    }
    case "choice":
      return spec.choices.includes(value) ? null : `${label} must be one of ${spec.choices.join(", ")}`;
    case "string":
    case "csv":
    case "range": {
      if (typeof value !== "string" || !value.trim()) return `${label} must not be empty`;
      if (hasBad(value)) return `${label} must be a single line`;
      if (value.length > (spec.maxLen ?? 500)) return `${label} is too long`;
      if (spec.pattern && !spec.pattern.test(value)) return `${label} has an invalid format`;
      return null;
    }
    case "text": {
      if (typeof value !== "string" || !value.trim()) return `${label} must not be empty`;
      if (value.includes("\0")) return `${label} contains an invalid character`;
      if (Buffer.byteLength(value, "utf8") > (spec.maxBytes ?? MAX_TEXT)) return `${label} is longer than ${(spec.maxBytes ?? MAX_TEXT) / 1024} KiB`;
      return null;
    }
    case "path":
      return validatePath(value, label);
    case "url":
      return validateBaseUrl(value, label);
    case "json": {
      if (typeof value !== "string" || !value.trim() || value.length > (spec.maxLen ?? 4000) || value.includes("\0")) {
        return `${label} must be a JSON object`;
      }
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : `${label} must be a JSON object`;
      } catch {
        return `${label} is not valid JSON`;
      }
    }
    case "list": {
      if (!Array.isArray(value) || value.length === 0) return `${label} must be a non-empty list`;
      if (value.length > (spec.maxItems ?? 100)) return `${label} has too many items`;
      for (const item of value) {
        if (typeof item !== "string" || (spec.itemPattern && !spec.itemPattern.test(item))) return `${label} has an invalid item "${String(item).slice(0, 40)}"`;
      }
      return null;
    }
    case "repeat": {
      if (!Array.isArray(value) || value.length === 0) return `${label} must be a non-empty list`;
      if (value.length > (spec.maxItems ?? 20)) return `${label} has too many items`;
      for (const item of value) {
        if (typeof item !== "string" || hasBad(item) || (spec.itemPattern && !spec.itemPattern.test(item))) {
          return `${label} has an invalid entry "${String(item).slice(0, 40)}"`;
        }
      }
      return null;
    }
    default:
      return `${label} cannot be set`;
  }
}

/** True when an option value means "not set" (the form sends empty strings / arrays for blanks). */
function isBlank(v) {
  return v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Display form of the command line with secrets masked (safe to show and to store). */
function displayCommand(argv) {
  return ["tool-eval-bench", ...argv.map((a) => (/^[A-Za-z0-9._:/@+=,~%-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''").slice(0, 120)}${a.length > 120 ? "…" : ""}'`))].join(" ");
}

/**
 * @param {Record<string, unknown>} options  values keyed by option name (e.g. { "base-url": "...", short: true })
 * @param {{ defaultBaseUrl?: string|null, savedApiKey?: string|null, extra?: string[], forPreview?: boolean }} [ctx]
 * @returns {{ ok: true, argv: string[], env: Record<string,string>, display: string, redacted: Record<string, unknown> }
 *          | { ok: false, errors: string[] }}
 */
export function buildToolEvalArgs(options, ctx = {}) {
  const errors = [];
  const argv = [];
  const env = {};
  const redacted = {};
  const opts = options && typeof options === "object" ? options : {};

  for (const name of Object.keys(opts)) {
    if (!specByName(name) && name !== "extra") errors.push(`Unknown option "${name}"`);
  }

  for (const spec of ARG_SPEC) {
    const value = opts[spec.name];
    if (spec.kind === "secret") continue; // handled below
    if (isBlank(value)) continue;
    const err = validateOne(spec, value);
    if (err) {
      errors.push(err);
      continue;
    }
    redacted[spec.name] = spec.secret ? "(hidden)" : value;
    if (spec.secret && spec.kind === "repeat") continue; // header values go through the environment
    switch (spec.kind) {
      case "bool":
        argv.push(spec.flag);
        break;
      case "list":
        argv.push(spec.flag, ...value.map((v) => (spec.name === "categories" ? v.toUpperCase() : v)));
        break;
      case "repeat":
        for (const item of value) argv.push(spec.flag, item);
        break;
      default:
        argv.push(spec.flag, String(value));
    }
  }

  // Headers: values are secrets, so they ride in TOOL_EVAL_HEADERS (';'-separated), never argv.
  const headers = opts.header;
  if (!isBlank(headers) && Array.isArray(headers) && !errors.some((e) => e.startsWith("Extra request headers"))) {
    env.TOOL_EVAL_HEADERS = headers.join(";");
  }

  // Connection defaults: this Spark's own LLM endpoint, unless a provider or URL was chosen.
  if (isBlank(opts["base-url"]) && isBlank(opts.provider) && ctx.defaultBaseUrl) {
    const err = validateBaseUrl(ctx.defaultBaseUrl, "Default URL");
    if (err) errors.push(err);
    else argv.push("--base-url", ctx.defaultBaseUrl);
  }

  // API key: typed in the form, else the key saved for the port. Env only.
  const typedKey = opts["api-key"];
  if (!isBlank(typedKey)) {
    if (typeof typedKey !== "string" || hasBad(typedKey) || typedKey.length > 1000) errors.push("API key has an invalid format");
    else env.TOOL_EVAL_API_KEY = typedKey;
    redacted["api-key"] = "(hidden)";
  } else if (ctx.savedApiKey) {
    env.TOOL_EVAL_API_KEY = ctx.savedApiKey;
    redacted["api-key"] = "(saved key)";
  }

  // Mutually exclusive prompt sources.
  if (!isBlank(opts["system-prompt"]) && !isBlank(opts["system-prompt-file"])) {
    errors.push("Use either the system prompt text or the system prompt file, not both");
  }
  if (!isBlank(opts["context-pressure"]) && !isBlank(opts["context-pressure-sweep"])) {
    errors.push("Use either a single context pressure or a sweep, not both");
  }
  if (!isBlank(opts.short) && !isBlank(opts.scenarios)) {
    errors.push("A short run and a specific scenario list cannot be combined");
  }

  // Additional raw arguments: flags and plain values only, argv-only so no shell is involved.
  const extra = Array.isArray(opts.extra) ? opts.extra : [];
  if (extra.length > 40) errors.push("Too many additional arguments");
  for (const tok of extra.slice(0, 40)) {
    if (typeof tok !== "string") {
      errors.push("Additional arguments must be text");
      continue;
    }
    if (tok.startsWith("--")) {
      if (!SAFE_EXTRA_FLAG.test(tok)) errors.push(`Additional argument "${tok.slice(0, 40)}" is not a valid flag`);
      else if (MANAGED.has(tok.slice(2))) errors.push(`${tok} is controlled by sparkDash and cannot be set here`);
      else argv.push(tok);
    } else if (!SAFE_EXTRA_VALUE.test(tok)) {
      errors.push(`Additional argument "${tok.slice(0, 40)}" has unsupported characters`);
    } else argv.push(tok);
  }
  if (extra.length) redacted.extra = extra.slice(0, 40);

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, argv, env, display: displayCommand(argv), redacted };
}

/** Split a free-form "additional arguments" line into tokens (whitespace separated; no quoting). */
export function splitExtraArgs(line) {
  return typeof line === "string" ? line.trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * Whether the key saved for a Spark's LLM port may go with a run against `baseUrl`.
 * Only for that Spark's own server (no URL, or a loopback one): a key saved for the local
 * port must never be sent to a custom endpoint someone else operates.
 */
export function mayUseSavedKey(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return true;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `http://${baseUrl.trim()}`);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}
