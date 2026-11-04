/**
 * Home Assistant as a power meter.
 *
 * Any HA power sensor can be a channel: a smart plug or strip outlet (Matter, Zigbee,
 * Wi-Fi), a PDU integration, a template sensor. Live readings come from the REST state
 * endpoint; history comes from the recorder's long-term statistics over the WebSocket
 * API (5-minute rows for the recorder's keep window, about 10 days by default, and hourly
 * rows kept indefinitely), which only exist for sensors with a `state_class`.
 *
 * Config entry: { "type": "homeassistant", "url": "https://ha.lan:8123" }
 * The long-lived access token comes only from the SPARKDASH_HA_TOKEN environment variable,
 * like SPARKDASH_MQTT_PASSWORD, and never leaves this module. A read-only HA user is enough.
 *
 * Every connection follows the dashboard's outbound policy (server/validate.js), as alert
 * channels do: the host must be an allowed target when the config loads, it is resolved with
 * assertAllowedTarget before each poll and each history session, and the connection is pinned
 * to the addresses that check approved. Responses are size-capped: a state body at 64 KiB, a
 * WebSocket message at 8 MiB.
 */
import dns from "node:dns/promises";
import WebSocket from "ws";
import { channelHost } from "../../alerts/outbound.js";
import { fetchPinned } from "../../occupancy/pinnedFetch.js";
import { assertAllowedTarget, isAllowedTargetHost, pinnedLookup } from "../../validate.js";
import { PowerMeterProvider } from "./PowerMeterProvider.js";

const ENTITY_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/** Where the long-lived access token comes from; never the config file. */
export const TOKEN_ENV = "SPARKDASH_HA_TOKEN";
const DEFAULT_TIMEOUT_MS = 8_000;
const HISTORY_TIMEOUT_MS = 60_000;
/** A state body is about 1 KB. */
const MAX_STATE_BYTES = 64 * 1024;
/** One WebSocket message; a 5-day chunk of 5-minute statistics is about 100 KB per channel. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Multipliers to watts for the power units HA uses. */
const POWER_UNITS = Object.freeze({ mW: 0.001, W: 1, kW: 1_000, MW: 1_000_000 });
/** Tolerated meter noise around zero; larger negative readings are rejected. */
const NEGATIVE_NOISE_W = 1;
const TLS_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Describe a connection failure without leaking request headers. */
function describeFetchError(error) {
  const code = error?.cause?.code || error?.code;
  if (code && TLS_CODES.has(code)) {
    return `TLS certificate not trusted (${code}); add the issuing CA with NODE_EXTRA_CA_CERTS`;
  }
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return "Home Assistant sent a message over the size cap";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  if (error?.cause?.code) return String(error.cause.code);
  // fetchPinned's own errors already say what failed ("Home Assistant request timed out", …).
  if (error?.status) return error.message;
  return code ? `${code}` : error?.message || String(error);
}

function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Turn one `/api/states/<entity>` body into a reading.
 * Exported for tests.
 */
export function parseHomeAssistantState(body) {
  const atMs = toMs(body?.last_reported) ?? toMs(body?.last_updated) ?? toMs(body?.last_changed);
  const state = body?.state;
  if (state === "unavailable" || state === "unknown" || state == null) {
    return { watts: null, atMs, error: `entity is ${state ?? "missing"}` };
  }
  const value = Number(state);
  if (typeof state !== "string" || state.trim() === "" || !Number.isFinite(value)) {
    return { watts: null, atMs, error: "state is not a number" };
  }
  const unit = body?.attributes?.unit_of_measurement;
  const factor = POWER_UNITS[unit];
  if (factor === undefined) {
    return { watts: null, atMs, error: `unit ${unit ? `"${unit}"` : "(none)"} is not a power unit` };
  }
  let watts = value * factor;
  if (watts < 0) {
    if (watts < -NEGATIVE_NOISE_W) return { watts: null, atMs, error: "negative power reading" };
    watts = 0;
  }
  return { watts, atMs };
}

/**
 * One short WebSocket session: authenticate, send each request in order, resolve with
 * their results, close. HA answers every request with a `result` frame carrying its id.
 */
