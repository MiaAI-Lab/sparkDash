import { useSyncExternalStore } from "react";

/**
 * Single-slot store for the per-model schedule dialog (which model's windows
 * are being edited). Mounted once in App.tsx; opened from any card's Schedule
 * button. Same pattern as useModelCommandDialog / useHermesUpdateDialog.
 */
let modelId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openModelScheduleDialog(id: string) {
  modelId = id;
  emit();
}

export function closeModelScheduleDialog() {
  modelId = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return modelId;
}

export function useModelScheduleDialog(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
