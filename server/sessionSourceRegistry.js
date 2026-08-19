/**
 * Session source kind registry (metadata only).
 * Collect/diagnose stay in occupancyPoller and sessionSourceHealth so this
 * module never imports OpenClawSessions or HermesSessions (ESM cycle).
 */

function trimmedEnv(value, fallback) {
  return value && String(value).trim() ? String(value).trim() : fallback;
}

const KINDS = Object.freeze([
  Object.freeze({
    id: "openclaw",
    label: "OpenClaw",
    urlPlaceholder: "http://127.0.0.1:18789",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OPENCLAW_STATE_DIR, "~/.openclaw");
    },
  }),
  Object.freeze({
    id: "hermes",
    label: "Hermes Agent",
    urlPlaceholder: "http://127.0.0.1:8787",
    usesUsername: true,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.HERMES_HOME, "~/.hermes");
    },
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    urlPlaceholder: "http://127.0.0.1:8788/occupancy",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OPENCODE_DATA_DIR, "~/.local/share/opencode");
    },
    conventionalConfigDir(env = process.env) {
      return trimmedEnv(env?.OPENCODE_CONFIG_DIR, "~/.config/opencode");
    },
  }),
  Object.freeze({
    id: "omp",
    label: "oh-my-pi",
    urlPlaceholder: "http://127.0.0.1:8789/occupancy",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OMP_STATE_DIR, "~/.omp");
    },
    conventionalConfigDir(env = process.env) {
      return trimmedEnv(env?.OMP_CONFIG_DIR, "~/.omp/agent");
    },
  }),
]);

export function sessionSourceKinds() {
  return KINDS.slice();
}

export function sessionSourceIds() {
  return KINDS.map((kind) => kind.id);
}

export function kindById(id) {
  const key = String(id ?? "");
  return KINDS.find((kind) => kind.id === key) ?? null;
}

export function conventionalStateDir(id, env = process.env) {
  const kind = kindById(id);
  return kind ? kind.conventionalStateDir(env) : "";
}

export function conventionalConfigDir(id, env = process.env) {
  const kind = kindById(id);
  if (kind && typeof kind.conventionalConfigDir === "function") {
    return kind.conventionalConfigDir(env);
  }
  return "";
}

export const SOURCE_IDS = Object.freeze(sessionSourceIds());
