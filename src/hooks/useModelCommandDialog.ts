import { useSyncExternalStore } from "react";
import type { ModelAction } from "../api/modelTypes";

/**
 * Single-slot store controlling the model command (transcript) dialog.
 *
 * Module-global on purpose — same reasoning as useHermesUpdateDialog: the
 * dialog can be opened from any card (Start/Stop/Restart/Logs) without
 * threading props, and it is mounted exactly once in App.tsx.
 */
export interface ModelCommandTarget {
  jobId: string;
  modelId: string;
  modelName: string;
  action: ModelAction;
  /** Extra ids stopped as part of an exclusive start (shown in the header). */
  stopping?: string[];
}

let target: ModelCommandTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openModelCommandDialog(t: ModelCommandTarget) {
  target = t;
  emit();
}

export function closeModelCommandDialog() {
  target = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ModelCommandTarget | null {
  return target;
}

export function useModelCommandDialog(): ModelCommandTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
