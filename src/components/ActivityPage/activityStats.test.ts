import { describe, expect, it } from "vitest";
import { setConfiguredTimeZone } from "../../shared/timeZone";
import type { ActivityEvent } from "../../api/types";
import {
  EMPTY_FILTER, NO_SPARK, categorize, countByCategory, countBySeverity, countBySpark, dayLabel, eventsPerDay,
  exportText, filterEvents, formatClock, formatStamp, groupByDay, isFilterActive, localDayKey, mergeEvents,
  sparkOptions, summarize, typeLabel,
} from "./activityStats";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
// 2026-10-07 15:00 UTC = 11:00 in New York (EDT), 00:00 Oct 8 in Tokyo.
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
const H = 3_600_000;

let nextId = 1;
function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  const id = over.id ?? nextId++;
  return { id, ts: NOW - id * 1000, type: "spark.online", severity: "info", sparkId: "a", sparkName: "Alpha", message: `Alpha event ${id}`, ...over };
}

describe("categorize / typeLabel", () => {
  it("maps every emitted type to a category", () => {
    expect(categorize("spark.online")).toBe("status");
    expect(categorize("spark.offline")).toBe("status");
    expect(categorize("gpu.throttle.thermal")).toBe("thermal");
    expect(categorize("gpu.throttle.cleared")).toBe("thermal");
    expect(categorize("hermes.update.success")).toBe("hermes");
    expect(categorize("bench.quality.failed")).toBe("bench");
    expect(categorize("power.wake")).toBe("power");
    expect(categorize("llm.start.requested")).toBe("llm");
    expect(categorize("spark.added")).toBe("fleet");
    expect(categorize("spark.removed")).toBe("fleet");
  });
  it("falls back to other for unknown types", () => {
    expect(categorize("weird.thing")).toBe("other");
    expect(categorize("")).toBe("other");
  });
  it("humanises labels", () => {
    expect(typeLabel("bench.decode.finished")).toBe("Decode bench");
    expect(typeLabel("bench.prefill.failed")).toBe("Prefill bench failed");
    expect(typeLabel("bench.quality.cancelled")).toBe("Quality bench cancelled");
    expect(typeLabel("llm.start.completed")).toBe("LLM start completed");
    expect(typeLabel("llm.attach.detached")).toBe("LLM attach detached");
    expect(typeLabel("gpu.throttle.thermal")).toBe("Thermal throttle");
    expect(typeLabel("power.shutdown")).toBe("Shutdown");
  });
  it("humanises unknown types without throwing", () => {
    expect(typeLabel("foo.bar_baz")).toBe("Foo bar baz");
    expect(typeLabel("bench.mystery.finished")).toBe("Bench mystery finished");
    expect(typeLabel("")).toBe("Event");
  });
});

describe("mergeEvents", () => {
  it("dedupes by id, keeps newest first and prefers incoming", () => {
    const cur = [ev({ id: 5 }), ev({ id: 3 }), ev({ id: 1 })];
    const inc = [ev({ id: 7 }), ev({ id: 5, message: "updated" })];
    const out = mergeEvents(cur, inc);
    expect(out.map((e) => e.id)).toEqual([7, 5, 3, 1]);
    expect(out[1].message).toBe("updated");
  });
  it("handles empty sides and does not mutate", () => {
    const cur = [ev({ id: 2 })];
    expect(mergeEvents([], [])).toEqual([]);
    expect(mergeEvents(cur, []).map((e) => e.id)).toEqual([2]);
    expect(mergeEvents([], [ev({ id: 1 }), ev({ id: 9 })]).map((e) => e.id)).toEqual([9, 1]);
    expect(cur).toHaveLength(1);
  });
  it("merges an older page behind the current list", () => {
    const out = mergeEvents([ev({ id: 10 }), ev({ id: 9 })], [ev({ id: 8 }), ev({ id: 7 })]);
    expect(out.map((e) => e.id)).toEqual([10, 9, 8, 7]);
  });
});

