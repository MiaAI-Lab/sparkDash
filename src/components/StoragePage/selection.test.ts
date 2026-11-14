import { describe, expect, it } from "vitest";
import type { StorageEntry } from "../../api/types";
import {
  confirmMatches,
  confirmPhrase,
  dedupe,
  headerState,
  isSelectable,
  pruneSelection,
  selectRange,
  selectedAncestor,
  summarize,
  toggleAllShown,
  toggleOne,
} from "./selection";

const MB = 1024 * 1024;
const e = (path: string, bytes: number, extra: Partial<StorageEntry> = {}): StorageEntry => ({ path, bytes, type: "dir", expanded: false, locked: null, ...extra });
const byPath = (...entries: StorageEntry[]) => new Map(entries.map((x) => [x.path, x]));
const set = (...p: string[]) => new Set(p);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("isSelectable", () => {
  it("only rows that may be deleted from here can be ticked", () => {
    expect(isSelectable(e("/d/a", 1))).toBe(true);
    expect(isSelectable(e("/d/a", 1, { locked: "SSH keys." }))).toBe(false);
    expect(isSelectable(e("/d/\u0001", 1, { unsafe: true }))).toBe(false);
  });
});

describe("toggleOne", () => {
  it("ticks and unticks one path without touching the others or the set it was given", () => {
    const before = set("/d/a");
    const after = toggleOne(before, "/d/b");
    expect(sorted(after)).toEqual(["/d/a", "/d/b"]);
    expect(sorted(toggleOne(after, "/d/a"))).toEqual(["/d/b"]);
    expect(sorted(before)).toEqual(["/d/a"]);
  });
});

describe("selectRange", () => {
  const order = ["/d/a", "/d/b", "/d/c", "/d/d", "/d/e"];

  it("ticks every row between the anchor and the clicked one, either direction", () => {
    expect(sorted(selectRange(set("/d/b"), order, "/d/b", "/d/d"))).toEqual(["/d/b", "/d/c", "/d/d"]);
    expect(sorted(selectRange(set("/d/d"), order, "/d/d", "/d/a"))).toEqual(["/d/a", "/d/b", "/d/c", "/d/d"]);
  });

  it("follows the order shown now, not the order things were ticked in", () => {
    const shown = ["/d/e", "/d/c", "/d/a"];
    expect(sorted(selectRange(set("/d/e"), shown, "/d/e", "/d/a"))).toEqual(["/d/a", "/d/c", "/d/e"]);
  });

  it("unticks the range when the clicked row was ticked (it takes the clicked row's new state)", () => {
    const all = set(...order);
    expect(sorted(selectRange(all, order, "/d/b", "/d/d"))).toEqual(["/d/a", "/d/e"]);
  });

  it("leaves rows that cannot be ticked alone", () => {
    const locked = (p: string) => p !== "/d/c";
    expect(sorted(selectRange(set("/d/a"), order, "/d/a", "/d/e", locked))).toEqual(["/d/a", "/d/b", "/d/d", "/d/e"]);
  });

  it("without an anchor in view it is a plain toggle", () => {
    expect(sorted(selectRange(set(), order, null, "/d/c"))).toEqual(["/d/c"]);
    expect(sorted(selectRange(set("/x/hidden"), order, "/x/hidden", "/d/c"))).toEqual(["/d/c", "/x/hidden"]);
  });

  it("keeps ticked rows outside the range, including ones hidden by a filter", () => {
    expect(sorted(selectRange(set("/d/a", "/x/hidden"), order, "/d/c", "/d/d"))).toEqual(["/d/a", "/d/c", "/d/d", "/x/hidden"]);
  });
});

describe("header check box", () => {
  const shown = ["/d/a", "/d/b", "/d/c"];

  it("is checked, mixed or clear by the rows shown", () => {
    expect(headerState(set(), shown)).toBe("none");
    expect(headerState(set("/d/b"), shown)).toBe("some");
    expect(headerState(set(...shown), shown)).toBe("all");
    // Ticked rows a filter hides do not make the shown ones look ticked.
    expect(headerState(set("/x/hidden"), shown)).toBe("none");
    expect(headerState(set(...shown, "/x/hidden"), shown)).toBe("all");
    expect(headerState(set("/d/a"), [])).toBe("none");
  });

  it("ticks every row shown, or unticks them when all are ticked, and keeps rows not shown", () => {
    expect(sorted(toggleAllShown(set("/x/hidden"), shown))).toEqual(["/d/a", "/d/b", "/d/c", "/x/hidden"]);
    expect(sorted(toggleAllShown(set("/d/b"), shown))).toEqual(["/d/a", "/d/b", "/d/c"]);
    expect(sorted(toggleAllShown(set(...shown, "/x/hidden"), shown))).toEqual(["/x/hidden"]);
  });
});

