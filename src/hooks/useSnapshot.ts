import { useEffect, useRef, useState, useCallback } from "react";
import type { SparkSnapshot, WsSnapshot } from "../api/types";
import type { ModelsSnapshot } from "../api/modelTypes";
import { ingestSnapshots } from "./metricsStore";
import { getVisibleSparkIds, subscribeSparkVisibility } from "./sparkVisibility";
import { OVERVIEW_ID } from "../constants";

const TOKEN = (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
const RECONNECT_DELAY = 2000;

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data.
 * Returns { sparks, models, activeId, setActiveId, activeSpark, connected }.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  const [models, setModels] = useState<ModelsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastValidSnapshotAt, setLastValidSnapshotAt] = useState<number | null>(null);
  const [snapshotGeneratedAt, setSnapshotGeneratedAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(OVERVIEW_ID);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);
  /** Serialized last models block — guards against re-render churn. */
  const modelsRef = useRef<string>("");

  /** Serialized last reported visibility ids — skips redundant WS sends. */
  const lastVisibleKey = useRef<string | null>(null);

  /**
   * Report which sparks' graphs are actually in view; the server pauses
   * polling for everything else (see hooks/sparkVisibility). Sent on every
   * change and again after each (re)connect.
   */
  const sendVisibility = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const ids = getVisibleSparkIds();
    const key = [...ids].sort().join("\0");
    if (key === lastVisibleKey.current) return;
    lastVisibleKey.current = key;
    try {
      ws.send(JSON.stringify({ type: "visibility", sparks: ids }));
    } catch {
      /* socket died mid-send — reconnect re-sends via onopen */
    }
  }, []);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // A socket alone is not healthy; wait for one valid snapshot.
      setConnected(false);
      console.log("[ws] connected");
      // New socket resets server-side state to "watching everything";
      // force a fresh report of the real visible set.
      lastVisibleKey.current = null;
      sendVisibility();
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsSnapshot = JSON.parse(ev.data);
        if (msg.type === "snapshot" && Array.isArray(msg.sparks)) {
          const receivedAt = Date.now();
          // Feed the central history store (8b) before notifying React state.
          ingestSnapshots(msg.sparks, msg.generatedAt ?? receivedAt);
          setSparks(msg.sparks);
          // Keep a stable reference while the launcher block is unchanged: the
          // spark half of the payload changes every tick and would otherwise
          // re-render the model cards (and their countdown) on every snapshot.
          const nextModels = msg.models ?? null;
          const serialized = nextModels ? JSON.stringify(nextModels) : "";
          if (serialized !== modelsRef.current) {
            modelsRef.current = serialized;
            setModels(nextModels);
          }
          setConnected(true);
          setLastValidSnapshotAt(receivedAt);
          setSnapshotGeneratedAt(
            Number.isFinite(msg.generatedAt) ? Number(msg.generatedAt) : null
          );
          setRefreshInterval(
            Number.isFinite(msg.refreshInterval) ? Number(msg.refreshInterval) : null
          );
          setSnapshotError(null);
          // Default to the Overview tab; keep the current selection if it
          // is still valid (Overview is always valid).
          setActiveId((prev) => {
            if (prev === OVERVIEW_ID) return OVERVIEW_ID;
            if (prev && msg.sparks.some((s) => s.id === prev)) return prev;
            return OVERVIEW_ID;
          });
        } else {
          setSnapshotError("The server sent an invalid telemetry payload.");
        }
      } catch {
        setSnapshotError("The server sent malformed telemetry data.");
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!shouldReconnect.current) return;
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  // ─── Lifecycle ───────────────────────────────────────────
  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connect]);

  // Keep the server's poll set in sync with what is on screen. The reporter
  // no-ops while the socket is down; onopen re-sends after (re)connect.
  useEffect(() => subscribeSparkVisibility(sendVisibility), [sendVisibility]);

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;

  return {
    sparks,
    models,
    connected,
    activeId,
    setActiveId,
    activeSpark,
    lastValidSnapshotAt,
    snapshotGeneratedAt,
    snapshotError,
    refreshInterval,
  };
}
