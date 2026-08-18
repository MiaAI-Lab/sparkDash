/**
 * Settings connectivity probe for session sources.
 * Counts only. Never persists. Never returns handles, transcripts, or tokens.
 */
import { attachList, loadSessionSources, conventionalStateDir } from "../sessionSources.js";
import { sessionSourceIds } from "../sessionSourceRegistry.js";
import { loadSessionSourceTokens } from "../secretsStore.js";
import { occupancyDiagnosers } from "./sessionSourceAdapters.js";
import { parseBaseUrl } from "./sessionIo.js";
import { projectConversations, withOccupancyHosts, hostListenIps } from "./sessionProjector.js";

/**
 * @param {object} [body]
 * @param {{ getSparks?: () => object[], loadSessionSources?: Function, loadSessionSourceTokens?: Function, diagnoseByKind?: Record<string, Function> }} [deps]
 * @returns {Promise<Record<string, object[]>>}
 */
export async function testSessionSources(body = {}, deps = {}) {
  const saved = (deps.loadSessionSources ?? loadSessionSources)();
  const storedTokens = (deps.loadSessionSourceTokens ?? loadSessionSourceTokens)();
  const sparks = deps.getSparks?.() ?? [];
  const patch = body && typeof body === "object" ? body : {};
  const diagnoseByKind = { ...occupancyDiagnosers(), ...deps.diagnoseByKind };
  const pairs = await Promise.all(
    sessionSourceIds().map(async (kind) => {
      const rows = await probeKind(
        kind,
        saved[kind],
        storedTokens,
        patch[kind],
        sparks,
        { ...deps, diagnose: diagnoseByKind[kind] }
      );
      return [kind, rows];
    })
  );
  return Object.fromEntries(pairs);
}

function probePatches(savedList, patch) {
  if (patch === undefined) return savedList.map(() => ({}));
  const listed = attachList(patch);
  return listed.length > 0 ? listed : [{}];
}

async function probeKind(kind, savedRaw, storedTokens, patch, sparks, deps) {
  const savedList = attachList(savedRaw);
  const patches = probePatches(savedList, patch);
  const jobs = patches.map((item, index) => {
    const saved = (item.id && savedList.find((a) => a.id === item.id)) || savedList[index] || savedList[0] || {};
    const attach = attachForTest(saved, item);
    const token = tokenForTest(storedTokens[attach.id] ?? storedTokens[kind], item, saved, attach);
    const collectDeps = {
      token,
      conventionalStateDir: conventionalStateDir(kind),
      countMapped: (rows) => countBound(rows, sparks),
      listSessions: deps.listSessions,
      fetchJson: deps.fetchJson,
      fetchResponse: deps.fetchResponse,
      gatewayRpc: deps.gatewayRpc,
    };
    const diagnose = deps.diagnose;
    if (typeof diagnose !== "function") {
      return Promise.resolve({
        id: attach.id || kind,
        status: "disabled",
        found: 0,
        mapped: 0,
        error: null,
      });
    }
    return diagnose(attach, collectDeps).then((result) => ({ id: attach.id || kind, ...result }));
  });
  return Promise.all(jobs);
}

function countBound(rows, sparks) {
  if (!Array.isArray(sparks) || sparks.length === 0) return 0;
  const bySpark = projectConversations(
    Array.isArray(rows) ? rows : [],
    withOccupancyHosts(sparks, hostListenIps())
  );
  return Object.values(bySpark).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function attachForTest(saved, patch) {
  const src = patch && typeof patch === "object" ? patch : {};
  return {
    id: typeof src.id === "string" && src.id.trim() ? src.id.trim() : saved?.id,
    enabled: src.enabled !== undefined ? Boolean(src.enabled) : Boolean(saved?.enabled),
    mode: typeof src.mode === "string" ? src.mode : saved?.mode ?? "local",
    url: src.url !== undefined ? String(src.url).trim() : String(saved?.url ?? ""),
    stateDir: src.stateDir !== undefined ? String(src.stateDir).trim() : String(saved?.stateDir ?? ""),
    label: src.label !== undefined ? String(src.label).trim() : String(saved?.label ?? ""),
    username: src.username !== undefined ? String(src.username).trim() : String(saved?.username ?? ""),
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
