import type { ActivityEvent } from "../../api/types";
import { configuredTimeZone } from "../../shared/timeZone";
import { activeLocale, i18next } from "../../i18n";
import { localizedActivityMessage } from "../../i18n/messages";

/** Pure logic for the Activity page: categories, labels, filtering, counts, day grouping, export. */

export type Severity = ActivityEvent["severity"];

export const SEVERITIES: readonly Severity[] = ["error", "warn", "success", "info"];

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case "error":
      return i18next.t("activity.severity.error", "Error");
    case "warn":
      return i18next.t("activity.severity.warn", "Warning");
    case "success":
      return i18next.t("activity.severity.success", "Success");
    case "info":
      return i18next.t("activity.severity.info", "Info");
  }
}

export type CategoryId = "status" | "thermal" | "health" | "hermes" | "bench" | "power" | "llm" | "fleet" | "other";

export const CATEGORIES: readonly CategoryId[] = [
  "status",
  "thermal",
  "health",
  "hermes",
  "bench",
  "power",
  "llm",
  "fleet",
  "other",
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Spark filter value for events that belong to no Spark. */
export const NO_SPARK = "__none__";

export type RangeId = "24h" | "7d" | "all";

export interface ActivityFilter {
  /** Empty = every severity. */
  severities: Severity[];
  category: CategoryId | "all";
  /** Spark id, NO_SPARK, or "all". */
  sparkId: string;
  query: string;
  range: RangeId;
}

export const EMPTY_FILTER: ActivityFilter = { severities: [], category: "all", sparkId: "all", query: "", range: "all" };

export function isFilterActive(f: ActivityFilter): boolean {
  return f.severities.length > 0 || f.category !== "all" || f.sparkId !== "all" || f.query.trim() !== "" || f.range !== "all";
}

export function categorize(type: string): CategoryId {
  if (type === "spark.online" || type === "spark.offline") return "status";
  if (type === "spark.added" || type === "spark.removed") return "fleet";
  if (type.startsWith("gpu.throttle")) return "thermal";
  if (type.startsWith("health.")) return "health";
  if (type.startsWith("hermes.")) return "hermes";
  if (type.startsWith("bench.")) return "bench";
  if (type.startsWith("power.")) return "power";
  if (type.startsWith("llm.")) return "llm";
  return "other";
}

function knownTypeLabel(type: string): string | null {
  switch (type) {
    case "spark.online":
      return i18next.t("activity.type.sparkOnline", "Online");
    case "spark.offline":
      return i18next.t("activity.type.sparkOffline", "Offline");
    case "spark.added":
      return i18next.t("activity.type.sparkAdded", "Spark added");
    case "spark.removed":
      return i18next.t("activity.type.sparkRemoved", "Spark removed");
    case "gpu.throttle.thermal":
      return i18next.t("activity.type.throttleThermal", "Thermal throttle");
    case "gpu.throttle.cleared":
      return i18next.t("activity.type.throttleCleared", "Throttle cleared");
    case "hermes.update.available":
      return i18next.t("activity.type.hermesAvailable", "Hermes update available");
    case "hermes.update.success":
    case "hermes.update.completed":
      return i18next.t("activity.type.hermesUpdated", "Hermes updated");
    case "hermes.update.error":
    case "hermes.update.failed":
      return i18next.t("activity.type.hermesFailed", "Hermes update failed");
    case "health.xid":
      return i18next.t("activity.type.xid", "Xid error");
    case "health.oom":
      return i18next.t("activity.type.oom", "Out of memory kill");
    case "health.thermal":
      return i18next.t("activity.type.runningHot", "Running hot");
    case "health.low-power":
      return i18next.t("activity.type.lowPower", "Low power state");
    case "health.memory":
      return i18next.t("activity.type.lowMemory", "Low memory");
    case "health.concurrency":
      return i18next.t("activity.type.concurrency", "Many models loaded");
    case "health.link-speed":
      return i18next.t("activity.type.linkSpeed", "Slow link");
    case "health.roce-link":
      return i18next.t("activity.type.roceLink", "RoCE link down");
    case "health.roce-loss":
      return i18next.t("activity.type.roceLoss", "RoCE packet loss");
    case "health.cleared":
      return i18next.t("activity.type.healthOk", "Health OK");
    case "power.shutdown":
    case "power.shutdown.requested":
      return i18next.t("activity.type.shutdown", "Shutdown");
    case "power.wake":
    case "power.wake.sent":
      return i18next.t("activity.type.wake", "Wake");
    default:
      return null;
  }
}

function benchName(id: string): string | null {
  switch (id) {
    case "decode":
      return i18next.t("activity.type.benchDecode", "Decode bench");
    case "prefill":
      return i18next.t("activity.type.benchPrefill", "Prefill bench");
    case "quality":
      return i18next.t("activity.type.benchQuality", "Quality bench");
    default:
      return null;
  }
}

function llmAction(id: string): string | null {
  switch (id) {
    case "start":
      return i18next.t("activity.type.llmStart", "LLM start");
    case "stop":
      return i18next.t("activity.type.llmStop", "LLM stop");
    case "attach":
      return i18next.t("activity.type.llmAttach", "LLM attach");
    default:
      return null;
  }
}

function sentence(s: string): string {
  const text = s.replace(/[._-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : i18next.t("activity.type.event", "Event");
}

/** Short human label for a type tag, e.g. "bench.decode.finished" -> "Decode bench". */
export function typeLabel(type: string): string {
  const known = knownTypeLabel(type);
  if (known) return known;
  const parts = type.split(".");
  if (parts[0] === "bench" && parts.length === 3) {
    const name = benchName(parts[1]);
    if (name) {
      switch (parts[2]) {
        case "finished":
          return i18next.t("activity.type.benchFinished", "{name}", { name });
        case "failed":
          return i18next.t("activity.type.benchFailed", "{name} failed", { name });
        case "cancelled":
          return i18next.t("activity.type.benchCancelled", "{name} cancelled", { name });
        default:
          break;
      }
    }
  }
  if (parts[0] === "llm" && parts.length === 3) {
    const action = llmAction(parts[1]);
    if (action) return i18next.t("activity.type.llmAction", "{action} {stage}", { action, stage: stageLabel(parts[2]) });
  }
  return sentence(type);
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "requested": return i18next.t("activity.stage.requested", "requested");
    case "completed": return i18next.t("activity.stage.completed", "completed");
    case "cancelled": return i18next.t("activity.stage.cancelled", "cancelled");
    case "failed": return i18next.t("activity.stage.failed", "failed");
    case "detached": return i18next.t("activity.stage.detached", "detached");
    default: return stage;
  }
}

export function categoryLabel(id: CategoryId): string {
  switch (id) {
    case "status":
      return i18next.t("activity.category.status", "Status (online/offline)");
    case "thermal":
      return i18next.t("activity.category.thermal", "Thermal");
    case "health":
      return i18next.t("activity.category.health", "Health");
    case "hermes":
      return i18next.t("activity.category.hermes", "Hermes");
    case "bench":
      return i18next.t("activity.category.bench", "Benchmarks");
    case "power":
      return i18next.t("activity.category.power", "Power");
    case "llm":
      return i18next.t("activity.category.llm", "LLM models");
    case "fleet":
      return i18next.t("activity.category.fleet", "Fleet changes");
    case "other":
      return i18next.t("activity.category.other", "Other");
  }
}

/** Newest first by id (ids are monotonic), ts as a tiebreak for odd inputs. */
function byNewest(a: ActivityEvent, b: ActivityEvent): number {
  return b.id - a.id || b.ts - a.ts;
}

/** Merge a page of events into a list: dedupe by id (incoming wins), newest first. */
export function mergeEvents(current: readonly ActivityEvent[], incoming: readonly ActivityEvent[]): ActivityEvent[] {
  const map = new Map<number, ActivityEvent>();
  for (const e of current) map.set(e.id, e);
  for (const e of incoming) map.set(e.id, e);
  return [...map.values()].sort(byNewest);
}

export function sparkKey(e: ActivityEvent): string {
  return e.sparkId ? e.sparkId : NO_SPARK;
}

function rangeCutoff(range: RangeId, now: number): number {
  return range === "24h" ? now - DAY_MS : range === "7d" ? now - 7 * DAY_MS : -Infinity;
}

type Dim = keyof ActivityFilter;

function matches(e: ActivityEvent, f: ActivityFilter, now: number, skip?: Dim): boolean {
  if (skip !== "severities" && f.severities.length > 0 && !f.severities.includes(e.severity)) return false;
  if (skip !== "category" && f.category !== "all" && categorize(e.type) !== f.category) return false;
  if (skip !== "sparkId" && f.sparkId !== "all" && sparkKey(e) !== f.sparkId) return false;
  if (skip !== "range" && e.ts < rangeCutoff(f.range, now)) return false;
  if (skip !== "query") {
    const q = f.query.trim().toLowerCase();
    if (q) {
      const hay = `${localizedActivityMessage(e)}\n${e.message}\n${e.sparkName ?? ""}\n${e.type}\n${typeLabel(e.type)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

/** Events matching every active filter dimension (order preserved). */
export function filterEvents(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): ActivityEvent[] {
  return events.filter((e) => matches(e, f, now));
}

/** Faceted counts: each dimension is counted with all the OTHER filters applied. */
export function countBySeverity(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warn: 0, success: 0, info: 0 };
  for (const e of events) if (matches(e, f, now, "severities") && e.severity in out) out[e.severity]++;
  return out;
}

export function countByCategory(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<CategoryId, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<CategoryId, number>;
  for (const e of events) if (matches(e, f, now, "category")) out[categorize(e.type)]++;
  return out;
}

export function countBySpark(events: readonly ActivityEvent[], f: ActivityFilter, now: number = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) if (matches(e, f, now, "sparkId")) out[sparkKey(e)] = (out[sparkKey(e)] ?? 0) + 1;
  return out;
}

export interface SparkOption {
  id: string;
  name: string;
}

/** Sparks from the live list plus any ids only seen in events (removed Sparks), sorted by name. */
export function sparkOptions(
  sparks: readonly { id: string; name?: string | null }[],
  events: readonly ActivityEvent[]
): SparkOption[] {
  const map = new Map<string, string>();
  for (const s of sparks) map.set(s.id, s.name || s.id);
  for (const e of events) {
    if (e.sparkId && !map.has(e.sparkId)) map.set(e.sparkId, e.sparkName || e.sparkId);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Local-day handling ──────────────────────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // No explicit zone: the Settings time zone, else the browser's.
  const zone = tz ?? configuredTimeZone() ?? undefined;
  const locale = activeLocale() === "zh-Hans" ? "zh-CN" : "en-US";
  const k = `${locale}|${key}|${zone ?? ""}`;
  let f = dtfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone });
    dtfCache.set(k, f);
  }
  return f;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymd(ts: number, tz?: string): Ymd {
  const parts = dtf("ymd", tz, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const keyOf = ({ y, m, d }: Ymd) => `${y}-${pad2(m)}-${pad2(d)}`;
const dayNumber = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d) / DAY_MS;

/** "YYYY-MM-DD" of the calendar day containing ts in `tz` (default: browser-local). */
export function localDayKey(ts: number, tz?: string): string {
  return keyOf(ymd(ts, tz));
}

function parseKey(key: string): Ymd {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

/** Format a day key with Intl options (the key is a plain calendar date, so UTC is exact). */
function formatDayKey(key: string, opts: Intl.DateTimeFormatOptions): string {
  const { y, m, d } = parseKey(key);
  return dtf(`dk${JSON.stringify(opts)}`, "UTC", opts).format(new Date(Date.UTC(y, m - 1, d)));
}

function shiftKey(key: string, days: number): string {
  const { y, m, d } = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return keyOf({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** "Today", "Yesterday", else "Tuesday, Oct 7" (adds the year when it differs from now's). */
export function dayLabel(key: string, now: number = Date.now(), tz?: string): string {
  const today = ymd(now, tz);
  const diff = dayNumber(today) - dayNumber(parseKey(key));
  if (diff === 0) return i18next.t("activity.day.today", "Today");
  if (diff === 1) return i18next.t("activity.day.yesterday", "Yesterday");
  const sameYear = parseKey(key).y === today.y;
  return formatDayKey(key, sameYear ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

/** "14:05" 24-hour local time. */
export function formatClock(ts: number, tz?: string): string {
  return dtf("clock", tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts));
}

/** "2026-10-07 14:05:09" in `tz`. */
export function formatStamp(ts: number, tz?: string): string {
  const parts = dtf("stamp", tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

export interface DayGroup {
  key: string;
  label: string;
  events: ActivityEvent[];
}

/** Group events (in the given order) by local day; groups keep first-seen order. */
export function groupByDay(events: readonly ActivityEvent[], now: number = Date.now(), tz?: string): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const e of events) {
    const key = localDayKey(e.ts, tz);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: dayLabel(key, now, tz), events: [] };
      groups.set(key, g);
    }
    g.events.push(e);
  }
  return [...groups.values()];
}

export interface DayBucket {
  key: string;
  /** Short axis label ("Oct 7"). */
  label: string;
  /** Tooltip heading ("Tue, Oct 7"). */
  title: string;
  counts: Record<Severity, number>;
}

/** One bucket per local day for the last `days` days (oldest first, today last), zero-filled. */
export function eventsPerDay(events: readonly ActivityEvent[], now: number = Date.now(), days = 14, tz?: string): DayBucket[] {
  const today = localDayKey(now, tz);
  const buckets: DayBucket[] = [];
  const index = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const key = shiftKey(today, -i);
    const b: DayBucket = {
      key,
      label: formatDayKey(key, { month: "short", day: "numeric" }),
      title: formatDayKey(key, { weekday: "short", month: "short", day: "numeric" }),
      counts: { error: 0, warn: 0, success: 0, info: 0 },
    };
    buckets.push(b);
    index.set(key, b);
  }
  for (const e of events) {
    const b = index.get(localDayKey(e.ts, tz));
    if (b && e.severity in b.counts) b.counts[e.severity]++;
  }
  return buckets;
}

export interface ActivitySummary {
  events24h: number;
  events7d: number;
  errors24h: number;
  errors7d: number;
  warnings24h: number;
  warnings7d: number;
  /** Sparks with at least one error or warning in the last 24 h. */
  problemSparks24h: number;
  problemSparks7d: number;
  mostActive: { sparkId: string; name: string; count: number } | null;
}

/** Headline numbers; the most active Spark is over the last 24 h, falling back to 7 d when quiet. */
export function summarize(events: readonly ActivityEvent[], now: number = Date.now()): ActivitySummary {
  const c24 = now - DAY_MS;
  const c7 = now - 7 * DAY_MS;
  const s: ActivitySummary = {
    events24h: 0, events7d: 0, errors24h: 0, errors7d: 0, warnings24h: 0, warnings7d: 0,
    problemSparks24h: 0, problemSparks7d: 0, mostActive: null,
  };
  const prob24 = new Set<string>();
  const prob7 = new Set<string>();
  const per24 = new Map<string, { name: string; count: number }>();
  const per7 = new Map<string, { name: string; count: number }>();
  const bump = (m: Map<string, { name: string; count: number }>, e: ActivityEvent) => {
    const k = e.sparkId as string;
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { name: e.sparkName || k, count: 1 });
  };
  for (const e of events) {
    if (e.ts < c7 || e.ts > now + HOUR_MS) continue;
    s.events7d++;
    const problem = e.severity === "error" || e.severity === "warn";
    if (e.severity === "error") s.errors7d++;
    if (e.severity === "warn") s.warnings7d++;
    if (problem && e.sparkId) prob7.add(e.sparkId);
    if (e.sparkId) bump(per7, e);
    if (e.ts >= c24) {
      s.events24h++;
      if (e.severity === "error") s.errors24h++;
      if (e.severity === "warn") s.warnings24h++;
      if (problem && e.sparkId) prob24.add(e.sparkId);
      if (e.sparkId) bump(per24, e);
    }
  }
  s.problemSparks24h = prob24.size;
  s.problemSparks7d = prob7.size;
  const best = (m: Map<string, { name: string; count: number }>) => {
    let top: ActivitySummary["mostActive"] = null;
    for (const [sparkId, v] of m) {
      if (!top || v.count > top.count || (v.count === top.count && v.name.localeCompare(top.name) < 0)) {
        top = { sparkId, name: v.name, count: v.count };
      }
    }
    return top;
  };
  s.mostActive = best(per24) ?? best(per7);
  return s;
}

/** Plain-text export, one line per event, in the order given. */
export function exportText(events: readonly ActivityEvent[], tz?: string): string {
  return events
    .map((e) => {
      return `${formatStamp(e.ts, tz)} [${severityLabel(e.severity)}] ${typeLabel(e.type)} - ${localizedActivityMessage(e)}`.replace(/\s+/g, " ");
    })
    .join("\n");
}
