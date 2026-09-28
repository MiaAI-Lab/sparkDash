/**
 * autopowerSchedules — pure config math for the Spark AutoPower feature.
 *
 * AutoPower mirrors the model scheduler's rhythm with one difference: instead
 * of several windows per day type it keeps a single span per day type:
 *
 *   watch  — the span during which sustained idle may end in a shutdown
 *            ({ weekday: [{start,end}], weekend: [...] }, at most ONE window
 *            per day type, wrap-aware via the modelSchedules window math)
 *   wake   — a single "HH:MM" per day type at which Wake-on-LAN is issued
 *            (null = no automatic wake for that day type)
 *
 * Everything here is pure and shared by the server manager and the dialog.
 * Window semantics (half-open, wrap-aware, start===end = 24 h) are inherited
 * from modelSchedules.normalizeWindow so both features read the same way.
 */
import { parseClock, normalizeWindow, formatClock } from "./modelSchedules.js";

export const AUTOPOWER_DEFAULT_TZ = "Europe/Prague";
export const AUTOPOWER_DEFAULT_IDLE_MIN = 30;
export const IDLE_TIMEOUT_MIN_LIMITS = Object.freeze({ min: 5, max: 720 });

/** The stored config shape (config/autopower.json). */
export function defaultAutoPowerConfig(tz = AUTOPOWER_DEFAULT_TZ) {
  return {
    enabled: false,
    tz,
    idleTimeoutMin: AUTOPOWER_DEFAULT_IDLE_MIN,
    watch: {
      weekday: [{ start: "22:00", end: "07:00" }],
      weekend: [{ start: "23:00", end: "08:00" }],
    },
    wake: { weekday: "08:00", weekend: "10:00" },
  };
}

/** One watch list → at most one normalized window; errors name the offender. */
function normalizeWatchList(list, dayType) {
  const errors = [];
  const raw = Array.isArray(list) ? list : [];
  if (raw.length > 1) errors.push(`${dayType}: only one watch span is supported.`);
  const src = raw[0];
  if (src == null) return { window: null, errors };
  const w = normalizeWindow(src, dayType);
  if (!w) {
    errors.push(`${dayType}: start and end must both be "HH:MM" (24-hour).`);
    return { window: null, errors };
  }
  return { window: { start: w.start, end: w.end }, errors };
}

/** One wake time → "HH:MM" or null. */
function normalizeWakeTime(value) {
  if (value == null || value === "") return { minute: null, errors: [] };
  const m = parseClock(value);
  if (m == null) return { minute: null, errors: ['wake must be "HH:MM" (24-hour) or empty.'] };
  return { minute: formatClock(m), errors: [] };
}

/** Clamp/coerce a raw config into exactly the stored shape (no validation). */
export function normalizeAutoPowerConfig(raw) {
  const def = defaultAutoPowerConfig();
  const src = raw && typeof raw === "object" ? raw : {};
  const idle = Number(src.idleTimeoutMin);
  const idleTimeoutMin = Number.isFinite(idle)
    ? Math.min(
        IDLE_TIMEOUT_MIN_LIMITS.max,
        Math.max(IDLE_TIMEOUT_MIN_LIMITS.min, Math.round(idle))
      )
    : def.idleTimeoutMin;
  const watchSrc = src.watch && typeof src.watch === "object" ? src.watch : {};
  const wakeSrc = src.wake && typeof src.wake === "object" ? src.wake : {};
  const one = (res) => (res.window ? [res.window] : []);
  const wake = (key) => {
    const w = normalizeWakeTime(wakeSrc[key]);
    return w.minute;
  };
  return {
    enabled: Boolean(src.enabled),
    tz: typeof src.tz === "string" && src.tz ? src.tz : def.tz,
    idleTimeoutMin,
    watch: {
      weekday: one(normalizeWatchList(watchSrc.weekday, "weekday")),
      weekend: one(normalizeWatchList(watchSrc.weekend, "weekend")),
    },
    wake: { weekday: wake("weekday"), weekend: wake("weekend") },
  };
}

/**
 * Full validation for the API: window shape, wake times, idle clamp, tz sanity.
 * @returns {{ ok: boolean, errors: string[], config: ReturnType<typeof normalizeAutoPowerConfig> }}
 */
export function validateAutoPowerConfig(raw) {
  const errors = [];
  const src = raw && typeof raw === "object" ? raw : {};
  const watchSrc = src.watch && typeof src.watch === "object" ? src.watch : {};
  const wakeSrc = src.wake && typeof src.wake === "object" ? src.wake : {};
  const weekday = normalizeWatchList(watchSrc.weekday, "weekday");
  const weekend = normalizeWatchList(watchSrc.weekend, "weekend");
  errors.push(...weekday.errors, ...weekend.errors);
  for (const dayType of ["weekday", "weekend"]) {
    const w = normalizeWakeTime(wakeSrc[dayType]);
    errors.push(...w.errors.map((e) => `${dayType} ${e}`));
  }
  if (typeof src.idleTimeoutMin !== "undefined") {
    const idle = Number(src.idleTimeoutMin);
    if (!Number.isFinite(idle)) {
      errors.push("idleTimeoutMin must be a number of minutes.");
    } else if (idle < IDLE_TIMEOUT_MIN_LIMITS.min || idle > IDLE_TIMEOUT_MIN_LIMITS.max) {
      errors.push(
        `idleTimeoutMin must be between ${IDLE_TIMEOUT_MIN_LIMITS.min} and ${IDLE_TIMEOUT_MIN_LIMITS.max} minutes.`
      );
    }
  }
  if (typeof src.tz === "string" && src.tz.trim()) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: src.tz.trim() });
    } catch {
      errors.push(`Unknown time zone: ${src.tz}`);
    }
  }
  return { ok: errors.length === 0, errors, config: normalizeAutoPowerConfig(src) };
}

/**
 * The single watch window covering `minute` for a day type, or null.
 * Reuses the modelSchedules window math so wrap-aware spans behave identically.
 */
export function resolveWatchWindow(config, dayType, minute) {
  const raw = config?.watch?.[dayType]?.[0];
  const w = raw ? normalizeWindow(raw) : null;
  if (!w) return null;
  const m = ((minute % 1440) + 1440) % 1440;
  const covers =
    w.fullDay || (w.wrap ? m >= w.startMin || m < w.endMin : m >= w.startMin && m < w.endMin);
  return covers ? w : null;
}
