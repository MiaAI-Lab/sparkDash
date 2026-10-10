import { describe, expect, it } from "vitest";
import { setConfiguredTimeZone } from "../../shared/timeZone";
import type { TokenHistoryRow } from "../../api/types";
import {
  RANGES,
  OTHER_ID,
  bucketKeys,
  bucketLabel,
  bucketTitle,
  bucketTotals,
  buildCsv,
  buildInsights,
  cacheRate,
  compare,
  endpointRows,
  entriesFromTotals,
  formatAgo,
  groupBuckets,
  lastSeenByModel,
  modelRows,
  pctChange,
  rowsIn,
  sortRows,
  summarize,
  tallyOf,
  trackedBuckets,
  windowFor,
} from "./tokenStats";

const NOW = Date.parse("2026-10-07T14:30:00Z");

function row(t: string, over: Partial<TokenHistoryRow> = {}): TokenHistoryRow {
  return { t, sparkId: "a", port: 8000, modelId: "m1", promptTokens: 1000, completionTokens: 100, cachedTokens: 400, ...over };
}
const hist = (day: TokenHistoryRow[], hour: TokenHistoryRow[] = [], firstDay: string | null = null, firstHour: string | null = null) => ({
  day,
  hour,
  firstDay,
  firstHour,
  retention: { days: 35, hours: 72 },
});

describe("tally", () => {
  it("sums, clamps cached to prompt per row and ignores junk", () => {
    const t = tallyOf([
      { sparkId: "a", port: 1, modelId: "m", promptTokens: 100, completionTokens: 10, cachedTokens: 500 },
      { sparkId: "a", port: 1, modelId: "m", promptTokens: 50, completionTokens: 5, cachedTokens: 20 },
      { sparkId: "a", port: 1, modelId: "m", promptTokens: -5, completionTokens: NaN, cachedTokens: 3 },
    ]);
    expect(t).toEqual({ generated: 15, prompt: 150, cached: 120, computed: 30, total: 165 });
  });
  it("cache rate is null without prompt data and never above 1", () => {
    expect(cacheRate({ cached: 0, prompt: 0 })).toBeNull();
    expect(cacheRate({ cached: 5, prompt: 4 })).toBe(1);
    expect(cacheRate({ cached: 1, prompt: 4 })).toBe(0.25);
  });
  it("handles generated-only rows (missing prompt data)", () => {
    const t = tallyOf([{ sparkId: "a", port: 1, modelId: "m", promptTokens: 0, completionTokens: 40, cachedTokens: 9 }]);
    expect(t).toMatchObject({ generated: 40, prompt: 0, cached: 0, total: 40 });
    expect(summarize(t, [{ key: "2026-10-07", total: 40 }], null).genPerPrompt).toBeNull();
  });
  it("pctChange needs a baseline", () => {
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(150, 100)).toBe(0.5);
  });
});

