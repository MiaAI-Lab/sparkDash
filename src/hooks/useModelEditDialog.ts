import { useSyncExternalStore } from "react";

/**
 * Single-slot store for the model edit dialog. `null` = closed, `"new"` =
 * create, otherwise the id of the model being edited. Mounted once in App.tsx.
 */
let target: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openModelEditDialog(id: string) {
  target = id;
  emit();
}

export function openNewModelDialog() {
  target = "new";
  emit();
}

export function closeModelEditDialog() {
  target = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return target;
}

export function useModelEditDialog(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const SCRIPT_RE = /^[A-Za-z0-9._-]{1,64}\.sh$/;
export const CONTAINER_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Server-side mirror: model ids that are actually route segments. */
export const RESERVED_MODEL_IDS = new Set(["jobs", "config", "preview", "order"]);
