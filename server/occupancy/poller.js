import { loadHelpers } from "./sources.js";
import { loadHelperTokens } from "../secretsStore.js";
import { fetchHelper, helperAllowlist } from "./policy.js";
import { projectOccupancy } from "./projector.js";

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * One occupancy refresh loop for the whole dashboard. An epoch identity makes
 * a late response, a disable, or a stop unable to publish over newer state.
 * Reads never spawn a bridge; they only GET the helper's cache.
 */
export function createOccupancyPoller({
  listSparks = () => [],
  maxAgeMs = () => 12 * 60 * 60 * 1000,
  fetchImpl = fetchHelper,
  allowlist = helperAllowlist,
  intervalMs = Number(process.env.OCCUPANCY_POLL_MS || DEFAULT_INTERVAL_MS),
  now = Date.now,
} = {}) {
  let epoch = 0;
  let timer = null;
  let inflight = null;
  /** @type {Map<string, object>} */
  const caches = new Map();
  /** @type {Map<string, { coverage: string, error: string | null, observedAt: number | null }>} */
  const health = new Map();

  function enabledSnapshot() {
    return loadHelpers().filter((helper) => helper.enabled);
  }

  async function tick() {
    const ticket = epoch;
    const controller = new AbortController();
    const helpers = enabledSnapshot();
    const tokens = loadHelperTokens();
    const allowed = allowlist();
    const job = Promise.all(
      helpers.map(async (helper) => {
        try {
          const payload = await fetchImpl(helper.url, {
            token: tokens.get(helper.id) || "",
            allowlist: allowed,
            signal: controller.signal,
          });
          return { helper, payload, error: null };
        } catch (err) {
          return { helper, payload: null, error: err };
        }
      })
    );
    inflight = { ticket, controller, job };
    let results;
    try {
      results = await job;
    } finally {
      if (inflight?.ticket === ticket) inflight = null;
    }
    if (ticket !== epoch) return;
    const live = new Set(enabledSnapshot().map((helper) => helper.id));
    for (const result of results) {
      if (ticket !== epoch || !live.has(result.helper.id)) continue;
      if (result.payload) {
        caches.set(result.helper.id, result.payload);
        health.set(result.helper.id, {
          coverage: "supported",
          error: null,
          observedAt: result.payload.observedAt,
          adapters: result.payload.adapters,
        });
        continue;
      }
      const previous = caches.get(result.helper.id);
      if (previous) {
        caches.set(result.helper.id, {
          ...previous,
          stale: true,
          adapters: markStale(previous.adapters, result.error),
        });
      }
      health.set(result.helper.id, {
        coverage: previous ? "partial" : "unavailable",
        error: result.error?.message || "Helper unavailable",
        observedAt: previous?.observedAt ?? null,
        adapters: previous ? markStale(previous.adapters, result.error) : {},
      });
    }
    for (const id of [...caches.keys()]) {
      if (!live.has(id)) caches.delete(id);
    }
  }

  function bump() {
    epoch += 1;
    if (inflight) {
      try {
        inflight.controller.abort();
      } catch {
        /* already finished */
      }
    }
  }

  function start() {
    if (timer) return;
    const wait = clampInterval(intervalMs);
    timer = setInterval(() => {
      void tick();
    }, wait);
    timer.unref?.();
    void tick();
  }

  async function stop() {
    bump();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    caches.clear();
    health.clear();
  }

  function reconfigure() {
    bump();
    const live = new Set(enabledSnapshot().map((helper) => helper.id));
    for (const id of [...caches.keys()]) if (!live.has(id)) caches.delete(id);
    if (timer) void tick();
  }

  function projection() {
    return projectOccupancy({
      helpers: loadHelpers(),
      caches,
      sparks: listSparks(),
      now: now(),
      maxAgeMs: maxAgeMs(),
    });
  }

  return {
    start,
    stop,
    tick,
    reconfigure,
    projection,
    health: () => new Map(health),
    caches: () => caches,
    epoch: () => epoch,
  };
}

function markStale(adapters, error) {
  const next = {};
  for (const [id, adapter] of Object.entries(adapters || {})) {
    next[id] = {
      ...adapter,
      stale: true,
      coverage: adapter.coverage === "supported" ? "partial" : adapter.coverage,
      error: error?.message || adapter.error || "Helper refresh failed",
    };
  }
  return next;
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.min(120_000, Math.max(5_000, Math.round(n)));
}
