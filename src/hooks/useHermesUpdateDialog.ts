import { useSyncExternalStore } from "react";

/**
 * Single-slot store controlling the Hermes update confirmation dialog.
 * Module-global on purpose: the dialog can be opened from anywhere (Spark
 * header button, update-alert toast action) without threading props.
 */

export interface HermesUpdateTarget {
  sparkId: string;
  sparkName: string;
  /** Currently installed hermes version when known (display context only). */
  currentVersion: string | null;
}

let target: HermesUpdateTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openHermesUpdateDialog(t: HermesUpdateTarget) {
  target = t;
  emit();
}

export function closeHermesUpdateDialog() {
  target = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): HermesUpdateTarget | null {
  return target;
}

/** Subscribe a component to the dialog target (null when closed). */
export function useHermesUpdateDialog(): HermesUpdateTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
