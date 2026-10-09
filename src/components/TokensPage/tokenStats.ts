/**
 * Pure logic for the Token totals page: range windows, bucketing (UTC day / UTC hour),
 * group-by with top-N + Other, totals, previous-period comparison, per-model and
 * per-endpoint tables, plain-English insights and CSV. No React, no I/O.
 *
 * Vocabulary: generated = completionTokens, prompt = promptTokens, cached = prefix-cache
 * served subset of prompt, computed = prompt - cached. total = generated + prompt.
 */
import { addTokens, formatTokensCompact } from "../../shared/tokenFormat";
import type { TokenHistory, TokenHistoryRow } from "../../api/types";
import type { LlmTokenSeriesTotals } from "../../api/llmTokenTypes";

export type RangeKey = "24h" | "7d" | "14d" | "30d" | "all";
export type BucketUnit = "hour" | "day";
export type GroupBy = "type" | "model" | "spark";

/** A token row without its time: what tables aggregate (history rows and lifetime totals both fit). */
export type Entry = Omit<TokenHistoryRow, "t">;

export interface RangeSpec {
  key: RangeKey;
  label: string;
  /** Used in sentences: "in the last 7 days". */
  phrase: string;
  unit: BucketUnit;
  /** Bucket count; null = everything retained. */
  count: number | null;
}

export const RANGES: readonly RangeSpec[] = [
  { key: "24h", label: "Last 24 h", phrase: "the last 24 hours", unit: "hour", count: 24 },
  { key: "7d", label: "7 d", phrase: "the last 7 days", unit: "day", count: 7 },
  { key: "14d", label: "14 d", phrase: "the last 14 days", unit: "day", count: 14 },
  { key: "30d", label: "30 d", phrase: "the last 30 days", unit: "day", count: 30 },
  { key: "all", label: "All time", phrase: "all time", unit: "day", count: null },
];

export const OTHER_ID = "__other";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Numbers ─────────────────────────────────────────────

/** Counters are never negative or non-finite; anything else is treated as zero. */
function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export interface Tally {
  generated: number;
  prompt: number;
  /** Always <= prompt. */
  cached: number;
  /** prompt - cached. */
  computed: number;
  /** generated + prompt. */
  total: number;
}

export function emptyTally(): Tally {
  return { generated: 0, prompt: 0, cached: 0, computed: 0, total: 0 };
}

/** Add one entry; cached is clamped to that entry's prompt so the invariant holds per row. */
export function addEntry(t: Tally, e: Pick<Entry, "promptTokens" | "completionTokens" | "cachedTokens">): void {
  const prompt = nn(e.promptTokens);
  const cached = Math.min(nn(e.cachedTokens), prompt);
  t.generated = addTokens(t.generated, nn(e.completionTokens));
  t.prompt = addTokens(t.prompt, prompt);
  t.cached = addTokens(t.cached, cached);
  t.computed = t.prompt - t.cached;
  t.total = addTokens(t.generated, t.prompt);
}

export function tallyOf(entries: readonly Entry[]): Tally {
  const t = emptyTally();
  for (const e of entries) addEntry(t, e);
  return t;
}

/** cached / prompt, or null when there is no prompt data to divide by. */
export function cacheRate(t: Pick<Tally, "cached" | "prompt">): number | null {
  return t.prompt > 0 ? Math.min(1, t.cached / t.prompt) : null;
}

/** Fraction change (0.25 = +25 %); null when the baseline is zero. */
export function pctChange(cur: number, prev: number): number | null {
  return prev > 0 ? (cur - prev) / prev : null;
}

export function fmtPct(fraction: number, digits?: number): string {
  const p = fraction * 100;
  const d = digits ?? (Math.abs(p) < 10 && p !== 0 ? 1 : 0);
  return `${p.toFixed(d)}%`;
}

// ─── Keys, labels, windows ───────────────────────────────

