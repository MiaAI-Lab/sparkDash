import fs from "fs";
import path from "path";

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomic write that works even if an older root-owned 0600 file is in the way.
 *
 * Writes to a stable per-target, per-pid temp file (so a crashed write is
 * overwritten next time instead of piling up), then renames onto the target.
 * If rename fails (e.g. root-owned target), falls back to unlink + rename. It
 * never overwrites the target in place: a partial in-place write would destroy
 * the existing contents. The temp file is always removed on failure. Mode is
 * best-effort applied via chmod.
 *
 * @param {string} filePath Destination path.
 * @param {string} contents Text contents to write.
 * @param {number} [mode=0o600] File mode to apply (best-effort chmod).
 */
export function atomicWrite(filePath, contents, mode = 0o600) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const cleanup = () => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  };
  try {
    fs.writeFileSync(tmp, contents, { mode });
  } catch (err) {
    cleanup();
    throw new Error(`Failed to write ${filePath}: ${err.message}`);
  }
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* best-effort */
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // rename over a root-owned file can fail: try unlink then rename.
    try {
      if (fs.existsSync(filePath)) {
        try {
          fs.chmodSync(filePath, 0o666);
        } catch {
          /* ignore */
        }
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tmp, filePath);
    } catch (err2) {
      cleanup();
      throw new Error(
        `Failed to write ${filePath}: ${err2.message}. ` +
          `If this is a root-owned file: sudo chown $(id -u):$(id -g) ${filePath}`
      );
    }
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* best-effort */
  }
}

export default atomicWrite;

/**
 * atomicWrite without blocking the event loop: the same temp-then-rename steps
 * and root-owned-target fallback, on fs.promises. The temp file has its own
 * name (`.async.tmp`), so a synchronous write of the same target — a shutdown
 * flush while this one is in flight — never shares it.
 *
 * `shouldCommit` is asked once the contents are on disk, just before the
 * rename; returning false discards the temp file and leaves the target alone
 * (a newer synchronous write has superseded this one).
 *
 * @param {string} filePath Destination path.
 * @param {string} contents Text contents to write.
 * @param {number} [mode=0o600] File mode to apply (best-effort chmod).
 * @param {{ shouldCommit?: () => boolean, fsp?: typeof fs.promises }} [opts]
 * @returns {Promise<boolean>} false when shouldCommit declined the rename.
 */
export async function atomicWriteAsync(filePath, contents, mode = 0o600, { shouldCommit, fsp = fs.promises } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.async.tmp`;
  const cleanup = () => fsp.unlink(tmp).catch(() => {});
  try {
    await fsp.writeFile(tmp, contents, { mode });
  } catch (err) {
    await cleanup();
    throw new Error(`Failed to write ${filePath}: ${err.message}`);
  }
  await fsp.chmod(tmp, mode).catch(() => {});
  if (shouldCommit && !shouldCommit()) {
    await cleanup();
    return false;
  }
  try {
    await fsp.rename(tmp, filePath);
  } catch {
    try {
      await fsp.chmod(filePath, 0o666).catch(() => {});
      await fsp.unlink(filePath).catch((err) => {
        if (err?.code !== "ENOENT") throw err;
      });
      await fsp.rename(tmp, filePath);
    } catch (err2) {
      await cleanup();
      throw new Error(
        `Failed to write ${filePath}: ${err2.message}. ` +
          `If this is a root-owned file: sudo chown $(id -u):$(id -g) ${filePath}`
      );
    }
  }
  await fsp.chmod(filePath, mode).catch(() => {});
  return true;
}

/**
 * A state file failed to parse: move it aside as <name>.corrupt-<ts> so the next
 * save does not destroy it, and log once. Never throws.
 * @param {string} filePath
 * @param {string} label Log prefix.
 * @param {Error} [err]
 * @returns {string|null} the quarantine path, or null when the rename failed.
 */
export function quarantineCorrupt(filePath, label, err) {
  try {
    const dest = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, dest);
    console.error(`[${label}] ${filePath} is unreadable (${err?.message ?? "parse error"}); moved to ${dest}`);
    return dest;
  } catch (e) {
    console.error(`[${label}] ${filePath} is unreadable and could not be quarantined: ${e?.message}`);
    return null;
  }
}
