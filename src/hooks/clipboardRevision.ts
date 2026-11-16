import { useSyncExternalStore } from "react";

/** Latest shared-clipboard revision pushed over the WebSocket; null until the server announces one. */
let revision: number | null = null;
const listeners = new Set<() => void>();

export function getClipboardRevision(): number | null {
  return revision;
}

export function publishClipboardRevision(next: number): void {
  if (!Number.isFinite(next) || next === revision) return;
  revision = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeClipboardRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useClipboardRevision(): number | null {
  return useSyncExternalStore(subscribeClipboardRevision, getClipboardRevision, getClipboardRevision);
}

export function _resetClipboardRevision(): void {
  revision = null;
  listeners.clear();
}