function webSocketSession({ url, token, requests, timeoutMs, signal, WebSocketImpl, lookup, maxPayload }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const results = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try {
        socket?.terminate?.();
      } catch {
        // Closing is best-effort.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("request aborted"));
    const timer = setTimeout(() => finish(new Error("Home Assistant WebSocket timed out")), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      socket = new WebSocketImpl(url, { handshakeTimeout: Math.min(timeoutMs, 15_000), lookup, maxPayload });
    } catch (error) {
      return finish(new Error(describeFetchError(error)));
    }
    const sendNext = () => {
      const index = results.length;
      if (index >= requests.length) return finish(null, results);
      socket.send(JSON.stringify({ id: index + 1, ...requests[index] }));
    };
    socket.on("error", (error) => finish(new Error(describeFetchError(error))));
    socket.on("close", () => finish(new Error("Home Assistant closed the WebSocket")));
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return finish(new Error("Home Assistant sent a malformed WebSocket frame"));
      }
      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (message.type === "auth_ok") {
        sendNext();
      } else if (message.type === "auth_invalid") {
        finish(new Error("Home Assistant rejected the token"));
      } else if (message.type === "result" && message.id === results.length + 1) {
        if (!message.success) {
          return finish(new Error(message.error?.message || "Home Assistant request failed"));
        }
        results.push(message.result);
        sendNext();
      }
    });
  });
}

export class HomeAssistantProvider extends PowerMeterProvider {
  static type = "homeassistant";
  static label = "Home Assistant";
  static historyPeriods = Object.freeze(["5minute", "hour"]);

