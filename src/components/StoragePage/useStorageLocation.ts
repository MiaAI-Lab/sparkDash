import { useCallback, useEffect, useRef, useState } from "react";

export type StorageTab = "files" | "docker";

/** What the address bar says about the Storage page: which Spark, which tab and which folder. */
export interface StorageLocation {
  spark: string | null;
  tab: StorageTab | null;
  /** The folder being looked at, or null for the root of the analysis. */
  path: string | null;
}

/** `?spark=…&tab=…&path=…`, leaving out whatever is not set. */
export function buildSearch(loc: StorageLocation): string {
  const q = new URLSearchParams();
  if (loc.spark) q.set("spark", loc.spark);
  if (loc.tab) q.set("tab", loc.tab);
  if (loc.path) q.set("path", loc.path);
  const text = q.toString();
  return text ? `?${text}` : "";
}

export function parseSearch(search: string): StorageLocation {
  const q = new URLSearchParams(search);
  const tab = q.get("tab");
  const path = q.get("path");
  return {
    spark: q.get("spark") || null,
    tab: tab === "files" || tab === "docker" ? tab : null,
    path: path && path.startsWith("/") ? path : null,
  };
}

export type NavigateMode = "push" | "replace";

/**
 * The Storage page's place in the address bar. Moving into a folder, switching tab or Spark pushes a
 * history entry, so Back and Forward walk through where you have been and a copied link opens the same
 * folder. The browser's own Back/Forward is followed through `popstate`.
 */
export function useStorageLocation(): [StorageLocation, (patch: Partial<StorageLocation>, mode?: NavigateMode) => void] {
  const [loc, setLoc] = useState(() => parseSearch(window.location.search));
  const current = useRef(loc);
  current.current = loc;

  useEffect(() => {
    const onPop = () => setLoc(parseSearch(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((patch: Partial<StorageLocation>, mode: NavigateMode = "push") => {
    const next = { ...current.current, ...patch };
    const url = `${window.location.pathname}${buildSearch(next)}`;
    // Nothing changed: do not stack identical history entries.
    if (url === `${window.location.pathname}${window.location.search}`) return;
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    current.current = next;
    setLoc(next);
  }, []);

  return [loc, go];
}
