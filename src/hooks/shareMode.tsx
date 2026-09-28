import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Share-safe mode (§5.8, invariant I-8, threat T2) — capability denial for
 * screenshots. Enabled via the `?share=1` URL param or the in-memory settings
 * toggle. State is deliberately NOT persisted: a screenshot workflow must not
 * be able to leak redaction state across sessions.
 *
 * The boundary is absence from the rendered tree: real hostnames, model
 * names, IPs, paths, and storage totals never enter the DOM in share mode,
 * and destructive controls (Wake All / Shutdown All, per-node settings
 * gears) are removed, not disabled.
 *
 * Known limitation (runbook): the raw WebSocket telemetry frames still carry
 * real identifiers — redaction happens at the render layer. Share mode is a
 * screenshot-safe view, not wire-level anonymisation.
 */

interface ShareModeState {
  shareMode: boolean;
  setShareMode: (on: boolean) => void;
}

const ShareModeContext = createContext<ShareModeState>({
  shareMode: false,
  setShareMode: () => {},
});

function shareParamOn(): boolean {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search).get("share");
  return p === "1" || p === "true";
}

export function ShareModeProvider({ children }: { children: ReactNode }) {
  const [shareMode, setShareMode] = useState(shareParamOn);
  const value = useMemo(() => ({ shareMode, setShareMode }), [shareMode]);
  return <ShareModeContext.Provider value={value}>{children}</ShareModeContext.Provider>;
}

export function useShareMode(): boolean {
  return useContext(ShareModeContext).shareMode;
}

export function useSetShareMode(): (on: boolean) => void {
  return useContext(ShareModeContext).setShareMode;
}

// Session-stable alias tables, keyed by the real identifier. Module-level so
// assignment survives re-renders and is identical on overview cards, tabs,
// and the per-node page (Node A means the same host everywhere in a session).
const nodeAliases = new Map<string, string>();
let nodeCounter = 0;
const modelAliases = new Map<string, string>();
let modelCounter = 0;

/** 1 → A, 26 → Z, 27 → AA … */
function letterLabel(n: number): string {
  let s = "";
  let i = n;
  while (i > 0) {
    i -= 1;
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26);
  }
  return s;
}

/** Stable per-session alias for a spark id: "Node A", "Node B", … */
export function aliasForNode(sparkId: string): string {
  let alias = nodeAliases.get(sparkId);
  if (!alias) {
    nodeCounter += 1;
    alias = `Node ${letterLabel(nodeCounter)}`;
    nodeAliases.set(sparkId, alias);
  }
  return alias;
}

/** Stable per-session alias for a served model name: "model-a", "model-b", … */
export function aliasForModel(modelId: string | null | undefined): string {
  const key = (modelId ?? "").trim() || "unknown";
  let alias = modelAliases.get(key);
  if (!alias) {
    modelCounter += 1;
    alias = `model-${letterLabel(modelCounter).toLowerCase()}`;
    modelAliases.set(key, alias);
  }
  return alias;
}