  static validate(spec) {
    const problems = [];
    let url = null;
    try {
      url = new URL(spec.url);
    } catch {
      problems.push("url must be an absolute http(s) URL");
    }
    if (url && url.protocol !== "http:" && url.protocol !== "https:") problems.push("url must use http or https");
    if (url && (url.username || url.password)) problems.push(`url must not embed credentials; set ${TOKEN_ENV}`);
    if (url && (url.protocol === "http:" || url.protocol === "https:") && !isAllowedTargetHost(channelHost(url))) {
      problems.push("url host is not allowed (the outbound policy for unit, LLM and alert targets)");
    }
    if ("token" in spec) problems.push(`token must not be stored in the file; set ${TOKEN_ENV}`);
    if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 500 || spec.timeoutMs > 60_000)) {
      problems.push("timeoutMs must be an integer from 500 to 60000");
    }
    return problems;
  }

  static validateChannel(channel) {
    return ENTITY_PATTERN.test(channel) ? null : "must be a Home Assistant entity id such as sensor.outlet_power";
  }

  // Private, so the token never shows up in JSON.stringify, util.inspect or a log line.
  #token;
  #base;
  #host;
  #wsUrl;
  #timeoutMs;
  #lookup;
  #WebSocket;
  #logger;
  #maxStateBytes;
  #maxMessageBytes;
  #warned = new Set();

  constructor(
    spec,
    {
      env = process.env,
      lookup = dns.lookup,
      WebSocketImpl = WebSocket,
      logger = console,
      maxStateBytes = MAX_STATE_BYTES,
      maxMessageBytes = MAX_MESSAGE_BYTES,
    } = {}
  ) {
    super(spec);
    const token = env[TOKEN_ENV];
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error(`environment variable ${TOKEN_ENV} is not set`);
    }
    this.#token = token.trim();
    this.#base = String(spec.url).replace(/\/+$/, "");
    this.#host = channelHost(new URL(this.#base));
    this.#wsUrl = `${this.#base.replace(/^http/, "ws")}/api/websocket`;
    this.#timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#lookup = lookup;
    this.#WebSocket = WebSocketImpl;
    this.#logger = logger;
    this.#maxStateBytes = maxStateBytes;
    this.#maxMessageBytes = maxMessageBytes;
  }

  describe() {
    return { type: HomeAssistantProvider.type, target: this.#base };
  }

  /** The meter's addresses under the outbound policy; every connection is pinned to them. */
  async #addresses() {
    try {
      return await assertAllowedTarget(this.#host, [this.#host], { lookup: this.#lookup });
    } catch (error) {
      throw new Error(
        error?.status === 403
          ? `${this.#host} resolves to an address the outbound policy does not allow`
          : `could not resolve ${this.#host}`
      );
    }
  }

  async readPower(channels, { signal } = {}) {
    const addresses = await this.#addresses();
    const readings = await Promise.all(channels.map((channel) => this.#readOne(channel, addresses, signal)));
    return new Map(channels.map((channel, index) => [channel, readings[index]]));
  }

  async readHistory(channels, { fromMs, toMs: endMs, period, signal } = {}) {
    if (!HomeAssistantProvider.historyPeriods.includes(period)) throw new Error(`unsupported history period ${period}`);
    const addresses = await this.#addresses();
    const [metadata, statistics] = await webSocketSession({
      url: this.#wsUrl,
      token: this.#token,
      timeoutMs: HISTORY_TIMEOUT_MS,
      signal,
      WebSocketImpl: this.#WebSocket,
      lookup: pinnedLookup(addresses),
      maxPayload: this.#maxMessageBytes,
      requests: [
        { type: "recorder/get_statistics_metadata", statistic_ids: channels },
        {
          type: "recorder/statistics_during_period",
          start_time: new Date(fromMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          statistic_ids: channels,
          period,
          types: ["mean", "max"],
          units: { power: "W" },
        },
      ],
    });
    const usable = new Set();
    for (const meta of Array.isArray(metadata) ? metadata : []) {
      const unit = meta?.statistics_unit_of_measurement;
      if (meta?.has_mean === false || meta?.mean_type === 0) {
        this.#warnOnce(`${meta.statistic_id}:mean`, `${meta.statistic_id} keeps no mean statistics; no history for it`);
        continue;
      }
      if (meta?.unit_class !== "power" && POWER_UNITS[unit] === undefined) {
        this.#warnOnce(`${meta.statistic_id}:unit`, `${meta.statistic_id} statistics are in "${unit}", not power; no history for it`);
        continue;
      }
      usable.add(meta.statistic_id);
    }
    const out = new Map();
    for (const channel of channels) {
      if (!usable.has(channel)) {
        this.#warnOnce(`${channel}:none`, `${channel} has no long-term statistics (does it have a state_class?); no history for it`);
        out.set(channel, []);
        continue;
      }
      const rows = Array.isArray(statistics?.[channel]) ? statistics[channel] : [];
      out.set(
        channel,
        rows
          .map((row) => ({
            startMs: toMs(row?.start),
            endMs: toMs(row?.end),
            meanW: Number.isFinite(row?.mean) ? Math.max(0, row.mean) : null,
            maxW: Number.isFinite(row?.max) ? Math.max(0, row.max) : null,
          }))
          .filter((row) => row.startMs != null && row.endMs != null && row.endMs > row.startMs && row.meanW != null)
      );
    }
    return out;
  }

  async #readOne(entityId, addresses, signal) {
    let response;
    try {
      response = await fetchPinned(new URL(`${this.#base}/api/states/${encodeURIComponent(entityId)}`), {
        addresses,
        headers: { authorization: `Bearer ${this.#token}` },
        timeoutMs: this.#timeoutMs,
        maxBytes: this.#maxStateBytes,
        signal,
        label: "Home Assistant",
        allowErrorStatus: true,
      });
    } catch (error) {
      return { watts: null, atMs: null, error: describeFetchError(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return { watts: null, atMs: null, error: `Home Assistant rejected the token (HTTP ${response.status})` };
    }
    if (response.status === 404) return { watts: null, atMs: null, error: "entity not found" };
    if (response.status < 200 || response.status >= 300) return { watts: null, atMs: null, error: `HTTP ${response.status}` };
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      return { watts: null, atMs: null, error: "response is not JSON" };
    }
    return parseHomeAssistantState(body);
  }

  #warnOnce(key, message) {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#logger.warn?.(`[powerMeters] ${message}`);
  }
}
