/**
 * ComfyProgressSocket — optional WebSocket client to a ComfyUI server.
 *
 * Note: stock ComfyUI sends `progress` / `progress_state` / many `executing`
 * events only to the clientId that submitted the prompt. A monitor socket
 * still receives `status` broadcasts; live step progress appears when Comfy
 * broadcasts (client_id null) or when we observe messages. UI falls back to
 * time-based estimates when no live frames arrive.
 */
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { llmProbeHost } from "./llmHost.js";

const IDLE_CLOSE_MS = 45_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/**
 * Reduce a Comfy WS JSON message into progress state.
 * @param {object | null} prev
 * @param {{ type?: string, data?: object }} msg
 * @param {Record<string, string>} [nodeLabels] nodeId → class_type
 * @returns {object | null}
 */
export function reduceComfyProgressMessage(prev, msg, nodeLabels = {}) {
  if (!msg || typeof msg !== "object") return prev;
  const type = msg.type;
  const data = msg.data && typeof msg.data === "object" ? msg.data : {};

  if (type === "execution_start") {
    return {
      promptId: data.prompt_id != null ? String(data.prompt_id) : prev?.promptId ?? null,
      nodeId: null,
      nodeLabel: null,
      value: 0,
      max: 0,
      percent: null,
      updatedAt: Date.now(),
      source: "ws",
    };
  }

  if (type === "executing") {
    const nodeId = data.node != null ? String(data.node) : null;
    // node null often means execution finished for that client
    if (nodeId == null) {
      return null;
    }
    const label = nodeLabels[nodeId] || nodeId;
    return {
      promptId: data.prompt_id != null ? String(data.prompt_id) : prev?.promptId ?? null,
      nodeId,
      nodeLabel: label,
      value: prev?.value ?? 0,
      max: prev?.max ?? 0,
      percent: prev?.percent ?? null,
      updatedAt: Date.now(),
      source: "ws",
    };
  }

  if (type === "progress") {
    const value = Number(data.value);
    const max = Number(data.max);
    const nodeId =
      data.node != null
        ? String(data.node)
        : prev?.nodeId != null
          ? prev.nodeId
          : null;
    const percent =
      Number.isFinite(value) && Number.isFinite(max) && max > 0
        ? Math.min(100, Math.round((value / max) * 100))
        : null;
    return {
      promptId: data.prompt_id != null ? String(data.prompt_id) : prev?.promptId ?? null,
      nodeId,
      nodeLabel: nodeId ? nodeLabels[nodeId] || nodeId : prev?.nodeLabel ?? null,
      value: Number.isFinite(value) ? value : 0,
      max: Number.isFinite(max) ? max : 0,
      percent,
      updatedAt: Date.now(),
      source: "ws",
    };
  }

  if (type === "progress_state") {
    const nodes = data.nodes && typeof data.nodes === "object" ? data.nodes : {};
    // Prefer a running node with the highest activity
    let best = null;
    for (const [nid, st] of Object.entries(nodes)) {
      if (!st || typeof st !== "object") continue;
      const state = st.state;
      if (state !== "running" && state !== "Running") continue;
      const value = Number(st.value);
      const max = Number(st.max);
      best = {
        promptId: data.prompt_id != null ? String(data.prompt_id) : prev?.promptId ?? null,
        nodeId: String(nid),
        nodeLabel: nodeLabels[nid] || String(nid),
        value: Number.isFinite(value) ? value : 0,
        max: Number.isFinite(max) ? max : 0,
        percent:
          Number.isFinite(value) && Number.isFinite(max) && max > 0
            ? Math.min(100, Math.round((value / max) * 100))
            : null,
        updatedAt: Date.now(),
        source: "ws",
      };
      break;
    }
    return best ?? prev;
  }

  if (
    type === "execution_success" ||
    type === "execution_error" ||
    type === "execution_interrupted"
  ) {
    return null;
  }

  return prev;
}

