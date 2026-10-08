import { describe, expect, it } from "vitest";
import type { EnergyHistoryRow } from "../../api/types";
import {
  HOUR_MS,
  buildBuckets,
  buildInsights,
  costFor,
  dayNight,
  fixedTz,
  floorHour,
  localDayKey,
  previousPeriodDelta,
  rangeWindow,
  sortNodes,
  summarize,
  toCsv,
  whPer1kTokens,
  type TzOffsetFn,
} from "./energyStats";

const NOW = Date.UTC(2026, 9, 7, 12, 30); // Wed 7 Oct 2026 12:30 UTC
const NODES = ["a", "b"];

function row(t: number, whA: number, whB: number, over: Partial<EnergyHistoryRow> = {}): EnergyHistoryRow {
  const fleetWh = whA + whB;
  return {
    t,
    nodeWh: { a: whA, b: whB },
    nodeCoverageMs: { a: HOUR_MS, b: HOUR_MS },
    avgWatts: fleetWh,
    fleetEnergyWh: fleetWh,
    fleetCoverageMs: HOUR_MS,
    outputTokens: 0,
    coveredOutputTokens: 0,
    ...over,
  };
}

/** n consecutive full hours ending at (and including) the hour of NOW. */
function hours(n: number, whA = 100, whB = 50): EnergyHistoryRow[] {
  const end = floorHour(NOW);
  return Array.from({ length: n }, (_, i) => row(end - (n - 1 - i) * HOUR_MS, whA, whB));
}

describe("local day keys", () => {
  it("shifts the date by the explicit offset", () => {
    const t = Date.UTC(2026, 9, 7, 23, 0);
    expect(localDayKey(t, fixedTz(0))).toBe("2026-10-07");
    expect(localDayKey(t, fixedTz(120))).toBe("2026-10-08");
    expect(localDayKey(t, fixedTz(-300))).toBe("2026-10-07");
    expect(localDayKey(Date.UTC(2026, 9, 7, 3, 0), fixedTz(-300))).toBe("2026-10-06");
  });

  it("handles half-hour zones", () => {
    expect(localDayKey(Date.UTC(2026, 9, 7, 18, 30), fixedTz(330))).toBe("2026-10-08");
    expect(localDayKey(Date.UTC(2026, 9, 7, 18, 29), fixedTz(330))).toBe("2026-10-07");
  });

  it("keeps a DST fall-back day (25 h) as one calendar day", () => {
    // Europe/Berlin 2026-10-25: CEST (+120) until 01:00 UTC, CET (+60) after.
    const berlin: TzOffsetFn = (ms) => (ms < Date.UTC(2026, 9, 25, 1, 0) ? 120 : 60);
    const start = Date.UTC(2026, 9, 24, 22, 0); // local midnight of the 25th
    const keys = new Set<string>();
    for (let i = 0; i < 25; i++) keys.add(localDayKey(start + i * HOUR_MS, berlin));
    expect([...keys]).toEqual(["2026-10-25"]);
    expect(localDayKey(start + 25 * HOUR_MS, berlin)).toBe("2026-10-26");
  });

  it("keeps a DST spring-forward day (23 h) as one calendar day", () => {
    const berlin: TzOffsetFn = (ms) => (ms < Date.UTC(2026, 2, 29, 1, 0) ? 60 : 120);
    const start = Date.UTC(2026, 2, 28, 23, 0); // local midnight of the 29th
    const keys = new Set<string>();
    for (let i = 0; i < 23; i++) keys.add(localDayKey(start + i * HOUR_MS, berlin));
    expect([...keys]).toEqual(["2026-03-29"]);
    expect(localDayKey(start + 23 * HOUR_MS, berlin)).toBe("2026-03-30");
  });
});

