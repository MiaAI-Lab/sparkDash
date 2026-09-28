/**
 * modelSchedules — pure schedule math shared by the server scheduler and the
 * browser dialogs (same bind-mounted `src/shared` trick as llmPrompts.js).
 *
 * No imports, no I/O, no clock reads: every function takes the time it needs.
 * That is what lets ModelScheduler / the ModelScheduleDialog be unit-tested
 * against fixed instants instead of wall time.
 *
 * ── The half-open circular interval ────────────────────────────────────────
 * A window is `[start, end)` on a 1440-minute clock:
 *   18:00 → 08:00  covers 1080..1439 and 0..479   (wraps midnight)
 *   08:00 → 18:00  covers 480..1079                (no wrap)
 *   18:00 → 18:00  start === end ⇒ the WHOLE day (not an empty window)
 *
 * Boundary equality is NOT an overlap: `18:00→08:00` + `08:00→18:00` tile the
 * day exactly and validate clean. Shift either end by a single minute and it
 * does overlap (`17:59→08:00` + `08:00→18:00` collide at 17:59) — which is why
 * the dialogs use minute precision (`<input type="time" step="900">` still
 * accepts a typed 17:59) and why validation is minute-exact, not hour-exact.
 */

export const MINUTES_PER_DAY = 1440;
export const DAY_TYPES = ["weekday", "weekend"];

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// ─── Clock helpers ─────────────────────────────────────────────────────────
/**
 * Parse "HH:MM" (accepts "8:00", rejects "08:60", "24:00", "8am").
 * @param {unknown} value
 * @returns {number|null} minutes past local midnight, or null
 */
