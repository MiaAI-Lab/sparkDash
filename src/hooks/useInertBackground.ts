import { useEffect, useLayoutEffect } from "react";

/** Elements outside the modal: the app root, which the portalled sheet/palette is not part of. */
function appRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("root");
}

/**
 * Makes the page behind an `aria-modal` overlay inert (unreachable by Tab, pointer and
 * assistive tech) while `active`.
 *
 * Call it AFTER `useFocusTrap` in the same component. The trap records the focused opener when
 * its effect runs, so inert must be applied after that; and it restores focus in its cleanup, so
 * inert must already be gone by then. Setting it in a passive effect (runs after the trap's) and
 * clearing it in a layout-effect cleanup (runs before any passive cleanup) gives both orders.
 */
export function useInertBackground(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    appRoot()?.setAttribute("inert", "");
  }, [active]);

  useLayoutEffect(
    () => () => {
      appRoot()?.removeAttribute("inert");
    },
    [active]
  );
}
