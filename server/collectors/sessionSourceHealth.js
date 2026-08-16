/**
 * Settings connectivity probe for OpenClaw / Hermes Agent sources.
 * Counts only. Never persists. Never returns handles, transcripts, or tokens.
 */
import { loadSessionSources, conventionalStateDir } from "../sessionSources.js";
import { loadSessionSourceTokens } from "../secretsStore.js";
import { diagnoseOpenClawSessions } from "./OpenClawSessions.js";
import { diagnoseHermesSessions } from "./HermesSessions.js";
import { parseBaseUrl } from "./sessionIo.js";
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
    probeOne("openclaw", saved.openclaw, storedTokens.openclaw, patch.openclaw, sparks, deps),
    probeOne("hermes", saved.hermes, storedTokens.hermes, patch.hermes, sparks, deps),
  ]);
  return { openclaw, hermes };
}

async function probeOne(id, saved, storedToken, patch, sparks, deps) {
  const attach = attachForTest(saved, patch);
  const token = tokenForTest(storedToken, patch, saved, attach);
  const collectDeps = {
    token,
    conventionalStateDir: conventionalStateDir(id),
    countMapped: (rows) => countBound(rows, sparks),
    listSessions: deps.listSessions,
    fetchJson: deps.fetchJson,
    fetchResponse: deps.fetchResponse,
  };
  return id === "openclaw"
    ? diagnoseOpenClawSessions(attach, collectDeps)
    : diagnoseHermesSessions(attach, collectDeps);
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

function tokenForTest(storedToken, patch, saved, attach) {
  if (patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, "token")) {
    return patch.token == null ? "" : String(patch.token);
  }
  if (!sameProbeTarget(saved, attach)) return "";
  return storedToken ?? "";
}

function sameProbeTarget(saved, attach) {
  const savedMode = saved?.mode ?? "local";
  if (attach.mode !== savedMode) return false;
  if (attach.mode === "url") return sameOrigin(saved?.url, attach.url);
  if (attach.mode === "state-dir") {
    return String(saved?.stateDir ?? "").trim() === attach.stateDir;
  }
  return true;
}

function sameOrigin(left, right) {
  const a = parseBaseUrl(String(left ?? "").trim());
  const b = parseBaseUrl(String(right ?? "").trim());
  if (!a || !b) return false;
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

export { SOURCE_IDS };