export function parseClock(value) {
  if (typeof value !== "string") return null;
  const m = CLOCK_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @param {number} minute minutes past local midnight (0..1439)
 * @returns {string} "HH:MM"
 */
export function formatClock(minute) {
  const m = Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.trunc(Number(minute) || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Wrap a possibly-negative / overflow minute into 0..1439. */
function wrapMinute(minute) {
  return ((Math.trunc(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

// ─── Windows ───────────────────────────────────────────────────────────────
/**
 * Canonicalise one window. Also carries `wrap` + `fullDay` so neither caller
 * has to re-derive them.
 * @param {{ start?: unknown, end?: unknown }|null|undefined} raw
 * @param {string} [owner] label used in validation messages
 * @returns {{ start: string, end: string, startMin: number, endMin: number,
 *   wrap: boolean, fullDay: boolean, key: string, label: string, owner: string|null,
 *   spans: [number,number][] }|null}
 */
export function normalizeWindow(raw, owner = null) {
  if (!raw || typeof raw !== "object") return null;
  const startMin = parseClock(raw.start);
  const endMin = parseClock(raw.end);
  if (startMin == null || endMin == null) return null;
  const start = formatClock(startMin);
  const end = formatClock(endMin);
  const fullDay = startMin === endMin;
  const wrap = !fullDay && endMin <= startMin;
  return {
    start,
    end,
    startMin,
    endMin,
    wrap,
    fullDay,
    key: `${start}-${end}`,
    label: `${start}–${end}${wrap ? " (+1d)" : ""}${fullDay ? " · 24 h" : ""}`,
    owner: typeof owner === "string" && owner ? owner : null,
    // Disjoint linear half-open pieces on [0, 1440). `spans` is what makes
    // overlap detection trivially correct across the midnight seam.
    spans: fullDay
      ? [[0, MINUTES_PER_DAY]]
      : wrap
        ? [[startMin, MINUTES_PER_DAY], [0, endMin]]
        : [[startMin, endMin]],
  };
}

/** Normalize a raw list, keeping the rejects separate so the API can name them. */
export function normalizeWindowList(list, owner = null) {
  const windows = [];
  const errors = [];
  const seenKeys = new Set();
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    const w = normalizeWindow(raw, owner);
    if (!w) {
      errors.push(`Window ${i + 1}: start and end must both be "HH:MM" (24-hour).`);
      return;
    }
    if (seenKeys.has(w.key)) {
      errors.push(`Window ${i + 1}: duplicate ${w.label}.`);
      return;
    }
    seenKeys.add(w.key);
    windows.push(w);
  });
  return { windows, errors };
}

/**
 * Is `minute` inside the window? Half-open, wrap-aware, 24 h when start===end.
 * @param {{startMin:number,endMin:number,wrap:boolean,fullDay:boolean}} w
 * @param {number} minute
 */
export function windowCovers(w, minute) {
  if (!w) return false;
  const m = wrapMinute(minute);
  if (w.fullDay) return true;
  if (w.wrap) return m >= w.startMin || m < w.endMin;
  return m >= w.startMin && m < w.endMin;
}

/** Half-open linear interval intersection: [a,b) ∩ [c,d) ≠ ∅. */
function spansOverlap(a, b) {
  for (const [a0, a1] of a.spans) {
    for (const [b0, b1] of b.spans) {
      if (a0 < b1 && b0 < a1) return true;
    }
  }
  return false;
}

/**
 * All overlapping pairs inside one window list. Empty when the list is a clean
 * tiling (boundary equality is allowed on purpose — see the file header).
 * @param {object[]} windows normalized windows
 * @returns {[object, object][]}
 */
export function findWindowOverlaps(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (spansOverlap(list[i], list[j])) pairs.push([list[i], list[j]]);
    }
  }
  return pairs;
}

/**
 * Validate one model's window list for one day type.
 * @returns {{ ok: boolean, windows: object[], errors: string[] }}
 */
export function validateWindows(list, owner = null) {
  const { windows, errors } = normalizeWindowList(list, owner);
  for (const [a, b] of findWindowOverlaps(windows)) {
    errors.push(`Windows ${a.label} and ${b.label} overlap — one model cannot run twice at once.`);
  }
  return { ok: errors.length === 0, windows, errors };
}

/**
 * Cross-model validation: two models must not both claim the same minute, or
 * the scheduler would have two targets for one tick.
 *
 * A window only competes with another when they can be *active at the same
 * moment*. Weekday and weekend windows never are — the scheduler reads one
 * dayType per instant — so this compares weekday-vs-weekday and
 * weekend-vs-weekend separately and never across the two. A weekend all-day
 * window is therefore free to sit alongside a weekday 08:00–18:00 on a
 * different model.
 *
 * Each entry may carry either a flat `windows` array (legacy: treated as one
 * bucket) or `weekday` / `weekend` arrays (day-scoped). Prefer the latter.
 * @param {Iterable<{ id: string, name?: string, windows?: object[], weekday?: object[], weekend?: object[] }>} entries
 * @returns {string[]} human-readable conflicts (empty when clean)
 */
export function findScheduleConflicts(entries) {
  const list = Array.from(entries || []);
  // Bucket windows by dayType; a flat `windows` array becomes its own bucket
  // so legacy single-list callers still detect collisions among themselves.
  const buckets = new Map();
  const add = (bucketKey, entry) => {
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(entry);
  };
  for (const e of list) {
    if (Array.isArray(e.weekday) || Array.isArray(e.weekend)) {
      if (e.weekday?.length) add("weekday", { ...e, windows: e.weekday });
      if (e.weekend?.length) add("weekend", { ...e, windows: e.weekend });
    } else if (Array.isArray(e.windows) && e.windows.length) {
      add("flat", e);
    }
  }
  const out = [];
  for (const bucket of buckets.values()) {
    const flat = [];
    for (const e of bucket) {
      for (const w of e.windows || []) flat.push({ ...w, modelId: e.id, name: e.name || e.id });
    }
    for (let i = 0; i < flat.length; i += 1) {
      for (let j = i + 1; j < flat.length; j += 1) {
        const a = flat[i];
        const b = flat[j];
        if (a.modelId === b.modelId) continue;
        if (spansOverlap(a, b)) {
          out.push(
            `${a.name} ${a.label} overlaps ${b.name} ${b.label} — a window may belong to only one model.`
          );
        }
      }
    }
  }
  return out;
}

/** The window covering `minute`, or null (a gap — the scheduler stops models). */
export function resolveActiveWindow(windows, minute) {
  const list = Array.isArray(windows) ? windows : [];
  return list.find((w) => windowCovers(w, minute)) || null;
}

/**
 * Next minute > `minute` at which coverage can change (any start or end),
 * searching forward across midnight. Null when there is no boundary at all,
 * i.e. no windows — the manual override would then never expire.
 * @returns {{ minute: number, minutesUntil: number }|null}
 */
export function nextBoundary(windows, minute) {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return null;
  const points = new Set();
  for (const w of list) {
    points.add(w.startMin);
    points.add(w.endMin);
  }
  const now = wrapMinute(minute);
  let best = null;
  for (const p of points) {
    // Distance forward to this point. A point equal to `now` has already
    // fired this instant, so its next occurrence is a full day away — which
    // only wins if it is the sole boundary (single-window day).
    const delta = p > now ? p - now : MINUTES_PER_DAY - (now - p);
    if (best === null || delta < best) best = delta;
  }
  if (best === null || best >= MINUTES_PER_DAY) return null;
  return { minute: wrapMinute(now + best), minutesUntil: best };
}

/**
 * Windows for a day type, normalized and validated.
 * @param {object} schedule model schedule ({ weekday: [...], weekend: [...] })
 * @param {"weekday"|"weekend"} dayType
 */
export function scheduleWindows(schedule, dayType) {
  const list = schedule && (dayType === "weekend" ? schedule.weekend : schedule.weekday);
  return normalizeWindowList(Array.isArray(list) ? list : []).windows;
}

// ─── Time zone (pure: the caller supplies the instant) ─────────────────────
/** Cache one formatter per zone — Intl formatters are expensive to build. */
const formatterCache = new Map();

function partsFormatter(tz) {
  const key = tz || "UTC";
  let f = formatterCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: key,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      // Invalid zone (bad env var) — fall back to UTC rather than crash the tick.
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * Wall-clock reading in `tz` for an absolute instant.
 * @param {Date|number} date
 * @param {string} tz IANA zone (falls back to UTC when unknown)
 * @returns {{ minute: number, dayType: "weekday"|"weekend", dateKey: string,
 *   weekday: string, offsetMin: number }}
 */
export function zonedParts(date, tz) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minuteOfDay = hour * 60 + Number(get("minute") || 0);
  const weekday = get("weekday");
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  // Shift between the shifted-epoch day grid and UTC; constant until DST moves.
  const wallMs = Date.UTC(
    Number(get("year")),
    Math.max(0, Number(get("month")) - 1),
    Number(get("day")),
    hour,
    Number(get("minute") || 0)
  );
  return {
    minute: wrapMinute(minuteOfDay),
    dayType: isWeekend ? "weekend" : "weekday",
    dateKey,
    weekday,
    offsetMin: Math.round((wallMs - ms) / 60000),
  };
}

/** Convenience wrapper for the scheduler tick. */
export function dayTypeOf(date, tz) {
  return zonedParts(date, tz).dayType;
}

/**
 * Absolute epoch ms of a wall-clock minute in `tz`, either today or tomorrow.
 * Deterministic (no `now` arithmetic), so the value is byte-stable in the WS
 * snapshot between boundaries — which is what keeps the diff cache from
 * thrashing on every poll tick.
 * @param {Date|number} date current instant (only used to pick today vs tomorrow)
 * @param {string} tz
 * @param {number} targetMinute wall minute-of-day
 */
export function zonedMinuteToEpoch(date, tz, targetMinute) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  const parts = zonedParts(date, tz);
  const [y, mo, d] = parts.dateKey.split("-").map(Number);
  const target = wrapMinute(targetMinute);
  // Wall minute → epoch: subtract the zone's current UTC offset, then push to
  // tomorrow if that wall minute has already gone by today.
  let epoch = Date.UTC(y, mo - 1, d) + target * 60_000 - parts.offsetMin * 60_000;
  if (epoch <= ms - 60_000) epoch += MINUTES_PER_DAY * 60_000;
  return epoch;
}

/**
 * Epoch ms of the next schedule boundary in `tz`. Stable between boundaries.
 * @returns {{ epochMs: number, minute: number, minutesUntil: number }|null}
 */
export function nextBoundaryAt(date, tz, windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return null;
  const ms = date instanceof Date ? date.getTime() : Number(date);
  const parts = zonedParts(date, tz);
  const boundary = nextBoundary(list, parts.minute);
  if (!boundary) return null;
  return {
    epochMs: zonedMinuteToEpoch(date, tz, boundary.minute),
    minute: boundary.minute,
    minutesUntil: boundary.minutesUntil,
  };
}

// ─── Scheduler config ─────────────────────────────────────────────────────
/** Clamp/coerce the persisted scheduler config into exactly this shape. */
export function normalizeSchedulerConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Boolean(src.enabled),
    tz: typeof src.tz === "string" && src.tz ? src.tz : "UTC",
  };
}

