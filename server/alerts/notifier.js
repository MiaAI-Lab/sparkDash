/**
 * Notification channels: ntfy, Discord, Slack and a generic JSON webhook.
 *
 * Everything that fires or resolves in one evaluation goes out as ONE message
 * per channel (Alertmanager-style grouping), filtered by the channel's minimum
 * severity. Sending never throws, and is deliberately narrow:
 *
 *   - the channel's host is resolved and checked against the outbound policy on
 *     every send, and the connection is pinned to the checked addresses
 *     (outbound.js);
 *   - redirects are never followed: any 3xx is a failed send;
 *   - a response body is never read. A failure is recorded as a status code or
 *     a fixed reason, so nothing a remote server says reaches the API, the
 *     channel status, the log or the Activity events.
 *
 * Failures are kept per channel (shown in the Alerts dialog), logged at most
 * once per channel every few minutes, and every send — delivered or not — is
 * reported to `onResult` for the Activity log.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { severityRank } from "./conditions.js";
import { OutboundPolicyError, pinnedLookup, resolveChannelTarget } from "./outbound.js";
import { capText } from "./text.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 5 * 60_000;
/** Discord rejects more than 10 embeds per message. */
const DISCORD_MAX_EMBEDS = 10;
/** Lines per message; the rest is summarised as "+N more". */
const MAX_LINES = 20;
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

/**
 * Slack mrkdwn control characters. `<…>` is how Slack spells links and mentions (`<!channel>`,
 * `<!here>`, `<@U123>`, `<https://x|text>`), so unit names and remote error text must not be
 * able to produce one; Slack asks for exactly these three to be escaped.
 */
export function slackEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    const tag = firing.length ? (group.reminder ? "Still firing" : a.severity.toUpperCase()) : "RESOLVED";
    title = `[${tag}] ${a.unitName}: ${a.label || a.ruleName}`;
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
  if (lines.length > MAX_LINES) lines.splice(MAX_LINES, lines.length - MAX_LINES, `+${lines.length - MAX_LINES} more`);
  if (group.test) lines.push("If you can read this, the channel works. Sent from the sparkDash Alerts dialog.");
  return { tone, title: capText(title, 200), lines, firing, resolved };
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
    label: a.label,
    summary: a.summary,
    startsAt: iso(a.startsAt),
    endsAt: status === "resolved" ? iso(a.endsAt) : null,
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
            title: capText(`${status === "resolved" ? "Resolved" : a.severity === "critical" ? "Critical" : "Warning"} · ${a.unitName}: ${a.label || a.ruleName}`, 256),
            description: capText(a.summary, 4000),
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
            content: capText(`${d.title}${more}`, 2000),
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
          body: JSON.stringify({
            text: [`*${slackEscape(d.title)}*`, ...d.lines.map((l) => `• ${slackEscape(l)}`)].join("\n"),
          }),
        },
      };
    case "webhook":
    default: {
      const alerts = [
        ...d.firing.map((a) => alertJson(a, "firing")),
        ...d.resolved.map((a) => alertJson(a, "resolved")),
      ];
      const status = group.test ? "test" : d.firing.length ? "firing" : "resolved";
      const severity = d.firing.length ? (d.firing.some((a) => a.severity === "critical") ? "critical" : "warning") : null;
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

/**
 * Why a send failed, as fixed text: a status code, a timeout, a socket error
 * code or a policy refusal. Never the error's own message, which can carry a
 * URL or what the server answered.
 */
function failureReason(err, timeoutMs) {
  if (err instanceof SendFailure || err instanceof OutboundPolicyError) return err.message;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return `connection failed (${code})`;
  return "request failed";
}

class SendFailure extends Error {}

export class Notifier {
  /**
   * @param {{
   *   fetchImpl?: (url: string, init: object) => Promise<Response>,
   *   lookup?: Function,
   *   timeoutMs?: number,
   *   now?: () => number,
   *   log?: Pick<Console, "warn">,
   *   logIntervalMs?: number,
   *   onResult?: (result: { channel: object, group: object, ok: boolean, status?: number, reason?: string }) => void,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._fetch = opts.fetchImpl || undiciFetch;
    this._lookup = opts.lookup;
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._now = opts.now || Date.now;
    this._log = opts.log || console;
    this._logIntervalMs = opts.logIntervalMs ?? LOG_INTERVAL_MS;
    this._onResult = opts.onResult || null;
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

  _report(result) {
    if (!this._onResult) return;
    try {
      this._onResult(result);
    } catch {
      /* a sink error never reaches the sender */
    }
  }

  /**
   * Send one group to one channel. Resolves `{ ok, status?, error? }`; never rejects.
   * `error` is always one of the fixed reasons above.
   */
  async send(channel, group) {
    const status = this._status(channel.id);
    let agent = null;
    try {
      if (!channel.url) throw new SendFailure("no URL stored for this channel");
      const { url, init } = buildRequest(channel, group, this._now());
      const target = new URL(url);
      const addresses = await resolveChannelTarget(target, this._lookup ? { lookup: this._lookup } : undefined);
      agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
      const res = await this._fetch(url, {
        ...init,
        redirect: "manual",
        dispatcher: agent,
        signal: AbortSignal.timeout(this._timeoutMs),
      });
      // Never read what the server answered; just release the connection.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new SendFailure(`redirect not followed (HTTP ${res.status || "3xx"})`);
      }
      if (!res.ok) throw new SendFailure(`HTTP ${res.status}`);
      status.lastSentAt = this._now();
      status.lastError = null;
      this._report({ channel, group, ok: true, status: res.status });
      return { ok: true, status: res.status };
    } catch (err) {
      const reason = failureReason(err, this._timeoutMs);
      status.lastError = reason;
      status.lastErrorAt = this._now();
      this._logFailure(channel, reason);
      this._report({ channel, group, ok: false, reason });
      return { ok: false, error: reason };
    } finally {
      if (agent) agent.destroy().catch(() => {});
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
