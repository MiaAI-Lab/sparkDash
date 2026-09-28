import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClock,
  formatClock,
  normalizeWindow,
  windowCovers,
  validateWindows,
  findWindowOverlaps,
  findScheduleConflicts,
  resolveActiveWindow,
  nextBoundary,
  zonedParts,
  nextBoundaryAt,
  normalizeModelSchedule,
  validateModelSchedule,
  scheduleIsUsable,
} from "../../../src/shared/modelSchedules.js";

// ─── Clock parsing ─────────────────────────────────────────
test("parseClock accepts 24h HH:MM and rejects junk", () => {
  assert.equal(parseClock("08:00"), 480);
  assert.equal(parseClock("8:00"), 480);
  assert.equal(parseClock("17:59"), 1079);
  assert.equal(parseClock("23:59"), 1439);
  assert.equal(parseClock("00:00"), 0);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("08:60"), null);
  assert.equal(parseClock("8am"), null);
  assert.equal(parseClock("8"), null);
  assert.equal(parseClock(null), null);
  assert.equal(formatClock(1079), "17:59");
  assert.equal(formatClock(0), "00:00");
});

// ─── Wrap-around coverage (the 18:00→08:00 night shift) ────
test("wrap window 18:00→08:00 is active at 02:00 and 22:00, not at noon", () => {
  const w = normalizeWindow({ start: "18:00", end: "08:00" });
  assert.ok(w.wrap);
  assert.equal(w.fullDay, false);
  assert.equal(windowCovers(w, 2 * 60), true); // 02:00
  assert.equal(windowCovers(w, 22 * 60), true); // 22:00
  assert.equal(windowCovers(w, 18 * 60), true); // 18:00 inclusive start
  assert.equal(windowCovers(w, 12 * 60), false); // noon out
});

test("half-open: end is exclusive, start is inclusive", () => {
  const w = normalizeWindow({ start: "08:00", end: "18:00" });
  assert.equal(windowCovers(w, 8 * 60), true); // 08:00 in
  assert.equal(windowCovers(w, 18 * 60), false); // 18:00 out
  assert.equal(windowCovers(w, 17 * 60 + 59), true);
});

test("start === end means whole day, not empty", () => {
  const w = normalizeWindow({ start: "18:00", end: "18:00" });
  assert.equal(w.fullDay, true);
  assert.ok(windowCovers(w, 0));
  assert.ok(windowCovers(w, 12 * 60));
  assert.ok(windowCovers(w, 18 * 60));
});

