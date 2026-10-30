/**
 * External power meters: reads them and hands their figures to the fleet-energy tracker,
 * which records wall power next to its estimate. This module stores no energy itself.
 *
 * Opt-in: without config/power-meters.json the runtime is inert (no timers, no network)
 * and only the status route answers. See docs/POWER-METERS.md.
 *
 *  - Live: each meter is read every `pollIntervalMs` (10 s by default, never under 5 s).
 *    The tracker's 2 s energy sampler reads the cached result through `wallReadings()`.
 *  - History: for meters that keep it, a pass 45 s after every 5-minute boundary writes the
 *    meter's own 5-minute (and once an hour, hourly) figures over the live minutes. The first
 *    pass backfills: the tracker's 31-day window minute by minute, anything older straight
 *    into the monthly archive, back to each unit's `since`.
 *  - Settling: the monthly archive folds a wall minute only once the meter has confirmed it
 *    (or it is an hour old), so a minute is counted once, with the meter's figure.
 */
import { loadPowerMeterConfig } from "./config.js";
import { PowerMeterProvider, createProvider, providerClass } from "./providers/index.js";
import { registerPowerMeterRoutes } from "./routes.js";

const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A meter clock this far ahead of ours still counts as fresh. */
const CLOCK_SKEW_MS = 60_000;
const RECONCILE_OFFSET_MS = 45_000;
const HISTORY_REQUEST_TIMEOUT_MS = 120_000;
const CHUNK_MS = { "5minute": 5 * DAY_MS, hour: 30 * DAY_MS };
/** Steady-state lookback, so periods the meter compiles late are still picked up. */
const LOOKBACK_MS = { "5minute": 6 * HOUR_MS, hour: 2 * DAY_MS };
/** Live wall minutes are folded into months unconfirmed once they are this old. */
const MAX_SETTLE_MS = HOUR_MS;

const floorTo = (ms, step) => Math.floor(ms / step) * step;

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function inertRuntime(result, logger) {
  if (result.status === "invalid") logger.error?.(`[powerMeters] disabled: ${result.error}`);
  else if (result.status === "disabled") logger.log?.(`[powerMeters] disabled by "enabled": false in ${result.filePath}`);
  const status = () => ({ enabled: false, state: result.status, ...(result.error ? { error: result.error } : {}) });
  return {
    enabled: false,
    status,
    wallReadings: () => null,
    register(app) {
      registerPowerMeterRoutes(app, { status });
    },
    renderPrometheus: () => "",
    start() {},
    stop() {},
  };
}

/**
 * @param {object} options
 * @param {import("../energy/FleetEnergyTracker.js").FleetEnergyTracker} options.tracker
 * @param {() => Array<{ id: string, name?: string }>} [options.listUnits]
 * @param {(event: { type: string, severity: string, message: string }) => void} [options.recordEvent]
 */
