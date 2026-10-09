import { useEffect } from "react";

interface Glide {
  el: HTMLElement;
  current: number;
  target: number;
  raf: number;
}

const EASE = 0.16; // share of the remaining distance covered per 60 Hz frame
const STEP = 1.1; // wheel pixels → scroll pixels

const canScrollY = (el: HTMLElement, dir: number): boolean => {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  return dir > 0 ? el.scrollTop < max - 1 : el.scrollTop > 1;
};

/** Nearest ancestor that scrolls vertically in `dir`, or the page itself. */
function scroller(start: EventTarget | null, dir: number): HTMLElement | null {
  let el = start instanceof Element ? start : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        if (canScrollY(el, dir)) return el;
        return null; // a pane at its end hands over to the browser's own chaining
      }
    }
    el = el.parentElement;
  }
  const root = document.scrollingElement as HTMLElement | null;
  return root && canScrollY(root, dir) ? root : null;
}

/**
 * Glides mouse-wheel scrolling instead of jumping a notch at a time. Touchpads and
 * anything that already sends small deltas are left alone, as are zoom gestures,
 * horizontal scrolling, number inputs and users who prefer reduced motion.
 */
export function useSmoothWheel(): void {
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const glides = new Map<HTMLElement, Glide>();

    const frame = (g: Glide) => {
      // Something else moved it (a keyboard scroll, auto-follow, the scrollbar): stop gliding.
      if (Math.abs(g.el.scrollTop - g.current) > 2) {
        glides.delete(g.el);
        return;
      }
      const diff = g.target - g.current;
      if (Math.abs(diff) < 0.5) {
        g.el.scrollTop = g.target;
        glides.delete(g.el);
        return;
      }
      g.current += diff * EASE;
      g.el.scrollTop = g.current;
      g.current = g.el.scrollTop; // the browser rounds / clamps
      g.raf = requestAnimationFrame(() => frame(g));
    };

    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
      // A wheel notch is a big whole step (≈100 px, or 3 lines); a touchpad sends small, varied ones.
      const notch = e.deltaMode === 1 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
      if (!notch) return;
      const t = e.target as Element | null;
      if (t?.closest?.("select, input[type=number], input[type=range]")) return;
      const el = scroller(e.target, e.deltaY);
      if (!el) return;
      e.preventDefault();
      const px = (e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY) * STEP;
      let g = glides.get(el);
      if (!g) {
        g = { el, current: el.scrollTop, target: el.scrollTop, raf: 0 };
        glides.set(el, g);
        g.raf = requestAnimationFrame(() => frame(g!));
      }
      const max = el.scrollHeight - el.clientHeight;
      g.target = Math.max(0, Math.min(max, g.target + px));
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      for (const g of glides.values()) cancelAnimationFrame(g.raf);
      glides.clear();
    };
  }, []);
}
