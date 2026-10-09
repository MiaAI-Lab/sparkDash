import { humanizeKey } from "./format";

/**
 * Defensive readers for the tool's result JSON. The exact nested field names are not
 * fully known, so every reader probes several common key names and falls back to the
 * raw value. Nothing here throws on odd input.
 */

export type Json = unknown;
export type Obj = Record<string, unknown>;
export type ScenarioStatus = "pass" | "partial" | "fail" | "other";

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** First present key (case-insensitive) among `keys`. */
export function pick(o: unknown, keys: readonly string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) if (k in o && o[k] != null) return o[k];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const hit = lower.get(k.toLowerCase());
    if (hit && o[hit] != null) return o[hit];
  }
  return undefined;
}
const pickStr = (o: unknown, keys: readonly string[]): string | null => {
  const v = pick(o, keys);
  return typeof v === "string" ? v : isNum(v) ? String(v) : null;
};
const pickNum = (o: unknown, keys: readonly string[]): number | null => {
  const v = pick(o, keys);
  if (isNum(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function normalizeStatus(v: unknown): ScenarioStatus {
  if (typeof v === "boolean") return v ? "pass" : "fail";
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("pass") || s === "ok" || s === "success" || s.includes("✅")) return "pass";
  if (s.startsWith("partial") || s.includes("⚠")) return "partial";
  if (s.startsWith("fail") || s === "error" || s.includes("❌")) return "fail";
  return "other";
}

/** Category names as documented for the tool (A–O, P = Hard Mode). Used only when the result carries no name. */
export const CATEGORY_NAMES: Record<string, string> = {
  A: "Tool selection",
  B: "Parameter precision",
  C: "Multi-step chains",
  D: "Restraint and refusal",
  E: "Error recovery",
  F: "Localization",
  G: "Structured reasoning",
  H: "Instruction following",
  I: "Context and state",
  J: "Code patterns",
  K: "Safety and boundaries",
  L: "Toolset scaling",
  M: "Autonomous planning",
  N: "Creative composition",
  O: "Structured output",
  P: "Hard mode",
};

export interface NormCategory {
  id: string;
  name: string | null;
  /** 0–100 */
  percent: number | null;
  points: number | null;
  maxPoints: number | null;
  raw: unknown;
}

export interface NormScenario {
  id: string;
  title: string | null;
  category: string | null;
  status: ScenarioStatus;
  rawStatus: string | null;
  points: number | null;
  maxPoints: number | null;
  durationSeconds: number | null;
  reasoning: string | null;
  raw: Obj;
}

export interface NormToolResult {
  score: number | null;
  rating: string | null;
  deployability: number | null;
  responsiveness: number | null;
  total: number | null;
  safety: string[];
  runId: string | null;
  version: string | null;
  model: string | null;
  backend: string | null;
  config: Obj;
  categories: NormCategory[];
  scenarios: NormScenario[];
  counts: { pass: number; partial: number; fail: number; other: number };
}

/** A category letter from a value like "A", "a", "A - Tool Selection" or "TC-A-01". */
export function categoryLetter(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (/^[A-Pa-p]$/.test(s)) return s.toUpperCase();
  const m = /^([A-Pa-p])\b[\s:.\-–)]/.exec(s);
  return m ? m[1].toUpperCase() : null;
}

function asRows(v: unknown): { key: string | null; value: unknown }[] {
  if (Array.isArray(v)) return v.map((value) => ({ key: null, value }));
  if (isObj(v)) return Object.entries(v).map(([key, value]) => ({ key, value }));
  return [];
}

/**
 * Category scores come in several shapes. Unambiguous ones are converted per category:
 * points / max_points (preferred when both exist), a `percent`/`percentage`/`pct` key, or a `ratio` key (x100).
 * A bare number, or a `score`/`final_score` key, could be a 0-1 ratio or a 0-100 percent; it is read as a
 * ratio only when EVERY such value in the result lies within 0..1 and at least one is not an integer
 * (so a real 1% next to 0% stays 1%, while 0.82, 0.5, 1 means a ratio).
 */
export function normalizeCategories(scores: unknown): NormCategory[] {
  const src = pick(scores, ["category_scores", "categories", "category_results", "by_category"]);
  const out: NormCategory[] = [];
  const ambiguous = new Set<NormCategory>();
  for (const { key, value } of asRows(src)) {
    if (isNum(value)) {
      const cat: NormCategory = { id: categoryLetter(key) ?? key ?? "?", name: null, percent: value, points: null, maxPoints: null, raw: value };
      ambiguous.add(cat);
      out.push(cat);
      continue;
    }
    if (!isObj(value)) continue;
    const rawId = pickStr(value, ["category", "id", "letter", "key", "code", "name"]) ?? key ?? "?";
    const letter = categoryLetter(rawId) ?? categoryLetter(key);
    const points = pickNum(value, ["points", "earned", "earned_points", "score_points", "total_points"]);
    const maxPoints = pickNum(value, ["max_points", "max", "possible", "max_score", "possible_points"]);
    let percent: number | null = null;
    let vague = false;
    if (points != null && maxPoints) percent = (points / maxPoints) * 100;
    else {
      const explicit = pickNum(value, ["percent", "percentage", "pct"]);
      const ratio = pickNum(value, ["ratio"]);
      const loose = pickNum(value, ["score", "final_score"]);
      if (explicit != null) percent = explicit;
      else if (ratio != null) percent = ratio * 100;
      else if (loose != null) (percent = loose), (vague = true);
    }
    const named = pickStr(value, ["label", "category_name", "title", "name", "description"]);
    const cat: NormCategory = {
      id: letter ?? rawId,
      name: named && named !== letter && categoryLetter(named) !== named ? named.replace(/^[A-P]\s*[-–:.)]\s*/i, "") : null,
      percent,
      points,
      maxPoints,
      raw: value,
    };
    if (vague) ambiguous.add(cat);
    out.push(cat);
  }
  const vals = [...ambiguous].map((c) => c.percent).filter(isNum);
  if (vals.length && vals.every((v) => v >= 0 && v <= 1) && vals.some((v) => !Number.isInteger(v))) {
    for (const c of ambiguous) if (isNum(c.percent)) c.percent *= 100;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeScenarios(scores: unknown, root?: unknown): NormScenario[] {
  const src = pick(scores, ["scenario_results", "scenarios", "results"]) ?? pick(root, ["scenario_results", "scenarios"]);
  const out: NormScenario[] = [];
  for (const { key, value } of asRows(src)) {
    if (!isObj(value)) continue;
    const id = pickStr(value, ["scenario_id", "id", "scenario", "name"]) ?? key ?? `#${out.length + 1}`;
    const statusRaw = pick(value, ["status", "result", "outcome", "verdict"]);
    const points = pickNum(value, ["points", "score", "earned"]);
    const maxPoints = pickNum(value, ["max_points", "max", "possible"]);
    let status = normalizeStatus(statusRaw);
    if (statusRaw == null && points != null) status = maxPoints != null ? (points >= maxPoints ? "pass" : points > 0 ? "partial" : "fail") : points >= 2 ? "pass" : points > 0 ? "partial" : "fail";
    const cat = pick(value, ["category", "category_id", "cat"]);
    out.push({
      id,
      title: pickStr(value, ["title", "scenario_title", "label", "description"]),
      category: categoryLetter(cat) ?? (typeof cat === "string" ? cat : null),
      status,
      rawStatus: typeof statusRaw === "string" ? statusRaw : null,
      points,
      maxPoints,
      durationSeconds: pickNum(value, ["duration_seconds", "duration_s", "duration", "elapsed_seconds", "elapsed"]),
      reasoning: pickStr(value, ["reasoning", "summary", "explanation", "note", "reason", "details"]),
      raw: value,
    });
  }
  return out;
}

export function normalizeToolResult(result: unknown): NormToolResult | null {
  if (!isObj(result)) return null;
  const scores = isObj(result.scores) ? result.scores : {};
  const config = isObj(result.config) ? result.config : {};
  const scenarios = normalizeScenarios(scores, result);
  const counts = { pass: 0, partial: 0, fail: 0, other: 0 };
  for (const s of scenarios) counts[s.status] += 1;
  const warnings = pick(result, ["safety_warnings"]) ?? pick(scores, ["safety_warnings"]);
  const safety = Array.isArray(warnings)
    ? warnings.map((w) => (typeof w === "string" ? w : isObj(w) ? pickStr(w, ["message", "warning", "text", "scenario_id", "id"]) ?? JSON.stringify(w) : String(w)))
    : [];
  return {
    score: pickNum(result, ["final_score"]) ?? pickNum(scores, ["final_score", "score"]),
    rating: pickStr(result, ["rating"]) ?? pickStr(scores, ["rating"]),
    deployability: pickNum(result, ["deployability"]) ?? pickNum(scores, ["deployability"]),
    responsiveness: pickNum(result, ["responsiveness"]) ?? pickNum(scores, ["responsiveness"]),
    total: pickNum(result, ["total_scenarios"]) ?? (scenarios.length || null),
    safety,
    runId: pickStr(result, ["run_id"]),
    version: pickStr(result, ["tool_eval_bench_version", "version"]),
    model: pickStr(config, ["model", "model_name"]),
    backend: pickStr(config, ["backend"]),
    config,
    categories: normalizeCategories(scores),
    scenarios,
    counts,
  };
}

/** Does this result look like it carries tool-call scenario data? */
export function hasScenarioData(result: unknown): boolean {
  const n = normalizeToolResult(result);
  return Boolean(n && (n.scenarios.length > 0 || n.categories.length > 0));
}

// ── Generic (metric-first) result reading ──

export interface MetricTile {
  path: string;
  label: string;
  value: number | string | boolean;
}

export interface GenericTable {
  path: string;
  title: string;
  columns: string[];
  rows: Obj[];
}

const META_KEYS = new Set(["schema_version", "tool_eval_bench_version", "run_id", "report_path", "metadata", "config", "timestamp", "created_at", "version", "git_sha"]);

/** Top-level scalars worth showing as headline tiles. */
export function topMetrics(result: unknown, max = 12): MetricTile[] {
  if (!isObj(result)) return [];
  const tiles: MetricTile[] = [];
  const visit = (o: Obj, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (tiles.length >= max) return;
      if (META_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (isNum(v) || typeof v === "boolean" || (typeof v === "string" && v.length <= 60)) {
        tiles.push({ path, label: humanizeKey(prefix ? `${prefix.split(".").pop()} ${k}` : k), value: v });
      } else if (isObj(v) && depth < 2) visit(v, path, depth + 1);
    }
  };
  visit(result, "", 0);
  return tiles;
}

/** Every array of objects in the result, as a table (depth-limited). */
export function collectTables(result: unknown, maxTables = 12): GenericTable[] {
  const tables: GenericTable[] = [];
  const visit = (v: unknown, path: string, depth: number) => {
    if (tables.length >= maxTables || depth > 4) return;
    if (Array.isArray(v)) {
      const rows = v.filter(isObj);
      if (rows.length >= 1 && rows.length === v.length) {
        const cols: string[] = [];
        for (const r of rows.slice(0, 200)) for (const k of Object.keys(r)) if (!cols.includes(k) && (!isObj(r[k]) || Object.keys(r[k] as Obj).length <= 6) && !Array.isArray(r[k])) cols.push(k);
        if (cols.length) tables.push({ path, title: humanizeKey(path.split(".").pop() ?? path), columns: cols.slice(0, 14), rows });
        return;
      }
      v.slice(0, 5).forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) if (!META_KEYS.has(k)) visit(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(result, "", 0);
  return tables;
}

/** Flatten a cell for table display (objects become short "k: v" strings). */
export function cellText(v: unknown): string {
  if (v == null) return "–";
  if (isNum(v)) return String(v);
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}: ${isObj(x) || Array.isArray(x) ? "…" : String(x)}`).join(", ");
  return JSON.stringify(v);
}

const X_KEYS = ["depth", "context_depth", "context", "context_length", "context_size", "pressure", "ratio", "length", "concurrency", "n_parallel", "pp", "prompt_tokens", "tokens", "level"];
const Y_HINT = /tps|tok|speed|throughput|accept|score|accuracy|percent|rate|speedup|recall|tau|latency|ttft|time/i;
const GROUP_KEYS = ["concurrency", "prompt_type", "prompt", "type", "label", "metric", "suite", "subject", "task", "kind", "name"];

export interface ChartSpec {
  title: string;
  xKey: string;
  yKey: string;
  group: string | null;
  points: { x: number; label: string; value: number | null }[];
}

/** Suggest line charts for a table: a numeric x column (depth, concurrency…) against a numeric metric. */
export function suggestCharts(table: GenericTable, maxCharts = 6): ChartSpec[] {
  const rows = table.rows;
  if (rows.length < 2) return [];
  const numericCols = table.columns.filter((c) => rows.some((r) => isNum(r[c])) && rows.every((r) => r[c] == null || isNum(r[c])));
  const xKey = X_KEYS.find((k) => numericCols.includes(k)) ?? numericCols.find((c) => X_KEYS.some((k) => c.toLowerCase().includes(k)));
  if (!xKey) return [];
  const ys = numericCols.filter((c) => c !== xKey && Y_HINT.test(c)).slice(0, 3);
  if (!ys.length) return [];
  const groupKey = [...GROUP_KEYS, ...numericCols].find((k) => k !== xKey && table.columns.includes(k) && new Set(rows.map((r) => String(r[k]))).size > 1 && new Set(rows.map((r) => String(r[k]))).size <= 6 && rows.length > new Set(rows.map((r) => r[xKey])).size);
  const charts: ChartSpec[] = [];
  const groups = groupKey ? [...new Set(rows.map((r) => String(r[groupKey])))] : [null];
  for (const y of ys) {
    for (const g of groups) {
      if (charts.length >= maxCharts) return charts;
      const sub = g == null ? rows : rows.filter((r) => String(r[groupKey as string]) === g);
      const byX = new Map<number, number[]>();
      for (const r of sub) {
        const x = r[xKey];
        const val = r[y];
        if (isNum(x) && isNum(val)) byX.set(x, [...(byX.get(x) ?? []), val]);
      }
      if (byX.size < 2) continue;
      const pts = [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, vs]) => ({ x, label: String(x), value: vs.reduce((a, b) => a + b, 0) / vs.length }));
      charts.push({ title: `${humanizeKey(y)} by ${humanizeKey(xKey).toLowerCase()}${g != null ? ` (${humanizeKey(groupKey as string).toLowerCase()} ${g})` : ""}`, xKey, yKey: y, group: g, points: pts });
    }
  }
  return charts;
}

/** All numeric leaves of a value as dotted path -> number (arrays of objects keyed by an id column when present). */
export function flattenNumbers(v: unknown, prefix = "", out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (depth > 6 || Object.keys(out).length > 2000) return out;
  if (isNum(v)) out[prefix || "value"] = v;
  else if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const id = isObj(x) ? pickStr(x, ["id", "name", "label", "scenario_id", "category", "subject", "suite", "task"]) : null;
      const extra = isObj(x) ? ["depth", "concurrency", "prompt_type", "context"].map((k) => (k in x ? `${k}=${String(x[k])}` : "")).filter(Boolean).join(",") : "";
      flattenNumbers(x, `${prefix}[${[id, extra].filter(Boolean).join(" ") || i}]`, out, depth + 1);
    });
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (META_KEYS.has(k) && depth === 0) continue;
      flattenNumbers(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}
