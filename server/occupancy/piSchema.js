/**
 * Shared, content-free Pi metadata schema. The Pi extension writes these
 * fields; the helper reads them and the dashboard normalizes them again.
 * Unknown fields are rejected rather than carried, so the file can never
 * become a transcript transport.
 */
export const PI_STALE_MS = 45_000;
export const PI_EXPIRE_MS = 120_000;
export const PI_GENERATION_MS = 10_000;
export const PI_MAX_FILE_BYTES = 16_384;
export const PI_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['schemaVersion', 'publisherId', 'sequence', 'sessionId', 'title', 'cwd', 'selection',
  'requestDestination', 'destinationEvidence', 'phase', 'requestOpen', 'updatedAt', 'lastDeltaAt'];
const GENERIC = ['activity', 'activityProvenance', 'origin', 'originProvenance'];
const PHASES = new Set(['requesting', 'receiving', 'tools', 'idle', 'unknown']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.length > 0)
  && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const time = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * A request destination is an absolute http(s) URL with no credentials, query
 * or fragment. The trailing slash is dropped so the same endpoint has one
 * spelling. Anything else is not a destination this dashboard can match.
 */
export function canonicalBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

/** Host and port a card would monitor for this destination. */
export function baseUrlEndpoint(value) {
  const canonical = canonicalBaseUrl(value);
  if (!canonical) return null;
  const u = new URL(canonical);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { host: u.hostname, port, protocol: u.protocol };
}

function model(v) {
  if (v === null) return null;
  if (!object(v) || Object.keys(v).length !== 3 || !['provider', 'model', 'baseUrl'].every(k => Object.hasOwn(v, k))) return undefined;
  if (!text(v.provider, 200) || !text(v.model, 200)) return undefined;
  const baseUrl = v.baseUrl === null ? null : canonicalBaseUrl(v.baseUrl);
  if (v.baseUrl !== null && !baseUrl) return undefined;
  return { provider: v.provider, model: v.model, baseUrl };
}

function normalize(raw, { now, lastSeenAt, file }) {
  try {
    if (!time(now) || !object(raw)) return null;
    const allowed = new Set([...FIELDS, ...(file ? [] : ['harness', 'lastSeenAt', ...GENERIC])]);
    if (Object.keys(raw).some(k => !allowed.has(k)) || !FIELDS.every(k => Object.hasOwn(raw, k))) return null;
    if (raw.schemaVersion !== 1 || !text(raw.publisherId, 36) || !PI_UUID.test(raw.publisherId)) return null;
    if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !text(raw.sessionId, file ? 100 : 200)) return null;
    if (!file && (raw.harness !== 'pi' || !raw.sessionId.endsWith(`:${raw.publisherId}`))) return null;
    const nativeId = file ? raw.sessionId : raw.sessionId.slice(0, -(raw.publisherId.length + 1));
    if (!text(nativeId, 100) || !text(raw.title, 200, true) || !text(raw.cwd, 500, true)) return null;
    const selection = model(raw.selection), destination = model(raw.requestDestination);
    if (selection === undefined || destination === undefined) return null;
    if (!['none', 'provider-matched'].includes(raw.destinationEvidence)) return null;
    if ((raw.destinationEvidence === 'none') !== (destination === null)) return null;
    if (destination && (!selection || destination.provider !== selection.provider || destination.model !== selection.model || destination.baseUrl !== selection.baseUrl)) return null;
    if (!PHASES.has(raw.phase) || typeof raw.requestOpen !== 'boolean') return null;
    const updated = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN;
    if (!time(updated) || new Date(updated).toISOString() !== raw.updatedAt || updated > now + 5000) return null;
    if (!time(lastSeenAt) || lastSeenAt > now + 5000) return null;
    if (raw.lastDeltaAt !== null && (!time(raw.lastDeltaAt) || raw.lastDeltaAt > now + 5000 || raw.lastDeltaAt > updated || !raw.requestOpen)) return null;
    return {
      harness: 'pi', schemaVersion: 1, publisherId: raw.publisherId, sequence: raw.sequence,
      sessionId: `${nativeId}:${raw.publisherId}`, title: raw.title, cwd: raw.cwd,
      selection, requestDestination: destination, destinationEvidence: raw.destinationEvidence,
      phase: raw.phase, requestOpen: raw.requestOpen, updatedAt: raw.updatedAt,
      lastDeltaAt: raw.lastDeltaAt, lastSeenAt,
    };
  } catch { return null; }
}

export function normalizePiFile(raw, { now = Date.now(), lastSeenAt } = {}) {
  return normalize(raw, { now, lastSeenAt, file: true });
}

export function normalizePiRow(raw, now = Date.now()) {
  return normalize(raw, { now, lastSeenAt: raw?.lastSeenAt, file: false });
}
