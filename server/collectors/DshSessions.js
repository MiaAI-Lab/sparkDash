/**
 * DeepSeek Harness (dsh) occupancy collector.
 * URL mode only: polls a helper that wraps the dsh web JSON-RPC API.
 * Projector input rows: source, handle, midTurn, gateway, context, agent,
 * originHost, originPort. The helper reads cordis.patch.yml to map
 * provider names to LLM endpoint host:port for spark-card projection.
 * Never throws.
 */
import {
  sanitizeProjectorRow,
  defaultFetchJson,
  sanitizeProbeError,
  stampAttachRows,
  parseHelperPayload,
} from "./sessionIo.js";

const SOURCE = "dsh";
const MAX_HELPER_ROWS = 500;

const PROJECTOR_ROW_KEYS = [
  "source",
  "id",
  "handle",
  "lastUsedAt",
  "midTurn",
  "gateway",
  "contextUsed",
  "contextWindow",
  "contextApprox",
  "agent",
  "originHost",
  "originPort",
];

export function sanitizeDshRow(row) {
  return sanitizeProjectorRow(row, SOURCE, PROJECTOR_ROW_KEYS);
}

/**
 * Fetch and sanitize dsh session rows from a helper URL.
 * @returns {Promise<{ missingState: boolean, invalidHelper: boolean, found: number, rows: object[] }>}
 */
export async function loadDshOccupancy(attach, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const url = String(attach?.url || "").trim();
  if (!url) return { missingState: false, invalidHelper: false, found: 0, rows: [] };
  const payload = await fetchJson(url, { token: deps.token });
  const parsed = parseHelperPayload(payload, MAX_HELPER_ROWS);
  if (parsed.error) return { missingState: false, invalidHelper: true, found: 0, rows: [] };
  const rows = stampAttachRows(
    parsed.rows.filter((row) => row && typeof row === "object").map(sanitizeDshRow),
    attach,
  );
  return { missingState: false, invalidHelper: false, found: parsed.found, rows };
}

export async function collectDshSessions(attach, deps = {}) {
  try {
    if (!attach?.enabled) return [];
    return (await loadDshOccupancy(attach, deps)).rows;
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<{ status: "disabled" | "ok" | "error", found: number, mapped: number, error: string | null }>}
 */
export async function diagnoseDshSessions(attach, deps = {}) {
  if (!attach?.enabled) {
    return { status: "disabled", found: 0, mapped: 0, error: null };
  }
  if (attach.mode === "url" && !String(attach.url || "").trim()) {
    return { status: "error", found: 0, mapped: 0, error: "URL is required" };
  }
  try {
    const loaded = await loadDshOccupancy(attach, deps);
    if (loaded.invalidHelper) {
      return { status: "error", found: 0, mapped: 0, error: "Invalid occupancy payload" };
    }
    return {
      status: "ok",
      found: loaded.found,
      mapped: deps.countMapped?.(loaded.rows) ?? loaded.rows.length,
      error: null,
    };
  } catch (err) {
    return { status: "error", found: 0, mapped: 0, error: sanitizeProbeError(err) };
  }
}
