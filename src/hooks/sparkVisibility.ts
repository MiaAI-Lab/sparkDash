import { useCallback, useEffect, useRef } from "react";

/**
 * sparkVisibility — viewport-driven polling.
 *
 * Tracks which sparks' graphs the user can ACTUALLY see:
 *  - overview cards via a shared IntersectionObserver (useSparkGraphRef), and
 *  - a mounted SparkPage via a refcounted pin (useSparkPinned — every panel
 *    on that page renders this spark's data).
 * The visible id set is reported over the WS by useSnapshot; the server then
 * pauses SparkMonitor polling for any spark no client can see, so machines
 * scrolled out of view take zero SSH / probe load. A hidden browser tab
 * reports an empty set (visibilitychange) — nothing is rendered anyway.
 */

type Cleanup = () => void;

const listeners = new Set<() => void>();
/** Observed elements: element -> { spark id, last reported intersecting state }. */
const elements = new Map<Element, { id: string; visible: boolean }>();
/** spark id -> number of currently-intersecting observed elements. */
const visibleCounts = new Map<string, number>();
/** mount pins (SparkPage): spark id -> refcount. */
const pins = new Map<string, number>();

let documentVisible = typeof document === "undefined" ? true : !document.hidden;

let cachedIds: string[] | null = null;

function notify() {
  cachedIds = null;
  for (const l of listeners) l();
}

let sharedObserver: IntersectionObserver | null = null;
function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const rec = elements.get(entry.target);
          if (!rec || rec.visible === entry.isIntersecting) continue;
          rec.visible = entry.isIntersecting;
          const n = visibleCounts.get(rec.id) ?? 0;
          const next = entry.isIntersecting ? n + 1 : Math.max(0, n - 1);
          if (next > 0) visibleCounts.set(rec.id, next);
          else visibleCounts.delete(rec.id);
          changed = true;
        }
        if (changed) notify();
      },
      // Pre-resume slightly before the card scrolls in so the first samples
      // are already arriving as it becomes visible.
      { rootMargin: "200px 0px" }
    );
  }
  return sharedObserver;
}

/** Observe one graph host element for a spark; returns the detach cleanup. */
export function watchSparkGraph(id: string, el: Element): Cleanup {
  const rec = { id, visible: false };
  elements.set(el, rec);
  getObserver()?.observe(el);
  return () => {
    elements.delete(el);
    getObserver()?.unobserve(el);
    if (rec.visible) {
      const n = (visibleCounts.get(id) ?? 1) - 1;
      if (n > 0) visibleCounts.set(id, n);
      else visibleCounts.delete(id);
      notify();
    }
  };
}

/** Keep a spark polling for as long as the pin is held. */
export function pinSpark(id: string): Cleanup {
  pins.set(id, (pins.get(id) ?? 0) + 1);
  notify();
  let released = false;
  return () => {
    if (released) return; // effects can double-invoke; unpin once
    released = true;
    const n = (pins.get(id) ?? 1) - 1;
    if (n > 0) pins.set(id, n);
    else pins.delete(id);
    notify();
  };
}

/** Spark ids any mounted consumer currently sees; [] when the tab is hidden. */
export function getVisibleSparkIds(): string[] {
  if (cachedIds) return cachedIds;
  if (!documentVisible) {
    cachedIds = [];
    return cachedIds;
  }
  const ids = new Set<string>(visibleCounts.keys());
  for (const [id, n] of pins) if (n > 0) ids.add(id);
  cachedIds = [...ids];
  return cachedIds;
}

export function subscribeSparkVisibility(cb: () => void): Cleanup {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Ref callback attaching a graph host element to the shared observer. */
export function useSparkGraphRef(id: string): (el: HTMLElement | null) => void {
  const cleanupRef = useRef<Cleanup | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = el ? watchSparkGraph(id, el) : null;
  }, [id]);
  // Detach on unmount even when React skips the null-ref call (tree removal
  // in the same commit as the hook's own unmount).
  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    []
  );
  return ref;
}

/** Pin a spark as visible for the lifetime of this component (SparkPage). */
export function useSparkPinned(id: string) {
  useEffect(() => pinSpark(id), [id]);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    documentVisible = !document.hidden;
    notify();
  });
}
