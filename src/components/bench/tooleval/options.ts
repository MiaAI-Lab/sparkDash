import type { ToolEvalArgSpec, ToolEvalRun, ToolEvalSpec } from "../../../api/types";
import { PRESETS, type Preset } from "./presets";

/**
 * Form state for the Tool Eval pages and its mapping to the API payload.
 * Strings stay strings while the user types (numbers are parsed at build time),
 * `categories` and `repeat` options are string arrays, bools are booleans.
 */
export type FieldValue = string | boolean | string[];

export interface FormState {
  values: Record<string, FieldValue>;
  extraArgs: string;
  /** LLM port on the Spark; null = the Spark's first port. */
  port: number | null;
  /** accuracy page: which suites to run. */
  suites: string[];
}

export const SUITES = [
  { id: "gsm8k", label: "GSM8K", help: "Grade-school math" },
  { id: "mmlu", label: "MMLU", help: "Multitask knowledge" },
  { id: "ifeval", label: "IFEval", help: "Instruction following" },
] as const;

/** A group on a page; `only` limits it to named fields (a field from another group can join a page this way). */
export interface GroupSel {
  id: string;
  only?: string[];
  /** Fields that the page sets itself and therefore hides. */
  hide?: string[];
  label?: string;
}

export interface TypeConfig {
  groups: GroupSel[];
  /** Flags this page always sends (they define what the page measures). */
  forced: Record<string, boolean>;
}

export const TYPE_CONFIG: Record<string, TypeConfig> = {
  "tool-eval": {
    groups: [{ id: "connection" }, { id: "scenarios" }, { id: "sampling" }, { id: "run" }, { id: "scoring" }, { id: "output" }],
    forced: {},
  },
  throughput: {
    groups: [{ id: "connection" }, { id: "throughput", hide: ["perf", "perf-only"] }, { id: "run", only: ["timeout"] }, { id: "output" }],
    forced: { "perf-only": true },
  },
  "spec-decode": {
    groups: [{ id: "connection" }, { id: "spec", hide: ["spec-bench"] }, { id: "sampling", only: ["temperature"] }, { id: "output" }],
    forced: { "spec-bench": true, "skip-tool-eval": true },
  },
  "context-pressure": {
    groups: [{ id: "connection" }, { id: "scenarios" }, { id: "pressure" }, { id: "sampling" }, { id: "run" }, { id: "output" }],
    forced: {},
  },
  accuracy: {
    groups: [
      { id: "connection" },
      { id: "gsm8k", hide: ["gsm8k", "gsm8k-only"] },
      { id: "mmlu", hide: ["mmlu", "mmlu-only"] },
      { id: "ifeval", hide: ["ifeval", "ifeval-only"] },
      { id: "sampling", only: ["seed"] },
      { id: "output" },
    ],
    forced: {},
  },
  needle: {
    groups: [{ id: "connection" }, { id: "needle", hide: ["needle", "needle-only"] }, { id: "output" }],
    forced: { "needle-only": true },
  },
  decision: {
    groups: [{ id: "connection" }, { id: "decision", hide: ["decision", "decision-only"] }, { id: "output" }],
    forced: { "decision-only": true },
  },
};

const ACCURACY_ONLY = ["gsm8k-only", "mmlu-only", "ifeval-only"];

export function typeConfig(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? TYPE_CONFIG["tool-eval"];
}

/** Names of the options the page itself controls (never shown, never persisted). */
export function managedNames(type: string): Set<string> {
  const names = new Set(Object.keys(typeConfig(type).forced));
  if (type === "accuracy") ACCURACY_ONLY.forEach((n) => names.add(n));
  return names;
}

/** The fields shown in the main form for a group on this page. */
export function groupFields(spec: ToolEvalSpec, type: string, sel: GroupSel): ToolEvalArgSpec[] {
  const hidden = new Set([...(sel.hide ?? []), ...managedNames(type)]);
  return spec.args.filter((a) => a.group === sel.id && a.kind !== "secret" && !hidden.has(a.name) && (!sel.only || sel.only.includes(a.name)));
}

