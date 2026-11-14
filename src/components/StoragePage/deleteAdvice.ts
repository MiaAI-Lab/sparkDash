import type { StorageAdvice, StorageAdviceItem, StorageAdviceLevel } from "../../api/types";

/**
 * The delete dialogs' check (the delete advisor) as the page sees it: pure functions, so the single and bulk dialogs
 * agree on what each level asks of the person, and so it can be tested without a browser.
 *
 * Friction grows with the level and never goes below today's: "low" adds nothing, "review" a tick, "high" a typed
 * phrase. While the check runs, deleting waits (or the person chooses not to wait). A check that failed, timed out or
 * was skipped counts as "review": it never reads as "nothing found".
 */

/** How long a dialog waits for the check before giving up on it (the server gives the Spark 45 s, connecting included). */
export const ADVICE_TIMEOUT_MS = 50_000;

export type AdviceState =
  | { status: "loading" }
  | { status: "ready"; advice: StorageAdvice }
  | { status: "failed"; message: string }
  | { status: "skipped" };

/** What deleting asks for on top of the dialog's own confirmation. "wait": nothing yet, the check is running. */
export type Friction = "wait" | "none" | "tick" | "typed";

/** The phrase typed to delete when the check found something serious. */
export const ADVICE_CONFIRM_PHRASE = "delete anyway";

export const LEVEL_LABEL: Record<StorageAdviceLevel, string> = { low: "Low", review: "Review", high: "High" };

/** The level that decides the friction: the check's own, "review" when it could not be had, null while it runs. */
export function effectiveLevel(state: AdviceState): StorageAdviceLevel | null {
  if (state.status === "loading") return null;
  if (state.status === "ready") return state.advice.level;
  return "review";
}

export function frictionOf(state: AdviceState): Friction {
  const level = effectiveLevel(state);
  return level == null ? "wait" : level === "low" ? "none" : level === "review" ? "tick" : "typed";
}

/** Trimmed and in any letter case (phone keyboards capitalise the first letter); nothing else is relaxed. */
export function adviceConfirmMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === ADVICE_CONFIRM_PHRASE;
}

/** Whether the check lets the delete go ahead with what the person has ticked or typed. */
export function adviceSatisfied(state: AdviceState, ticked: boolean, typed: string): boolean {
  const f = frictionOf(state);
  return f === "none" || (f === "tick" && ticked) || (f === "typed" && adviceConfirmMatches(typed));
}

/** The short line at the top of the check: one line on a phone, whatever the state. */
export function adviceHeadline(state: AdviceState): string {
  if (state.status === "loading") return "Checking…";
  if (state.status === "failed") return "Could not check";
  if (state.status === "skipped") return "Not checked";
  const { level, complete } = state.advice;
  if (level === "high") return "Look before deleting";
  if (level === "review") return complete || state.advice.items.some((i) => i.reasons.some((r) => r.level === "review")) ? "Worth a look" : "Not fully checked";
  return "Nothing found";
}

/** How many items are at each level. */
export function levelCounts(items: readonly StorageAdviceItem[]): Record<StorageAdviceLevel, number> {
  const counts = { low: 0, review: 0, high: 0 };
  for (const it of items) counts[it.level] += 1;
  return counts;
}

type Unchecked = StorageAdviceItem["unchecked"][number];
const sameUnchecked = (a: Unchecked, b: Unchecked) => a.rule === b.rule && a.text === b.text;

/** What every one of several items could not have checked: said once in the bulk dialog, not under each item. */
export function sharedUnchecked(items: readonly StorageAdviceItem[]): Unchecked[] {
  if (items.length < 2) return [];
  const [first, ...rest] = items;
  return first.unchecked.filter((u) => rest.every((it) => it.unchecked.some((v) => sameUnchecked(u, v))));
}

/** What an item has to say beyond what all items share. */
export function ownUnchecked(item: StorageAdviceItem, shared: readonly Unchecked[]): Unchecked[] {
  return item.unchecked.filter((u) => !shared.some((v) => sameUnchecked(u, v)));
}

/**
 * Items worth showing on their own in the bulk dialog (anything found, or something not checked that the others do
 * not share), highest first; the rest are counted.
 */
export function flaggedItems(items: readonly StorageAdviceItem[], shared: readonly Unchecked[] = []): StorageAdviceItem[] {
  const rank = { high: 0, review: 1, low: 2 };
  return items.filter((it) => it.reasons.length > 0 || ownUnchecked(it, shared).length > 0).sort((a, b) => rank[a.level] - rank[b.level]);
}
