// Shapes bridge replies into the browser-facing records. A value the bridge did not supply (or
// supplied in an unusable form) becomes null, which the page renders as "unknown" — never 0.
import { KEY_ID_RE } from "./bridgeClient.js";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function str(v, max = 200) {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function time(v) {
  const s = str(v, 64);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}
const STATES = new Set(["active", "blocked", "expired"]);

/** One key record, or null when it has no valid hashed id. Never carries key material. */
export function normalizeKey(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id || !KEY_ID_RE.test(id)) return null;
  const blocked = typeof raw.blocked === "boolean" ? raw.blocked : null;
  let state = STATES.has(raw.state) ? raw.state : null;
  if (!state && blocked === true) state = "blocked";
  return {
    id,
    alias: str(raw.alias, 120),
    state: state ?? "unknown",
    blocked,
    spend: num(raw.spend),
    maxBudget: num(raw.maxBudget),
    budgetDuration: str(raw.budgetDuration, 16),
    budgetResetAt: time(raw.budgetResetAt),
    expires: time(raw.expires),
    createdAt: time(raw.createdAt),
    lastActive: time(raw.lastActive),
    rpmLimit: num(raw.rpmLimit),
    tpmLimit: num(raw.tpmLimit),
    maxParallelRequests: num(raw.maxParallelRequests),
    models: Array.isArray(raw.models) ? raw.models.filter((m) => typeof m === "string").slice(0, 100).map((m) => m.slice(0, 120)) : [],
  };
}

export function normalizeKeyList(json) {
  const list = json && Array.isArray(json.keys) ? json.keys : null;
  if (!list) return null;
  return list.map(normalizeKey).filter(Boolean).slice(0, 5000);
}

export function normalizeHealth(json) {
  const upstream = json && ["ok", "down"].includes(json.upstream) ? json.upstream : "unknown";
  return { bridge: "ok", upstream, bridgeVersion: str(json?.version, 32) };
}
