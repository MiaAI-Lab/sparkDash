import type { KeyboardEvent } from "react";

/**
 * Roving-tabindex keyboard handling (WAI-ARIA APG) for tablists and radiogroups.
 * `role` is the item role ("tab" or "radio"); arrow keys move focus (and selection, via `select`)
 * to the next enabled sibling with that role inside the closest group, wrapping around.
 */
export function rovingNext(key: string, index: number, count: number, orientation: "horizontal" | "both" = "both"): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "ArrowDown":
      return orientation === "both" ? (index + 1) % count : null;
    case "ArrowUp":
      return orientation === "both" ? (index - 1 + count) % count : null;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** onKeyDown for one item of a roving group: focuses the target and calls `select(i)` for it. */
export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>, role: "tab" | "radio", select: (index: number) => void, orientation: "horizontal" | "both" = "both"): void {
  const group = e.currentTarget.closest<HTMLElement>('[role="tablist"],[role="radiogroup"]');
  if (!group) return;
  const items = [...group.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
  const index = items.indexOf(e.currentTarget);
  const next = rovingNext(e.key, index, items.length, orientation);
  if (next == null || index < 0) return;
  e.preventDefault();
  items[next].focus();
  select(next);
}
