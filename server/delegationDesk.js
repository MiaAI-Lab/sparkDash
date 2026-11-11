/**
 * Proxy for the delegation desk (an advisory lease desk that says which
 * delegate route has room). sparkDash only relays: the desk owns routing,
 * budgets and overrides. The admin token for budget writes stays on this
 * server; the browser only learns whether edits are possible (`canEdit`).
 */
import { DELEGATION_DESK_TOKEN, DELEGATION_DESK_URL } from "./config.js";
import { readCappedBody } from "./util/readCappedBody.js";

const STATUS_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 5_000;
// Making an override permanent has the desk open a GitHub pull request first.
const PERMANENT_PR_TIMEOUT_MS = 30_000;
const CACHE_MS = 5_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REASON_CHARS = 300;
const ROUTE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The desk's base URL without a trailing slash, or null for anything but plain http(s). */
export function deskBaseUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const text = raw.trim();
  if (!text || /[?#]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const timedOut = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";

function failureReason(err, timeoutMs) {
  if (timedOut(err)) return `timed out after ${timeoutMs / 1000} s`;
  const code = err?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
  return "connection failed";
}

/** Why the desk could not be reached: never the URL or the request headers. */
function unreachable(err, timeoutMs) {
  return new DeskError(503, `Can't reach the delegation desk: ${failureReason(err, timeoutMs)}`);
}

/**
 * A write sent but not answered may still have been applied by the desk, so it is a 504
 * whose wording says so. Only a connection that never opened proves nothing changed.
 */
function unanswered(err, timeoutMs) {
  const code = err?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return unreachable(err, timeoutMs);
  return new DeskError(504, `The delegation desk did not answer (${failureReason(err, timeoutMs)}), so the change may or may not have applied`);
}

async function readJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("unreadable");
  }
  const bytes = await readCappedBody(response.body, MAX_BODY_BYTES);
  if (!bytes) throw new Error("unreadable");
  return JSON.parse(bytes.toString("utf8"));
}

export class DelegationDesk {
  constructor({
    url = DELEGATION_DESK_URL, token = DELEGATION_DESK_TOKEN, fetchImpl = globalThis.fetch,
    now = () => Date.now(), statusTimeoutMs = STATUS_TIMEOUT_MS, writeTimeoutMs = WRITE_TIMEOUT_MS,
  } = {}) {
    this.base = deskBaseUrl(url);
    this.configError = !String(url || "").trim()
      ? "The delegation desk isn't configured on this server (DELEGATION_DESK_URL is unset)"
      : this.base ? null : "DELEGATION_DESK_URL is not a plain http(s) URL";
    this.token = typeof token === "string" ? token.trim() : "";
    this.fetch = fetchImpl;
    this.now = now;
    this.statusTimeoutMs = statusTimeoutMs;
    this.writeTimeoutMs = writeTimeoutMs;
    this.cache = null;
    this.inflight = null;
    this.acknowledgedWrites = 0;
  }

  get canEdit() {
    return Boolean(this.base && this.token);
  }

  async request(method, pathname, { body, admin = false, timeoutMs }) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (admin) headers.Authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await this.fetch(`${this.base}${pathname}`, {
        method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw admin ? unanswered(err, timeoutMs) : unreachable(err, timeoutMs);
    }
    try {
      return { status: response.status, payload: await readJson(response) };
    } catch (err) {
      if (admin) throw unanswered(err, timeoutMs);
      if (timedOut(err)) throw unreachable(err, timeoutMs);
      throw new DeskError(502, `The delegation desk sent an unreadable answer (HTTP ${response.status})`);
    }
  }

  /** The desk's own error text, bounded, and with the admin token cut out should the desk ever echo it. */
  deskReason(payload) {
    if (!isObject(payload) || typeof payload.error !== "string") return "";
    const text = this.token ? payload.error.split(this.token).join("[redacted]") : payload.error;
    return text.slice(0, MAX_REASON_CHARS);
  }

  /** The desk's status JSON plus `canEdit`, cached briefly and shared by concurrent readers. */
  async status() {
    if (!this.base) throw new DeskError(503, this.configError);
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.body;
    if (!this.inflight) {
      const read = this.readStatus().finally(() => {
        if (this.inflight === read) this.inflight = null;
      });
      this.inflight = read;
    }
    return this.inflight;
  }

