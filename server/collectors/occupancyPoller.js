/**
 * Dashboard occupancy poll (U5). Collect once per tick, then project onto Sparks.
 * Never throws. Does not read showcase/bench. Skip I/O when both sources are off.
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
  if (!sources?.openclaw?.enabled && !sources?.hermes?.enabled) return {};
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

async function collectSafe(collect, attach, deps) {
  try {
    const rows = await collect(attach, deps);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
