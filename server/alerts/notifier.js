/**
 * Notification channels: ntfy, Discord, Slack and a generic JSON webhook.
 *
 * Everything that fires or resolves in one evaluation goes out as ONE message
 * per channel (Alertmanager-style grouping), filtered by the channel's minimum
 * severity. Sending never throws: failures are recorded per channel (shown in
 * the Alerts dialog) and logged at most once per channel every few minutes, so
 * a dead webhook cannot flood the log or reach the poll loop.
 */
import { severityRank } from "./rules.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 5 * 60_000;
/** Discord rejects more than 10 embeds per message. */
const DISCORD_MAX_EMBEDS = 10;
const DISCORD_COLORS = { critical: 0xdc2626, warning: 0xf59e0b, resolved: 0x16a34a, test: 0x6366f1 };
const NTFY_PRIORITY = { critical: "5", warning: "4", resolved: "3", test: "3" };
const NTFY_TAGS = { critical: "rotating_light", warning: "warning", resolved: "white_check_mark", test: "test_tube" };

/** "3m", "2h 5m", "1d 4h". */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * One group's messages, independent of the channel format.
 * @param {{ firing: object[], resolved: object[], reminder?: boolean, test?: boolean }} group
 */
export function describeGroup(group, now = Date.now()) {
  const firing = group.firing || [];
  const resolved = group.resolved || [];
  const tone = group.test
    ? "test"
    : firing.some((a) => a.severity === "critical")
      ? "critical"
      : firing.length > 0
        ? "warning"
        : "resolved";
  let title;
  if (group.test) {
    title = "sparkDash test notification";
  } else if (firing.length + resolved.length === 1) {
    const a = firing[0] || resolved[0];
    const label = firing.length ? (group.reminder ? "Still firing" : a.severity.toUpperCase()) : "RESOLVED";
    title = `[${label}] ${a.unitName}: ${a.ruleName}`;
  } else {
    const parts = [];
    if (firing.length) parts.push(`${firing.length} ${group.reminder ? "still firing" : "firing"}`);
    if (resolved.length) parts.push(`${resolved.length} resolved`);
    title = `sparkDash: ${parts.join(", ")}`;
  }
  const lines = [];
  for (const a of firing) {
    lines.push(`${a.severity.toUpperCase()} ${a.unitName} · ${a.ruleName}: ${a.summary} (for ${formatAge(now - a.startsAt)})`);
  }
  for (const a of resolved) {
    lines.push(`RESOLVED ${a.unitName} · ${a.ruleName}: ${a.summary} (lasted ${formatAge((a.endsAt ?? now) - a.startsAt)})`);
  }
  if (group.test) lines.push("If you can read this, the channel works. Sent from the sparkDash Alerts dialog.");
  return { tone, title, lines, firing, resolved };
}

/** ntfy reads RFC 2047 encoded-words in headers; fetch refuses non-Latin-1 header values. */
function headerSafe(value) {
  const s = String(value).replace(/[\r\n]+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function alertJson(a, status) {
  return {
    status,
    severity: a.severity,
    rule: a.ruleId,
    ruleName: a.ruleName,
    unit: a.unitName,
    unitId: a.unitId,
    summary: a.summary,
    startsAt: iso(a.startsAt),
    endsAt: status === "resolved" ? iso(a.endsAt) : null,
    value: a.value ?? null,
  };
}

/**
 * Build the HTTP request for one channel. Pure — tests assert on this.
 * @returns {{ url: string, init: { method: string, headers: Record<string,string>, body: string } }}
 */
export function buildRequest(channel, group, now = Date.now()) {
  const d = describeGroup(group, now);
  switch (channel.type) {
    case "ntfy":
      return {
        url: channel.url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Title: headerSafe(d.title),
            Priority: NTFY_PRIORITY[d.tone],
            Tags: NTFY_TAGS[d.tone],
          },
          body: d.lines.join("\n"),
        },
      };
    case "discord": {
      const items = [
        ...d.firing.map((a) => ({ a, status: "firing" })),
        ...d.resolved.map((a) => ({ a, status: "resolved" })),
      ];
      const embeds = group.test
        ? [{ title: d.title, description: d.lines.join("\n"), color: DISCORD_COLORS.test }]
        : items.slice(0, DISCORD_MAX_EMBEDS).map(({ a, status }) => ({
            title: `${status === "resolved" ? "Resolved" : a.severity === "critical" ? "Critical" : "Warning"} · ${a.unitName}: ${a.ruleName}`.slice(0, 256),
            description: a.summary.slice(0, 4000),
            color: status === "resolved" ? DISCORD_COLORS.resolved : DISCORD_COLORS[a.severity] ?? DISCORD_COLORS.warning,
            timestamp: iso(status === "resolved" ? a.endsAt : a.startsAt) ?? undefined,
          }));
      const more = items.length > DISCORD_MAX_EMBEDS ? ` (+${items.length - DISCORD_MAX_EMBEDS} more)` : "";
      return {
        url: channel.url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "sparkDash",
            content: `${d.title}${more}`.slice(0, 2000),
            embeds,
            // Unit names are user text: never let one ping @everyone.
            allowed_mentions: { parse: [] },
          }),
        },
      };
    }
    case "slack":
      return {
        url: channel.url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: [`*${d.title}*`, ...d.lines.map((l) => `• ${l}`)].join("\n") }),
        },
      };
    case "webhook":
    default: {
      const alerts = [
        ...d.firing.map((a) => alertJson(a, "firing")),
        ...d.resolved.map((a) => alertJson(a, "resolved")),
      ];
      const status = group.test ? "test" : d.firing.length ? "firing" : "resolved";
      const severity = d.firing.length
        ? d.firing.some((a) => a.severity === "critical") ? "critical" : "warning"
        : null;
      return {
        url: channel.url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "sparkDash",
            status,
            severity,
            title: d.title,
            reminder: Boolean(group.reminder),
            sentAt: iso(now),
            alerts,
          }),
        },
      };
    }
  }
}