// ─── The 17:59 validation rule (minute-exact) ───────────────
test("validateWindows accepts exact tiling 18:00→08:00 + 08:00→18:00", () => {
  const r = validateWindows([
    { start: "18:00", end: "08:00" },
    { start: "08:00", end: "18:00" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test("validateWindows rejects 17:59 overlap and names both windows", () => {
  const r = validateWindows([
    { start: "17:59", end: "08:00" },
    { start: "08:00", end: "18:00" },
  ]);
  assert.equal(r.ok, false);
  // The message must name both offending windows so the UI can point at them.
  assert.match(r.errors.join(" "), /17:59/);
  assert.match(r.errors.join(" "), /overlap/i);
});

test("validateWindows rejects 18:00|18:00 duplicate vs a full day", () => {
  // Two identical windows collide (both cover every minute).
  const r = validateWindows([
    { start: "18:00", end: "18:00" },
    { start: "18:00", end: "18:00" },
  ]);
  assert.equal(r.ok, false);
});

test("a single 18:00|18:00 window is accepted (whole-day window)", () => {
  const r = validateWindows([{ start: "18:00", end: "18:00" }]);
  assert.equal(r.ok, true);
});

test("findWindowOverlaps is empty for a clean 3-way tiling", () => {
  const wins = [
    { start: "00:00", end: "08:00" },
    { start: "08:00", end: "16:00" },
    { start: "16:00", end: "00:00" },
  ].map((w) => normalizeWindow(w));
  assert.equal(findWindowOverlaps(wins).length, 0);
});

// ─── Cross-model conflicts ─────────────────────────────────
test("findScheduleConflicts names the two models that collide", () => {
  const a = normalizeWindow({ start: "18:00", end: "08:00" });
  const b = normalizeWindow({ start: "06:00", end: "12:00" });
  const conflicts = findScheduleConflicts([
    { id: "glm", name: "GLM", windows: [a] },
    { id: "qwen", name: "Qwen", windows: [b] },
  ]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /GLM/);
  assert.match(conflicts[0], /Qwen/);
});

// Regression: a weekend all-day window must NOT clash with a weekday shift on
// another model. Weekday and weekend are never active at the same instant, so
// comparing across them produced a phantom "08:00–18:00 overlaps 00:00–23:59".
test("weekday and weekend windows never conflict across day types", () => {
  const conflicts = findScheduleConflicts([
    {
      id: "qwen",
      name: "Qwen3.8 Flash Next NVFP4",
      weekday: [normalizeWindow({ start: "08:00", end: "18:00" })],
      weekend: [],
    },
    {
      id: "ds",
      name: "DeepSeek-V4 Flash DSpark",
      weekday: [],
      weekend: [normalizeWindow({ start: "00:00", end: "23:59" })],
    },
  ]);
  assert.deepEqual(conflicts, []);
});

test("same-day-type overlap is still caught (weekday vs weekday)", () => {
  const conflicts = findScheduleConflicts([
    {
      id: "qwen",
      name: "Qwen",
      weekday: [normalizeWindow({ start: "08:00", end: "18:00" })],
      weekend: [],
    },
    {
      id: "ds",
      name: "DeepSeek",
      weekday: [normalizeWindow({ start: "17:00", end: "23:00" })],
      weekend: [],
    },
  ]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /Qwen/);
  assert.match(conflicts[0], /DeepSeek/);
});

// ─── resolveActiveWindow + nextBoundary ────────────────────
test("resolveActiveWindow returns the covering window or null in a gap", () => {
  const wins = [
    normalizeWindow({ start: "08:00", end: "18:00" }, "glm"),
    normalizeWindow({ start: "20:00", end: "22:00" }, "qwen"),
  ];
  assert.equal(resolveActiveWindow(wins, 10 * 60)?.owner, "glm");
  assert.equal(resolveActiveWindow(wins, 21 * 60)?.owner, "qwen");
  assert.equal(resolveActiveWindow(wins, 19 * 60), null); // gap
});

test("nextBoundary finds the nearest strictly-future boundary", () => {
  const wins = [normalizeWindow({ start: "08:00", end: "18:00" })];
  // At 10:00 the next change is 18:00 → 480 min away.
  const nb = nextBoundary(wins, 10 * 60);
  assert.equal(nb.minute, 18 * 60);
  assert.equal(nb.minutesUntil, 480);
  // Exactly on a boundary, that boundary must not count as "next" (skip to the following).
  const onEdge = nextBoundary(wins, 18 * 60);
  assert.equal(onEdge.minute, 8 * 60);
  assert.equal(onEdge.minutesUntil, 840);
});

// ─── Time zone (fixed instants) ────────────────────────────
test("zonedParts maps an instant to wall minute + dayType in a zone", () => {
  // 2026-01-05 is a Monday. 2026-01-05T01:00Z = 02:00 CET (UTC+1 in winter).
  const mon = Date.UTC(2026, 0, 5, 1, 0, 0);
  const p = zonedParts(mon, "Europe/Prague");
  assert.equal(p.dayType, "weekday");
  assert.equal(p.minute, 2 * 60);
  assert.equal(p.offsetMin, 60);
  // 2026-01-03 is a Saturday.
  const sat = Date.UTC(2026, 0, 3, 12, 0, 0);
  assert.equal(zonedParts(sat, "Europe/Prague").dayType, "weekend");
  assert.equal(zonedParts(sat, "Europe/Prague").weekday, "Sat");
});

test("an unknown zone falls back to UTC instead of throwing", () => {
  const t = Date.UTC(2026, 0, 5, 5, 30, 0);
  const p = zonedParts(t, "Not/AZone");
  assert.equal(p.dayType, "weekday");
  assert.equal(p.minute, 5 * 60 + 30);
});

test("nextBoundaryAt is stable between boundaries (diff-cache safe)", () => {
  const wins = [normalizeWindow({ start: "08:00", end: "18:00" })];
  const tz = "UTC";
  const t1 = Date.UTC(2026, 0, 5, 10, 0, 0);
  const t2 = Date.UTC(2026, 0, 5, 10, 5, 0); // 5 min later, same window
  assert.equal(nextBoundaryAt(t1, tz, wins).epochMs, nextBoundaryAt(t2, tz, wins).epochMs);
});

// ─── Schedule normalize/validate ───────────────────────────
test("normalizeModelSchedule keeps only valid windows and coerces enabled", () => {
  const s = normalizeModelSchedule({
    enabled: "yes",
    weekday: [{ start: "08:00", end: "18:00" }, { start: "bad" }],
    weekend: null,
  });
  assert.equal(s.enabled, true);
  assert.equal(s.weekday.length, 1);
  assert.deepEqual(s.weekday[0], { start: "08:00", end: "18:00" });
  assert.deepEqual(s.weekend, []);
});

test("validateModelSchedule rejects an overlapping weekday set", () => {
  const v = validateModelSchedule({
    enabled: true,
    weekday: [{ start: "17:59", end: "08:00" }, { start: "08:00", end: "18:00" }],
    weekend: [],
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Weekday/.test(e)));
});

test("scheduleIsUsable requires enabled AND at least one window", () => {
  assert.equal(scheduleIsUsable({ enabled: true, weekday: [{ start: "08:00", end: "09:00" }], weekend: [] }), true);
  assert.equal(scheduleIsUsable({ enabled: false, weekday: [{ start: "08:00", end: "09:00" }], weekend: [] }), false);
  assert.equal(scheduleIsUsable({ enabled: true, weekday: [], weekend: [] }), false);
});
