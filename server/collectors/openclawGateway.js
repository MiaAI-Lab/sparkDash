/**
 * OpenClaw URL attach: gateway WebSocket RPC (sessions.list + config.get).
 * Control UI HTML at GET / is not a session list. Never transcripts.
 */
import crypto from "node:crypto";
import WebSocket from "ws";
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { loadSessionSourceDevice, saveSessionSourceDevice } from "../secretsStore.js";
import { assertAllowedFetchUrl } from "./sessionIo.js";

const PROTOCOL_MIN = 3;
const PROTOCOL_MAX = 4;
const CLIENT = Object.freeze({
  id: "cli",
  version: "1.3.0",
  platform: process.platform || "linux",
  mode: "cli",
});
const SCOPES = Object.freeze(["operator.admin"]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function gatewayWsUrl(raw) {
  const parsed = assertAllowedFetchUrl(raw);
  const proto = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${parsed.host}`;
}

export function gatewayDeviceKey(url, attachId) {
  const id = typeof attachId === "string" ? attachId.trim() : "";
  if (id) return id;
  try {
    return `openclaw:${new URL(url).host}`;
  } catch {
    return "openclaw";
  }
}

/**
 * @param {string} url
 * @param {string} [token]
 * @param {{ deviceKey?: string, deviceIdentity?: object, timeoutMs?: number }} [opts]
 * @returns {Promise<{ sessions: unknown, providers: Record<string, { baseUrl?: string }> }>}
 */
export async function defaultOpenClawGatewayRpc(url, token = "", opts = {}) {
  const wsUrl = gatewayWsUrl(url);
  const deviceKey = opts.deviceKey || gatewayDeviceKey(url);
  const identity = opts.deviceIdentity ?? loadOrCreateDevice(deviceKey);
  const timeoutMs = opts.timeoutMs ?? LLM_PROBE_TIMEOUT_MS;
  return await withGateway(wsUrl, timeoutMs, identity, token);
}

function loadOrCreateDevice(id) {
  const stored = loadSessionSourceDevice(id);
  if (stored?.deviceId && stored?.publicKey && stored?.privateKeyPem) return stored;
  const created = createIdentity();
  try {
    saveSessionSourceDevice(id, created);
  } catch {
    /* still connect; pairing will not stick across restarts */
  }
  return created;
}

function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKeyRaw(publicKey);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKey: b64url(raw),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function publicKeyRaw(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function normalizeMeta(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function buildConnectParams(nonce, identity, token) {
  if (!nonce) throw new Error("gateway connect challenge missing nonce");
  const signedAt = Date.now();
  const payload = [
    "v3",
    identity.deviceId,
    CLIENT.id,
    CLIENT.mode,
    "operator",
    SCOPES.join(","),
    String(signedAt),
    token ?? "",
    nonce,
    normalizeMeta(CLIENT.platform),
    "",
  ].join("|");
  const key = crypto.createPrivateKey(identity.privateKeyPem);
  const signature = b64url(crypto.sign(null, Buffer.from(payload, "utf8"), key));
  return {
    minProtocol: PROTOCOL_MIN,
    maxProtocol: PROTOCOL_MAX,
    client: { ...CLIENT },
    role: "operator",
    scopes: [...SCOPES],
    ...(token ? { auth: { token } } : {}),
    device: {
      id: identity.deviceId,
      publicKey: identity.publicKey,
      signature,
      signedAt,
      nonce,
    },
  };
}

function providersFromConfig(payload) {
  const cfg = payload?.config ?? payload;
  const providers = cfg?.models?.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
}

function rpcError(parsed) {
  return new Error(parsed?.error?.message || "Request failed");
}

function withGateway(wsUrl, timeoutMs, identity, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
    const pending = new Map();
    let seq = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));
    }, timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    }

    function sendReq(method, params = {}) {
      const id = `r${++seq}`;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    }

    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", (code, reason) => {
      if (settled) return;
      const text = String(reason || "").trim();
      finish(new Error(text || `WebSocket closed (${code})`));
    });
    ws.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch (err) {
        finish(err);
        return;
      }
      if (parsed.type === "event" && parsed.event === "connect.challenge") {
        try {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "connect",
              method: "connect",
              params: buildConnectParams(parsed.payload?.nonce, identity, token),
            })
          );
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (parsed.type !== "res") return;
      if (parsed.id === "connect") {
        if (!parsed.ok) {
          finish(rpcError(parsed));
          return;
        }
        void (async () => {
          try {
            const listed = await sendReq("sessions.list", {});
            let config = {};
            try {
              config = await sendReq("config.get", {});
            } catch {
              config = {};
            }
            finish(null, {
              sessions: listed?.sessions ?? listed ?? [],
              providers: providersFromConfig(config),
            });
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        })();
        return;
      }
      const waiter = pending.get(parsed.id);
      if (!waiter) return;
      pending.delete(parsed.id);
      if (!parsed.ok) waiter.rej(rpcError(parsed));
      else waiter.res(parsed.payload);
    });
  });
}