export function createPowerMeterRuntime({
  configResult,
  loadConfig = loadPowerMeterConfig,
  env = process.env,
  tracker,
  listUnits = () => [],
  recordEvent = () => {},
  now = () => Date.now(),
  createProviderFn = createProvider,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  logger = console,
} = {}) {
  const result = configResult ?? loadConfig();
  if (result.status !== "ok") return inertRuntime(result, logger);
  const cfg = result.config;
  const startedAt = now();

  const meters = new Map();
  for (const [id, spec] of Object.entries(cfg.meters)) {
    const meter = {
      id,
      type: spec.type,
      // The provider names itself; known even when it could not start.
      label: providerClass(spec.type)?.label || spec.type,
      provider: null,
      error: null,
      health: "pending",
      lastOkAt: null,
      lastError: null,
      history: { state: "pending", lastOkAt: null, lastError: null, backfill: null },
      historyFailing: false,
    };
    try {
      const provider = createProviderFn(spec, { env, logger });
      if (!(provider instanceof PowerMeterProvider)) throw new Error("provider does not extend PowerMeterProvider");
      meter.provider = provider;
      meter.label = provider.label || meter.label;
    } catch (error) {
      meter.error = error.message;
      meter.health = "unavailable";
      meter.history.state = "unavailable";
      logger.error?.(`[powerMeters] meter ${id} unavailable: ${error.message}`);
    }
    if (meter.provider && !meter.provider.supportsHistory) meter.history.state = "unsupported";
    else if (meter.provider && !cfg.history.enabled) meter.history.state = "off";
    meters.set(id, meter);
  }

  const units = new Map();
  for (const [id, spec] of Object.entries(cfg.units)) {
    const key = `${spec.meter}|${cfg.meters[spec.meter].type}|${spec.channel}`;
    units.set(id, {
      id,
      meterId: spec.meter,
      channel: spec.channel,
      sinceMs: spec.sinceMs,
      key,
      backfillKey: `${key}|since=${spec.sinceMs ?? ""}|days=${cfg.history.backfillDays}`,
      reading: null,
    });
  }
  const unitIds = [...units.keys()];
  const tracked = new Set(tracker.configureWall({ nodeIds: unitIds, settledBefore: () => settledBefore() }));
  for (const id of unitIds) {
    if (!tracked.has(id)) logger.warn?.(`[powerMeters] ${id} is not a registered unit; its readings are shown but not recorded`);
  }
  // A unit now on another outlet: its stored wall minutes belonged to a different device.
  for (const unit of units.values()) {
    const state = tracker.wallState(unit.id);
    if (state && state.key !== unit.key) {
      logger.warn?.(`[powerMeters] ${unit.id} now reads ${unit.key}; dropping its wall minutes from ${state.key}`);
      tracker.clearWall(unit.id);
      tracker.setWallState(unit.id, null);
    }
  }

  let polling = false;
  let reconciling = null;
  let caughtUp = false;
  let lastHourlyRun = null;
  let pollTimer = null;
  let reconcileTimer = null;
  let stopped = false;
  const lifecycle = new AbortController();

  const historyMeters = () =>
    [...meters.values()].filter((m) => m.provider?.supportsHistory && cfg.history.enabled);
  const metered = (meter) => [...units.values()].filter((u) => u.meterId === meter.id && tracked.has(u.id));

  function state(unit) {
    const stored = tracker.wallState(unit.id);
    return stored?.key === unit.key ? stored : { key: unit.key, marks: {}, backfill: null };
  }

  function saveState(unit, patch) {
    const current = state(unit);
    tracker.setWallState(unit.id, { ...current, ...patch, marks: { ...current.marks, ...(patch.marks ?? {}) } });
  }

  function mark(unit, period) {
    return state(unit).marks?.[period] ?? null;
  }

  function fresh(unit, atMs) {
    const r = unit.reading;
    if (!r || !Number.isFinite(r.watts) || r.atMs == null) return false;
    const ageMs = atMs - r.atMs;
    return ageMs <= cfg.staleAfterMs && ageMs >= -CLOCK_SKEW_MS;
  }

  /** Before this instant the meters will not revise wall minutes any more. */
  function settledBefore() {
    const t = now();
    let settled = Infinity;
    for (const meter of historyMeters()) {
      for (const unit of metered(meter)) {
        const fallback = t - MAX_SETTLE_MS;
        if (!caughtUp) settled = Math.min(settled, t - startedAt > MAX_SETTLE_MS ? fallback : -Infinity);
        else settled = Math.min(settled, Math.max(mark(unit, "5minute") ?? -Infinity, mark(unit, "hour") ?? -Infinity, fallback));
      }
    }
    return settled;
  }

  function event(type, severity, message) {
    try {
      recordEvent({ type: `power-meter.${type}`, severity, message });
    } catch {
      // The activity log is best-effort.
    }
  }

  function describeMeter(meter) {
    return meters.size > 1 ? `${meter.label} (${meter.id})` : meter.label;
  }

  function setHealth(meter, ok, error) {
    const previous = meter.health;
    meter.health = ok ? "ok" : "error";
    if (ok && previous !== "ok") {
      const count = [...units.values()].filter((u) => u.meterId === meter.id && fresh(u, now())).length;
      event(previous === "error" ? "recovered" : "connected", "success", previous === "error"
        ? `${describeMeter(meter)} is reading again`
        : `${describeMeter(meter)} connected: ${count} outlet${count === 1 ? "" : "s"}`);
      logger.log?.(`[powerMeters] meter ${meter.id} ok`);
    } else if (!ok && previous !== "error") {
      event("unreachable", "error", `${describeMeter(meter)} stopped reading: ${error}`);
      logger.warn?.(`[powerMeters] meter ${meter.id}: ${error}`);
    }
  }

  async function pollOnce() {
    if (polling || stopped) return;
    polling = true;
    try {
      await Promise.all(
        [...meters.values()].map(async (meter) => {
          const meterUnits = [...units.values()].filter((u) => u.meterId === meter.id);
          if (!meterUnits.length || !meter.provider) return;
          const channels = meterUnits.map((u) => u.channel);
          let readings;
          try {
            readings = await meter.provider.readPower(channels, {
              signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(cfg.pollIntervalMs)]),
            });
          } catch (error) {
            readings = new Map(channels.map((c) => [c, { watts: null, atMs: null, error: error.message }]));
          }
          if (stopped) return;
          const polledAtMs = now();
          let firstError = null;
          for (const unit of meterUnits) {
            const r = readings?.get?.(unit.channel) ?? { watts: null, atMs: null, error: "no reading returned" };
            unit.reading = {
              watts: Number.isFinite(r.watts) ? r.watts : null,
              atMs: r.atMs ?? null,
              error: r.error ?? null,
              polledAtMs,
            };
            if (!unit.reading.error && !fresh(unit, polledAtMs)) unit.reading.error = "reading is stale";
            if (unit.reading.error) firstError ??= `${unit.id}: ${unit.reading.error}`;
          }
          meter.lastError = firstError;
          if (!firstError) meter.lastOkAt = polledAtMs;
          setHealth(meter, !firstError, firstError);
        })
      );
    } finally {
      polling = false;
    }
  }

  /** Fetch one range; minutes in the tracker's window are overwritten, older hours collected. */
  async function fetchRange(meter, meterUnits, period, fromMs, toMs, older, onChunk) {
    const step = period === "5minute" ? FIVE_MINUTES_MS : HOUR_MS;
    for (let a = floorTo(fromMs, step); a < toMs && !stopped; a += CHUNK_MS[period]) {
      const b = Math.min(toMs, a + CHUNK_MS[period]);
      const history = await meter.provider.readHistory(
        meterUnits.map((u) => u.channel),
        { fromMs: a, toMs: b, period, signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(HISTORY_REQUEST_TIMEOUT_MS)]) }
      );
      const windowStart = tracker.windowStartMs(now());
      for (const unit of meterUnits) {
        const periods = (history?.get?.(unit.channel) ?? []).filter((p) => unit.sinceMs == null || p.startMs >= unit.sinceMs);
        tracker.applyWallPeriods(unit.id, periods.filter((p) => p.startMs >= windowStart), { sinceMs: unit.sinceMs });
        if (older) older.get(unit.id).push(...periods.filter((p) => p.endMs <= windowStart));
        const end = periods.reduce((max, p) => Math.max(max, p.endMs), -Infinity);
        if (Number.isFinite(end) && end > (mark(unit, period) ?? -Infinity)) saveState(unit, { marks: { [period]: end } });
      }
      onChunk?.(b);
    }
  }

  async function backfill(meter, meterUnits) {
    const pending = meterUnits.filter((u) => state(u).backfill !== u.backfillKey);
    if (!pending.length) return;
    const t = now();
    const oldest = t - cfg.history.backfillDays * DAY_MS;
    const fromMs = floorTo(Math.max(oldest, Math.min(...pending.map((u) => u.sinceMs ?? oldest))), HOUR_MS);
    meter.history.state = "backfilling";
    meter.history.backfill = { fromMs, throughMs: fromMs, startedAt: t };
    logger.log?.(`[powerMeters] backfilling ${pending.map((u) => u.id).join(", ")} from meter ${meter.id} since ${new Date(fromMs).toISOString()}`);
    const older = new Map(pending.map((u) => [u.id, []]));
    const periods = meter.provider.historyPeriods;
    if (periods.includes("hour")) {
      await fetchRange(meter, pending, "hour", fromMs, t, older, (through) => {
        meter.history.backfill.throughMs = through;
      });
    }
    if (periods.includes("5minute")) {
      await fetchRange(meter, pending, "5minute", Math.max(fromMs, tracker.windowStartMs(t)), t, null);
    }
    if (stopped) return;
    tracker.importWallHistory(older);
    for (const unit of pending) saveState(unit, { backfill: unit.backfillKey });
    meter.history.backfill = { ...meter.history.backfill, throughMs: t, doneAt: now() };
    const days = Math.round((t - fromMs) / DAY_MS);
    event("history-loaded", "info", `${describeMeter(meter)}: ${days} days of history loaded`);
    tracker.flush();
  }

  async function catchUp(meter, meterUnits, period, { initial }) {
    if (!meter.provider.historyPeriods.includes(period)) return;
    const t = now();
    const windowStart = tracker.windowStartMs(t);
    let fromMs = t - LOOKBACK_MS[period];
    if (initial) {
      // After downtime, continue from the oldest confirmed period.
      for (const unit of meterUnits) fromMs = Math.min(fromMs, mark(unit, period) ?? fromMs);
    }
    await fetchRange(meter, meterUnits, period, Math.max(fromMs, windowStart), t, null);
  }

  async function reconcileMeter(meter) {
    const meterUnits = metered(meter);
    if (!meterUnits.length) return;
    try {
      await backfill(meter, meterUnits);
      const initial = !caughtUp;
      await catchUp(meter, meterUnits, "5minute", { initial });
      const hour = floorTo(now(), HOUR_MS);
      if (initial || lastHourlyRun !== hour) await catchUp(meter, meterUnits, "hour", { initial });
      if (meter.historyFailing) event("history-recovered", "success", `${describeMeter(meter)} history is loading again`);
      meter.historyFailing = false;
      meter.history.state = "ok";
      meter.history.lastOkAt = now();
      meter.history.lastError = null;
    } catch (error) {
      if (stopped) return;
      if (!meter.historyFailing) {
        event("history-failed", "warn", `${describeMeter(meter)} history failed: ${error.message}`);
      }
      meter.historyFailing = true;
      meter.history.state = "error";
      meter.history.lastError = error.message;
      logger.warn?.(`[powerMeters] history from meter ${meter.id} failed: ${error.message}`);
    }
  }

  function reconcileOnce() {
    if (stopped) return Promise.resolve();
    if (reconciling) return reconciling;
    reconciling = (async () => {
      try {
        for (const meter of historyMeters()) await reconcileMeter(meter);
        lastHourlyRun = floorTo(now(), HOUR_MS);
        caughtUp = true;
      } finally {
        reconciling = null;
      }
    })();
    return reconciling;
  }

  function scheduleReconcile() {
    if (stopped) return;
    const t = now();
    const delay = floorTo(t, FIVE_MINUTES_MS) + FIVE_MINUTES_MS + RECONCILE_OFFSET_MS - t;
    reconcileTimer = timers.setTimeout(() => {
      reconcileOnce().finally(scheduleReconcile);
    }, delay);
    reconcileTimer?.unref?.();
  }

  function status() {
    const names = new Map((listUnits() ?? []).map((u) => [u.id, u.name ?? u.id]));
    const t = now();
    return {
      enabled: true,
      state: "ok",
      configPath: result.filePath,
      pollIntervalMs: cfg.pollIntervalMs,
      staleAfterMs: cfg.staleAfterMs,
      history: { ...cfg.history },
      meters: [...meters.values()].map((m) => ({
        id: m.id,
        type: m.type,
        label: m.label,
        target: m.provider?.describe().target ?? null,
        health: m.health,
        ok: m.health === "ok",
        error: m.error ?? m.lastError,
        lastOkAt: m.lastOkAt,
        history: { ...m.history },
      })),
      units: [...units.values()].map((u) => ({
        id: u.id,
        name: names.get(u.id) ?? u.id,
        known: names.has(u.id),
        recorded: tracked.has(u.id),
        meter: u.meterId,
        channel: u.channel,
        sinceMs: u.sinceMs,
        watts: u.reading?.watts ?? null,
        atMs: u.reading?.atMs ?? null,
        fresh: fresh(u, t),
        error: u.reading?.error ?? (meters.get(u.meterId).error || null),
        polledAtMs: u.reading?.polledAtMs ?? null,
        reconciledThroughMs: mark(u, "5minute"),
      })),
    };
  }

  const runtime = {
    enabled: true,
    status,
    pollOnce,
    reconcileOnce,
    settledBefore,

    /** Fresh wall readings by unit id, from the last poll. Never contacts a meter. */
    wallReadings(atMs = now()) {
      const out = new Map();
      for (const unit of units.values()) if (fresh(unit, atMs)) out.set(unit.id, unit.reading.watts);
      return out;
    },

    register(app) {
      registerPowerMeterRoutes(app, { status, reconcile: reconcileOnce });
    },

    renderPrometheus() {
      const t = now();
      const lines = [
        "# HELP sparkdash_power_meter_up 1 while an external power meter answered its last poll for every unit on it, else 0.",
        "# TYPE sparkdash_power_meter_up gauge",
        ...[...meters.values()].map((m) => `sparkdash_power_meter_up{meter="${escapeLabel(m.id)}",type="${escapeLabel(m.type)}"} ${m.health === "ok" ? 1 : 0}`),
        "# HELP sparkdash_wall_power_watts Power measured at the wall by an external power meter. Only fresh readings are exported.",
        "# TYPE sparkdash_wall_power_watts gauge",
      ];
      for (const u of units.values()) {
        if (fresh(u, t)) lines.push(`sparkdash_wall_power_watts{unit="${escapeLabel(u.id)}",meter="${escapeLabel(u.meterId)}"} ${u.reading.watts}`);
      }
      return `${lines.join("\n")}\n`;
    },

    start() {
      if (stopped || pollTimer) return;
      logger.log?.(`[powerMeters] enabled: ${unitIds.length} unit(s) on ${meters.size} meter(s), polling every ${cfg.pollIntervalMs / 1000}s`);
      void pollOnce();
      pollTimer = timers.setInterval(() => void pollOnce(), cfg.pollIntervalMs);
      pollTimer?.unref?.();
      if (historyMeters().length) void reconcileOnce().finally(scheduleReconcile);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      lifecycle.abort();
      if (pollTimer) timers.clearInterval(pollTimer);
      if (reconcileTimer) timers.clearTimeout(reconcileTimer);
      for (const meter of meters.values()) {
        try {
          meter.provider?.close();
        } catch {
          // Closing is best-effort.
        }
      }
    },
  };
  return runtime;
}
