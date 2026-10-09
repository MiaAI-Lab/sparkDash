import { flushSync } from "react-dom";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

export interface PageTransitionOptions {
  /**
   * Jump to the top of the page once the new page is in. Set for forward navigation; leave it
   * off for back/forward (popstate) so the browser keeps restoring the scroll position.
   */
  scrollTop?: boolean;
}

function scrollToTop(): void {
  try {
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") window.scrollTo(0, 0);
  } catch {
    /* environments without layout (jsdom) */
  }
}

/**
 * Run a state update inside a View Transition so the page cross-fades and slides
 * (styles in index.css). Falls back to a plain update when the browser has no View
 * Transitions, the user prefers reduced motion, or the tab is hidden.
 */
export function withPageTransition(update: () => void, options: PageTransitionOptions = {}): void {
  const { scrollTop = false } = options;
  const run = () => {
    update();
    if (scrollTop) scrollToTop();
  };
  const doc = typeof document !== "undefined" ? (document as ViewTransitionDocument) : null;
  const reduce =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc?.startViewTransition || reduce || doc.hidden) {
    run();
    return;
  }
  try {
    doc.startViewTransition(() => {
      flushSync(update);
      if (scrollTop) scrollToTop();
    });
  } catch {
    run();
  }
}
