import { isIP } from "node:net";

const POLL_INTERVAL_MS = 5_000;
const SOURCE_MAX_AGE_MS = 30_000;
const RETENTION_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACTIVE = 256;
const MAX_RECENT = 24;
const MAX_DURATION_MS = 24 * 60 * 60_000;

function looksSecret(value) {
  return /^(?:sk[-_]|bearer(?:[-_ ]|$)|eyJ)/i.test(value) || /^[a-f0-9]{32,}$/i.test(value);
}

export function approvedLabels(raw) {
  const labels = String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (labels.length > MAX_ACTIVE || labels.some((value) =>
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || isIP(value) || looksSecret(value)
  )) return [];
  return [...new Set(labels)];
}

/** Server-owned IP literals only: no DNS rebinding, credentials or redirects. */
export function activityUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048 || /[\\?#]/.test(raw)) return null;
  const text = raw.trim();
  const match = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::\d+)?(?:\/.*)?$/.exec(text);
  if (!match) return null;
  const host = match[1].replace(/^\[|\]$/g, "");
  const version = isIP(host);
  const octets = version === 4 ? host.split(".").map(Number) : [];
  const privateHost = host === "::1" || (version === 4 && (
    octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  ));
  if (!privateHost) return null;
  try {
    const url = new URL(text);
    return url.username || url.password || url.port === "0" ? null : url.href;
  } catch {
    return null;
  }
}

export async function readActivity(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000), redirect: "error", headers: { Accept: "application/json" },
  });
  if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
    Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("activity-source-unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("activity-source-unavailable");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

function duration(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS;
}

function modelLabel(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/.test(value) &&
    !value.includes("://") && !value.split(/[/:]/).some((part) => looksSecret(part) || isIP(part)) ? value : "unknown";
}

/** Retain only approved display names and bounded, prompt-free summaries. */
export function parseActivity(payload, labels, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.available !== true ||
    !Array.isArray(payload.active) || !Array.isArray(payload.recent)) return null;
  const generatedMs = typeof payload.generatedAt === "string" ? Date.parse(payload.generatedAt) : NaN;
  if (!Number.isFinite(generatedMs) || nowMs - generatedMs > SOURCE_MAX_AGE_MS || generatedMs > nowMs + 10_000) return null;
  const principal = (value) => typeof value === "string" && labels.includes(value) ? value : "unknown";
  const active = [];
  const groups = new Map();
  let totalCount = 0;
  for (const entry of payload.active.slice(0, MAX_ACTIVE)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const oldestAgeMs = entry.oldestAgeMs ?? entry.oldest_age_ms;
    const newestAgeMs = entry.newestAgeMs ?? entry.newest_age_ms;
    if (!Number.isSafeInteger(entry.count) || entry.count < 1 ||
      !duration(oldestAgeMs) || !duration(newestAgeMs) || newestAgeMs > oldestAgeMs) return null;
    totalCount += entry.count;
    if (!Number.isSafeInteger(totalCount)) return null;
    const normalized = { principal: principal(entry.principal), model: modelLabel(entry.model), count: entry.count, oldestAgeMs, newestAgeMs };
    const group = JSON.stringify([normalized.principal, normalized.model]);
    const existing = groups.get(group);
    if (existing) {
      existing.count += normalized.count;
      if (!Number.isSafeInteger(existing.count)) return null;
      existing.oldestAgeMs = Math.max(existing.oldestAgeMs, oldestAgeMs);
      existing.newestAgeMs = Math.min(existing.newestAgeMs, newestAgeMs);
    } else {
      groups.set(group, normalized);
      active.push(normalized);
    }
  }
  const recent = [];
  for (const entry of payload.recent.slice(0, MAX_RECENT)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !duration(entry.ageMs) || !duration(entry.durationMs)) return null;
    if (entry.status != null && (!Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599)) return null;
    if (nowMs - generatedMs + entry.ageMs > RETENTION_MS) continue;
    recent.push({
      principal: principal(entry.principal), model: modelLabel(entry.model),
      durationMs: entry.durationMs, status: entry.status ?? null,
      observedAt: new Date(Math.max(0, generatedMs - entry.ageMs)).toISOString(),
    });
  }
  return { generatedMs, active, recent, overflowed: payload.overflowed === true || payload.active.length > MAX_ACTIVE };
}

export class InferenceActivityStore {
  constructor({ url = process.env.SPARKDASH_INFERENCE_ACTIVITY_URL, labelNames = process.env.SPARKDASH_INFERENCE_ACTIVITY_LABELS,
    read = readActivity, now = () => Date.now() } = {}) {
    this.enabled = typeof url === "string" && url.trim() !== "";
    this.url = activityUrl(url);
    this.labels = approvedLabels(labelNames);
    this.read = read;
    this.now = now;
    this.payload = null;
    this.error = this.enabled && (!this.url || !this.labels.length) ? "activity-configuration-invalid" : null;
    this.lastPollMs = -Infinity;
    this.inflight = null;
  }

  async refreshIfDue() {
    if (!this.enabled || !this.url || !this.labels.length) return;
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastPollMs < POLL_INTERVAL_MS) return;
    this.lastPollMs = this.now();
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refresh() {
    try {
      this.payload = parseActivity(await this.read(this.url), this.labels, this.now());
      this.error = this.payload ? null : "activity-source-unavailable";
    } catch {
      this.payload = null;
      this.error = "activity-source-unavailable";
    }
  }

  snapshot() {
    const nowMs = this.now();
    const available = this.enabled && this.payload != null && nowMs - this.payload.generatedMs <= SOURCE_MAX_AGE_MS &&
      this.payload.generatedMs <= nowMs + 10_000;
    return {
      enabled: this.enabled, available, labels: this.labels,
      generatedAt: available ? new Date(this.payload.generatedMs).toISOString() : null,
      error: this.enabled ? this.error ?? (available ? null : "activity-source-unavailable") : null,
      active: available ? this.payload.active.map((entry) => ({
        ...entry, oldestAgeMs: entry.oldestAgeMs + Math.max(0, nowMs - this.payload.generatedMs),
        newestAgeMs: entry.newestAgeMs + Math.max(0, nowMs - this.payload.generatedMs),
      })) : [],
      recent: available ? this.payload.recent.filter((entry) => nowMs - Date.parse(entry.observedAt) <= RETENTION_MS) : [],
      overflowed: available && this.payload.overflowed,
    };
  }
}
