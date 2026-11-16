/**
 * Client for `sparkdash-agent` (agent/ in this repository): a small read-only
 * service on a Linux unit that serves its /proc, /sys and NVML readings as one
 * token-gated JSON document, so the dashboard reads that unit without opening
 * SSH sessions. See docs/NODE-AGENT.md.
 */
import { Agent, fetch as undiciFetch } from "undici";
import { assertAllowedTarget, isAllowedTargetHost, pinnedLookup } from "../validate.js";

export const NODE_AGENT_SCHEMA = "sparkdash.node-agent/1";
export const NODE_AGENT_TOKEN_ENV = "SPARKDASH_AGENT_TOKEN";
/** Domains polled on the same tick share one request. */
export const SNAPSHOT_SHARE_MS = 500;
export const FETCH_TIMEOUT_MS = 3000;

/**
 * The `agent` block of a Linux unit: `{ url }` with an HTTP(S) origin on an
 * allowed host, or null (the unit keeps SSH).
 * @param {unknown} value
 * @returns {{ url: string } | null}
 */
export function normalizeNodeAgent(value) {
  if (!value || typeof value !== "object") return null;
  const raw = String(/** @type {{ url?: unknown }} */ (value).url ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" || !isAllowedTargetHost(url.hostname.replace(/^\[|\]$/g, ""))) return null;
  return { url: url.origin };
}

/** True when this unit's metrics come from a node agent instead of SSH. */
export function usesNodeAgent(spark) {
  return Boolean(spark && spark.kind !== "mac" && spark.platform === "linux" && !spark.isLocal && spark.agent?.url);
}

function describeFetchError(err) {
  const cause = /** @type {{ code?: string, message?: string } | undefined} */ (err?.cause);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  return cause?.code || cause?.message || err?.message || String(err);
}

export class NodeAgentClient {
  /**
   * @param {{ url: string }} agent
   * @param {{ token?: string, fetchImpl?: Function, lookup?: Function, now?: () => number }} [options]
   */
  constructor(agent, { token, fetchImpl = undiciFetch, lookup, now = Date.now } = {}) {
    this.baseUrl = agent.url;
    this._token = token;
    this._fetch = fetchImpl;
    this._lookup = lookup;
    this._now = now;
    /** @type {{ at: number, data: any } | null} */
    this._cached = null;
    /** @type {Promise<any> | null} */
    this._inflight = null;
  }

  get token() {
    return this._token ?? process.env[NODE_AGENT_TOKEN_ENV] ?? "";
  }

  /** The agent's latest snapshot; rejects when the agent cannot be read. */
  snapshot() {
    if (this._cached && this._now() - this._cached.at < SNAPSHOT_SHARE_MS) return Promise.resolve(this._cached.data);
    this._inflight ??= this._document("/v1/snapshot")
      .then((data) => {
        this._cached = { at: this._now(), data };
        return data;
      })
      .finally(() => {
        this._inflight = null;
      });
    return this._inflight;
  }

  /**
   * RDMA/RoCE port state and counters. Separate from the snapshot because the
   * agent reads them from the NIC's firmware; the RoCE sampler asks every few seconds.
   */
  rdma() {
    return this._document("/v1/rdma");
  }

  async _document(path) {
    const data = await this._get(path);
    if (data?.schema !== NODE_AGENT_SCHEMA) throw new Error(`node agent ${this.baseUrl} sent an unsupported document`);
    return data;
  }

  async _get(path) {
    const token = this.token;
    if (!token) throw new Error(`${NODE_AGENT_TOKEN_ENV} is not set`);
    const host = new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, "");
    const addresses = await assertAllowedTarget(host, [host], this._lookup ? { lookup: this._lookup } : undefined);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
    try {
      let response;
      try {
        response = await this._fetch(`${this.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          dispatcher,
        });
      } catch (err) {
        throw new Error(`node agent ${this.baseUrl}: ${describeFetchError(err)}`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const hint = response.status === 401 ? ` (check ${NODE_AGENT_TOKEN_ENV})` : "";
        throw new Error(`node agent ${this.baseUrl} answered HTTP ${response.status}${hint}`);
      }
      return await response.json();
    } finally {
      await dispatcher.close();
    }
  }
}
