import type { EnergyHistoryRow } from "../../api/types";
import { tzOffsetMinutes } from "../../shared/timeZone";

/**
 * Pure maths for the Fleet energy page: range selection, local-calendar grouping,
 * per-node totals, deltas, efficiency, cost, insights and CSV. Everything that
 * depends on the viewer's time zone takes an explicit `tzOffsetMin` function so it
 * can be tested without relying on the machine TZ.
 *
 * Data semantics (mirrors server/energy/FleetEnergyTracker.js):
 *  - nodeWh / nodeCoverageMs: per node, while THAT node reported fresh telemetry.
 *  - fleetEnergyWh / fleetCoverageMs / coveredOutputTokens: only while EVERY node was fresh.
 *  - Hours with no coverage at all are omitted by the server (gaps).
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type EnergyRange = "24h" | "7d" | "14d" | "31d";
export const RANGE_DAYS: Record<EnergyRange, number> = { "24h": 1, "7d": 7, "14d": 14, "31d": 31 };

/** Minutes east of UTC for the instant `ms` (e.g. +120 for CEST). */
export type TzOffsetFn = (ms: number) => number;

/** Offset of the chart time zone at `ms`: the Settings time zone, else the viewer's browser's. */
export const browserTzOffset: TzOffsetFn = (ms) => tzOffsetMinutes(ms);

/** Fixed-offset helper, mostly for tests. */
export const fixedTz = (minutes: number): TzOffsetFn => () => minutes;

/** Node colours in stack order (largest consumer first). */
export const NODE_COLORS = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-violet)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
  "var(--color-muted-strong)",
  "var(--color-faint)",
];

/** Rows need at least this much coverage before an hour counts for "peak". */
const MIN_PEAK_COVERAGE_MS = 10 * 60_000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date whose UTC fields read as the viewer's wall clock at `ms`. */
function wall(ms: number, tz: TzOffsetFn): Date {
  return new Date(ms + tz(ms) * 60_000);
}

