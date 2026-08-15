/**
 * Settings connectivity probe for OpenClaw / Hermes Agent sources.
 * Counts only. Never persists. Never returns handles, transcripts, or tokens.
 */
import { loadSessionSources, conventionalStateDir } from "../sessionSources.js";
import { loadSessionSourceTokens } from "../secretsStore.js";
import { collectOpenClawSessions, diagnoseOpenClawSessions } from "./OpenClawSessions.js";
import { collectHermesSessions, diagnoseHermesSessions } from "./HermesSessions.js";
import { projectConversations } from "./sessionProjector.js";

const SOURCE_IDS = Object.freeze(["openclaw", "hermes"]);

/**
 * @param {object} [body]
 * @param {{ getSparks?: () => object[], loadSessionSources?: Function, loadSessionSourceTokens?: Function }} [deps]
 * @returns {Promise<{ openclaw: object, hermes: object }>}
 */
export async function testSessionSources(body = {}, deps = {}) {
  const saved = (deps.loadSessionSources ?? loadSessionSources)();
  const storedTokens = (deps.loadSessionSourceTokens ?? loadSessionSourceTokens)();
  const sparks = deps.getSparks?.() ?? [];
  const patch = body && typeof body === "object" ? body : {};
  const [openclaw, hermes] = await Promise.all([
    probeOne("openclaw", saved.openclaw, storedTokens.openclaw, patch.openclaw, sparks),
    probeOne("hermes", saved.hermes, storedTokens.hermes, patch.hermes, sparks),
  ]);
  return { openclaw, hermes };
}

async function probeOne(id, saved, storedToken, patch, sparks) {
  const attach = attachForTest(saved, patch);
  const token = tokenForTest(storedToken, patch);
  const collectDeps = {
    token,
    conventionalStateDir: conventionalStateDir(id),
  };
  const diag =
    id === "openclaw"
      ? await diagnoseOpenClawSessions(attach, collectDeps)
      : await diagnoseHermesSessions(attach, collectDeps);
  if (diag.status !== "ok") return diag;
  const rows =
    id === "openclaw"
      ? await collectOpenClawSessions(attach, collectDeps)
      : await collectHermesSessions(attach, collectDeps);
  return { ...diag, mapped: countBound(rows, sparks) };
}

function countBound(rows, sparks) {
  if (!Array.isArray(sparks) || sparks.length === 0) return 0;
  const bySpark = projectConversations(Array.isArray(rows) ? rows : [], sparks);
  return Object.values(bySpark).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function attachForTest(saved, patch) {
  const src = patch && typeof patch === "object" ? patch : {};
  return {
    enabled: src.enabled !== undefined ? Boolean(src.enabled) : Boolean(saved?.enabled),
    mode: typeof src.mode === "string" ? src.mode : saved?.mode ?? "local",
    url: src.url !== undefined ? String(src.url).trim() : String(saved?.url ?? ""),
    stateDir: src.stateDir !== undefined ? String(src.stateDir).trim() : String(saved?.stateDir ?? ""),
  };
}

function tokenForTest(storedToken, patch) {
  if (patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, "token")) {
    return patch.token == null ? "" : String(patch.token);
  }
  return storedToken ?? "";
}

export { SOURCE_IDS };