/**
 * Per-model schedule stored on the model record. `windows[dayType]` are raw
 * `{ start, end }` strings as typed in the dialog.
 */
export function normalizeModelSchedule(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const pick = (list) =>
    (Array.isArray(list) ? list : [])
      .map((w) => normalizeWindow(w))
      .filter(Boolean)
      .map((w) => ({ start: w.start, end: w.end }));
  return {
    enabled: Boolean(src.enabled),
    weekday: pick(src.weekday),
    weekend: pick(src.weekend),
  };
}

/** True when a model's schedule could ever win a tick. */
export function scheduleIsUsable(schedule) {
  if (!schedule || !schedule.enabled) return false;
  return scheduleWindows(schedule, "weekday").length +
    scheduleWindows(schedule, "weekend").length >
    0;
}

/** Full validation for the API/registry: both day types plus the shape. */
export function validateModelSchedule(raw) {
  const errors = [];
  const src = raw && typeof raw === "object" ? raw : {};
  const weekday = validateWindows(src.weekday, "weekday");
  const weekend = validateWindows(src.weekend, "weekend");
  errors.push(...weekday.errors.map((e) => `Weekday ${e}`));
  errors.push(...weekend.errors.map((e) => `Weekend ${e}`));
  return {
    ok: errors.length === 0,
    errors,
    schedule: normalizeModelSchedule(src),
    weekdayWindows: weekday.windows,
    weekendWindows: weekend.windows,
  };
}
