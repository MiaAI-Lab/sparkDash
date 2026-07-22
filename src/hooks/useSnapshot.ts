import { useEffect, useRef, useState, useCallback } from "react";
import type { SparkSnapshot, WsSnapshot } from "../api/types";
import { ingestSnapshots } from "./metricsStore";
import { OVERVIEW_ID } from "../constants";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
const RECONNECT_DELAY = 2000;

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data.
 * Returns { sparks, activeId, setActiveId, activeSpark, connected }.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(OVERVIEW_ID);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log("[ws] connected");
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsSnapshot = JSON.parse(ev.data);
        if (msg.type === "snapshot") {
          // Feed the central history store (8b) before notifying React state.
          ingestSnapshots(msg.sparks);
          setSparks(msg.sparks);
          // Default to the Overview tab; keep the current selection if it
          // is still valid (Overview is always valid).
          setActiveId((prev) => {
            if (prev === OVERVIEW_ID) return OVERVIEW_ID;
            if (prev && msg.sparks.some((s) => s.id === prev)) return prev;
            return OVERVIEW_ID;
          });
        }
      } catch {}
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

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;

  return {
    sparks,
    connected,
    activeId,
    setActiveId,
    activeSpark,
  };
}