/** Every option not in the main form (and not managed by the page): the "Advanced / all options" disclosure. */
export function advancedFields(spec: ToolEvalSpec, type: string): ToolEvalArgSpec[] {
  const shown = new Set<string>();
  for (const sel of typeConfig(type).groups) groupFields(spec, type, sel).forEach((f) => shown.add(f.name));
  const managed = managedNames(type);
  return spec.args.filter((a) => a.kind !== "secret" && !shown.has(a.name) && !managed.has(a.name));
}

export function emptyState(type: string): FormState {
  return { values: {}, extraArgs: "", port: null, suites: type === "accuracy" ? SUITES.map((s) => s.id) : [] };
}

export function applyPreset(type: string, preset: Preset): FormState {
  const base = emptyState(type);
  return { ...base, values: { ...preset.values }, suites: preset.suites ? [...preset.suites] : base.suites };
}

export function presetsFor(type: string): Preset[] {
  return PRESETS[type] ?? [];
}

const isBlank = (v: FieldValue | undefined): boolean => v === undefined || v === "" || v === false || (Array.isArray(v) && v.every((x) => !x.trim()));

/** Value of a `list` option as tokens (whitespace / comma separated). */
export function splitList(raw: string): string[] {
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** Convert one form value to what the API expects; undefined = not set. */
function toApiValue(spec: ToolEvalArgSpec, v: FieldValue | undefined): unknown {
  if (isBlank(v)) return undefined;
  switch (spec.kind) {
    case "bool":
      return v === true ? true : undefined;
    case "int":
    case "float": {
      const s = String(v).trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : s; // invalid text is sent as is so the server explains it
    }
    case "list":
      return Array.isArray(v) ? v.filter(Boolean) : splitList(String(v));
    case "repeat":
      return Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : String(v).split("\n").map((x) => x.trim()).filter(Boolean);
    default:
      return typeof v === "string" ? v.trim() === "" ? undefined : spec.kind === "text" ? v : v.trim() : undefined;
  }
}

/** The key that will actually be sent: only with a non-blank custom base URL. */
export function apiKeyFor(state: Pick<FormState, "values">, apiKey: string): string {
  const url = state.values["base-url"];
  return apiKey && typeof url === "string" && url.trim() ? apiKey : "";
}

export interface BuiltRequest {
  options: Record<string, unknown>;
  extraArgs: string;
  port?: number;
}

/** Form state -> request body parts (options keyed by option name, plus the forced flags of the page). */
export function buildRequest(spec: ToolEvalSpec, type: string, state: FormState, apiKey = ""): BuiltRequest {
  const options: Record<string, unknown> = {};
  const managed = managedNames(type);
  for (const arg of spec.args) {
    if (arg.kind === "secret" || managed.has(arg.name)) continue;
    const v = toApiValue(arg, state.values[arg.name]);
    if (v !== undefined) options[arg.name] = v;
  }
  for (const [name, on] of Object.entries(typeConfig(type).forced)) if (on) options[name] = true;
  if (type === "accuracy") for (const s of state.suites) options[`${s}-only`] = true;
  // A typed key belongs to the custom endpoint: with no base URL the run goes to the local server, which must never see it.
  if (apiKey && options["base-url"] !== undefined) options["api-key"] = apiKey;
  const out: BuiltRequest = { options, extraArgs: state.extraArgs.trim() };
  if (state.port != null) out.port = state.port;
  return out;
}

/** Client-side check of one raw field value, mirroring the server so errors show while typing. */
export function validateField(spec: ToolEvalArgSpec, v: FieldValue | undefined): string | null {
  if (isBlank(v)) return null;
  const label = spec.label;
  const s = typeof v === "string" ? v.trim() : "";
  // Whitespace-only text is dropped by toApiValue, so it is not an error either.
  if (typeof v === "string" && !s) return null;
  switch (spec.kind) {
    case "int":
    case "float": {
      const n = Number(s);
      if (!s || !Number.isFinite(n)) return `${label} must be a number`;
      if (spec.kind === "int" && !Number.isInteger(n)) return `${label} must be a whole number`;
      if (spec.min != null && n < spec.min) return `${label} must be at least ${spec.min}`;
      if (spec.max != null && n > spec.max) return `${label} must be at most ${spec.max}`;
      return null;
    }
    case "choice":
      return spec.choices?.includes(s) ? null : `${label} must be one of ${spec.choices?.join(", ")}`;
    case "string":
    case "csv":
    case "range":
      if (s.length > (spec.maxLen ?? 500)) return `${label} is too long`;
      if (spec.pattern && !new RegExp(spec.pattern).test(s)) return `${label} has an invalid format`;
      return null;
    case "text": {
      const bytes = byteLength(typeof v === "string" ? v : "");
      return bytes > (spec.maxBytes ?? 32768) ? `${label} is longer than ${(spec.maxBytes ?? 32768) / 1024} KiB` : null;
    }
    case "path":
      if (!/^(~\/|\/)[A-Za-z0-9._@+=,/ -]{0,300}$/.test(s)) return `${label} must be an absolute path (or start with ~/)`;
      return s.split("/").includes("..") ? `${label} must not contain ..` : null;
    case "url":
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return `${label} must start with http:// or https://`;
        return u.username || u.password ? `${label} must not contain credentials (use the API key field)` : null;
      } catch {
        return `${label} is not a valid URL`;
      }
    case "json":
      return jsonObjectError(s) ? `${label}: ${jsonObjectError(s)}` : null;
    case "list": {
      const items = Array.isArray(v) ? v : splitList(String(v));
      if (spec.maxItems && items.length > spec.maxItems) return `${label} has too many items`;
      const re = spec.itemPattern ? new RegExp(spec.itemPattern) : null;
      const bad = re ? items.find((i) => !re.test(i)) : undefined;
      return bad ? `${label} has an invalid item "${bad.slice(0, 40)}"` : null;
    }
    case "repeat": {
      const items = (Array.isArray(v) ? v : [String(v)]).map((x) => x.trim()).filter(Boolean);
      if (spec.maxItems && items.length > spec.maxItems) return `${label} has too many items`;
      const re = spec.itemPattern ? new RegExp(spec.itemPattern) : null;
      const bad = re ? items.find((i) => !re.test(i)) : undefined;
      return bad ? `${label} has an invalid entry "${bad.slice(0, 40)}"` : null;
    }
    default:
      return null;
  }
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** null when `s` is a JSON object; otherwise a short reason. */
export function jsonObjectError(s: string): string | null {
  try {
    const p = JSON.parse(s);
    return p && typeof p === "object" && !Array.isArray(p) ? null : "must be a JSON object";
  } catch {
    return "is not valid JSON";
  }
}

/** Errors per option name plus form-level ones (cross-field rules). */
export function validateState(spec: ToolEvalSpec, type: string, state: FormState): { fields: Record<string, string>; form: string[] } {
  const fields: Record<string, string> = {};
  const managed = managedNames(type);
  for (const arg of spec.args) {
    if (arg.kind === "secret" || managed.has(arg.name)) continue;
    const e = validateField(arg, state.values[arg.name]);
    if (e) fields[arg.name] = e;
  }
  const form: string[] = [];
  const set = (n: string) => !isBlank(state.values[n]);
  if (set("system-prompt") && set("system-prompt-file")) form.push("Use either the system prompt text or the system prompt file, not both");
  if (set("context-pressure") && set("context-pressure-sweep")) form.push("Use either a single context pressure or a sweep, not both");
  if (set("short") && set("scenarios")) form.push("A short run and a specific scenario list cannot be combined");
  if (type === "accuracy" && state.suites.length === 0) form.push("Tick at least one suite to run");
  if (type === "context-pressure" && !set("context-pressure") && !set("context-pressure-sweep")) {
    form.push("Set a pressure ratio or a sweep range, otherwise this is a plain tool-call run");
  }
  return { fields, form };
}

/** Map the server's `errors[]` (which start with the option label) back onto fields. */
export function mapServerErrors(spec: ToolEvalSpec, errors: readonly string[]): { fields: Record<string, string>; form: string[] } {
  const fields: Record<string, string> = {};
  const form: string[] = [];
  const byLen = [...spec.args].sort((a, b) => b.label.length - a.label.length);
  for (const e of errors) {
    const hit = byLen.find((a) => e.startsWith(a.label));
    const quoted = /Unknown option "([^"]+)"/.exec(e);
    if (hit) fields[hit.name] ??= e;
    else if (quoted && spec.args.some((a) => a.name === quoted[1])) fields[quoted[1]] ??= e;
    else form.push(e);
  }
  return { fields, form };
}