/** The subset of a group this channel wants, or null when nothing is left. */
export function filterGroupForChannel(channel, group) {
  if (group.test) return group;
  const min = severityRank(channel.minSeverity);
  const firing = (group.firing || []).filter((a) => severityRank(a.severity) >= min);
  // A resolved alert goes wherever its firing went: judge by its peak.
  const resolved = (group.resolved || []).filter((a) => severityRank(a.peakSeverity || a.severity) >= min);
  if (firing.length === 0 && resolved.length === 0) return null;
  return { ...group, firing, resolved };
}

export class Notifier {
  /**
   * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number, log?: Pick<Console, "warn">, logIntervalMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this._fetch = opts.fetchImpl || ((...args) => globalThis.fetch(...args));
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._now = opts.now || Date.now;
    this._log = opts.log || console;
    this._logIntervalMs = opts.logIntervalMs ?? LOG_INTERVAL_MS;
    /** @type {Map<string, { lastSentAt: number|null, lastError: string|null, lastErrorAt: number|null }>} */
    this.status = new Map();
    /** @type {Map<string, { at: number, suppressed: number }>} */
    this._lastLog = new Map();
  }

  _status(id) {
    let s = this.status.get(id);
    if (!s) {
      s = { lastSentAt: null, lastError: null, lastErrorAt: null };
      this.status.set(id, s);
    }
    return s;
  }

  _logFailure(channel, message) {
    const now = this._now();
    const prev = this._lastLog.get(channel.id);
    if (prev && now - prev.at < this._logIntervalMs) {
      prev.suppressed += 1;
      return;
    }
    const extra = prev?.suppressed ? ` (${prev.suppressed} more failures since the last report)` : "";
    try {
      this._log.warn(`[alerts] channel "${channel.name}" (${channel.type}) failed: ${message}${extra}`);
    } catch {
      /* logging must never throw into the caller */
    }
    this._lastLog.set(channel.id, { at: now, suppressed: 0 });
  }

  /**
   * Send one group to one channel. Resolves `{ ok, status?, error? }`; never rejects.
   */
  async send(channel, group) {
    const status = this._status(channel.id);
    try {
      const { url, init } = buildRequest(channel, group, this._now());
      const res = await this._fetch(url, { ...init, signal: AbortSignal.timeout(this._timeoutMs) });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 200).trim();
        } catch {
          /* body unreadable */
        }
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      // Drain the body so the connection can be reused.
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      status.lastSentAt = this._now();
      status.lastError = null;
      return { ok: true, status: res.status };
    } catch (err) {
      const message =
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `timed out after ${Math.round(this._timeoutMs / 1000)}s`
          : err?.cause?.code
            ? `${err.message} (${err.cause.code})`
            : err?.message || String(err);
      status.lastError = message;
      status.lastErrorAt = this._now();
      this._logFailure(channel, message);
      return { ok: false, error: message };
    }
  }

  /**
   * Fan one evaluation's group out to every enabled channel that wants it.
   * Returns the settled sends (tests await it; the engine does not).
   */
  dispatch(channels, group) {
    const sends = [];
    for (const channel of channels || []) {
      if (!channel?.enabled) continue;
      const subset = filterGroupForChannel(channel, group);
      if (subset) sends.push(this.send(channel, subset).then((r) => ({ channelId: channel.id, ...r })));
    }
    return Promise.all(sends);
  }
}