describe("filterEvents + counts", () => {
  const events = [
    ev({ id: 10, severity: "error", type: "spark.offline", sparkId: "a", sparkName: "Alpha", message: "Alpha went offline", ts: NOW - H }),
    ev({ id: 9, severity: "warn", type: "gpu.throttle.thermal", sparkId: "b", sparkName: "Beta", message: "Beta thermal throttling at 91 C", ts: NOW - 2 * H }),
    ev({ id: 8, severity: "success", type: "bench.decode.finished", sparkId: "b", sparkName: "Beta", message: "Decode bench done: 42 tok/s", ts: NOW - 3 * 24 * H }),
    ev({ id: 7, severity: "info", type: "spark.added", sparkId: null, sparkName: null, message: "Fleet grew", ts: NOW - 10 * 24 * H }),
  ];
  it("returns everything with the empty filter", () => {
    expect(filterEvents(events, EMPTY_FILTER, NOW)).toHaveLength(4);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });
  it("filters by severity set, category, spark and range", () => {
    expect(filterEvents(events, { ...EMPTY_FILTER, severities: ["error", "warn"] }, NOW).map((e) => e.id)).toEqual([10, 9]);
    expect(filterEvents(events, { ...EMPTY_FILTER, category: "bench" }, NOW).map((e) => e.id)).toEqual([8]);
    expect(filterEvents(events, { ...EMPTY_FILTER, sparkId: "b" }, NOW).map((e) => e.id)).toEqual([9, 8]);
    expect(filterEvents(events, { ...EMPTY_FILTER, sparkId: NO_SPARK }, NOW).map((e) => e.id)).toEqual([7]);
    expect(filterEvents(events, { ...EMPTY_FILTER, range: "24h" }, NOW).map((e) => e.id)).toEqual([10, 9]);
    expect(filterEvents(events, { ...EMPTY_FILTER, range: "7d" }, NOW).map((e) => e.id)).toEqual([10, 9, 8]);
  });
  it("searches message, spark name, type and label case-insensitively", () => {
    const q = (query: string) => filterEvents(events, { ...EMPTY_FILTER, query }, NOW).map((e) => e.id);
    expect(q("THERMAL")).toEqual([9]);
    expect(q("beta")).toEqual([9, 8]);
    expect(q("bench.decode")).toEqual([8]);
    expect(q("decode bench")).toEqual([8]);
    expect(q("  tok/s ")).toEqual([8]);
    expect(q("nothing like this")).toEqual([]);
  });
  it("combines filters (AND)", () => {
    expect(filterEvents(events, { ...EMPTY_FILTER, sparkId: "b", severities: ["warn"] }, NOW).map((e) => e.id)).toEqual([9]);
  });
  it("counts each facet with the other filters applied", () => {
    const f = { ...EMPTY_FILTER, sparkId: "b" };
    expect(countBySeverity(events, f, NOW)).toEqual({ error: 0, warn: 1, success: 1, info: 0 });
    // the severity selection itself is ignored when counting severities
    expect(countBySeverity(events, { ...f, severities: ["warn"] }, NOW)).toEqual({ error: 0, warn: 1, success: 1, info: 0 });
    expect(countByCategory(events, { ...EMPTY_FILTER, severities: ["warn"] }, NOW)).toMatchObject({ thermal: 1, bench: 0, status: 0 });
    expect(countBySpark(events, EMPTY_FILTER, NOW)).toEqual({ a: 1, b: 2, [NO_SPARK]: 1 });
  });
  it("handles empty input", () => {
    expect(filterEvents([], EMPTY_FILTER, NOW)).toEqual([]);
    expect(countBySeverity([], EMPTY_FILTER, NOW)).toEqual({ error: 0, warn: 0, success: 0, info: 0 });
    expect(countBySpark([], EMPTY_FILTER, NOW)).toEqual({});
  });
});