/** Local calendar date key "YYYY-MM-DD". Built from wall-clock fields, so DST days are still one day. */
export function localDayKey(ms: number, tz: TzOffsetFn): string {
  const d = wall(ms, tz);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function localHour(ms: number, tz: TzOffsetFn): number {
  return wall(ms, tz).getUTCHours();
}

export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** "Tue 14:00" */
export function formatLocalHour(ms: number, tz: TzOffsetFn): string {
  const d = wall(ms, tz);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:00`;
}

/** "Tue 7 Oct" */
export function formatLocalDay(ms: number, tz: TzOffsetFn): string {
  const d = wall(ms, tz);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface RangeWindow {
  range: EnergyRange;
  /** Start of the first hour slot in the range (UTC ms, hour-aligned). */
  startMs: number;
  /** Start of the hour containing "now". */
  endHourMs: number;
  nowMs: number;
  hours: number;
  /** Where measuring could have begun: max(startMs, first recorded hour). */
  windowStartMs: number;
  /** Length of the span coverage is measured against. */
  windowMs: number;
  /** Equal-length period directly before the range. */
  prevStartMs: number;
}

export function rangeWindow(range: EnergyRange, nowMs: number, rows: readonly EnergyHistoryRow[]): RangeWindow {
  const hours = RANGE_DAYS[range] * 24;
  const endHourMs = floorHour(nowMs);
  const startMs = endHourMs - (hours - 1) * HOUR_MS;
  const firstT = rows.length ? Math.min(...rows.map((r) => r.t)) : startMs;
  const windowStartMs = Math.min(endHourMs, Math.max(startMs, firstT));
  return {
    range,
    startMs,
    endHourMs,
    nowMs,
    hours,
    windowStartMs,
    windowMs: slotMs(windowStartMs, endHourMs, nowMs),
    prevStartMs: startMs - hours * HOUR_MS,
  };
}

/** Milliseconds of hour slots from `fromHour` to the slot holding `nowMs` (last slot only partly elapsed). */
function slotMs(fromHour: number, endHour: number, nowMs: number): number {
  if (endHour < fromHour) return 0;
  const full = (endHour - fromHour) / HOUR_MS;
  return full * HOUR_MS + Math.max(0, Math.min(HOUR_MS, nowMs - endHour));
}

export function rowsInRange(rows: readonly EnergyHistoryRow[], fromMs: number, toHourMs: number): EnergyHistoryRow[] {
  return rows.filter((r) => r.t >= fromMs && r.t <= toHourMs);
}

export const rowNodeWh = (row: EnergyHistoryRow): number =>
  Object.values(row.nodeWh).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);

/** Longest single-node coverage in the row: how much of the hour had *some* data. */
const rowMaxCoverageMs = (row: EnergyHistoryRow): number =>
  Math.max(0, ...Object.values(row.nodeCoverageMs).map((v) => (Number.isFinite(v) ? v : 0)));

export interface EnergyBucket {
  key: string;
  startMs: number;
  /** Short axis label. */
  label: string;
  /** Tooltip heading. */
  title: string;
  /** kWh per node id. */
  nodeKwh: Record<string, number>;
  kwh: number;
  fleetWh: number;
  fleetCoverageMs: number;
  /** Time in the bucket that could have been covered (hours elapsed in range). */
  expectedMs: number;
  outputTokens: number;
  coveredTokens: number;
  avgWatts: number | null;
  /** Wh per 1,000 generated tokens, null without token data. */
  whPer1kTokens: number | null;
  hasData: boolean;
}

export function whPer1kTokens(fleetWh: number, coveredTokens: number): number | null {
  return coveredTokens > 0 && fleetWh > 0 ? (fleetWh / coveredTokens) * 1000 : null;
}

/**
 * Group hourly rows into buckets: one per hour ("hour" mode) or one per LOCAL calendar
 * day ("day" mode). Buckets are generated from hour slots, so empty hours/days appear as
 * gaps and DST days (23 h / 25 h) are still a single bucket.
 */
export function buildBuckets(
  rows: readonly EnergyHistoryRow[],
  win: RangeWindow,
  mode: "hour" | "day",
  tz: TzOffsetFn
): EnergyBucket[] {
  const from = mode === "hour" ? win.startMs : win.windowStartMs;
  const byKey = new Map<string, EnergyBucket>();
  const order: EnergyBucket[] = [];
  const keyOf = (t: number) => (mode === "hour" ? String(t) : localDayKey(t, tz));
  const ensure = (t: number): EnergyBucket => {
    const key = keyOf(t);
    let b = byKey.get(key);
    if (!b) {
      b = {
        key,
        startMs: t,
        label: mode === "hour" ? `${pad(localHour(t, tz))}:00` : formatShortDay(t, tz),
        title: mode === "hour" ? formatLocalHour(t, tz) : formatLocalDay(t, tz),
        nodeKwh: {},
        kwh: 0,
        fleetWh: 0,
        fleetCoverageMs: 0,
        expectedMs: 0,
        outputTokens: 0,
        coveredTokens: 0,
        avgWatts: null,
        whPer1kTokens: null,
        hasData: false,
      };
      byKey.set(key, b);
      order.push(b);
    }
    return b;
  };
  for (let t = floorHour(from); t <= win.endHourMs; t += HOUR_MS) {
    ensure(t).expectedMs += t === win.endHourMs ? Math.max(0, Math.min(HOUR_MS, win.nowMs - t)) : HOUR_MS;
  }
  for (const r of rows) {
    if (r.t < floorHour(from) || r.t > win.endHourMs) continue;
    const b = ensure(r.t);
    for (const [id, wh] of Object.entries(r.nodeWh)) {
      if (!Number.isFinite(wh) || wh <= 0) continue;
      b.nodeKwh[id] = (b.nodeKwh[id] || 0) + wh / 1000;
      b.kwh += wh / 1000;
    }
    b.fleetWh += r.fleetEnergyWh || 0;
    b.fleetCoverageMs += r.fleetCoverageMs || 0;
    b.outputTokens += r.outputTokens || 0;
    b.coveredTokens += r.coveredOutputTokens || 0;
    b.hasData = true;
  }
  for (const b of order) {
    b.avgWatts = b.fleetCoverageMs > 0 ? b.fleetWh / (b.fleetCoverageMs / HOUR_MS) : null;
    b.whPer1kTokens = whPer1kTokens(b.fleetWh, b.coveredTokens);
  }
  return order;
}

export function formatShortDay(ms: number, tz: TzOffsetFn): string {
  const d = wall(ms, tz);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export interface NodeStat {
  id: string;
  kwh: number;
  /** Share of fleet kWh, 0..1. */
  share: number;
  avgWatts: number | null;
  peakWatts: number | null;
  peakAtMs: number | null;
  coverageMs: number;
  /** 0..1 of the measuring window. */
  coverage: number;
  cost: number | null;
}

export interface PeakHour {
  watts: number;
  atMs: number;
}

export interface EnergySummary {
  kwh: number;
  avgWatts: number | null;
  peak: PeakHour | null;
  /** 0..1 of the measuring window with the whole fleet fresh. */
  coverage: number;
  fleetCoverageMs: number;
  windowMs: number;
  outputTokens: number;
  coveredTokens: number;
  whPer1kTokens: number | null;
  /** Hours (or fractions) of fleet-wide data. */
  coveredHours: number;
  nodes: NodeStat[];
  cost: number | null;
  costPerDay: number | null;
  hasData: boolean;
}

export function costFor(kwh: number, price: number | null | undefined): number | null {
  return price != null && Number.isFinite(price) && price >= 0 ? kwh * price : null;
}

export function summarize(
  rows: readonly EnergyHistoryRow[],
  win: RangeWindow,
  nodeIds: readonly string[],
  price: number | null | undefined
): EnergySummary {
  const inRange = rowsInRange(rows, win.startMs, win.endHourMs);
  const nodeWh = new Map<string, number>();
  const nodeCov = new Map<string, number>();
  const nodePeak = new Map<string, PeakHour>();
  let fleetWh = 0;
  let fleetCov = 0;
  let tokens = 0;
  let covered = 0;
  let peak: PeakHour | null = null;
  for (const id of nodeIds) {
    nodeWh.set(id, 0);
    nodeCov.set(id, 0);
  }
  for (const r of inRange) {
    for (const [id, wh] of Object.entries(r.nodeWh)) {
      if (Number.isFinite(wh)) nodeWh.set(id, (nodeWh.get(id) || 0) + wh);
    }
    for (const [id, ms] of Object.entries(r.nodeCoverageMs)) {
      if (!Number.isFinite(ms)) continue;
      nodeCov.set(id, (nodeCov.get(id) || 0) + ms);
      if (ms >= MIN_PEAK_COVERAGE_MS) {
        const w = (r.nodeWh[id] || 0) / (ms / HOUR_MS);
        const cur = nodePeak.get(id);
        if (!cur || w > cur.watts) nodePeak.set(id, { watts: w, atMs: r.t });
      }
    }
    fleetWh += r.fleetEnergyWh || 0;
    fleetCov += r.fleetCoverageMs || 0;
    tokens += r.outputTokens || 0;
    covered += r.coveredOutputTokens || 0;
    if (r.avgWatts != null && (r.fleetCoverageMs || 0) >= MIN_PEAK_COVERAGE_MS && (!peak || r.avgWatts > peak.watts)) {
      peak = { watts: r.avgWatts, atMs: r.t };
    }
  }
  const totalWh = [...nodeWh.values()].reduce((s, v) => s + v, 0);
  const kwh = totalWh / 1000;
  const nodes: NodeStat[] = [...nodeWh.entries()]
    .map(([id, wh]) => {
      const cov = nodeCov.get(id) || 0;
      const pk = nodePeak.get(id);
      return {
        id,
        kwh: wh / 1000,
        share: totalWh > 0 ? wh / totalWh : 0,
        avgWatts: cov > 0 ? wh / (cov / HOUR_MS) : null,
        peakWatts: pk?.watts ?? null,
        peakAtMs: pk?.atMs ?? null,
        coverageMs: cov,
        coverage: win.windowMs > 0 ? Math.min(1, cov / win.windowMs) : 0,
        cost: costFor(wh / 1000, price),
      };
    })
    .sort((a, b) => b.kwh - a.kwh);
  const dataSpanDays = win.windowMs / DAY_MS;
  const cost = costFor(kwh, price);
  return {
    kwh,
    avgWatts: fleetCov > 0 ? fleetWh / (fleetCov / HOUR_MS) : null,
    peak,
    coverage: win.windowMs > 0 ? Math.min(1, fleetCov / win.windowMs) : 0,
    fleetCoverageMs: fleetCov,
    windowMs: win.windowMs,
    outputTokens: tokens,
    coveredTokens: covered,
    whPer1kTokens: whPer1kTokens(fleetWh, covered),
    coveredHours: fleetCov / HOUR_MS,
    nodes,
    cost,
    costPerDay: cost != null && dataSpanDays > 0 ? cost / dataSpanDays : null,
    hasData: totalWh > 0,
  };
}

export interface PeriodDelta {
  prevKwh: number;
  /** (current - previous) / previous. */
  ratio: number;
}

/**
 * Change versus the equal-length period before the range. Null unless that period holds
 * enough data (>= 75% of its hours had some telemetry) to make the comparison fair.
 */
export function previousPeriodDelta(rows: readonly EnergyHistoryRow[], win: RangeWindow, currentKwh: number): PeriodDelta | null {
  const prev = rowsInRange(rows, win.prevStartMs, win.startMs - HOUR_MS);
  if (!prev.length) return null;
  const covered = prev.reduce((s, r) => s + Math.min(HOUR_MS, rowMaxCoverageMs(r)), 0);
  if (covered < 0.75 * win.hours * HOUR_MS) return null;
  const prevKwh = prev.reduce((s, r) => s + rowNodeWh(r), 0) / 1000;
  if (prevKwh <= 0) return null;
  return { prevKwh, ratio: (currentKwh - prevKwh) / prevKwh };
}

// ─── Insights ────────────────────────────────────────────────────────────

export interface InsightContext {
  summary: EnergySummary;
  buckets: readonly EnergyBucket[];
  rows: readonly EnergyHistoryRow[];
  mode: "hour" | "day";
  tz: TzOffsetFn;
  price: number | null | undefined;
  currency: string;
  nodeName: (id: string) => string;
}

const fmtNum = (v: number, digits = 1) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatKwh(v: number | null): string {
  if (v == null) return "—";
  return v >= 100 ? fmtNum(v, 0) : v >= 10 ? fmtNum(v, 1) : fmtNum(v, 2);
}

export function formatWatts(v: number | null): string {
  return v == null ? "—" : `${Math.round(v).toLocaleString("en-US")} W`;
}

export function formatMoney(v: number | null, currency: string): string {
  if (v == null) return "—";
  const digits = Math.abs(v) >= 100 ? 0 : 2;
  return `${currency}${fmtNum(v, digits)}`;
}

export function formatTokensPerKwh(v: number): string {
  if (v >= 1_000_000) return `${fmtNum(v / 1_000_000, 2)} M`;
  if (v >= 1000) return `${fmtNum(v / 1000, 1)} k`;
  return fmtNum(v, 0);
}

const NIGHT_START = 22;
const NIGHT_END = 6;
const isNight = (h: number) => h >= NIGHT_START || h < NIGHT_END;

/** Plain-English observations; each is only produced when the data supports it. */
export function buildInsights(ctx: InsightContext): string[] {
  const { summary, buckets, rows, tz, price, currency, nodeName } = ctx;
  const out: string[] = [];
  if (!summary.hasData) return out;

  const top = summary.nodes[0];
  if (summary.nodes.filter((n) => n.kwh > 0).length >= 2 && top && top.kwh > 0) {
    const second = summary.nodes[1];
    const spread = second && second.kwh > 0 ? top.kwh / second.kwh : null;
    out.push(
      `${nodeName(top.id)} uses the most energy: ${formatKwh(top.kwh)} kWh, ${Math.round(top.share * 100)}% of the fleet total` +
        (top.avgWatts != null ? `, averaging ${formatWatts(top.avgWatts)} while reporting.` : ".") +
        (spread != null && spread >= 1.5 ? ` That is ${fmtNum(spread, 1)}x the next node.` : "")
    );
  }

  if (summary.peak) {
    const where = formatLocalHour(summary.peak.atMs, tz);
    const low = lowestHour(rows, summary, summary.peak.atMs);
    out.push(
      `The highest-draw hour was ${where} (local) at ${formatWatts(summary.peak.watts)}` +
        (low ? `; the lowest was ${formatLocalHour(low.atMs, tz)} at ${formatWatts(low.watts)}.` : ".")
    );
  }

  if (ctx.mode === "day") {
    const days = buckets.filter((b) => b.kwh > 0 && b.expectedMs >= 20 * HOUR_MS && b.fleetCoverageMs >= 0.6 * b.expectedMs);
    if (days.length >= 3) {
      const best = days.reduce((a, b) => (b.kwh > a.kwh ? b : a));
      const avg = days.reduce((s, b) => s + b.kwh, 0) / days.length;
      out.push(
        `${best.title} was the highest-use day with ${formatKwh(best.kwh)} kWh, ${Math.round((best.kwh / avg - 1) * 100)}% above the ${fmtNum(avg, 1)} kWh average of well-covered days.`
      );
    }
  }

  const dn = dayNight(rows, tz);
  if (dn) {
    const diff = (dn.day - dn.night) / dn.day;
    if (Math.abs(diff) >= 0.05) {
      out.push(
        diff > 0
          ? `Overnight (22:00 to 06:00 local) the fleet averaged ${formatWatts(dn.night)}, ${Math.round(diff * 100)}% lower than the ${formatWatts(dn.day)} daytime average.`
          : `Overnight (22:00 to 06:00 local) the fleet averaged ${formatWatts(dn.night)}, ${Math.round(-diff * 100)}% higher than the ${formatWatts(dn.day)} daytime average.`
      );
    } else {
      out.push(`Draw is steady around the clock: ${formatWatts(dn.night)} overnight versus ${formatWatts(dn.day)} during the day.`);
    }
  }

  if (summary.cost != null && summary.coveredHours >= 12 && price != null) {
    const perWeek = ((summary.kwh / (summary.windowMs / DAY_MS)) * 7) * price;
    out.push(
      `At ${currency}${fmtNum(price, price < 1 ? 3 : 2)} per kWh, this pace would cost about ${formatMoney(perWeek, currency)} per week. This is a rough extrapolation from the data recorded so far, not a forecast.`
    );
  }

  if (summary.whPer1kTokens != null && summary.coveredTokens >= 1000) {
    const tokensPerKwh = 1_000_000 / summary.whPer1kTokens;
    out.push(
      `The fleet generated about ${formatTokensPerKwh(tokensPerKwh)} output tokens per kWh (${fmtNum(summary.whPer1kTokens, summary.whPer1kTokens < 10 ? 2 : 1)} Wh per 1,000 tokens), counting idle time in the same hours.`
    );
  }
  return out.slice(0, 6);
}

function lowestHour(rows: readonly EnergyHistoryRow[], summary: EnergySummary, peakAtMs: number): PeakHour | null {
  let low: PeakHour | null = null;
  for (const r of rows) {
    if (r.avgWatts == null || (r.fleetCoverageMs || 0) < 30 * 60_000 || r.t === peakAtMs) continue;
    if (!low || r.avgWatts < low.watts) low = { watts: r.avgWatts, atMs: r.t };
  }
  // Only worth mentioning when it differs meaningfully from the peak.
  return low && summary.peak && low.watts < summary.peak.watts * 0.95 ? low : null;
}

/** Average fleet watts overnight vs daytime (local); null unless both have >= 3 covered hours. */
export function dayNight(rows: readonly EnergyHistoryRow[], tz: TzOffsetFn): { day: number; night: number } | null {
  const acc = { day: { wh: 0, ms: 0 }, night: { wh: 0, ms: 0 } };
  for (const r of rows) {
    if (!(r.fleetCoverageMs > 0)) continue;
    const a = isNight(localHour(r.t, tz)) ? acc.night : acc.day;
    a.wh += r.fleetEnergyWh || 0;
    a.ms += r.fleetCoverageMs;
  }
  if (acc.day.ms < 3 * HOUR_MS || acc.night.ms < 3 * HOUR_MS) return null;
  return { day: acc.day.wh / (acc.day.ms / HOUR_MS), night: acc.night.wh / (acc.night.ms / HOUR_MS) };
}

// ─── Sorting (By node table) ─────────────────────────────────────────────

export type NodeSortKey = "name" | "kwh" | "share" | "avgWatts" | "peakWatts" | "coverage" | "cost";

export function sortNodes(nodes: readonly NodeStat[], key: NodeSortKey, dir: "asc" | "desc", nameOf: (id: string) => string): NodeStat[] {
  const sign = dir === "asc" ? 1 : -1;
  const val = (n: NodeStat): number | string | null => {
    switch (key) {
      case "name": return nameOf(n.id).toLowerCase();
      case "kwh": return n.kwh;
      case "share": return n.share;
      case "avgWatts": return n.avgWatts;
      case "peakWatts": return n.peakWatts;
      case "coverage": return n.coverage;
      case "cost": return n.cost;
    }
  };
  return [...nodes].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // Missing values always sink to the bottom regardless of direction.
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" && typeof y === "string") return sign * x.localeCompare(y);
    return sign * ((x as number) - (y as number));
  });
}

// ─── CSV ─────────────────────────────────────────────────────────────────

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Hourly rows in the range as CSV: UTC hour, per-node Wh and coverage minutes, fleet figures. */
export function toCsv(rows: readonly EnergyHistoryRow[], nodeIds: readonly string[], nameOf: (id: string) => string): string {
  const header = [
    "hour_start_utc",
    ...nodeIds.map((id) => `${nameOf(id)} Wh`),
    ...nodeIds.map((id) => `${nameOf(id)} coverage min`),
    "fleet Wh (all nodes fresh)",
    "fleet avg W",
    "fleet coverage min",
    "output tokens",
    "output tokens (covered)",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.t).toISOString(),
        ...nodeIds.map((id) => round(r.nodeWh[id] ?? 0, 3)),
        ...nodeIds.map((id) => round((r.nodeCoverageMs[id] ?? 0) / 60_000, 1)),
        round(r.fleetEnergyWh, 3),
        r.avgWatts == null ? "" : round(r.avgWatts, 1),
        round(r.fleetCoverageMs / 60_000, 1),
        r.outputTokens,
        r.coveredOutputTokens,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
