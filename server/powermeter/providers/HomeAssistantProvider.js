/**
 * Home Assistant as a power meter.
 *
 * Any HA power sensor can be a channel: a smart plug or strip outlet (Matter, Zigbee,
 * Wi-Fi), a PDU integration, a template sensor. Live readings come from the REST state
 * endpoint; history comes from the recorder's long-term statistics over the WebSocket
 * API (5-minute rows for the recorder's keep window, about 10 days by default, and hourly
 * rows kept indefinitely), which only exist for sensors with a `state_class`.
 *
 * Config entry: { "type": "homeassistant", "url": "https://ha.lan:8123", "tokenEnv": "HOME_ASSISTANT_TOKEN" }
 * The long-lived access token is read from the named environment variable and never
 * leaves this module. A read-only HA user is enough.
 */
import WebSocket from "ws";
import { PowerMeterProvider } from "./PowerMeterProvider.js";

const ENTITY_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TOKEN_ENV = "HOME_ASSISTANT_TOKEN";
const DEFAULT_TIMEOUT_MS = 8_000;
const HISTORY_TIMEOUT_MS = 60_000;
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

/** Describe a fetch failure without leaking request headers. */
function describeFetchError(error) {
  const code = error?.cause?.code || error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  if (code && TLS_CODES.has(code)) {
    return `TLS certificate not trusted (${code}); add the issuing CA with NODE_EXTRA_CA_CERTS`;
  }
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
function webSocketSession({ url, token, requests, timeoutMs, signal, WebSocketImpl }) {
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
      socket = new WebSocketImpl(url, { handshakeTimeout: Math.min(timeoutMs, 15_000) });
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
    if (url && (url.username || url.password)) problems.push("url must not embed credentials; use tokenEnv");
    if (spec.tokenEnv !== undefined && (typeof spec.tokenEnv !== "string" || !ENV_NAME_PATTERN.test(spec.tokenEnv))) {
      problems.push("tokenEnv must be an environment variable name");
    }
    if ("token" in spec) problems.push("token must not be stored in the file; put it in an environment variable named by tokenEnv");
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
  #wsUrl;
  #timeoutMs;
  #fetch;
  #WebSocket;
  #logger;
  #warned = new Set();

  constructor(spec, { env = process.env, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, logger = console } = {}) {
    super(spec);
    const tokenEnv = spec.tokenEnv || DEFAULT_TOKEN_ENV;
    const token = env[tokenEnv];
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error(`environment variable ${tokenEnv} is not set`);
    }
    this.#token = token;
    this.#base = String(spec.url).replace(/\/+$/, "");
    this.#wsUrl = `${this.#base.replace(/^http/, "ws")}/api/websocket`;
    this.#timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocketImpl;
    this.#logger = logger;
  }

  describe() {
    return { type: HomeAssistantProvider.type, target: this.#base };
  }

  async readPower(channels, { signal } = {}) {
    const readings = await Promise.all(channels.map((channel) => this.#readOne(channel, signal)));
    return new Map(channels.map((channel, index) => [channel, readings[index]]));
  }

  async readHistory(channels, { fromMs, toMs: endMs, period, signal } = {}) {
    if (!HomeAssistantProvider.historyPeriods.includes(period)) throw new Error(`unsupported history period ${period}`);
    const [metadata, statistics] = await webSocketSession({
      url: this.#wsUrl,
      token: this.#token,
      timeoutMs: HISTORY_TIMEOUT_MS,
      signal,
      WebSocketImpl: this.#WebSocket,
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

  async #readOne(entityId, signal) {
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (signal) signals.push(signal);
    let response;
    try {
      response = await this.#fetch(`${this.#base}/api/states/${encodeURIComponent(entityId)}`, {
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      return { watts: null, atMs: null, error: describeFetchError(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return { watts: null, atMs: null, error: `Home Assistant rejected the token (HTTP ${response.status})` };
    }
    if (response.status === 404) return { watts: null, atMs: null, error: "entity not found" };
    if (!response.ok) return { watts: null, atMs: null, error: `HTTP ${response.status}` };
    let body;
    try {
      body = await response.json();
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
