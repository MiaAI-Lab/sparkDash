import { describe, expect, it } from "vitest";
import type { StorageEntry } from "../../api/types";
import {
  baseName,
  breadcrumb,
  buildIndex,
  filterRows,
  folderView,
  formatShare,
  freesNothing,
  freesOf,
  sharedOf,
  parentPath,
  shareSegments,
  shellQuote,
  sortRows,
} from "./storageTree";

const e = (path: string, bytes: number, type: StorageEntry["type"] = "dir", expanded = false): StorageEntry => ({ path, bytes, type, expanded, locked: null });

const ENTRIES = [
  e("/", 1000, "dir", true),
  e("/home", 600, "dir", true),
  e("/home/me", 500, "dir", true),
  e("/home/me/models", 300, "dir"),
  e("/home/me/big.bin", 150, "file"),
  e("/var", 300, "dir", true),
  e("/var/lib", 200, "dir"),
  e("/etc", 50, "dir"),
];

describe("paths", () => {
  it("parentPath and baseName", () => {
    expect(parentPath("/")).toBeNull();
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/a/b")).toBe("/a");
    expect(baseName("/")).toBe("/");
    expect(baseName("/a/b c")).toBe("b c");
  });

  it("shellQuote survives quotes and spaces", () => {
    expect(shellQuote("/home/me/My Files")).toBe("'/home/me/My Files'");
    expect(shellQuote("/home/me/it's")).toBe(`'/home/me/it'\\''s'`);
  });
});

describe("breadcrumb", () => {
  it("starts at the scanned root", () => {
    expect(breadcrumb("/", "/")).toEqual([{ path: "/", label: "Whole disk" }]);
    expect(breadcrumb("/home/me", "/")).toEqual([
      { path: "/", label: "Whole disk" },
      { path: "/home", label: "home" },
      { path: "/home/me", label: "me" },
    ]);
    expect(breadcrumb("/var/lib/docker/overlay2", "/var/lib")).toEqual([
      { path: "/var/lib", label: "lib" },
      { path: "/var/lib/docker", label: "docker" },
      { path: "/var/lib/docker/overlay2", label: "overlay2" },
    ]);
  });

  it("falls back to the root for a path outside it", () => {
    expect(breadcrumb("/etc", "/var")).toEqual([{ path: "/var", label: "var" }]);
  });
});

describe("folderView", () => {
  const index = buildIndex(ENTRIES);

  it("lists children biggest first with their share of the folder", () => {
    const view = folderView(index, "/")!;
    expect(view.rows.map((r) => r.name)).toEqual(["home", "var", "etc"]);
    expect(view.rows[0].share).toBeCloseTo(0.6);
    expect(view.rows.map((r) => r.rank)).toEqual([0, 1, 2]);
    expect(view.scanned).toBe(true);
    expect(view.smallerBytes).toBe(50);
  });

  it("works out what is left over inside a folder", () => {
    const view = folderView(index, "/home/me")!;
    expect(view.rows.map((r) => r.name)).toEqual(["models", "big.bin"]);
    expect(view.smallerBytes).toBe(50);
  });

  it("knows a folder it never looked inside", () => {
    const view = folderView(index, "/home/me/models")!;
    expect(view.scanned).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.smallerBytes).toBe(0);
  });

  it("attaches an item to the nearest listed ancestor when its parent was left out", () => {
    const idx = buildIndex([e("/", 100, "dir", true), e("/a/b/c", 40, "file")]);
    expect(folderView(idx, "/")!.rows.map((r) => r.entry.path)).toEqual(["/a/b/c"]);
  });

  it("is null for a path that is not in the result", () => {
    expect(folderView(index, "/nope")).toBeNull();
  });
});

describe("sorting and filtering", () => {
  const view = folderView(buildIndex(ENTRIES), "/home/me")!;
  it("sorts by size or by name with folders first", () => {
    expect(sortRows(view.rows, "size").map((r) => r.name)).toEqual(["models", "big.bin"]);
    expect(sortRows(view.rows, "name").map((r) => r.name)).toEqual(["models", "big.bin"]);
    const mixed = buildIndex([e("/", 100, "dir", true), e("/b", 10, "file"), e("/a", 5, "file"), e("/z", 1, "dir"), e("/file10", 3, "file"), e("/file2", 2, "file")]);
    expect(sortRows(folderView(mixed, "/")!.rows, "name").map((r) => r.name)).toEqual(["z", "a", "b", "file2", "file10"]);
  });

  it("sorts by last change either way, with unknown and unusable dates last both times", () => {
    const at = (path: string, bytes: number, modifiedAt?: number): StorageEntry => ({ ...e(path, bytes), ...(modifiedAt != null ? { modifiedAt } : {}) });
    const idx = buildIndex([
      e("/", 1000, "dir", true),
      at("/old", 100, 1_400_000_000),
      at("/new", 50, 1_700_000_000),
      at("/mid", 300, 1_600_000_000),
      at("/tie", 200, 1_600_000_000), // same time as mid: bigger first
      at("/unknown", 900),
      at("/epoch", 800, 0), // a placeholder, not a date
    ]);
    const rows = folderView(idx, "/")!.rows;
    expect(sortRows(rows, "newest").map((r) => r.name)).toEqual(["new", "mid", "tie", "old", "unknown", "epoch"]);
    expect(sortRows(rows, "oldest").map((r) => r.name)).toEqual(["old", "mid", "tie", "new", "unknown", "epoch"]);
  });

  it("filters by name, ignoring case", () => {
    expect(filterRows(view.rows, " MOD ").map((r) => r.name)).toEqual(["models"]);
    expect(filterRows(view.rows, "").length).toBe(2);
    expect(filterRows(view.rows, "zzz")).toEqual([]);
  });
});

