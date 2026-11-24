import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { normalizePiFile, PI_UUID, PI_EXPIRE_MS, PI_MAX_FILE_BYTES } from '../../server/occupancy/piSchema.js';

const DIR = 'pi-sparkdash-occupancy';
// Live metadata files this adapter will read. A crashed session leaves its file
// behind, so the directory cap counts live files rather than entries: expired
// files are skipped from stat alone and never take a running session's slot.
const LIVE_FILE_CAP = 2000;
// Bound on directory entries examined per refresh. Expired files are cheap to
// skip, but the scan itself must stay finite however many are left behind.
const SCAN_ENTRY_CAP = 20_000;
const unavailable = error => ({ coverage: 'unavailable', stale: false, error, rows: [] });
const copy = row => ({ ...row, selection: row.selection && { ...row.selection }, requestDestination: row.requestDestination && { ...row.requestDestination } });
const signature = row => JSON.stringify({ ...row, lastSeenAt: 0 });
function privateStat(s, uid, directory) {
  return s.uid === uid && (s.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory ? s.isDirectory() : s.isFile()) && !s.isSymbolicLink();
}
function sameFile(a, b) { return a.ino === b.ino && a.dev === b.dev; }

/**
 * Native metadata only. The helper owns `seen`; GET handlers never call this
 * reader. Files are private to the user, and a file left by a crashed session
 * expires on its own clock.
 */
export async function loadPi({ stateDir, now = Date.now, filesystem = fs, seen = new Map() } = {}) {
  const stamp = typeof now === 'function' ? now() : now;
  const uid = process.getuid?.();
  const runtime = process.env.XDG_RUNTIME_DIR || (uid === undefined ? '' : `/run/user/${uid}`);
  const dir = stateDir === undefined ? path.join(runtime, DIR) : stateDir;
  if (uid === undefined || !Number.isFinite(stamp) || stamp < 0 || typeof dir !== 'string'
      || !path.isAbsolute(dir) || path.basename(dir) !== DIR) return unavailable('Pi metadata directory unavailable');
  let entries;
  let truncatedScan = false;
  try {
    if (!privateStat(await filesystem.lstat(path.dirname(dir)), uid, true)
      || !privateStat(await filesystem.lstat(dir), uid, true)) return unavailable('Pi metadata directory unavailable');
    entries = [];
    const stream = await filesystem.opendir(dir);
    for await (const entry of stream) {
      entries.push(entry.name);
      if (entries.length > SCAN_ENTRY_CAP) { truncatedScan = true; break; }
    }
  } catch { return unavailable('Pi metadata directory unavailable'); }
  const names = entries.filter(name => name.endsWith('.json') && PI_UUID.test(name.slice(0, -5)));
  const publishers = new Set(names.map(name => name.slice(0, -5)));
  // A truncated scan must not forget publishers it never looked at.
  if (!truncatedScan) for (const id of seen.keys()) if (!publishers.has(id)) seen.delete(id);
  const rows = [];
  let rejected = false;
  let live = 0;
  for (const name of names) {
    const publisherId = name.slice(0, -5), file = path.join(dir, name);
    let handle;
    try {
      const before = await filesystem.lstat(file);
      if (!privateStat(before, uid, false) || !Number.isFinite(before.mtimeMs) || before.mtimeMs > stamp + 5000
          || before.size < 2 || before.size > PI_MAX_FILE_BYTES) { rejected = true; continue; }
      // Expired files are skipped before opening content or counting live rows,
      // and they do not consume the directory capacity either.
      if (stamp - before.mtimeMs > PI_EXPIRE_MS) continue;
      if (++live > LIVE_FILE_CAP) return unavailable('Pi metadata directory capacity exceeded');
      handle = await filesystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!sameFile(before, opened) || !privateStat(opened, uid, false)) { rejected = true; continue; }
      const bytes = Buffer.alloc(PI_MAX_FILE_BYTES + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const after = await handle.stat();
      if (used > PI_MAX_FILE_BYTES || !sameFile(opened, after) || opened.size !== after.size
          || opened.mtimeMs !== after.mtimeMs || !privateStat(after, uid, false)) { rejected = true; continue; }
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
      const row = normalizePiFile(raw, { now: stamp, lastSeenAt: after.mtimeMs });
      if (!row || row.publisherId !== publisherId) { rejected = true; continue; }
      const prior = seen.get(publisherId), sig = signature(row);
      let effective = row;
      if (prior) {
        if (row.sequence < prior.row.sequence || (row.sequence === prior.row.sequence && sig !== prior.signature)) {
          rejected = true; continue;
        }
        if (row.sequence === prior.row.sequence) effective = prior.row;
      }
      if (!prior || row.sequence > prior.row.sequence) seen.set(publisherId, { row: copy(row), signature: sig });
      if (stamp - effective.lastSeenAt > PI_EXPIRE_MS) continue;
      rows.push(copy(effective));
      if (rows.length > 500) return unavailable('Pi metadata live capacity exceeded');
    } catch { rejected = true; }
    finally { try { await handle?.close(); } catch { /* No raw path/error is returned. */ } }
  }
  const error = truncatedScan ? 'Pi metadata scan truncated' : rejected ? 'Pi metadata rejected' : null;
  return { coverage: truncatedScan || rejected ? 'partial' : 'supported', stale: false, error, rows };
}