describe("sparkOptions", () => {
  it("unions live sparks with ids only seen in events, sorted by name", () => {
    const opts = sparkOptions(
      [{ id: "b", name: "Beta" }, { id: "a", name: "Alpha" }],
      [ev({ sparkId: "z", sparkName: "Zulu (removed)" }), ev({ sparkId: "a", sparkName: "Old name" }), ev({ sparkId: null }), ev({ sparkId: "q", sparkName: null })]
    );
    expect(opts).toEqual([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }, { id: "q", name: "q" }, { id: "z", name: "Zulu (removed)" }]);
    expect(sparkOptions([], [])).toEqual([]);
  });
});

describe("local days", () => {
  it("keys the calendar day in the given timezone", () => {
    expect(localDayKey(NOW, NY)).toBe("2026-10-07");
    expect(localDayKey(NOW, TOKYO)).toBe("2026-10-08");
    // Without an explicit zone the Settings time zone applies.
    setConfiguredTimeZone(TOKYO);
    try {
      expect(localDayKey(NOW)).toBe("2026-10-08");
    } finally {
      setConfiguredTimeZone(null);
    }
    // 03:30 UTC is still the previous evening in New York
    expect(localDayKey(Date.UTC(2026, 9, 7, 3, 30), NY)).toBe("2026-10-06");
    expect(localDayKey(Date.UTC(2026, 9, 7, 3, 30), "UTC")).toBe("2026-10-07");
  });
  it("labels Today, Yesterday, weekdays and other years", () => {
    expect(dayLabel("2026-10-07", NOW, NY)).toBe("Today");
    expect(dayLabel("2026-10-06", NOW, NY)).toBe("Yesterday");
    expect(dayLabel("2026-10-05", NOW, NY)).toBe("Monday, Oct 5");
    expect(dayLabel("2025-12-31", NOW, NY)).toBe("Wednesday, Dec 31, 2025");
    // same instant, different zone: the labels shift with the zone
    expect(dayLabel("2026-10-07", NOW, TOKYO)).toBe("Yesterday");
  });
  it("is DST-safe for Yesterday across a fall-back change", () => {
    // New York fell back on 2026-11-01; Oct 31 is yesterday on Nov 1 noon.
    const noon = Date.UTC(2026, 10, 1, 17, 0);
    expect(dayLabel("2026-10-31", noon, NY)).toBe("Yesterday");
  });
  it("formats clock and stamp in 24 h", () => {
    expect(formatClock(NOW, NY)).toBe("11:00");
    expect(formatClock(Date.UTC(2026, 9, 7, 4, 5), NY)).toBe("00:05");
    expect(formatStamp(NOW, TOKYO)).toBe("2026-10-08 00:00:00");
  });
  it("groups by local day in first-seen order", () => {
    const events = [
      ev({ id: 4, ts: NOW }),
      ev({ id: 3, ts: NOW - 5 * H }), // 06:00 NY, same day
      ev({ id: 2, ts: NOW - 12 * H }), // 23:00 Oct 6 NY
      ev({ id: 1, ts: NOW - 13 * H }), // 22:00 Oct 6 NY
      ev({ id: 0, ts: NOW - 20 * H }), // 19:00 Oct 6 NY
    ];
    const g = groupByDay(events, NOW, NY);
    expect(g.map((x) => [x.key, x.label, x.events.length])).toEqual([["2026-10-07", "Today", 2], ["2026-10-06", "Yesterday", 3]]);
    expect(groupByDay([], NOW, NY)).toEqual([]);
  });
});