// ── History re-run: loading a stored run's (redacted) options back into the form ──

export function stateFromRun(spec: ToolEvalSpec, type: string, run: Pick<ToolEvalRun, "options" | "port">): FormState {
  const state = emptyState(type);
  const managed = managedNames(type);
  const opts = run.options ?? {};
  const suites: string[] = [];
  for (const arg of spec.args) {
    const raw = opts[arg.name];
    if (raw === undefined || raw === null) continue;
    if (type === "accuracy" && ACCURACY_ONLY.includes(arg.name)) {
      if (raw === true) suites.push(arg.name.replace("-only", ""));
      continue;
    }
    if (arg.kind === "secret" || managed.has(arg.name) || raw === "(hidden)" || raw === "(saved key)") continue;
    if (arg.secret) continue; // header values are not stored
    // Large values (system prompt, backend kwargs) are stored as an "(omitted: …)" placeholder: never reload that as the value.
    if (typeof raw === "string" && raw.startsWith("(omitted:")) continue;
    if (arg.kind === "bool") state.values[arg.name] = raw === true;
    else if (arg.kind === "repeat") state.values[arg.name] = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    else if (arg.kind === "list") state.values[arg.name] = arg.choices ? (Array.isArray(raw) ? raw.map(String) : []) : Array.isArray(raw) ? raw.join(" ") : String(raw);
    else state.values[arg.name] = String(raw);
  }
  if (type === "accuracy") state.suites = suites.length ? suites : state.suites;
  if (Array.isArray(opts.extra)) state.extraArgs = opts.extra.map(String).join(" ");
  state.port = typeof run.port === "number" ? run.port : null;
  return state;
}

