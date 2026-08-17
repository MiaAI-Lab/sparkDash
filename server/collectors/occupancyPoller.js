/**
 * Dashboard occupancy poll. Collect once per tick, then project onto Sparks.
 * Never throws. Skip I/O when no registry kind is enabled.
 * The process owner injects sparks/sources/tokens/apply; this module owns
 * inflight, the LLM-cadence timer, and the disable-during-poll recheck.
 */
import { attachList } from "../sessionSources.js";
import { sessionSourceIds } from "../sessionSourceRegistry.js";
import { collectOpenClawSessions } from "./OpenClawSessions.js";
import { collectHermesSessions } from "./HermesSessions.js";
import { projectConversations, withOccupancyHosts, hostListenIps } from "./sessionProjector.js";

const DEFAULT_COLLECTORS = {
  openclaw: collectOpenClawSessions,
  hermes: collectHermesSessions,
};

/**
 * @param {object} opts
 * @param {object[]} opts.sparks
 * @param {Record<string, object|object[]>} opts.sources
 * @param {Record<string, string>} [opts.tokens]
 * @param {Function} [opts.collectOpenClaw]
 * @param {Function} [opts.collectHermes]
 * @param {Record<string, Function>} [opts.collectors]
 * @param {Function} [opts.project]
 * @returns {Promise<Record<string, object[]>>}
 */
export async function pollOccupancy({
  sparks,
  sources,
  tokens = {},
  collectOpenClaw,
  collectHermes,
  collectors,
  project = projectConversations,
} = {}) {
  if (!sourcesEnabled(sources)) return {};
  const collectByKind = {
    ...DEFAULT_COLLECTORS,
    ...collectors,
  };
  if (collectOpenClaw) collectByKind.openclaw = collectOpenClaw;
  if (collectHermes) collectByKind.hermes = collectHermes;
  const batches = await Promise.all(
    sessionSourceIds().map((kind) => {
      const collect = collectByKind[kind];
      if (typeof collect !== "function") return [];
      return collectKind(collect, sources?.[kind], tokens, kind);
    })
  );
  try {
    return project(batches.flat(), withOccupancyHosts(sparks, hostListenIps()));
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
    const tokens = getTokens();
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
        tokens,
      });
      const currentSources = getSources();
      const currentTokens = getTokens();
      if (!sourcesEnabled(currentSources)) {
        apply({});
        return;
      }
      if (sourcesSnapshot(sources, tokens) !== sourcesSnapshot(currentSources, currentTokens)) {
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
  return sessionSourceIds().some((kind) =>
    attachList(sources?.[kind]).some((attach) => attach.enabled)
  );
}

function collectKind(collect, attaches, tokens, kind) {
  const jobs = attachList(attaches)
    .filter((attach) => attach.enabled)
    .map((attach) =>
      collectSafe(collect, attach, { token: tokens[attach.id] ?? tokens[kind] ?? "" })
    );
  return Promise.all(jobs).then((batches) => batches.flat());
}

function attachSnapshot(attach, token) {
  return {
    id: attach?.id ?? "",
    enabled: Boolean(attach?.enabled),
    mode: attach?.mode ?? "",
    url: attach?.url ?? "",
    stateDir: attach?.stateDir ?? "",
    label: attach?.label ?? "",
    username: attach?.username ?? "",
    token: token ?? "",
  };
}

function sourcesSnapshot(sources, tokens = {}) {
  const snapshot = {};
  for (const kind of sessionSourceIds()) {
    snapshot[kind] = attachList(sources?.[kind]).map((attach) =>
      attachSnapshot(attach, tokens[attach.id] ?? tokens[kind])
    );
  }
  return JSON.stringify(snapshot);
}

async function collectSafe(collect, attach, deps) {
  try {
    const rows = await collect(attach, deps);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
