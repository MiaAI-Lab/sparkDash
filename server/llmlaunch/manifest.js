/**
 * Optional per-launcher settings.
 *
 * A launcher directory may hold a manifest (`sparkdash-launcher.json`) declaring
 * typed settings, and sparkDash keeps their values in `launcher.env` beside it.
 * The manifest is written by the model's owner, so it is untrusted input: every
 * key, type, bound and option is checked here before a value is shown or written.
 *
 * Values reach the Spark as `KEY=value` lines in a plain env file, which the
 * start script sources. Nothing is quoted, so a value that could need quoting is
 * rejected instead: no spaces, quotes, `$`, backticks, newlines or backslashes.
 * The file is written by commands.js from a base64 payload, so no value is ever
 * pasted into a shell string.
 */

export const MANIFEST_FILE = "sparkdash-launcher.json";
export const ENV_FILE = "launcher.env";
export const MANIFEST_VERSION = 1;
/** A manifest is a short declaration, not a document. */
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_SETTINGS = 32;
export const MAX_STRING_LENGTH = 128;
export const MAX_ENUM_OPTIONS = 64;

/** Environment variable names only: what the start script can read. */
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Conservative allow-list: safe unquoted in a shell-sourced env file. */
const STRING_VALUE_RE = /^[A-Za-z0-9._:@%+=,/-]{0,128}$/;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const TYPES = ["integer", "number", "boolean", "enum", "string"];
const TYPE_SET = new Set(TYPES);

export function isValidSettingKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

/** Printable text with no control characters, trimmed and capped. */
function cleanText(value, max, what) {
  if (typeof value !== "string") return { ok: false, error: `${what} must be a string` };
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: `${what} must not contain control characters` };
  if (text.length > max) return { ok: false, error: `${what} is longer than ${max} characters` };
  return { ok: true, value: text };
}

function toNumber(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return Number.NaN;
  const text = raw.trim();
  if (!NUMBER_RE.test(text)) return Number.NaN;
  return Number(text);
}

/**
 * Check one value against its setting.
 * @returns {{ ok: true, value: string|number|boolean } | { ok: false, error: string }}
 */
export function validateValue(setting, raw) {
  const key = setting.key;
  switch (setting.type) {
    case "integer": {
      const n = toNumber(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `${key} must be a whole number` };
      if (setting.min != null && n < setting.min) return { ok: false, error: `${key} must be at least ${setting.min}` };
      if (setting.max != null && n > setting.max) return { ok: false, error: `${key} must be at most ${setting.max}` };
      return { ok: true, value: n };
    }
    case "number": {
      const n = toNumber(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
      if (setting.min != null && n < setting.min) return { ok: false, error: `${key} must be at least ${setting.min}` };
      if (setting.max != null && n > setting.max) return { ok: false, error: `${key} must be at most ${setting.max}` };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (raw === true || raw === "true") return { ok: true, value: true };
      if (raw === false || raw === "false") return { ok: true, value: false };
      return { ok: false, error: `${key} must be true or false` };
    }
    case "enum": {
      if (typeof raw !== "string" || !setting.options.includes(raw)) {
        return { ok: false, error: `${key} must be one of ${setting.options.join(", ")}` };
      }
      return { ok: true, value: raw };
    }
    case "string": {
      if (typeof raw !== "string" || !STRING_VALUE_RE.test(raw)) {
        return {
          ok: false,
          error: `${key} may only use letters, digits and . _ : @ % + = , / - (128 characters max)`,
        };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: `${key} has an unknown type` };
  }
}

function normalizeSetting(raw, index) {
  const where = `settings[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${where} must be an object` };

  if (!isValidSettingKey(raw.key)) {
    return {
      ok: false,
      error: `${where}.key must be an environment variable name: A-Z, 0-9 and _, starting with a letter, 64 characters max`,
    };
  }
  const key = raw.key;

  const label = cleanText(raw.label, 80, `${where}.label`);
  if (!label.ok) return label;
  if (!label.value) return { ok: false, error: `${where}.label is required` };

  if (!TYPE_SET.has(raw.type)) {
    return { ok: false, error: `${where}.type must be one of ${TYPES.join(", ")}` };
  }
  const type = raw.type;
  const numeric = type === "integer" || type === "number";

  const bounds = {};
  for (const name of ["min", "max"]) {
    const value = raw[name];
    if (value === undefined || value === null) {
      bounds[name] = null;
      continue;
    }
    if (!numeric) return { ok: false, error: `${where}.${name} is only for integer and number settings` };
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `${where}.${name} must be a number` };
    }
    bounds[name] = value;
  }
  if (bounds.min != null && bounds.max != null && bounds.min > bounds.max) {
    return { ok: false, error: `${where}.min is greater than ${where}.max` };
  }

  let step = null;
  if (raw.step !== undefined && raw.step !== null) {
    if (!numeric) return { ok: false, error: `${where}.step is only for integer and number settings` };
    if (typeof raw.step !== "number" || !Number.isFinite(raw.step) || raw.step <= 0) {
      return { ok: false, error: `${where}.step must be a positive number` };
    }
    step = raw.step;
  }

  let options = null;
  if (type === "enum") {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      return { ok: false, error: `${where}.options must be a non-empty array for an enum` };
    }
    if (raw.options.length > MAX_ENUM_OPTIONS) {
      return { ok: false, error: `${where}.options has more than ${MAX_ENUM_OPTIONS} entries` };
    }
    options = [];
    for (const option of raw.options) {
      if (typeof option !== "string" || !STRING_VALUE_RE.test(option) || option === "") {
        return {
          ok: false,
          error: `${where}.options entries may only use letters, digits and . _ : @ % + = , / - (128 characters max)`,
        };
      }
      if (options.includes(option)) return { ok: false, error: `${where}.options repeats ${option}` };
      options.push(option);
    }
  } else if (raw.options !== undefined && raw.options !== null) {
    return { ok: false, error: `${where}.options is only for enum settings` };
  }

  let unit = null;
  if (raw.unit !== undefined && raw.unit !== null) {
    const cleaned = cleanText(raw.unit, 16, `${where}.unit`);
    if (!cleaned.ok) return cleaned;
    unit = cleaned.value || null;
  }

  let help = null;
  if (raw.help !== undefined && raw.help !== null) {
    const cleaned = cleanText(raw.help, 300, `${where}.help`);
    if (!cleaned.ok) return cleaned;
    help = cleaned.value || null;
  }

  let restart = true;
  if (raw.restart !== undefined) {
    if (typeof raw.restart !== "boolean") return { ok: false, error: `${where}.restart must be true or false` };
    restart = raw.restart;
  }

  let memory = null;
  if (raw.memory !== undefined && raw.memory !== null) {
    if (!numeric) return { ok: false, error: `${where}.memory is only for integer and number settings` };
    if (raw.memory !== "GiB") return { ok: false, error: `${where}.memory must be "GiB"` };
    memory = "GiB";
  }

  const setting = { key, label: label.value, type, min: bounds.min, max: bounds.max, step, options, unit, help, restart, memory };

  if (!("default" in raw)) return { ok: false, error: `${where}.default is required` };
  const checked = validateValue(setting, raw.default);
  if (!checked.ok) return { ok: false, error: `${where}.default: ${checked.error}` };

  return { ok: true, setting: { ...setting, default: checked.value } };
}