// ── Persistence of the last-used options per page type (never the API key or header values) ──

const storageKey = (type: string) => `sparkdash.tooleval.options.${type}`;

export function persistable(spec: ToolEvalSpec | null, state: FormState): FormState {
  const secretNames = new Set((spec?.args ?? []).filter((a) => a.secret || a.kind === "secret").map((a) => a.name));
  secretNames.add("api-key");
  secretNames.add("header");
  const values: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(state.values)) if (!secretNames.has(k)) values[k] = v;
  return { ...state, values };
}

export function saveState(type: string, spec: ToolEvalSpec | null, state: FormState): void {
  try {
    localStorage.setItem(storageKey(type), JSON.stringify(persistable(spec, state)));
  } catch {
    /* private mode */
  }
}

export function loadState(type: string): FormState | null {
  try {
    const raw = localStorage.getItem(storageKey(type));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<FormState>;
    if (!p || typeof p !== "object" || typeof p.values !== "object" || p.values === null || Array.isArray(p.values)) return null;
    const base = emptyState(type);
    return {
      values: p.values as Record<string, FieldValue>,
      extraArgs: typeof p.extraArgs === "string" ? p.extraArgs : "",
      port: typeof p.port === "number" ? p.port : null,
      suites: Array.isArray(p.suites) ? p.suites.filter((s): s is string => typeof s === "string") : base.suites,
    };
  } catch {
    return null;
  }
}

/** Count of options that differ from "unset", for the "N options set" hint. */
export function countSet(state: FormState): number {
  return Object.values(state.values).filter((v) => !isBlank(v)).length + (state.extraArgs.trim() ? 1 : 0);
}
