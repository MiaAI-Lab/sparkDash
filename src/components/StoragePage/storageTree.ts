import type { StorageEntry } from "../../api/types";
import { usableSeconds } from "../../shared/relativeTime";

/** Colours for the biggest items in a folder, matched between the share bar and the rows. */
export const SHARE_COLORS = 6;

export function parentPath(path: string): string | null {
  if (path === "/") return null;
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function baseName(path: string): string {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Single-quote a path for a shell, so the command shown for a terminal is safe to paste. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export interface TreeIndex {
  byPath: Map<string, StorageEntry>;
  /** Children by the nearest listed ancestor. Small items that were not listed are not here. */
  children: Map<string, StorageEntry[]>;
}

/** Bytes of an entry that stay on disk when it is deleted, because another link to the same data lives elsewhere. */
export function sharedOf(e: StorageEntry): number {
  return Math.min(e.bytes, Math.max(0, e.sharedBytes ?? 0));
}

/** What deleting the entry would give back: the bytes whose every link is inside it. */
export function freesOf(e: StorageEntry): number {
  return Math.max(0, e.bytes - sharedOf(e));
}

/** True when deleting it frees (almost) nothing although it is not small: it is all hard links to data kept elsewhere. */
export function freesNothing(e: StorageEntry): boolean {
  return e.bytes >= 1024 * 1024 && sharedOf(e) > 0 && freesOf(e) < Math.max(1024 * 1024, e.bytes * 0.01);
}

export function buildIndex(entries: readonly StorageEntry[]): TreeIndex {
  const byPath = new Map<string, StorageEntry>();
  for (const e of entries) byPath.set(e.path, e);
  const children = new Map<string, StorageEntry[]>();
  for (const e of entries) {
    let parent = parentPath(e.path);
    while (parent != null && !byPath.has(parent)) parent = parentPath(parent);
    if (parent == null) continue;
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  return { byPath, children };
}

export interface Crumb {
  path: string;
  label: string;
}

/** From the scanned root down to `path`, one crumb per folder. */
export function breadcrumb(path: string, root: string): Crumb[] {
  const rootLabel = root === "/" ? "Whole disk" : baseName(root);
  const crumbs: Crumb[] = [{ path: root, label: rootLabel }];
  if (path === root) return crumbs;
  const prefix = root === "/" ? "" : root;
  if (!path.startsWith(`${prefix}/`)) return crumbs;
  let at = root;
  for (const part of path.slice(prefix.length + 1).split("/")) {
    at = at === "/" ? `/${part}` : `${at}/${part}`;
    crumbs.push({ path: at, label: part });
  }
  return crumbs;
}

/** "newest" / "oldest": by when anything inside last changed; items without a known date come last either way. */
export type SortKey = "size" | "name" | "newest" | "oldest";

export interface Row {
  entry: StorageEntry;
  name: string;
  /** 0..1 of the folder it is in. */
  share: number;
  /** 0..1 of this entry that is shared with files elsewhere (the hatched part of its bar). */
  sharedFrac: number;
  /** Position by size inside the folder; the biggest few get a colour. */
  rank: number;
}

export interface FolderView {
  entry: StorageEntry;
  rows: Row[];
  /** Bytes in the folder that are not part of any listed item. Only known once the folder was scanned. */
  smallerBytes: number;
  /** The folder's children were scanned, so an empty list means there is nothing big in it. */
  scanned: boolean;
  /** The listed items add up to more than the folder: some of them hold links to the same files. */
  overlap: boolean;
}

/** Everything the list needs for one folder, biggest first. */
export function folderView(index: TreeIndex, path: string): FolderView | null {
  const entry = index.byPath.get(path);
  if (!entry) return null;
  const kids = [...(index.children.get(path) ?? [])].sort((a, b) => b.bytes - a.bytes);
  const total = entry.bytes;
  const listed = kids.reduce((sum, k) => sum + k.bytes, 0);
  const rows = kids.map((k, rank) => ({
    entry: k,
    name: baseName(k.path),
    share: total > 0 ? Math.min(1, k.bytes / total) : 0,
    sharedFrac: k.bytes > 0 ? sharedOf(k) / k.bytes : 0,
    rank,
  }));
  // Folders that hold links to the same files add up to more than the folder itself.
  const overlap = listed > total * 1.001 + 4096;
  return { entry, rows, smallerBytes: entry.expanded && !overlap ? Math.max(0, total - listed) : 0, scanned: entry.expanded, overlap };
}

export function sortRows(rows: readonly Row[], key: SortKey): Row[] {
  const out = [...rows];
  if (key === "size") return out.sort((a, b) => b.entry.bytes - a.entry.bytes || a.name.localeCompare(b.name));
  if (key === "newest" || key === "oldest") {
    const dir = key === "newest" ? -1 : 1;
    return out.sort((a, b) => {
      const ta = usableSeconds(a.entry.modifiedAt);
      const tb = usableSeconds(b.entry.modifiedAt);
      if (ta == null || tb == null) return (ta == null ? 1 : 0) - (tb == null ? 1 : 0) || b.entry.bytes - a.entry.bytes || a.name.localeCompare(b.name);
      return dir * (ta - tb) || b.entry.bytes - a.entry.bytes || a.name.localeCompare(b.name);
    });
  }
  // Folders first, then files, each A to Z, the way a file manager lists them.
  const isDir = (r: Row) => (r.entry.type === "dir" ? 0 : 1);
  return out.sort((a, b) => isDir(a) - isDir(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function filterRows(rows: readonly Row[], text: string): Row[] {
  const needle = text.trim().toLowerCase();
  return needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : [...rows];
}

export interface ShareSegment {
  key: string;
  label: string;
  bytes: number;
  share: number;
  /** Index into the colour set, or null for the grey "everything else" segment. */
  color: number | null;
}

/** The bar above the list: the biggest items, then one grey segment for the rest of the folder. */
export function shareSegments(view: FolderView, maxSegments = SHARE_COLORS): ShareSegment[] {
  const total = view.entry.bytes;
  if (total <= 0) return [];
  const top = view.rows.slice(0, maxSegments);
  const topBytes = top.reduce((sum, r) => sum + r.entry.bytes, 0);
  // Overlapping folders can add up to more than the whole: scale the bar so it still fits.
  const whole = Math.max(total, topBytes);
  const segments: ShareSegment[] = top.map((r, i) => ({
    key: r.entry.path,
    label: r.name,
    bytes: r.entry.bytes,
    share: r.entry.bytes / whole,
    color: i,
  }));
  const rest = Math.max(0, whole - topBytes);
  if (rest > 0) segments.push({ key: "__rest__", label: "Everything else", bytes: rest, share: rest / whole, color: null });
  return segments;
}

/** "42%", or "<1%" for a sliver that would round to nothing. */
export function formatShare(share: number): string {
  if (!(share > 0)) return "0%";
  const pct = share * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
