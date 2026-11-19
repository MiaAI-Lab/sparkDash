import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = () => new Error('Pi occupancy metadata unavailable');

/**
 * Writes one private metadata file per Pi process. No filesystem work happens
 * until the first write, and a path is never taken from session metadata.
 *
 * @param {{runtimeDir?: string, publisherId: string}} options
 */
export function createPiFileWriter({ runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, publisherId }) {
  if (!UUID.test(publisherId) || !path.isAbsolute(runtimeDir) || typeof process.getuid !== 'function') throw failure();
  const uid = process.getuid();
  const directory = path.join(runtimeDir, 'pi-sparkdash-occupancy');
  const file = path.join(directory, `${publisherId}.json`);
  const privateDir = s => s.isDirectory() && s.uid === uid && (s.mode & 0o7777) === 0o700;
  const privateFile = s => s.isFile() && s.uid === uid && (s.mode & 0o7777) === 0o600;

  async function prepare(create) {
    if (!privateDir(await fs.lstat(runtimeDir))) throw failure();
    if (create) {
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    try {
      if (!privateDir(await fs.lstat(directory))) throw failure();
      return true;
    } catch (e) {
      if (!create && e.code === 'ENOENT') return false;
      throw e;
    }
  }
  async function existing() {
    try {
      if (!privateFile(await fs.lstat(file))) throw failure();
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }
  async function write(record) {
    let temporary;
    let handle;
    try {
      if (record === null) {
        if (await prepare(false) && await existing()) await fs.unlink(file);
        return;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw failure();
      const bytes = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
      if (bytes.length > 16 * 1024) throw failure();
      await prepare(true);
      await existing();
      temporary = path.join(directory, `.${publisherId}.${randomUUID()}.tmp`);
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      await fs.rename(temporary, file); temporary = undefined;
    } catch {
      throw failure();
    } finally {
      await handle?.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
  return { write };
}