describe("shareSegments", () => {
  it("shows the biggest items and one grey segment for the rest", () => {
    const view = folderView(buildIndex(ENTRIES), "/")!;
    const segs = shareSegments(view, 2);
    expect(segs.map((s) => [s.label, s.color])).toEqual([["home", 0], ["var", 1], ["Everything else", null]]);
    expect(segs.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
  });

  it("has no segments for an empty folder", () => {
    const view = folderView(buildIndex([e("/", 0, "dir", true)]), "/")!;
    expect(shareSegments(view)).toEqual([]);
  });
});

describe("formatShare", () => {
  it("rounds and marks slivers", () => {
    expect(formatShare(0.426)).toBe("43%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(1)).toBe("100%");
  });
});

describe("hard-linked (shared) bytes", () => {
  const MB = 1024 * 1024;
  const e2 = (path: string, bytes: number, sharedBytes?: number, type: StorageEntry["type"] = "dir", expanded = false): StorageEntry => ({
    path, bytes, type, expanded, locked: null, ...(sharedBytes ? { sharedBytes } : {}),
  });

  it("what deleting frees is the size minus the shared part", () => {
    expect(freesOf(e2("/a", 100 * MB, 40 * MB))).toBe(60 * MB);
    expect(freesOf(e2("/a", 100 * MB))).toBe(100 * MB);
    expect(sharedOf(e2("/a", 10, 50))).toBe(10); // never more than the size
    expect(freesOf(e2("/a", 10, 50))).toBe(0);
  });

  it("flags an entry that frees (almost) nothing although it is not small", () => {
    expect(freesNothing(e2("/native", 475 * MB, 475 * MB))).toBe(true);
    expect(freesNothing(e2("/native", 475 * MB, 474.9 * MB))).toBe(true); // a sliver rounds to nothing
    expect(freesNothing(e2("/hub", 647 * MB, 475 * MB))).toBe(false);
    expect(freesNothing(e2("/plain", 475 * MB))).toBe(false);
    expect(freesNothing(e2("/tiny", 1000, 1000))).toBe(false); // too small to matter
  });

  it("rows carry how much of each bar is shared", () => {
    const idx = buildIndex([e2("/", 960 * MB, undefined, "dir", true), e2("/hub", 647 * MB, 475 * MB), e2("/native", 475 * MB, 475 * MB), e2("/other", 300 * MB)]);
    const rows = new Map(folderView(idx, "/")!.rows.map((r) => [r.name, r]));
    expect(rows.get("hub")!.sharedFrac).toBeCloseTo(475 / 647);
    expect(rows.get("native")!.sharedFrac).toBe(1);
    expect(rows.get("other")!.sharedFrac).toBe(0);
  });

  it("folders that hold links to the same files add up to more than the whole: overlap is flagged and no 'smaller items' is invented", () => {
    const idx = buildIndex([e2("/", 960 * MB, undefined, "dir", true), e2("/hub", 647 * MB, 475 * MB), e2("/native", 475 * MB, 475 * MB), e2("/other", 300 * MB)]);
    const view = folderView(idx, "/")!;
    expect(view.overlap).toBe(true);
    expect(view.smallerBytes).toBe(0);
    // The share bar still fits: segments are scaled to the listed total, never more than 100%.
    const segs = shareSegments(view);
    expect(segs.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1);
    expect(segs.some((x) => x.label === "Everything else")).toBe(false);
  });

  it("without overlap, the leftover is still reported as smaller items", () => {
    const idx = buildIndex([e2("/", 1000, undefined, "dir", true), e2("/a", 600), e2("/b", 300)]);
    const view = folderView(idx, "/")!;
    expect(view.overlap).toBe(false);
    expect(view.smallerBytes).toBe(100);
  });
});