describe("keys and labels", () => {
  it("builds ascending day keys ending today (UTC)", () => {
    expect(bucketKeys("day", 3, NOW)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });
  it("builds hour keys across midnight", () => {
    const k = bucketKeys("hour", 3, Date.parse("2026-10-07T01:10:00Z"));
    expect(k).toEqual(["2026-10-06T23", "2026-10-07T00", "2026-10-07T01"]);
    expect(bucketKeys("hour", 24, NOW)).toHaveLength(24);
  });
  it("labels hours in local time via the offset and days in UTC", () => {
    expect(bucketLabel("2026-10-07T14", "hour", 120)).toBe("16:00");
    expect(bucketLabel("2026-10-07T23", "hour", 120)).toBe("01:00");
    expect(bucketLabel("2026-10-07T03", "hour", -300)).toBe("22:00");
    expect(bucketLabel("2026-10-07", "day")).toBe("7 Oct");
    expect(bucketTitle("2026-10-07", "day")).toBe("Wed 7 Oct 2026 (UTC)");
    expect(bucketTitle("2026-10-07T23", "hour", 120)).toBe("Thu 8 Oct, 01:00–02:00 (local)");
  });
  it("shows the minutes of half-hour zones, and follows the Settings time zone", () => {
    expect(bucketLabel("2026-10-07T14", "hour", 330)).toBe("19:30");
    expect(bucketTitle("2026-10-07T14", "hour", 330)).toBe("Wed 7 Oct, 19:30–20:30 (local)");
    setConfiguredTimeZone("Asia/Kolkata");
    try {
      expect(bucketLabel("2026-10-07T14", "hour")).toBe("19:30");
    } finally {
      setConfiguredTimeZone(null);
    }
  });
  it("passes malformed keys through", () => {
    expect(bucketLabel("garbage", "day")).toBe("garbage");
  });
});

describe("windowFor", () => {
  it("returns the previous window only when tracking covered it", () => {
    const covered = windowFor("7d", hist([row("2026-09-20")], [], "2026-09-20"), NOW);
    expect(covered.keys).toHaveLength(7);
    expect(covered.prevKeys).toEqual(bucketKeys("day", 7, Date.parse("2026-09-30T00:00:00Z")));
    const partial = windowFor("7d", hist([row("2026-10-03")], [], "2026-10-03"), NOW);
    expect(partial.prevKeys).toEqual([]);
    expect(windowFor("7d", hist([]), NOW).prevKeys).toEqual([]);
  });
  it("hour range is 24 buckets with a 24 h previous window", () => {
    const w = windowFor("24h", hist([], [row("2026-10-05T10")], null, "2026-10-05T10"), NOW);
    expect(w.keys).toHaveLength(24);
    expect(w.prevKeys).toHaveLength(24);
    expect(w.keys[0] > w.prevKeys[23]).toBe(true);
  });
  it("all time spans first tracked day to today, capped at retention", () => {
    expect(windowFor("all", hist([row("2026-10-05")], [], "2026-10-05"), NOW).keys).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(windowFor("all", hist([], [], "2026-01-01"), NOW).keys).toHaveLength(35);
    expect(windowFor("all", hist([]), NOW).keys).toEqual(["2026-10-07"]);
  });
  it("every range spec resolves", () => {
    for (const r of RANGES) expect(windowFor(r.key, hist([]), NOW).keys.length).toBeGreaterThan(0);
  });
});

describe("trackedBuckets", () => {
  it("counts buckets since tracking began, inclusive", () => {
    expect(trackedBuckets("2026-10-04", "day", NOW)).toBe(4);
    expect(trackedBuckets("2026-10-07T12", "hour", NOW)).toBe(3);
    expect(trackedBuckets(null, "day", NOW)).toBeNull();
  });
});

describe("rows and totals", () => {
  const rows = [row("2026-10-06"), row("2026-10-07", { completionTokens: 300 }), row("2026-09-01")];
  it("filters to keys and totals per bucket with zeros", () => {
    const keys = bucketKeys("day", 3, NOW);
    const inRange = rowsIn(rows, keys);
    expect(inRange).toHaveLength(2);
    expect(bucketTotals(inRange, keys).map((b) => b.total)).toEqual([0, 1100, 1300]);
  });
});

describe("summarize and compare", () => {
  it("computes averages over tracked buckets, busiest and active", () => {
    const keys = bucketKeys("day", 7, NOW);
    const rs = [row("2026-10-06"), row("2026-10-07", { completionTokens: 900 })];
    const s = summarize(tallyOf(rs), bucketTotals(rs, keys), "2026-10-06");
    expect(s.elapsed).toBe(2);
    expect(s.avgPerBucket).toBe(s.total / 2);
    expect(s.busiest?.key).toBe("2026-10-07");
    expect(s.activeBuckets).toBe(2);
    expect(s.cacheRate).toBeCloseTo(0.4);
    expect(s.genPerPrompt).toBeCloseTo(0.5);
  });
  it("single day and empty data do not divide by zero", () => {
    const s = summarize(tallyOf([]), [], null);
    expect(s.avgPerBucket).toBe(0);
    expect(s.busiest).toBeNull();
    expect(s.cacheRate).toBeNull();
  });
  it("compare is null without previous traffic", () => {
    expect(compare(tallyOf([row("x")]), tallyOf([]))).toBeNull();
    const c = compare(tallyOf([row("x", { promptTokens: 2000, cachedTokens: 1000 })]), tallyOf([row("x")]));
    expect(c?.total).toBeCloseTo((2100 - 1100) / 1100);
    expect(c?.cachePoints).toBeCloseTo(10);
  });
});

describe("groupBuckets", () => {
  const keys = ["2026-10-06", "2026-10-07"];
  it("splits by type with computed = prompt - cached", () => {
    const g = groupBuckets([row("2026-10-07")], keys, "type");
    expect(g.series.map((s) => s.id)).toEqual(["generated", "cached", "computed"]);
    expect(g.buckets[1].values).toEqual({ generated: 100, cached: 400, computed: 600 });
    expect(g.buckets[0].values).toEqual({ generated: 0, cached: 0, computed: 0 });
  });
  it("clamps cached > prompt in type mode", () => {
    const g = groupBuckets([row("2026-10-07", { promptTokens: 100, cachedTokens: 900 })], keys, "type");
    expect(g.buckets[1].values).toMatchObject({ cached: 100, computed: 0 });
  });
  it("keeps the top N models and folds the rest into Other", () => {
    const rs = Array.from({ length: 8 }, (_, i) => row("2026-10-07", { modelId: `m${i}`, promptTokens: 1000 * (i + 1), completionTokens: 0 }));
    const g = groupBuckets(rs, keys, "model", { topN: 5 });
    expect(g.series).toHaveLength(6);
    expect(g.series[0].label).toBe("m7");
    expect(g.series.at(-1)?.id).toBe(OTHER_ID);
    expect(g.buckets[1].values[OTHER_ID]).toBe(1000 + 2000 + 3000);
  });
  it("no Other when groups fit, and spark mode uses names", () => {
    const rs = [row("2026-10-07", { sparkId: "s1" }), row("2026-10-07", { sparkId: "s2", promptTokens: 10, completionTokens: 0 })];
    const g = groupBuckets(rs, keys, "spark", { sparkName: (id) => id.toUpperCase() });
    expect(g.series.map((s) => s.label)).toEqual(["S1", "S2"]);
  });
  it("empty input yields no model series", () => {
    expect(groupBuckets([], keys, "model").series).toEqual([]);
  });
});

describe("tables", () => {
  const entries = [
    { sparkId: "a", port: 8000, modelId: "big", promptTokens: 900, completionTokens: 100, cachedTokens: 450 },
    { sparkId: "b", port: 8000, modelId: "big", promptTokens: 100, completionTokens: 0, cachedTokens: 0 },
    { sparkId: "a", port: 8001, modelId: "small", promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    { sparkId: "a", port: 8001, modelId: "tiny", promptTokens: 50, completionTokens: 50, cachedTokens: 0 },
  ];
  it("aggregates models with shares, spark lists and last seen", () => {
    const rows = modelRows(entries, new Map([["big", 123]]));
    expect(rows.map((r) => r.modelId)).toEqual(["big", "tiny"]);
    expect(rows[0]).toMatchObject({ total: 1100, sparkIds: ["a", "b"], lastSeen: 123, cacheRate: 0.45 });
    expect(rows[0].share + rows[1].share).toBeCloseTo(1);
    expect(rows[1].lastSeen).toBeNull();
  });
  it("aggregates endpoints per spark and port", () => {
    const rows = endpointRows(entries);
    expect(rows.map((r) => `${r.sparkId}:${r.port}`)).toEqual(["a:8000", "a:8001", "b:8000"]);
    expect(rows[1].models).toEqual(["small", "tiny"]);
  });
  it("sorts with nulls last and is stable", () => {
    const rs = [{ n: "b", v: 1 }, { n: "a", v: null }, { n: "c", v: 3 }, { n: "d", v: 1 }];
    expect(sortRows(rs, (r) => r.v, "desc").map((r) => r.n)).toEqual(["c", "b", "d", "a"]);
    expect(sortRows(rs, (r) => r.v, "asc").map((r) => r.n)).toEqual(["b", "d", "c", "a"]);
    expect(sortRows(rs, (r) => r.n, "desc").map((r) => r.n)).toEqual(["d", "c", "b", "a"]);
  });
  it("flattens lifetime totals and finds last seen", () => {
    const series = [
      { sparkId: "a", port: 1, updatedAt: 1, lastModelId: "m", totals: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, models: [{ modelId: "m", promptTokens: 5, completionTokens: 1, cachedTokens: 2, lastSeenAt: 50 }] },
      { sparkId: "b", port: 1, updatedAt: 1, lastModelId: "m", totals: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, models: [{ modelId: "m", promptTokens: 5, completionTokens: 1, cachedTokens: 2, lastSeenAt: 90 }] },
    ];
    expect(entriesFromTotals(series)).toHaveLength(2);
    expect(lastSeenByModel(series).get("m")).toBe(90);
    expect(entriesFromTotals(undefined as never)).toEqual([]);
  });
  it("formats ages", () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(formatAgo(NOW - 10 * 60_000, NOW)).toBe("10 min ago");
    expect(formatAgo(NOW - 5 * 3_600_000, NOW)).toBe("5 h ago");
    expect(formatAgo(NOW - 4 * 86_400_000, NOW)).toBe("4 d ago");
  });
});

describe("insights", () => {
  function ctx(rows: TokenHistoryRow[], range: "7d" | "24h" = "7d") {
    const w = windowFor(range, hist(rows, [], rows[0]?.t ?? null), NOW);
    const inRange = rowsIn(rows, w.keys);
    const totals = bucketTotals(inRange, w.keys);
    const summary = summarize(tallyOf(inRange), totals, w.firstKey);
    return { spec: w.spec, summary, comparison: null, models: modelRows(inRange), endpoints: endpointRows(inRange), totals, firstKey: w.firstKey, sparkName: (id: string) => `Spark ${id}` };
  }
  it("returns nothing without data", () => {
    expect(buildInsights(ctx([]))).toEqual([]);
  });
  it("describes a rich week in plain English, capped at 6", () => {
    const rows = [
      row("2026-10-01", { modelId: "big", completionTokens: 50 }),
      row("2026-10-03", { modelId: "big", sparkId: "b", completionTokens: 5000 }),
      row("2026-10-05", { modelId: "small" }),
    ];
    const lines = buildInsights({ ...ctx(rows), comparison: { total: 0.25, generated: 0, prompt: 0, cachePoints: 0 } });
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(text).toContain("busiest day was Sat 3 Oct 2026");
    expect(text).toMatch(/prefix cache served \d+(\.\d)?% of prompt tokens/);
    expect(text).toContain("big");
    expect(text).toContain("had no traffic");
  });
  it("single day: no busiest, no idle sentences", () => {
    const text = buildInsights(ctx([row("2026-10-07")])).join("\n");
    expect(text).not.toContain("busiest day");
    expect(text).not.toContain("no traffic at all");
    expect(text).toContain("All traffic ran on m1");
  });
  it("flags zero cache hits and omits ratio without prompt data", () => {
    const zero = buildInsights(ctx([row("2026-10-07", { cachedTokens: 0 })])).join("\n");
    expect(zero).toContain("No prompt tokens were served from the prefix cache");
    const none = buildInsights(ctx([row("2026-10-07", { promptTokens: 0, cachedTokens: 0 })])).join("\n");
    expect(none).not.toContain("prompt tokens were read");
    expect(none).not.toContain("prefix cache");
  });
});

describe("buildCsv", () => {
  it("emits a header, sorted rows, a computed column and escapes cells", () => {
    const csv = buildCsv(
      [row("2026-10-07", { modelId: 'we"ird,model', promptTokens: 10, cachedTokens: 99 }), row("2026-10-06")],
      (id) => `Spark ${id}`
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("bucket_utc,spark_id,spark,port,model,prompt_tokens,completion_tokens,cached_tokens,computed_prefill_tokens");
    expect(lines[1].startsWith("2026-10-06,a,Spark a,8000,m1,1000,100,400,600")).toBe(true);
    expect(lines[2]).toBe('2026-10-07,a,Spark a,8000,"we""ird,model",10,100,10,0');
  });
  it("is header-only for no rows", () => {
    expect(buildCsv([]).trim().split("\n")).toHaveLength(1);
  });
});
