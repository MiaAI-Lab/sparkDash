import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keeps a container from collapsing while its content reloads. When `resetKey` changes (another
 * Spark, port or Remote target remounts the page body), the container holds the height it had
 * before the change until the new content has settled, so the page below does not jump.
 */
export function useStickyHeight(resetKey: string, settleMs = 700): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef(0);
  const lastKey = useRef(resetKey);

  // Track the natural height while the content is stable.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.style.minHeight === "") lastHeight.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    if (lastHeight.current > 0) el.style.minHeight = `${lastHeight.current}px`;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const id = setTimeout(() => {
      // Release the held height: ease down to the new content's height instead of snapping.
      const held = el.style.minHeight;
      el.style.minHeight = "";
      const natural = el.offsetHeight;
      lastHeight.current = natural;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!held || reduce || natural >= parseFloat(held)) return;
      el.style.minHeight = held;
      void el.offsetHeight;
      el.style.transition = "min-height 0.25s ease";
      el.style.minHeight = `${natural}px`;
      cleanup = setTimeout(() => {
        el.style.transition = "";
        el.style.minHeight = "";
      }, 300);
    }, settleMs);
    return () => {
      clearTimeout(id);
      clearTimeout(cleanup);
    };
  }, [resetKey, settleMs]);

  return ref;
}
