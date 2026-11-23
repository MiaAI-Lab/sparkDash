import type { AgentJunkGroup, AgentJunkItem, AgentJunkVerdict, StorageEntry } from "../../api/types";
import { summarize, type SelectionSummary } from "./selection";

/**
 * Remove agent junk: pure helpers over the unit's answer, so the list, the pick buttons and the delete dialog agree
 * and can be tested without a browser.
 */

export const JUNK_GROUPS: readonly AgentJunkGroup[] = ["worktrees", "temp", "sessions", "editors", "scratch", "caches"];
export const JUNK_VERDICTS: readonly AgentJunkVerdict[] = ["junk", "likely", "review", "keep"];

/** How much the quick pick buttons tick: the smart guess, also what is probably junk, everything, or nothing. */
export type JunkPick = "smart" | "likely" | "all" | "none";

const PICKED: Record<JunkPick, ReadonlySet<AgentJunkVerdict>> = {
  smart: new Set(["junk"]),
  likely: new Set(["junk", "likely"]),
  all: new Set(["junk", "likely", "review", "keep"]),
  none: new Set(),
};

/** The paths a pick button ticks. */
export function pickPaths(items: readonly AgentJunkItem[], pick: JunkPick): Set<string> {
  const want = PICKED[pick];
  return new Set(items.filter((it) => want.has(it.verdict)).map((it) => it.path));
}

/** Which pick button the selection matches exactly, or null when it was changed by hand. */
export function currentPick(items: readonly AgentJunkItem[], sel: ReadonlySet<string>): JunkPick | null {
  for (const pick of ["smart", "likely", "all", "none"] as const) {
    const want = pickPaths(items, pick);
    if (want.size === sel.size && [...want].every((p) => sel.has(p))) return pick;
  }
  return null;
}

export interface JunkGroupView {
  group: AgentJunkGroup;
  items: AgentJunkItem[];
  /** Measured bytes; items that could not be measured are left out (see `unmeasured`). */
  bytes: number;
  unmeasured: number;
}

/** The items by group, biggest group first; within a group, by verdict and then size (the server's order). */
export function groupItems(items: readonly AgentJunkItem[]): JunkGroupView[] {
  const by = new Map<AgentJunkGroup, JunkGroupView>();
  for (const it of items) {
    let g = by.get(it.group);
    if (!g) by.set(it.group, (g = { group: it.group, items: [], bytes: 0, unmeasured: 0 }));
    g.items.push(it);
    if (it.bytes == null) g.unmeasured += 1;
    else g.bytes += it.bytes;
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes || JUNK_GROUPS.indexOf(a.group) - JUNK_GROUPS.indexOf(b.group));
}

/** Count and measured size of the ticked items. */
export function selectedTotals(items: readonly AgentJunkItem[], sel: ReadonlySet<string>): { count: number; bytes: number; unmeasured: number } {
  let count = 0;
  let bytes = 0;
  let unmeasured = 0;
  for (const it of items) {
    if (!sel.has(it.path)) continue;
    count += 1;
    if (it.bytes == null) unmeasured += 1;
    else bytes += it.bytes;
  }
  return { count, bytes, unmeasured };
}

/** Items by verdict, for the filter chips. */
export function verdictCounts(items: readonly AgentJunkItem[]): Record<AgentJunkVerdict, number> {
  const out: Record<AgentJunkVerdict, number> = { junk: 0, likely: 0, review: 0, keep: 0 };
  for (const it of items) out[it.verdict] += 1;
  return out;
}

/** An item as the bulk delete dialog takes it (a Files-tab entry). */
export function toEntry(it: AgentJunkItem): StorageEntry {
  return {
    path: it.path,
    bytes: it.bytes ?? 0,
    type: it.type === "d" ? "dir" : "file",
    expanded: false,
    locked: null,
    ...(it.modifiedAt != null ? { modifiedAt: it.modifiedAt } : {}),
  };
}

/** What the bulk delete dialog shows for the ticked items, or null when none is ticked. */
export function junkSelection(items: readonly AgentJunkItem[], sel: ReadonlySet<string>): SelectionSummary | null {
  const byPath = new Map(items.filter((it) => sel.has(it.path)).map((it) => [it.path, toEntry(it)]));
  return byPath.size === 0 ? null : summarize(new Set(byPath.keys()), byPath);
}

/** Does the item match the search text (name, path or agent, any case)? */
export function matchesSearch(it: AgentJunkItem, text: string): boolean {
  const q = text.trim().toLowerCase();
  return q === "" || it.path.toLowerCase().includes(q) || it.agent.toLowerCase().includes(q);
}

/** "3 days", "5 weeks", "4 months", "2 years": an age in whole days as the coarsest plain unit. */
export function ageParts(days: number): { unit: "day" | "week" | "month" | "year"; count: number } {
  if (days >= 730) return { unit: "year", count: Math.floor(days / 365) };
  if (days >= 60) return { unit: "month", count: Math.floor(days / 30) };
  if (days >= 14) return { unit: "week", count: Math.floor(days / 7) };
  return { unit: "day", count: days };
}
