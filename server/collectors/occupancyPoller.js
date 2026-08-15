/**
 * Dashboard occupancy poll. Collect once per tick, then project onto Sparks.
 * Never throws. Skip I/O when both sources are off.
 * The process owner injects sparks/sources/tokens/apply; this module owns
 * inflight, the LLM-cadence timer, and the disable-during-poll recheck.
 */
import { collectOpenClawSessions } from "./OpenClawSessions.js";
import { collectHermesSessions } from "./HermesSessions.js";
import { projectConversations } from "./sessionProjector.js";

/**
 * @param {object} opts
 * @param {object[]} opts.sparks
 * @param {{ openclaw?: { enabled?: boolean }, hermes?: { enabled?: boolean } }} opts.sources
 * @param {{ openclaw?: string, hermes?: string }} [opts.tokens]
 * @param {Function} [opts.collectOpenClaw]
 * @param {Function} [opts.collectHermes]
 * @param {Function} [opts.project]
 * @returns {Promise<Record<string, object[]>>}
 */
export async function pollOccupancy({
  sparks,
  sources,
  tokens = {},
  collectOpenClaw = collectOpenClawSessions,
  collectHermes = collectHermesSessions,
  project = projectConversations,
} = {}) {
  if (!sourcesEnabled(sources)) return {};
  const [openclawRows, hermesRows] = await Promise.all([
    sources.openclaw?.enabled
      ? collectSafe(collectOpenClaw, sources.openclaw, { token: tokens.openclaw })
      : [],
    sources.hermes?.enabled
      ? collectSafe(collectHermes, sources.hermes, { token: tokens.hermes })
      : [],
  ]);
  try {
    return project([...openclawRows, ...hermesRows], sparks);
  } catch {
    return {};
  }
}

/**
 * @param {object} opts
 * @param {number} opts.intervalMs
 * @param {() => object[]} opts.getSparks
 * @param {() => object} opts.getSources
 * @param {() => Record<string, string>} [opts.getTokens]
 * @param {(bySpark: Record<string, object[]>) => void} opts.apply
 * @param {typeof pollOccupancy} [opts.poll]
 * @returns {{ start: () => void, stop: () => void, tick: () => Promise<void> }}
 */
export function createOccupancyLoop({
  intervalMs,
  getSparks,
  getSources,
  getTokens = () => ({}),
  apply,
  poll = pollOccupancy,
} = {}) {
  let inflight = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  async function tick() {
    const sources = getSources();
    if (!sourcesEnabled(sources)) {
      apply({});
      return;
    }
    if (inflight) return;
    inflight = true;
    try {
      const bySpark = await poll({
        sparks: getSparks(),
        sources,
        tokens: getTokens(),
      });
      if (!sourcesEnabled(getSources())) {
        apply({});
        return;
      }
      apply(bySpark);
    } catch (err) {
      console.error("[occupancy] poll error:", err.message);
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (timer != null) return;
    timer = setInterval(() => void tick(), intervalMs);
    void tick();
  }

  function stop() {
    if (timer == null) return;
    clearInterval(timer);
    timer = null;
    inflight = false;
  }

  return { start, stop, tick };
}

export function sourcesEnabled(sources) {
  return Boolean(sources?.openclaw?.enabled || sources?.hermes?.enabled);
}

async function collectSafe(collect, attach, deps) {
  try {
    const rows = await collect(attach, deps);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
