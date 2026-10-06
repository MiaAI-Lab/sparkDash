import { useEffect, useRef, useState, useCallback } from "react";
import type { AlertInstance, SparkSnapshot, WsSnapshot } from "../api/types";
import { ingestSnapshots } from "./metricsStore";
import { OVERVIEW_ID } from "../constants";
import { fetchAuthStatus, getToken, onTokenChange, reportAuthRequired } from "../api/authToken";

const RECONNECT_DELAY = 2000;

/** Built per connect so a token saved from the dialog is used on the next socket. */
function wsUrl(): string {
  const token = getToken();
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data.
 * Returns { sparks, activeId, setActiveId, activeSpark, connected }.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastValidSnapshotAt, setLastValidSnapshotAt] = useState<number | null>(null);
  const [snapshotGeneratedAt, setSnapshotGeneratedAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  /** Server-side firing alerts; null while the server sends none (alerts off). */
  const [serverAlerts, setServerAlerts] = useState<AlertInstance[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(OVERVIEW_ID);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);
  /** Token value whose rejection we already checked, so a refused socket asks once, not every retry. */
  const authCheckedFor = useRef<string | null>(null);

  // A browser cannot see why an upgrade was refused — it just gets a close.
  // When a socket dies before its first snapshot, ask the server whether the
  // token is the reason, and if so let the app prompt for one.
  const checkAuthAfterRefusal = useCallback(() => {
    const token = getToken();
    if (authCheckedFor.current === token) return;
    authCheckedFor.current = token;
    fetchAuthStatus(token)
      .then((status) => {
        if (!shouldReconnect.current || getToken() !== token) return;
        if (status.tokenRequired && !status.authenticated) reportAuthRequired();
      })
      .catch(() => {
        // Server unreachable (or restarting): check again on the next refusal.
        authCheckedFor.current = null;
      });
  }, []);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    let receivedSnapshot = false;

    ws.onopen = () => {
      // A socket alone is not healthy; wait for one valid snapshot.
      setConnected(false);
      console.log("[ws] connected");
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsSnapshot = JSON.parse(ev.data);
        if (msg.type === "snapshot" && Array.isArray(msg.sparks)) {
          const receivedAt = Date.now();
          // Feed the central history store (8b) before notifying React state.
          ingestSnapshots(msg.sparks, msg.generatedAt ?? receivedAt);
          setSparks(msg.sparks);
          setConnected(true);
          receivedSnapshot = true;
          authCheckedFor.current = null;
          setLastValidSnapshotAt(receivedAt);
          setSnapshotGeneratedAt(
            Number.isFinite(msg.generatedAt) ? Number(msg.generatedAt) : null
          );
          setRefreshInterval(
            Number.isFinite(msg.refreshInterval) ? Number(msg.refreshInterval) : null
          );
          setServerAlerts(Array.isArray(msg.alerts?.active) ? msg.alerts.active : null);
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
      if (!receivedSnapshot) checkAuthAfterRefusal();
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [checkAuthAfterRefusal]);

  /** Drop the current socket without scheduling the usual delayed reconnect. */
  const disposeSocket = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
    wsRef.current = null;
  }, []);

  // ─── Lifecycle ───────────────────────────────────────────
  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      disposeSocket();
    };
  }, [connect, disposeSocket]);

  // A new (or cleared) token takes effect immediately: reconnect with it.
  useEffect(
    () =>
      onTokenChange(() => {
        disposeSocket();
        connect();
      }),
    [connect, disposeSocket]
  );

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;

  return {
    sparks,
    connected,
    activeId,
    setActiveId,
    activeSpark,
    lastValidSnapshotAt,
    snapshotGeneratedAt,
    snapshotError,
    refreshInterval,
    serverAlerts,
  };
}