describe("overlap", () => {
  it("finds the nearest ticked folder above a path", () => {
    expect(selectedAncestor("/d/a/b/c", set("/d", "/d/a/b"))).toBe("/d/a/b");
    expect(selectedAncestor("/d/a", set("/d/a"))).toBeNull();
    expect(selectedAncestor("/d/ab", set("/d/a"))).toBeNull();
  });

  it("keeps only the outer item of a folder and something inside it, in the order given", () => {
    expect(dedupe(["/d/a/x", "/d/b", "/d/a", "/d/a/y/z", "/d/ab", "/d/b"])).toEqual({ roots: ["/d/b", "/d/a", "/d/ab"], covered: ["/d/a/x", "/d/a/y/z"] });
    expect(dedupe([])).toEqual({ roots: [], covered: [] });
  });
});

describe("pruneSelection", () => {
  const index = byPath(e("/d/a", 1), e("/d/b", 1), e("/d/locked", 1, { locked: "Protected." }));

  it("drops paths that are gone or can no longer be ticked", () => {
    expect(sorted(pruneSelection(set("/d/a", "/d/gone", "/d/locked"), index))).toEqual(["/d/a"]);
  });

  it("gives back the same set when nothing changed, so nothing re-renders", () => {
    const sel = set("/d/a", "/d/b");
    expect(pruneSelection(sel, index)).toBe(sel);
  });
});

describe("summarize", () => {
  it("adds sizes and what deleting frees, counting shared data once, biggest first", () => {
    const index = byPath(
      e("/d/models", 600 * MB),
      e("/d/linked", 200 * MB, { sharedBytes: 150 * MB }),
      e("/d/notes.txt", 2 * MB, { type: "file" })
    );
    const s = summarize(set("/d/notes.txt", "/d/linked", "/d/models"), index);
    expect(s.items.map((x) => x.path)).toEqual(["/d/models", "/d/linked", "/d/notes.txt"]);
    expect(s.bytes).toBe(802 * MB);
    expect(s.shared).toBe(150 * MB);
    expect(s.frees).toBe(652 * MB);
    expect(s.freesNothing).toBe(false);
    expect(s.folders).toBe(2);
    expect(s.covered).toBe(0);
  });

  it("counts an item inside a ticked folder once, with the folder, and says how many were folded in", () => {
    const index = byPath(e("/d/a", 500 * MB, { sharedBytes: 100 * MB }), e("/d/a/inner.bin", 300 * MB, { type: "file" }), e("/d/b", 50 * MB));
    const s = summarize(set("/d/a/inner.bin", "/d/a", "/d/b"), index);
    expect(s.items.map((x) => x.path)).toEqual(["/d/a", "/d/b"]);
    expect(s.covered).toBe(1);
    expect(s.bytes).toBe(550 * MB);
    expect(s.frees).toBe(450 * MB);
  });

  it("says when the whole selection frees (almost) nothing because it is all linked from elsewhere", () => {
    const index = byPath(e("/d/a", 400 * MB, { sharedBytes: 400 * MB }), e("/d/b", 100 * MB, { sharedBytes: 100 * MB }));
    const s = summarize(set("/d/a", "/d/b"), index);
    expect(s.frees).toBe(0);
    expect(s.freesNothing).toBe(true);
    // Small things are not called "frees nothing": a few bytes of links is not worth a warning.
    expect(summarize(set("/d/x"), byPath(e("/d/x", 10, { sharedBytes: 10 }))).freesNothing).toBe(false);
  });

  it("never counts shared bytes beyond the item's size, and leaves out paths missing from the analysis", () => {
    const index = byPath(e("/d/a", 100, { sharedBytes: 500 }));
    const s = summarize(set("/d/a", "/d/gone"), index);
    expect(s.items.map((x) => x.path)).toEqual(["/d/a"]);
    expect(s.shared).toBe(100);
    expect(s.frees).toBe(0);
  });

  it("is empty for an empty selection", () => {
    expect(summarize(set(), byPath())).toEqual({ items: [], covered: 0, bytes: 0, frees: 0, shared: 0, freesNothing: false, folders: 0 });
  });
});

describe("typed confirmation", () => {
  it("is the literal 'delete N items', singular for one", () => {
    expect(confirmPhrase(5)).toBe("delete 5 items");
    expect(confirmPhrase(1)).toBe("delete 1 item");
    expect(confirmPhrase(200)).toBe("delete 200 items");
  });

  it("matches only that phrase, ignoring the ends and letter case", () => {
    expect(confirmMatches("delete 5 items", 5)).toBe(true);
    expect(confirmMatches("  Delete 5 items ", 5)).toBe(true);
    expect(confirmMatches("DELETE 5 ITEMS", 5)).toBe(true);
    expect(confirmMatches("delete 4 items", 5)).toBe(false);
    expect(confirmMatches("delete five items", 5)).toBe(false);
    expect(confirmMatches("delete 5  items", 5)).toBe(false);
    expect(confirmMatches("delete 1 items", 1)).toBe(false);
    expect(confirmMatches("", 5)).toBe(false);
  });
});
