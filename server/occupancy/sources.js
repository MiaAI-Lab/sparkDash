import fs from "node:fs";
import { OCCUPANCY_HELPERS_JSON_PATH as CONFIGURED_HELPERS_PATH } from "../config.js";

function helpersPath() {
  return process.env.OCCUPANCY_HELPERS_JSON_PATH || CONFIGURED_HELPERS_PATH;
}
import { atomicWrite } from "../util/atomicWrite.js";
import { isValidSparkId } from "../validate.js";
import { loadHelperTokens, saveHelperTokens } from "../secretsStore.js";
import { HARNESS_IDS } from "./catalog.js";
import { parseHelperUrl } from "./policy.js";

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_HELPERS = 20;
const MAX_ROUTES = 50;

function status(code, message) {
  const err = new Error(message);
  err.status = code;
  return err;
}

export function originKey(url) {
  const parsed = parseHelperUrl(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function readFileConfig() {
  try {
    const raw = fs.readFileSync(helpersPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === "ENOENT") return { helpers: [] };
    throw status(500, "Occupancy helper config is unreadable");
  }
}

export function loadHelpers() {
  const body = readFileConfig();
  const list = Array.isArray(body.helpers) ? body.helpers : [];
  return list.map((item) => normalizeStored(item)).filter(Boolean);
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!ID_RE.test(String(raw.id || ""))) return null;
  let url = "";
  try {
    url = parseHelperUrl(raw.url).toString();
  } catch {
    return null;
  }
  return {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : "",
    url,
    enabled: raw.enabled !== false,
    harnesses: uniqueHarnesses(raw.harnesses),
    routes: normalizeRoutes(raw.routes),
  };
}

export function publicHelpers() {
  const tokens = loadHelperTokens();
  return loadHelpers().map((helper) => ({
    ...helper,
    hasToken: Boolean(tokens.get(helper.id)),
  }));
}

/**
 * Replace the helper list. A changed URL without a new token clears the old
 * bearer so it is never sent to the new host. Config write failure rolls the
 * token write back.
 */
export function replaceHelpers(input, { sparks = [] } = {}) {
  const current = loadHelpers();
  const previousTokens = new Map(loadHelperTokens());
  const next = normalizeReplacement(input, current, sparks);
  const tokens = nextTokens(current, next, previousTokens);
  let wroteTokens = false;
  try {
    if (!sameTokens(previousTokens, tokens)) {
      saveHelperTokens(tokens);
      wroteTokens = true;
    }
    atomicWrite(
      helpersPath(),
      JSON.stringify({ helpers: next.map(persistable) }, null, 2) + "\n",
      0o644
    );
  } catch (err) {
    if (wroteTokens) {
      try {
        saveHelperTokens(previousTokens);
      } catch (rollbackErr) {
        err.message = `${err.message}; token rollback failed: ${rollbackErr.message}`;
      }
    }
    throw err;
  }
  return publicHelpers();
}

export function removeHelper(id) {
  const current = loadHelpers();
  if (!current.some((helper) => helper.id === id)) throw status(404, "Helper not found");
  return replaceHelpers(
    current.filter((helper) => helper.id !== id).map((helper) => ({ ...helper })),
    { sparks: current.flatMap((helper) => helper.routes.map((route) => ({ id: route.sparkId, llmPorts: [route.port] }))) }
  );
}

function persistable(helper) {
  return {
    id: helper.id,
    label: helper.label,
    url: helper.url,
    enabled: helper.enabled,
    harnesses: helper.harnesses,
    routes: helper.routes,
  };
}

function normalizeReplacement(input, current, sparks) {
  const list = Array.isArray(input) ? input : input?.helpers;
  if (!Array.isArray(list)) throw status(400, "helpers must be a list");
  if (list.length > MAX_HELPERS) throw status(400, "Too many helpers");
  const used = new Set();
  const sparkIds = new Set((sparks || []).map((spark) => spark.id));
  const sparkPorts = new Map((sparks || []).map((spark) => [spark.id, new Set((spark.llmPorts || []).map(Number))]));
  return list.map((raw) => {
    if (!raw || typeof raw !== "object") throw status(400, "Invalid helper");
    const previous = raw.id ? current.find((item) => item.id === raw.id) : null;
    const id = assignId(raw.id || previous?.id || slug(raw.label || raw.url), used);
    used.add(id);
    const parsed = parseHelperUrl(raw.url ?? previous?.url ?? "");
    const harnesses = uniqueHarnesses(raw.harnesses ?? previous?.harnesses ?? []);
    if (harnesses.length === 0) throw status(400, "Pick at least one harness");
    const routes = normalizeRoutes(raw.routes ?? [], { strict: true, harnesses, sparkIds, sparkPorts });
    const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : previous?.label || "";
    return {
      id,
      label,
      url: parsed.toString(),
      enabled: raw.enabled !== false,
      harnesses,
      routes,
      token: Object.prototype.hasOwnProperty.call(raw, "token") ? String(raw.token ?? "") : undefined,
    };
  });
}

function assignId(raw, used) {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (ID_RE.test(id) && !used.has(id)) return id;
  const base = ID_RE.test(id) ? id : "helper";
  if (!used.has(base) && ID_RE.test(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function slug(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return text || "helper";
}

function uniqueHarnesses(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = String(item || "");
    if (!HARNESS_IDS.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function normalizeRoutes(value, ctx) {
  if (!Array.isArray(value)) {
    if (ctx?.strict) throw status(400, "routes must be a list");
    return [];
  }
  if (value.length > MAX_ROUTES) throw status(400, "Too many routes");
  const routes = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      if (ctx?.strict) throw status(400, "Invalid route");
      continue;
    }
    const harness = String(raw.harness || "");
    const sparkId = String(raw.sparkId || "");
    const port = Number(raw.port);
    if (!HARNESS_IDS.includes(harness) || !isValidSparkId(sparkId)) {
      if (ctx?.strict) throw status(400, "Invalid route target");
      continue;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      if (ctx?.strict) throw status(400, "Invalid route port");
      continue;
    }
    if (ctx?.strict) {
      if (!ctx.harnesses.includes(harness)) throw status(400, "Route harness is not enabled on this helper");
      if (ctx.sparkIds.size > 0 && !ctx.sparkIds.has(sparkId)) throw status(400, "Route Spark does not exist");
      const ports = ctx.sparkPorts.get(sparkId);
      if (ports && ports.size > 0 && !ports.has(port)) throw status(400, "Route port is not configured on that Spark");
    }
    const cwdPrefix = typeof raw.cwdPrefix === "string" ? raw.cwdPrefix.trim().slice(0, 300) : "";
    routes.push({ harness, sparkId, port, ...(cwdPrefix ? { cwdPrefix } : {}) });
  }
  return routes;
}

function nextTokens(previous, next, stored) {
  const out = new Map();
  const prevById = new Map(previous.map((helper) => [helper.id, helper]));
  for (const helper of next) {
    const prev = prevById.get(helper.id);
    const originChanged = prev ? originKey(prev.url) !== originKey(helper.url) : false;
    if (helper.token != null) {
      if (helper.token) out.set(helper.id, helper.token);
      continue;
    }
    if (originChanged) continue;
    const existing = stored.get(helper.id);
    if (existing) out.set(helper.id, existing);
  }
  return out;
}

function sameTokens(left, right) {
  if (left.size !== right.size) return false;
  for (const [id, value] of left) if (right.get(id) !== value) return false;
  return true;
}