  async readStatus() {
    const writesBefore = this.acknowledgedWrites;
    const { status, payload } = await this.request("GET", "/v1/status", { timeoutMs: this.statusTimeoutMs });
    if (status === 503 && isObject(payload)) {
      const detail = typeof payload.roster_error === "string" ? `: ${payload.roster_error.slice(0, MAX_REASON_CHARS)}` : "";
      throw new DeskError(503, `The delegation desk can't read its roster${detail}`);
    }
    if (status !== 200 || !isObject(payload) || !Array.isArray(payload.routes)) {
      throw new DeskError(502, `The delegation desk answered HTTP ${status} without a status`);
    }
    const body = { ...payload, canEdit: this.canEdit };
    if (writesBefore === this.acknowledgedWrites) this.cache = { at: this.now(), body };
    return body;
  }

  async write(method, route, suffix, body, timeoutMs) {
    if (!this.base) throw new DeskError(503, this.configError);
    if (!this.token) throw new DeskError(503, "Budget changes not configured on this server (DELEGATION_DESK_TOKEN is unset)");
    if (typeof route !== "string" || !ROUTE_KEY.test(route)) throw new DeskError(400, "Unknown route");
    const { status, payload } = await this.request(
      method, `/v1/overrides/${encodeURIComponent(route)}${suffix}`, { body, admin: true, timeoutMs }
    );
    if (status >= 200 && status < 300 && isObject(payload)) {
      // The next read must start after this write: drop the cache and any read already in flight.
      this.cache = null;
      this.inflight = null;
      this.acknowledgedWrites += 1;
      return payload;
    }
    const reason = this.deskReason(payload);
    // Never pass a desk 401 through: the browser reads a 401 as its own dashboard token failing.
    if (status === 401 || status === 403) throw new DeskError(502, "The delegation desk refused sparkDash's admin token");
    if (status === 404) throw new DeskError(502, "This delegation desk does not accept budget overrides");
    if (status === 400 || status === 409) throw new DeskError(status, reason || `The delegation desk refused the change (HTTP ${status})`);
    if (status === 503) throw new DeskError(503, reason ? `The delegation desk: ${reason}` : "The delegation desk can't take budget changes right now");
    throw new DeskError(502, reason || `The delegation desk answered HTTP ${status}`);
  }

  setOverride(route, budget) {
    return this.write("PUT", route, "", { budget }, this.writeTimeoutMs);
  }

  removeOverride(route) {
    return this.write("DELETE", route, "", undefined, this.writeTimeoutMs);
  }

  makePermanent(route) {
    return this.write("POST", route, "/permanent", {}, PERMANENT_PR_TIMEOUT_MS);
  }
}

/**
 * GET /api/delegation-desk and the three override writes. Every route sits behind the
 * global auth middleware; writes also pass `allowChange` (the destructive-action limiter).
 * While the Overview toggle is off nothing is fetched from the desk.
 */
export function registerDelegationDeskRoutes(app, { desk, isEnabled, allowChange, rejectLimited }) {
  const fail = (res, err) => {
    const known = err instanceof DeskError;
    res.status(known ? err.status : 500).json({ error: known ? err.message : "Delegation desk request failed" });
  };
  const off = (res) => res.status(404).json({ error: "The delegation desk panel is off (Settings: Show delegation desk)" });

  app.get("/api/delegation-desk", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!isEnabled()) return off(res);
    try {
      res.json(await desk.status());
    } catch (err) {
      fail(res, err);
    }
  });

  const write = (handler) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!isEnabled()) return off(res);
    if (!allowChange(req)) return rejectLimited(res, "Too many budget changes; try again shortly");
    try {
      res.json(await handler(req));
    } catch (err) {
      fail(res, err);
    }
  };

  app.put("/api/delegation-desk/overrides/:route", write((req) => {
    const budget = req.body?.budget;
    if (!Number.isInteger(budget) || budget < 0) throw new DeskError(400, "budget must be a whole number, 0 or more");
    return desk.setOverride(req.params.route, budget);
  }));
  app.delete("/api/delegation-desk/overrides/:route", write((req) => desk.removeOverride(req.params.route)));
  app.post("/api/delegation-desk/overrides/:route/permanent", write((req) => desk.makePermanent(req.params.route)));
}
