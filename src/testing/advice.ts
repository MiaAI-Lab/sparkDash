import type { StorageAdvice, StorageAdviceItem, StorageAdviceLevel } from "../api/types";

/** A delete check where everything ran and nothing was found: the delete dialogs then work as they did before it. */
export function lowAdvice(paths: readonly string[]): StorageAdvice {
  return { checkedAt: 1, recentMinutes: 1440, level: "low", complete: true, items: paths.map((path) => ({ path, level: "low", complete: true, reasons: [], unchecked: [] })), covered: [] };
}

/** A delete check with the given items (missing fields filled in); the overall level is the highest. */
export function adviceOf(items: (Partial<StorageAdviceItem> & { path: string })[], covered: string[] = []): StorageAdvice {
  const rank: Record<StorageAdviceLevel, number> = { low: 0, review: 1, high: 2 };
  const full = items.map((it) => ({ level: "low" as StorageAdviceLevel, complete: true, reasons: [], unchecked: [], ...it }));
  const level = full.reduce<StorageAdviceLevel>((l, it) => (rank[it.level] > rank[l] ? it.level : l), "low");
  return { checkedAt: 1, recentMinutes: 1440, level, complete: full.every((it) => it.complete), items: full, covered };
}