/**
 * Parse and validate a manifest document.
 * @returns {{ ok: true, manifest: { version: number, settings: object[] } } | { ok: false, error: string }}
 */
export function parseManifest(text) {
  if (typeof text !== "string") return { ok: false, error: "Manifest is not text" };
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `Manifest is larger than ${MAX_MANIFEST_BYTES} bytes` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Manifest is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Manifest must be a JSON object" };
  if (raw.version !== MANIFEST_VERSION) {
    return { ok: false, error: `Manifest version must be ${MANIFEST_VERSION}` };
  }
  if (!Array.isArray(raw.settings)) return { ok: false, error: "Manifest settings must be an array" };
  if (raw.settings.length > MAX_SETTINGS) {
    return { ok: false, error: `Manifest declares more than ${MAX_SETTINGS} settings` };
  }
  const settings = [];
  const seen = new Set();
  for (let i = 0; i < raw.settings.length; i += 1) {
    const result = normalizeSetting(raw.settings[i], i);
    if (!result.ok) return result;
    if (seen.has(result.setting.key)) return { ok: false, error: `Manifest repeats the key ${result.setting.key}` };
    seen.add(result.setting.key);
    settings.push(result.setting);
  }
  return { ok: true, manifest: { version: MANIFEST_VERSION, settings } };
}

/**
 * Validate a full set of values against the manifest. Every declared setting must
 * be present and nothing else may be: the env file is rewritten whole, so a
 * partial set would silently reset the rest.
 * @returns {{ ok: true, values: Record<string, string|number|boolean> } | { ok: false, error: string }}
 */
export function validateValues(manifest, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "values must be an object" };
  }
  const declared = new Set(manifest.settings.map((s) => s.key));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) return { ok: false, error: `${key} is not declared in the manifest` };
  }
  const values = {};
  for (const setting of manifest.settings) {
    if (!(setting.key in input)) return { ok: false, error: `${setting.key} is missing` };
    const checked = validateValue(setting, input[setting.key]);
    if (!checked.ok) return checked;
    values[setting.key] = checked.value;
  }
  return { ok: true, values };
}

/** The env file line for one value. Booleans are written as true / false. */
export function envValue(setting, value) {
  if (setting.type === "boolean") return value ? "true" : "false";
  return String(value);
}

/** The whole env file: a comment line, then one KEY=value per declared setting. */
export function serializeEnvFile(manifest, values) {
  const lines = ["# sparkDash launcher settings. Change them in the Models panel; this file is rewritten on save."];
  for (const setting of manifest.settings) lines.push(`${setting.key}=${envValue(setting, values[setting.key])}`);
  return `${lines.join("\n")}\n`;
}

/** Read KEY=value lines, ignoring comments, blank lines and anything that is not a valid key. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Current values: what the env file says, falling back to the manifest default.
 * A value the file holds but the manifest rejects is reported, not hidden.
 * @returns {{ values: Record<string, string|number|boolean>, invalid: { key: string, raw: string }[] }}
 */
export function resolveValues(manifest, fileValues) {
  const values = {};
  const invalid = [];
  for (const setting of manifest.settings) {
    const raw = fileValues[setting.key];
    if (raw === undefined) {
      values[setting.key] = setting.default;
      continue;
    }
    const checked = validateValue(setting, raw);
    if (checked.ok) values[setting.key] = checked.value;
    else {
      values[setting.key] = setting.default;
      invalid.push({ key: setting.key, raw });
    }
  }
  return { values, invalid };
}