describe("rangeWindow", () => {
  it("covers N*24 hour slots ending at the current hour", () => {
    const w = rangeWindow("24h", NOW, hours(24));
    expect(w.hours).toBe(24);
    expect(w.endHourMs - w.startMs).toBe(23 * HOUR_MS);
    expect(w.windowMs).toBe(23 * HOUR_MS + 30 * 60_000);
  });

  it("starts measuring at the first recorded hour when history is shorter than the range", () => {
    const w = rangeWindow("7d", NOW, hours(10));
    expect(w.windowStartMs).toBe(floorHour(NOW) - 9 * HOUR_MS);
    expect(w.windowMs).toBe(9 * HOUR_MS + 30 * 60_000);
  });

  it("falls back to the full range with no rows", () => {
    const w = rangeWindow("31d", NOW, []);
    expect(w.windowStartMs).toBe(w.startMs);
  });
});

describe("buildBuckets", () => {
  it("builds one bucket per hour and leaves gaps empty", () => {
    const rows = hours(24).filter((_, i) => i !== 10);
    const w = rangeWindow("24h", NOW, rows);
    const b = buildBuckets(rows, w, "hour", fixedTz(0));
    expect(b).toHaveLength(24);
    expect(b.filter((x) => !x.hasData)).toHaveLength(1);
    expect(b[0].label).toMatch(/^\d\d:00$/);
    expect(b[23].expectedMs).toBe(30 * 60_000);
  });

  it("uses local time for hour labels", () => {
    const w = rangeWindow("24h", NOW, hours(24));
    const utc = buildBuckets([], w, "hour", fixedTz(0));
    const plus2 = buildBuckets([], w, "hour", fixedTz(120));
    expect(utc[23].label).toBe("12:00");
    expect(plus2[23].label).toBe("14:00");
  });

  it("groups hours into local calendar days with per-node kWh", () => {
    const rows = hours(48, 100, 50);
    const w = rangeWindow("7d", NOW, rows);
    const days = buildBuckets(rows, w, "day", fixedTz(0));
    // 48 slots ending 12:00 on the 7th: 7th has 13 slots, 6th 24, 5th 11.
    expect(days.map((d) => d.key)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(days[1].kwh).toBeCloseTo((24 * 150) / 1000, 6);
    expect(days[1].nodeKwh.a).toBeCloseTo(2.4, 6);
    expect(days[1].nodeKwh.b).toBeCloseTo(1.2, 6);
    expect(days[1].avgWatts).toBeCloseTo(150, 6);
    expect(days[1].expectedMs).toBe(24 * HOUR_MS);
    expect(days[2].expectedMs).toBe(12 * HOUR_MS + 30 * 60_000);
  });

  it("a different offset moves hours across the day boundary", () => {
    const rows = hours(48);
    const w = rangeWindow("7d", NOW, rows);
    const a = buildBuckets(rows, w, "day", fixedTz(0));
    const b = buildBuckets(rows, w, "day", fixedTz(720));
    expect(a[0].key).not.toBe(b[0].key);
    expect(b.reduce((s, d) => s + d.kwh, 0)).toBeCloseTo(a.reduce((s, d) => s + d.kwh, 0), 9);
  });

  it("keeps empty days inside the data window", () => {
    const end = floorHour(NOW);
    const rows = [row(end - 60 * HOUR_MS, 10, 10), row(end, 10, 10)];
    const w = rangeWindow("14d", NOW, rows);
    const days = buildBuckets(rows, w, "day", fixedTz(0));
    expect(days.some((d) => !d.hasData)).toBe(true);
    expect(days[0].hasData).toBe(true);
    expect(days.at(-1)!.hasData).toBe(true);
  });
});

describe("summarize", () => {
  it("totals energy, average power, peak and per-node shares", () => {
    const rows = hours(24, 100, 50);
    rows[5] = row(rows[5].t, 200, 100); // peak 300 W
    const w = rangeWindow("24h", NOW, rows);
    const s = summarize(rows, w, NODES, null);
    expect(s.kwh).toBeCloseTo((23 * 150 + 300) / 1000, 6);
    expect(s.avgWatts).toBeCloseTo((23 * 150 + 300) / 24, 6);
    expect(s.peak).toEqual({ watts: 300, atMs: rows[5].t });
    expect(s.nodes[0].id).toBe("a");
    expect(s.nodes[0].share).toBeCloseTo((23 * 100 + 200) / (23 * 150 + 300), 6);
    expect(s.nodes[0].peakWatts).toBe(200);
    expect(s.nodes[1].avgWatts).toBeCloseTo((23 * 50 + 100) / 24, 6);
    expect(s.cost).toBeNull();
    expect(s.costPerDay).toBeNull();
  });

  it("computes coverage against the measuring window", () => {
    const rows = hours(10);
    rows[3] = row(rows[3].t, 50, 25, { fleetCoverageMs: HOUR_MS / 2, nodeCoverageMs: { a: HOUR_MS, b: HOUR_MS / 2 } });
    const w = rangeWindow("7d", NOW, rows);
    const s = summarize(rows, w, NODES, null);
    // 9.5 h elapsed since first row; 9.5 h of fleet coverage minus half an hour = 9 h (last hour only half elapsed but fully covered counts 1 h)
    expect(s.fleetCoverageMs).toBe(9.5 * HOUR_MS);
    expect(s.coverage).toBeCloseTo(Math.min(1, 9.5 / 9.5), 6);
    const b = s.nodes.find((n) => n.id === "b")!;
    expect(b.coverageMs).toBe(9.5 * HOUR_MS);
  });

  it("ignores rows outside the range", () => {
    const rows = hours(60);
    const w = rangeWindow("24h", NOW, rows);
    const s = summarize(rows, w, NODES, null);
    expect(s.kwh).toBeCloseTo((24 * 150) / 1000, 6);
  });

  it("applies the price per kWh, per node and per day", () => {
    const rows = hours(24);
    const w = rangeWindow("24h", NOW, rows);
    const s = summarize(rows, w, NODES, 0.3);
    expect(s.cost).toBeCloseTo(s.kwh * 0.3, 9);
    expect(s.nodes[0].cost).toBeCloseTo(s.nodes[0].kwh * 0.3, 9);
    expect(s.costPerDay).toBeCloseTo(s.cost! / (w.windowMs / (24 * HOUR_MS)), 9);
    expect(costFor(10, null)).toBeNull();
    expect(costFor(10, 0)).toBe(0);
    expect(costFor(10, Number.NaN)).toBeNull();
  });

  it("returns an empty summary without rows", () => {
    const w = rangeWindow("24h", NOW, []);
    const s = summarize([], w, NODES, 0.2);
    expect(s.hasData).toBe(false);
    expect(s.kwh).toBe(0);
    expect(s.avgWatts).toBeNull();
    expect(s.peak).toBeNull();
    expect(s.coverage).toBe(0);
    expect(s.whPer1kTokens).toBeNull();
    expect(buildInsights({
      summary: s, buckets: [], rows: [], mode: "hour", tz: fixedTz(0), price: 0.2, currency: "$", nodeName: (id) => id,
    })).toEqual([]);
  });

  it("does not count barely-covered hours as the peak", () => {
    const rows = hours(5);
    rows[2] = row(rows[2].t, 900, 900, { avgWatts: 9000, fleetCoverageMs: 60_000 });
    const s = summarize(rows, rangeWindow("24h", NOW, rows), NODES, null);
    expect(s.peak!.watts).toBe(150);
  });

  it("handles a node with no data", () => {
    const rows = hours(3).map((r) => ({ ...r, nodeWh: { a: 100 }, nodeCoverageMs: { a: HOUR_MS } }));
    const s = summarize(rows, rangeWindow("24h", NOW, rows), NODES, null);
    const b = s.nodes.find((n) => n.id === "b")!;
    expect(b.kwh).toBe(0);
    expect(b.avgWatts).toBeNull();
    expect(b.peakWatts).toBeNull();
  });
});

describe("efficiency", () => {
  it("is Wh per 1,000 covered tokens", () => {
    expect(whPer1kTokens(300, 100_000)).toBeCloseTo(3, 9);
    expect(whPer1kTokens(300, 0)).toBeNull();
    expect(whPer1kTokens(0, 5000)).toBeNull();
  });

  it("uses fleet energy and covered tokens only", () => {
    const rows = hours(24, 100, 50).map((r) => ({ ...r, outputTokens: 80_000, coveredOutputTokens: 50_000 }));
    const s = summarize(rows, rangeWindow("24h", NOW, rows), NODES, null);
    expect(s.coveredTokens).toBe(24 * 50_000);
    expect(s.whPer1kTokens).toBeCloseTo((24 * 150) / (24 * 50_000) * 1000, 9);
  });

  it("is null when there is no token data", () => {
    const rows = hours(24);
    const s = summarize(rows, rangeWindow("24h", NOW, rows), NODES, null);
    expect(s.whPer1kTokens).toBeNull();
  });

  it("is reported per bucket", () => {
    const rows = hours(24).map((r, i) => ({ ...r, coveredOutputTokens: i === 3 ? 15_000 : 0 }));
    const b = buildBuckets(rows, rangeWindow("24h", NOW, rows), "hour", fixedTz(0));
    expect(b[3].whPer1kTokens).toBeCloseTo(10, 9);
    expect(b[4].whPer1kTokens).toBeNull();
  });
});

describe("previousPeriodDelta", () => {
  it("compares with the equal-length period before", () => {
    const rows = hours(48, 100, 50);
    for (let i = 0; i < 24; i++) rows[i] = row(rows[i].t, 50, 25); // previous day half as heavy
    const w = rangeWindow("24h", NOW, rows);
    const cur = summarize(rows, w, NODES, null);
    const d = previousPeriodDelta(rows, w, cur.kwh)!;
    expect(d.prevKwh).toBeCloseTo((24 * 75) / 1000, 6);
    expect(d.ratio).toBeCloseTo(1, 6);
  });

  it("is null when the previous period has no or too little data", () => {
    const rows = hours(24);
    const w = rangeWindow("24h", NOW, rows);
    expect(previousPeriodDelta(rows, w, 3.6)).toBeNull();
    const sparse = hours(30);
    expect(previousPeriodDelta(sparse, rangeWindow("24h", NOW, sparse), 3.6)).toBeNull();
  });
});

describe("day / night", () => {
  it("compares overnight with daytime average watts in local time", () => {
    const rows: EnergyHistoryRow[] = [];
    const base = Date.UTC(2026, 9, 5, 0, 0);
    for (let i = 0; i < 48; i++) {
      const t = base + i * HOUR_MS;
      const h = new Date(t).getUTCHours();
      const night = h >= 22 || h < 6;
      rows.push(row(t, night ? 40 : 100, night ? 20 : 50));
    }
    const dn = dayNight(rows, fixedTz(0))!;
    expect(dn.night).toBeCloseTo(60, 6);
    expect(dn.day).toBeCloseTo(150, 6);
    // Same data viewed 12 h east: night and day swap roles for most hours.
    const shifted = dayNight(rows, fixedTz(720))!;
    expect(shifted.night).not.toBeCloseTo(60, 1);
  });

  it("needs at least 3 covered hours on each side", () => {
    expect(dayNight(hours(2), fixedTz(0))).toBeNull();
  });
});

describe("insights", () => {
  const ctx = (rows: EnergyHistoryRow[], range: "24h" | "7d", price: number | null, mode: "hour" | "day") => {
    const w = rangeWindow(range, NOW, rows);
    const s = summarize(rows, w, NODES, price);
    return buildInsights({
      summary: s,
      buckets: buildBuckets(rows, w, mode, fixedTz(0)),
      rows: rowsFor(rows, w),
      mode,
      tz: fixedTz(0),
      price,
      currency: "€",
      nodeName: (id) => `Spark ${id}`,
    });
  };
  const rowsFor = (rows: EnergyHistoryRow[], w: ReturnType<typeof rangeWindow>) => rows.filter((r) => r.t >= w.startMs);

  it("names the top node and the peak hour", () => {
    const lines = ctx(hours(24, 100, 40), "24h", null, "hour");
    expect(lines[0]).toContain("Spark a uses the most energy");
    expect(lines[0]).toContain("71%");
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("omits cost lines without a price and tokens lines without tokens", () => {
    const lines = ctx(hours(24), "24h", null, "hour").join(" ");
    expect(lines).not.toContain("per week");
    expect(lines).not.toContain("tokens per kWh");
  });

  it("adds an explicitly estimated weekly cost when a price is set", () => {
    const lines = ctx(hours(24), "24h", 0.3, "hour").join(" ");
    expect(lines).toContain("per week");
    expect(lines).toContain("rough extrapolation");
  });

  it("adds tokens per kWh when token data exists", () => {
    const rows = hours(24, 100, 50).map((r) => ({ ...r, coveredOutputTokens: 30_000, outputTokens: 30_000 }));
    const lines = ctx(rows, "24h", null, "hour").join(" ");
    expect(lines).toContain("output tokens per kWh");
  });

  it("does not claim a highest day with fewer than three well-covered days", () => {
    const lines = ctx(hours(48), "7d", null, "day").join(" ");
    expect(lines).not.toContain("highest-use day");
  });

  it("reports the highest-use day with enough days", () => {
    const rows = hours(24 * 5);
    const idx = rows.findIndex((r) => new Date(r.t).getUTCDate() === 4 && new Date(r.t).getUTCHours() === 5);
    for (let i = idx; i < idx + 24; i++) if (rows[i]) rows[i] = row(rows[i].t, 300, 150);
    const lines = ctx(rows, "7d", null, "day").join(" ");
    expect(lines).toContain("highest-use day");
  });
});

describe("sortNodes", () => {
  const rows = hours(24, 100, 50);
  const s = summarize(rows, rangeWindow("24h", NOW, rows), NODES, null);
  it("sorts by numeric and name columns, both directions", () => {
    const name = (id: string) => (id === "a" ? "Zeta" : "Alpha");
    expect(sortNodes(s.nodes, "kwh", "desc", name).map((n) => n.id)).toEqual(["a", "b"]);
    expect(sortNodes(s.nodes, "kwh", "asc", name).map((n) => n.id)).toEqual(["b", "a"]);
    expect(sortNodes(s.nodes, "name", "asc", name).map((n) => n.id)).toEqual(["b", "a"]);
  });
  it("keeps missing values last", () => {
    const withNull = [{ ...s.nodes[0], cost: null }, { ...s.nodes[1], cost: 2 }];
    expect(sortNodes(withNull, "cost", "desc", (i) => i)[0].id).toBe("b");
    expect(sortNodes(withNull, "cost", "asc", (i) => i)[0].id).toBe("b");
  });
});

describe("toCsv", () => {
  it("writes a header, ISO hours and escapes names", () => {
    const rows = [row(Date.UTC(2026, 9, 7, 10), 100.1234, 50, { avgWatts: null, outputTokens: 5, coveredOutputTokens: 4 })];
    const csv = toCsv(rows, NODES, (id) => (id === "a" ? 'Spark "A", main' : "B"));
    const [head, line] = csv.trim().split("\n");
    expect(head.startsWith('hour_start_utc,"Spark ""A"", main Wh",B Wh')).toBe(true);
    // avg W is blank when the hour has no fleet-wide coverage figure
    expect(line).toBe("2026-10-07T10:00:00.000Z,100.123,50,60,60,150.123,,60,5,4");
  });
});
