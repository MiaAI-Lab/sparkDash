import { flushSync } from "react-dom";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

/**
 * Run a state update inside a View Transition so the page cross-fades and slides
 * (styles in index.css). Falls back to a plain update when the browser has no View
 * Transitions, the user prefers reduced motion, or the tab is hidden.
 */
export function withPageTransition(update: () => void): void {
  const doc = typeof document !== "undefined" ? (document as ViewTransitionDocument) : null;
  const reduce =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc?.startViewTransition || reduce || doc.hidden) {
    update();
    return;
  }
  try {
    doc.startViewTransition(() => {
      flushSync(update);
    });
  } catch {
    update();
  }
}