describe("eventsPerDay", () => {
  it("returns 14 zero-filled local days ending today", () => {
    const b = eventsPerDay([], NOW, 14, NY);
    expect(b).toHaveLength(14);
    expect(b[13].key).toBe("2026-10-07");
    expect(b[0].key).toBe("2026-09-24");
    expect(b.every((x) => Object.values(x.counts).every((n) => n === 0))).toBe(true);
    expect(b[13].label).toBe("Oct 7");
    expect(b[13].title).toBe("Wed, Oct 7");
  });
  it("counts per severity and ignores events outside the window", () => {
    const events = [
      ev({ severity: "error", ts: NOW }),
      ev({ severity: "error", ts: NOW - H }),
      ev({ severity: "success", ts: NOW - 24 * H }),
      ev({ severity: "info", ts: NOW - 40 * 24 * H }),
    ];
    const b = eventsPerDay(events, NOW, 14, NY);
    expect(b[13].counts).toEqual({ error: 2, warn: 0, success: 0, info: 0 });
    expect(b[12].counts.success).toBe(1);
    expect(b.reduce((n, x) => n + x.counts.error + x.counts.warn + x.counts.success + x.counts.info, 0)).toBe(3);
  });
  it("crosses month boundaries", () => {
    const b = eventsPerDay([], Date.UTC(2026, 2, 2, 12), 5, "UTC");
    expect(b.map((x) => x.key)).toEqual(["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});

describe("summarize", () => {
  it("is zeroed for no events", () => {
    expect(summarize([], NOW)).toEqual({
      events24h: 0, events7d: 0, errors24h: 0, errors7d: 0, warnings24h: 0, warnings7d: 0,
      problemSparks24h: 0, problemSparks7d: 0, mostActive: null,
    });
  });
  it("counts 24 h and 7 d windows, problem sparks and the most active spark", () => {
    const events = [
      ev({ severity: "error", sparkId: "a", sparkName: "Alpha", ts: NOW - H }),
      ev({ severity: "warn", sparkId: "b", sparkName: "Beta", ts: NOW - 2 * H }),
      ev({ severity: "warn", sparkId: "b", sparkName: "Beta", ts: NOW - 3 * H }),
      ev({ severity: "info", sparkId: "b", sparkName: "Beta", ts: NOW - 4 * H }),
      ev({ severity: "error", sparkId: "c", sparkName: "Gamma", ts: NOW - 3 * 24 * H }),
      ev({ severity: "error", sparkId: null, sparkName: null, ts: NOW - 5 * H }),
      ev({ severity: "info", ts: NOW - 9 * 24 * H }),
    ];
    const s = summarize(events, NOW);
    expect(s.events24h).toBe(5);
    expect(s.events7d).toBe(6);
    expect(s.errors24h).toBe(2);
    expect(s.errors7d).toBe(3);
    expect(s.warnings24h).toBe(2);
    expect(s.problemSparks24h).toBe(2);
    expect(s.problemSparks7d).toBe(3);
    expect(s.mostActive).toEqual({ sparkId: "b", name: "Beta", count: 3 });
  });
  it("falls back to the 7 d busiest spark when the last 24 h is quiet, ties break by name", () => {
    const s = summarize(
      [
        ev({ sparkId: "z", sparkName: "Zed", ts: NOW - 2 * 24 * H }),
        ev({ sparkId: "m", sparkName: "Mu", ts: NOW - 3 * 24 * H }),
      ],
      NOW
    );
    expect(s.events24h).toBe(0);
    expect(s.mostActive).toEqual({ sparkId: "m", name: "Mu", count: 1 });
  });
});

describe("exportText", () => {
  it("writes one stamped line per event and flattens newlines", () => {
    const text = exportText([ev({ id: 1, ts: NOW, severity: "warn", type: "gpu.throttle.thermal", message: "Alpha hot\nat 90 C" }), ev({ id: 2, ts: NOW - H, severity: "success", type: "bench.decode.finished", message: "done" })], NY);
    expect(text.split("\n")).toEqual([
      "2026-10-07 11:00:00 [Warning] Thermal throttle - Alpha hot at 90 C",
      "2026-10-07 10:00:00 [Success] Decode bench - done",
    ]);
    expect(exportText([], NY)).toBe("");
  });
});
