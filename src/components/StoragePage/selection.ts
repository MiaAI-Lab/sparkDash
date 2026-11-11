import type { StorageEntry } from "../../api/types";
import { freesOf, parentPath, sharedOf } from "./storageTree";

/**
 * Picking several rows of the Files list to delete them in one go. Pure functions over a set of paths, so the
 * list, the selection bar and the bulk dialog agree, and so they can be tested without a browser.
 */
export type Selection = ReadonlySet<string>;

/** The header check box: every row shown is ticked, some are, or none. */
export type HeaderState = "all" | "some" | "none";

/** A row may be ticked when it may be deleted from here: not locked by policy, and its name can be sent back to the Spark. */
export function isSelectable(e: StorageEntry): boolean {
  return !e.locked && !e.unsafe;
}

/** Tick or untick one path. */
export function toggleOne(sel: Selection, path: string): Set<string> {
  const next = new Set(sel);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * Shift-click: every row from the anchor (the row toggled last) to the clicked one, in the order the list shows
 * them now, takes the clicked row's new state. Rows that cannot be ticked are left alone. Without an anchor in
 * that order (none yet, or filtered out), it is a plain toggle.
 */
export function selectRange(sel: Selection, order: readonly string[], anchor: string | null, target: string, selectable: (path: string) => boolean = () => true): Set<string> {
  const from = anchor == null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return toggleOne(sel, target);
  const on = !sel.has(target);
  const next = new Set(sel);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) {
    const p = order[i];
    if (!selectable(p)) continue;
    if (on) next.add(p);
    else next.delete(p);
  }
  return next;
}

/** The header check box's state for the rows shown that can be ticked (a filter narrows it). */
export function headerState(sel: Selection, shown: readonly string[]): HeaderState {
  let n = 0;
  for (const p of shown) if (sel.has(p)) n += 1;
  if (n === 0) return "none";
  return n === shown.length ? "all" : "some";
}

/** The header check box pressed: untick every row shown when all are ticked, else tick them all. Rows not shown keep their state. */
export function toggleAllShown(sel: Selection, shown: readonly string[]): Set<string> {
  const next = new Set(sel);
  if (headerState(sel, shown) === "all") for (const p of shown) next.delete(p);
  else for (const p of shown) next.add(p);
  return next;
}

/** The nearest folder above `path` that is ticked, or null. */
export function selectedAncestor(path: string, sel: Selection): string | null {
  for (let p = parentPath(path); p != null; p = parentPath(p)) if (sel.has(p)) return p;
  return null;
}

/**
 * Paths that would be deleted twice: one inside another ticked folder is `covered` (deleting the folder removes
 * it), and only the outer ones are `roots`. Repeats count once; the order given is kept.
 */
export function dedupe(paths: Iterable<string>): { roots: string[]; covered: string[] } {
  const all = new Set(paths);
  const roots: string[] = [];
  const covered: string[] = [];
  for (const p of all) (selectedAncestor(p, all) != null ? covered : roots).push(p);
  return { roots, covered };
}

/**
 * The ticked paths that still exist in the analysis and may still be deleted (after a rescan, a refresh or a
 * delete). The same set comes back when nothing was dropped, so React keeps its state as it is.
 */
export function pruneSelection(sel: Selection, byPath: ReadonlyMap<string, StorageEntry>): Selection {
  let dropped = false;
  const next = new Set<string>();
  for (const p of sel) {
    const e = byPath.get(p);
    if (e && isSelectable(e)) next.add(p);
    else dropped = true;
  }
  return dropped ? next : sel;
}

export interface SelectionSummary {
  /** What will be deleted: the ticked items, without those inside another ticked folder. Biggest first. */
  items: StorageEntry[];
  /** Ticked items left out because a ticked folder holds them (they go with it). */
  covered: number;
  /** Their size, each file counted once. */
  bytes: number;
  /**
   * About what deleting them gives back: each item's size less the part hard-linked to files outside it. Data
   * linked only between two ticked items is left out too (it would come back, but the analysis cannot tell it
   * apart from data linked from elsewhere), so this is never more than what really comes back.
   */
  frees: number;
  /** The part of `bytes` that is hard-linked from outside the items. */
  shared: number;
  /** Deleting them gives back (almost) nothing although they are not small: everything is linked from elsewhere. */
  freesNothing: boolean;
  folders: number;
}

/** What the selection bar and the bulk dialog say about the ticked items. Paths missing from the analysis are left out. */
export function summarize(sel: Selection, byPath: ReadonlyMap<string, StorageEntry>): SelectionSummary {
  const present = [...sel].filter((p) => byPath.has(p));
  const { roots, covered } = dedupe(present);
  const items = roots
    .map((p) => byPath.get(p)!)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  let bytes = 0;
  let frees = 0;
  let shared = 0;
  for (const e of items) {
    bytes += e.bytes;
    frees += freesOf(e);
    shared += sharedOf(e);
  }
  const MiB = 1024 * 1024;
  return {
    items,
    covered: covered.length,
    bytes,
    frees,
    shared,
    freesNothing: bytes >= MiB && shared > 0 && frees < Math.max(MiB, bytes * 0.01),
    folders: items.filter((e) => e.type === "dir").length,
  };
}

/**
 * The phrase typed to confirm a bulk delete: exactly `delete <N> items` (`delete 1 item` for one), with N in
 * digits. It is compared after trimming the ends and ignoring letter case, since phone keyboards capitalise the
 * first letter; nothing else is relaxed.
 */
export function confirmPhrase(n: number): string {
  return `delete ${n} ${n === 1 ? "item" : "items"}`;
}

export function confirmMatches(typed: string, n: number): boolean {
  return typed.trim().toLowerCase() === confirmPhrase(n);
}