export class ComfyProgressSocket {
  /**
   * @param {object} spark
   * @param {number} port
   */
  constructor(spark, port) {
    this.spark = spark;
    this.port = port;
    this.clientId = randomUUID();
    /** @type {import('ws').WebSocket | null} */
    this._ws = null;
    /** @type {object | null} */
    this.progress = null;
    /** @type {Record<string, string>} */
    this.nodeLabels = {};
    this._wantOpen = false;
    this._reconnectTimer = null;
    this._idleTimer = null;
    this._reconnectAttempt = 0;
    this._lastMessageAt = 0;
    this._closed = false;
  }

  setTarget(spark, port) {
    const nextPort = Number(port);
    const hostChanged =
      llmProbeHost(spark) !== llmProbeHost(this.spark) ||
      (Number.isInteger(nextPort) ? nextPort : this.port) !== this.port;
    this.spark = spark;
    if (Number.isInteger(nextPort) && nextPort >= 1 && nextPort <= 65535) {
      this.port = nextPort;
    }
    // Soft reconnect on host/port change — do not use close() (that sets
    // _closed permanently and is reserved for dispose/stop).
    if (hostChanged) {
      const want = this._wantOpen;
      this.disconnect();
      if (want && !this._closed) this.open();
    }
  }

  /** @param {Record<string, string>} labels */
  setNodeLabels(labels) {
    this.nodeLabels = labels && typeof labels === "object" ? labels : {};
  }

  getProgress() {
    return this.progress;
  }

  open() {
    if (this._closed) return;
    this._wantOpen = true;
    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this._connect();
  }

  /** Keep socket if running; schedule close when idle. */
  touchActivity(isBusy) {
    if (isBusy) {
      this.open();
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      return;
    }
    if (!this._wantOpen) return;
    if (this._idleTimer) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this._wantOpen = false;
      this._teardownWs();
    }, IDLE_CLOSE_MS);
  }

  close() {
    this._wantOpen = false;
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._teardownWs();
    this.progress = null;
  }

  /** Soft close (monitoring still on, host down). */
  disconnect() {
    this._wantOpen = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._teardownWs();
  }

  _teardownWs() {
    if (this._ws) {
      try {
        const ws = this._ws;
        this._ws = null;
        ws.removeAllListeners();
        // Swallow late errors from in-flight handshake after tests/dispose.
        ws.on("error", () => {});
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch {
        /* ignore */
      }
    }
  }

  _wsUrl() {
    const host = llmProbeHost(this.spark);
    return `ws://${host}:${this.port}/ws?clientId=${encodeURIComponent(this.clientId)}`;
  }

  _connect() {
    if (this._closed || !this._wantOpen) return;
    this._teardownWs();
    let ws;
    try {
      ws = new WebSocket(this._wsUrl(), { handshakeTimeout: 5000 });
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on("open", () => {
      this._reconnectAttempt = 0;
      this._lastMessageAt = Date.now();
    });

    ws.on("message", (raw) => {
      this._lastMessageAt = Date.now();
      let msg;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        // Binary preview frames — ignore
        if (text.length && text.charCodeAt(0) < 32 && text.charCodeAt(0) !== 9) {
          // might be binary; try parse only if looks like JSON
          if (!text.trimStart().startsWith("{")) return;
        }
        msg = JSON.parse(text);
      } catch {
        return;
      }
      this.progress = reduceComfyProgressMessage(this.progress, msg, this.nodeLabels);
    });

    ws.on("close", () => {
      this._ws = null;
      if (this._wantOpen && !this._closed) this._scheduleReconnect();
    });

    ws.on("error", () => {
      // close handler will reconnect
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  _scheduleReconnect() {
    if (!this._wantOpen || this._closed) return;
    if (this._reconnectTimer) return;
    const exp = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * Math.pow(2, this._reconnectAttempt)
    );
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, exp);
  }
}
