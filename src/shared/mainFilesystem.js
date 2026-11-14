/**
 * "The main disk" of a unit, decided one way everywhere (Storage Manager roadmap B6): the Storage
 * Manager's Spark cards and disk summary, the Overview card, and later the per-filesystem samples and
 * alerts. Plain JavaScript so the server can import it too (see contextFit.js, fleetExceptions.js).
 *
 * The rule:
 * 1. Boot and firmware partitions (/boot, /boot/efi, /efi) and snap mounts never count, nor does a row
 *    without an absolute mount or a size.
 * 2. A bind mount repeats its device: rows of one device count once, at their shortest mount.
 * 3. The filesystem mounted at "/" wins (the biggest, if more than one row says "/"); that is what
 *    "Whole disk" analyses. Otherwise the biggest remaining one.
 * Ties go to the shorter, then alphabetically first, mount so every caller picks the same row.
 */

/** Partitions that hold the boot loader or firmware, and snap's read-only images. */
export function isSystemMount(mount) {
  if (typeof mount !== "string") return true;
  return (
    mount === "/boot" ||
    mount.startsWith("/boot/") ||
    mount === "/efi" ||
    mount.startsWith("/efi/") ||
    mount === "/snap" ||
    mount.startsWith("/snap/") ||
    mount.startsWith("/var/snap/")
  );
}

const better = (a, b) =>
  // Is `a` a better pick than `b`?
  a.totalBytes !== b.totalBytes ? a.totalBytes > b.totalBytes : a.mount.length !== b.mount.length ? a.mount.length < b.mount.length : a.mount < b.mount;

/**
 * @template T
 * @param {readonly T[] | null | undefined} items
 * @param {(item: T) => { mount: string, device?: string | null, totalBytes: number }} view
 * @returns {T | null}
 */
export function mainFilesystem(items, view) {
  if (!Array.isArray(items)) return null;
  /** One candidate per device: its shortest mount. */
  const byDevice = new Map();
  const rows = [];
  for (const item of items) {
    const v = view(item);
    const mount = v?.mount;
    const totalBytes = Number(v?.totalBytes);
    if (typeof mount !== "string" || !mount.startsWith("/") || isSystemMount(mount)) continue;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    const row = { item, mount, totalBytes };
    const device = v.device ? String(v.device) : null;
    if (device == null) {
      rows.push(row);
      continue;
    }
    const have = byDevice.get(device);
    if (!have || mount.length < have.mount.length || (mount.length === have.mount.length && mount < have.mount)) byDevice.set(device, row);
  }
  rows.push(...byDevice.values());
  const pick = (list) => list.reduce((best, r) => (best == null || better(r, best) ? r : best), null);
  const root = pick(rows.filter((r) => r.mount === "/"));
  return (root ?? pick(rows))?.item ?? null;
}

/** For the Storage Manager's status rows (`{ source, mount, totalBytes }`). */
export const statusView = (f) => ({ mount: f.mount, device: f.source, totalBytes: f.totalBytes });

/** For a unit snapshot's `metrics.storage` rows (`{ device, label, total }`, sizes in MiB). */
export const metricsView = (d) => ({ mount: d.label, device: d.device, totalBytes: d.total });