export function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** Start of a bucket in ms, or null for a malformed key. */
export function parseKey(key: string): number | null {
  const ms = Date.parse(key.length === 10 ? `${key}T00:00:00Z` : `${key}:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The `count` most recent bucket keys ending at the bucket that contains `nowMs`, oldest first. */
export function bucketKeys(unit: BucketUnit, count: number, nowMs: number): string[] {
  const step = unit === "hour" ? HOUR_MS : DAY_MS;
  const fmt = unit === "hour" ? hourKey : dayKey;
  const last = Math.floor(nowMs / step) * step;
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(fmt(last - i * step));
  return out;
}

function tzOffset(ms: number, offsetMin?: number): number {
  return offsetMin ?? -new Date(ms).getTimezoneOffset();
}

/**
 * Short x-axis label. Days are UTC dates ("7 Oct"); hours are LOCAL clock hours ("14:00").
 * `offsetMin` (minutes east of UTC) overrides the browser's zone — used by tests.
 */
export function bucketLabel(key: string, unit: BucketUnit, offsetMin?: number): string {
  const ms = parseKey(key);
  if (ms == null) return key;
  if (unit === "day") {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  const d = new Date(ms + tzOffset(ms, offsetMin) * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

/** Tooltip heading: "Wed 7 Oct 2026 (UTC)" or "Wed 7 Oct, 14:00–15:00 (local)". */
export function bucketTitle(key: string, unit: BucketUnit, offsetMin?: number): string {
  const ms = parseKey(key);
  if (ms == null) return key;
  if (unit === "day") {
    const d = new Date(ms);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} (UTC)`;
  }
  const off = tzOffset(ms, offsetMin);
  const d = new Date(ms + off * 60_000);
  const hh = (n: number) => `${String(n % 24).padStart(2, "0")}:00`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh(d.getUTCHours())}–${hh(d.getUTCHours() + 1)} (local)`;
}

export interface RangeWindow {
  spec: RangeSpec;
  keys: string[];
  /** Equal-length window right before `keys`; empty when it was not fully tracked. */
  prevKeys: string[];
  /** First bucket tracking ever recorded for this unit (null = none yet). */
  firstKey: string | null;
}

function firstKeyOf(history: Pick<TokenHistory, "firstDay" | "firstHour" | "day" | "hour">, unit: BucketUnit): string | null {
  const declared = unit === "hour" ? history.firstHour : history.firstDay;
  const rows = unit === "hour" ? history.hour : history.day;
  let min = declared || null;
  for (const r of rows) if (r.t && (!min || r.t < min)) min = r.t;
  return min;
}

/** Resolve a range into bucket keys (and the previous equal-length window when tracking covers it). */
export function windowFor(
  range: RangeKey,
  history: Pick<TokenHistory, "firstDay" | "firstHour" | "day" | "hour" | "retention">,
  nowMs: number
): RangeWindow {
  const spec = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const firstKey = firstKeyOf(history, spec.unit);
  if (spec.count == null) {
    // All time: the retained daily buckets, from the first tracked day to today.
    const retained = Math.max(1, history.retention?.days || 35);
    const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const firstMs = firstKey ? parseKey(firstKey) : null;
    const spanDays = firstMs == null ? 1 : Math.max(1, Math.round((todayMs - firstMs) / DAY_MS) + 1);
    return { spec, keys: bucketKeys("day", Math.min(spanDays, retained), nowMs), prevKeys: [], firstKey };
  }
  const keys = bucketKeys(spec.unit, spec.count, nowMs);
  const step = spec.unit === "hour" ? HOUR_MS : DAY_MS;
  const startMs = parseKey(keys[0]) ?? nowMs;
  const prevKeys = bucketKeys(spec.unit, spec.count, startMs - step);
  // Only compare against a previous period that tracking fully covered.
  const covered = firstKey != null && prevKeys[0] >= firstKey;
  return { spec, keys, prevKeys: covered ? prevKeys : [], firstKey };
}

/** Buckets from `firstKey` through the current one (inclusive); null when nothing was tracked yet. */
export function trackedBuckets(firstKey: string | null, unit: BucketUnit, nowMs: number): number | null {
  const first = firstKey ? parseKey(firstKey) : null;
  if (first == null) return null;
  const step = unit === "hour" ? HOUR_MS : DAY_MS;
  return Math.max(1, Math.floor(nowMs / step) - Math.floor(first / step) + 1);
}

export function rowsIn(rows: readonly TokenHistoryRow[], keys: readonly string[]): TokenHistoryRow[] {
  const set = new Set(keys);
  return rows.filter((r) => set.has(r.t));
}

/** Per-bucket totals (generated + prompt) for `keys`, zero where nothing was recorded. */
export function bucketTotals(rows: readonly TokenHistoryRow[], keys: readonly string[]): { key: string; total: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.t, addTokens(by.get(r.t) || 0, addTokens(nn(r.completionTokens), nn(r.promptTokens))));
  return keys.map((key) => ({ key, total: by.get(key) || 0 }));
}

/** Flatten lifetime totals into entries (used for the All time tables and tiles). */
export function entriesFromTotals(series: readonly LlmTokenSeriesTotals[]): Entry[] {
  const out: Entry[] = [];
  for (const s of Array.isArray(series) ? series : []) {
    for (const m of Array.isArray(s.models) ? s.models : []) {
      out.push({
        sparkId: s.sparkId,
        port: s.port,
        modelId: m.modelId,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        cachedTokens: m.cachedTokens,
      });
    }
  }
  return out;
}

/** modelId → latest lastSeenAt (ms) across endpoints. */
export function lastSeenByModel(series: readonly LlmTokenSeriesTotals[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of Array.isArray(series) ? series : []) {
    for (const m of Array.isArray(s.models) ? s.models : []) {
      if (m.lastSeenAt > (out.get(m.modelId) || 0)) out.set(m.modelId, m.lastSeenAt);
    }
  }
  return out;
}

// ─── Summary ─────────────────────────────────────────────

export interface Summary extends Tally {
  cacheRate: number | null;
  /** generated / prompt (output-to-input ratio). */
  genPerPrompt: number | null;
  /** Buckets since tracking began (or the whole window), at least 1. */
  elapsed: number;
  avgPerBucket: number;
  busiest: { key: string; total: number } | null;
  activeBuckets: number;
}

/**
 * `elapsed` overrides the number of buckets the average is spread over (All time spans
 * the whole tracked history, which can be longer than the retained daily buckets).
 */
export function summarize(tally: Tally, totals: readonly { key: string; total: number }[], firstKey: string | null, elapsed?: number): Summary {
  const tracked = firstKey ? totals.filter((b) => b.key >= firstKey) : totals;
  const n = Math.max(1, elapsed ?? tracked.length);
  let busiest: Summary["busiest"] = null;
  let active = 0;
  for (const b of totals) {
    if (b.total > 0) active++;
    if (b.total > 0 && (!busiest || b.total > busiest.total)) busiest = b;
  }
  return {
    ...tally,
    cacheRate: cacheRate(tally),
    genPerPrompt: tally.prompt > 0 ? tally.generated / tally.prompt : null,
    elapsed: n,
    avgPerBucket: tally.total / n,
    busiest,
    activeBuckets: active,
  };
}

export interface Comparison {
  total: number | null;
  generated: number | null;
  prompt: number | null;
  /** Change in cache hit rate in percentage points. */
  cachePoints: number | null;
}

/** Compare against the previous period; null when it had no traffic. */
export function compare(cur: Tally, prev: Tally): Comparison | null {
  if (prev.total <= 0) return null;
  const cr = cacheRate(cur);
  const pr = cacheRate(prev);
  return {
    total: pctChange(cur.total, prev.total),
    generated: pctChange(cur.generated, prev.generated),
    prompt: pctChange(cur.prompt, prev.prompt),
    cachePoints: cr != null && pr != null ? (cr - pr) * 100 : null,
  };
}

// ─── Group-by ────────────────────────────────────────────

export interface GroupSeries {
  id: string;
  label: string;
  total: number;
}

export interface GroupedBuckets {
  series: GroupSeries[];
  buckets: { key: string; values: Record<string, number> }[];
}

export const TYPE_SERIES: readonly { id: string; label: string }[] = [
  { id: "generated", label: "Generated" },
  { id: "cached", label: "Cached prefill" },
  { id: "computed", label: "Computed prefill" },
];

/** One bucket-by-series matrix for the stacked chart; model / spark keep the top N, the rest fold into "Other". */
export function groupBuckets(
  rows: readonly TokenHistoryRow[],
  keys: readonly string[],
  by: GroupBy,
  opts: { topN?: number; sparkName?: (id: string) => string } = {}
): GroupedBuckets {
  const topN = opts.topN ?? 5;
  const name = opts.sparkName ?? ((id: string) => id);
  const byKey = new Map<string, TokenHistoryRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.t);
    if (list) list.push(r);
    else byKey.set(r.t, [r]);
  }

  if (by === "type") {
    const totals: Record<string, number> = { generated: 0, cached: 0, computed: 0 };
    const buckets = keys.map((key) => {
      const t = tallyOf(byKey.get(key) ?? []);
      totals.generated += t.generated;
      totals.cached += t.cached;
      totals.computed += t.computed;
      return { key, values: { generated: t.generated, cached: t.cached, computed: t.computed } };
    });
    return { series: TYPE_SERIES.map((s) => ({ ...s, total: totals[s.id] })), buckets };
  }

  const idOf = (r: TokenHistoryRow) => (by === "model" ? r.modelId : r.sparkId);
  const labelOf = (id: string) => (by === "model" ? id : name(id));
  const weight = (r: TokenHistoryRow) => addTokens(nn(r.completionTokens), nn(r.promptTokens));
  const totals = new Map<string, number>();
  for (const key of keys) for (const r of byKey.get(key) ?? []) totals.set(idOf(r), addTokens(totals.get(idOf(r)) || 0, weight(r)));
  const ranked = [...totals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || labelOf(a[0]).localeCompare(labelOf(b[0])));
  const top = ranked.slice(0, topN);
  const keep = new Set(top.map(([id]) => id));
  const series: GroupSeries[] = top.map(([id, total]) => ({ id, label: labelOf(id), total }));
  const otherTotal = ranked.slice(topN).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) series.push({ id: OTHER_ID, label: "Other", total: otherTotal });

  const buckets = keys.map((key) => {
    const values: Record<string, number> = {};
    for (const r of byKey.get(key) ?? []) {
      const id = keep.has(idOf(r)) ? idOf(r) : OTHER_ID;
      values[id] = addTokens(values[id] || 0, weight(r));
    }
    return { key, values };
  });
  return { series, buckets };
}

// ─── Tables ──────────────────────────────────────────────

export interface ModelRow extends Tally {
  modelId: string;
  cacheRate: number | null;
  share: number;
  sparkIds: string[];
  /** Latest activity in ms (lifetime), or null when unknown. */
  lastSeen: number | null;
}

export function modelRows(entries: readonly Entry[], lastSeen?: ReadonlyMap<string, number>): ModelRow[] {
  const by = new Map<string, { t: Tally; sparks: Set<string> }>();
  for (const e of entries) {
    const cur = by.get(e.modelId) ?? { t: emptyTally(), sparks: new Set<string>() };
    addEntry(cur.t, e);
    cur.sparks.add(e.sparkId);
    by.set(e.modelId, cur);
  }
  const grand = [...by.values()].reduce((s, v) => s + v.t.total, 0);
  return [...by.entries()]
    .filter(([, v]) => v.t.total > 0)
    .map(([modelId, v]) => ({
      ...v.t,
      modelId,
      cacheRate: cacheRate(v.t),
      share: grand > 0 ? v.t.total / grand : 0,
      sparkIds: [...v.sparks].sort(),
      lastSeen: lastSeen?.get(modelId) ?? null,
    }))
    .sort((a, b) => b.total - a.total || a.modelId.localeCompare(b.modelId));
}

export interface EndpointRow extends Tally {
  sparkId: string;
  port: number;
  cacheRate: number | null;
  share: number;
  models: string[];
}

/** One row per (Spark, port) endpoint. */
export function endpointRows(entries: readonly Entry[]): EndpointRow[] {
  const by = new Map<string, { sparkId: string; port: number; t: Tally; models: Set<string> }>();
  for (const e of entries) {
    const id = `${e.sparkId}:${e.port}`;
    const cur = by.get(id) ?? { sparkId: e.sparkId, port: e.port, t: emptyTally(), models: new Set<string>() };
    addEntry(cur.t, e);
    cur.models.add(e.modelId);
    by.set(id, cur);
  }
  const grand = [...by.values()].reduce((s, v) => s + v.t.total, 0);
  return [...by.values()]
    .filter((v) => v.t.total > 0)
    .map((v) => ({
      ...v.t,
      sparkId: v.sparkId,
      port: v.port,
      cacheRate: cacheRate(v.t),
      share: grand > 0 ? v.t.total / grand : 0,
      models: [...v.models].sort(),
    }))
    .sort((a, b) => b.total - a.total || a.sparkId.localeCompare(b.sparkId) || a.port - b.port);
}

export type SortDir = "asc" | "desc";

/** Stable sort by an accessor; nulls always last; strings compare case-insensitively. */
export function sortRows<T>(rows: readonly T[], get: (row: T) => number | string | null, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const c = typeof a.v === "string" || typeof b.v === "string" ? String(a.v).localeCompare(String(b.v), undefined, { sensitivity: "base" }) : a.v - b.v;
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/** "3 h ago", "2 d ago", "just now". */
export function formatAgo(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ─── Insights ────────────────────────────────────────────

export interface InsightInput {
  spec: RangeSpec;
  summary: Summary;
  comparison: Comparison | null;
  models: readonly ModelRow[];
  endpoints: readonly EndpointRow[];
  /** Per-bucket totals for the window, oldest first. */
  totals: readonly { key: string; total: number }[];
  firstKey: string | null;
  sparkName: (id: string) => string;
  tzOffsetMin?: number;
}

const compact = formatTokensCompact;

/** 3-6 plain-English observations; each is only emitted when the data supports it. */
export function buildInsights(i: InsightInput): string[] {
  const out: string[] = [];
  const s = i.summary;
  if (s.total <= 0) return out;
  const unitWord = i.spec.unit === "hour" ? "hour" : "day";
  const period = i.spec.phrase;

  if (s.busiest && s.activeBuckets >= 2) {
    const share = s.busiest.total / Math.max(1, i.totals.reduce((a, b) => a + b.total, 0));
    out.push(`The busiest ${unitWord} was ${bucketTitle(s.busiest.key, i.spec.unit, i.tzOffsetMin).replace(/ \((UTC|local)\)$/, "")} with ${compact(s.busiest.total)} tokens, ${fmtPct(share)} of ${period === "all time" ? "the retained history" : period}.`);
  }

  if (s.prompt > 0) {
    if (s.cached > 0) {
      out.push(`The prefix cache served ${fmtPct(s.cacheRate ?? 0)} of prompt tokens, so about ${compact(s.cached)} prefill tokens did not have to be recomputed.`);
    } else {
      out.push("No prompt tokens were served from the prefix cache. Either prefix caching is off or the engine does not report cache hits.");
    }
  }

  const top = i.models[0];
  if (top) {
    if (i.models.length === 1) out.push(`All traffic ran on ${top.modelId}.`);
    else if (top.share >= 0.5) out.push(`${top.modelId} dominates, handling ${fmtPct(top.share)} of all tokens across ${i.models.length} models.`);
    else out.push(`Traffic is spread across ${i.models.length} models; the busiest, ${top.modelId}, has ${fmtPct(top.share)}.`);
  }

  if (s.genPerPrompt != null && s.generated > 0) {
    const r = s.genPerPrompt;
    const shape =
      r < 0.1 ? "a very input-heavy workload (long prompts, short answers)" : r < 0.5 ? "an input-heavy workload" : r <= 1.5 ? "a fairly balanced mix of input and output" : "an output-heavy workload";
    const perGen = s.prompt / s.generated;
    out.push(`For every generated token, ${perGen >= 10 ? Math.round(perGen) : perGen.toFixed(1)} prompt tokens were read: ${shape}.`);
  }

  const completed = i.totals.slice(0, -1).filter((b) => !i.firstKey || b.key >= i.firstKey);
  const idle = completed.filter((b) => b.total <= 0).length;
  if (idle > 0 && completed.length >= 2) {
    out.push(`${idle} of the ${completed.length} completed ${unitWord}s in ${period === "all time" ? "the retained history" : period} had no traffic at all.`);
  }

  const sparkTotals = new Map<string, number>();
  for (const e of i.endpoints) sparkTotals.set(e.sparkId, (sparkTotals.get(e.sparkId) || 0) + e.total);
  if (sparkTotals.size >= 2 && out.length < 6) {
    const [id, v] = [...sparkTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push(`${i.sparkName(id)} served ${fmtPct(v / s.total)} of all tokens, the most of ${sparkTotals.size} Sparks.`);
  }

  if (i.comparison?.total != null && out.length < 6) {
    const c = i.comparison.total;
    const prev = i.spec.phrase.replace("the last", "the previous");
    out.push(Math.abs(c) < 0.01 ? `Usage is flat compared with ${prev}.` : `Usage is ${c > 0 ? "up" : "down"} ${fmtPct(Math.abs(c))} compared with ${prev}.`);
  }
  return out.slice(0, 6);
}

// ─── CSV ─────────────────────────────────────────────────

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Raw per-bucket rows (UTC bucket start) with a computed-prefill column. */
export function buildCsv(rows: readonly TokenHistoryRow[], sparkName: (id: string) => string = (id) => id): string {
  const head = ["bucket_utc", "spark_id", "spark", "port", "model", "prompt_tokens", "completion_tokens", "cached_tokens", "computed_prefill_tokens"];
  const sorted = [...rows].sort((a, b) => a.t.localeCompare(b.t) || a.sparkId.localeCompare(b.sparkId) || a.port - b.port || a.modelId.localeCompare(b.modelId));
  const lines = [head.join(",")];
  for (const r of sorted) {
    const prompt = nn(r.promptTokens);
    const cached = Math.min(nn(r.cachedTokens), prompt);
    lines.push([r.t, r.sparkId, sparkName(r.sparkId), r.port, r.modelId, prompt, nn(r.completionTokens), cached, prompt - cached].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
