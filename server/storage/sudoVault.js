/**
 * Sudo passwords the person chose to remember, so they do not have to be typed again after a reload or
 * a restart. Encrypted with the dashboard's secrets key (the same protection as stored SSH passwords),
 * one per account on the machine (`user@host:port`), in their own file. A stored password is never sent to
 * the browser: the server uses it itself when an action asks for administrator rights without one.
 */
import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";

export class SudoVault {
  /**
   * @param {{ file: string | null, encrypt: (plain: string) => string, decrypt: (blob: string) => string }} opts
   *   `file` null keeps nothing on disk (the vault then only lasts until a restart).
   */
  constructor({ file, encrypt, decrypt }) {
    this._file = file;
    this._encrypt = encrypt;
    this._decrypt = decrypt;
    /** @type {Map<string, string>} account key -> encrypted blob */
    this._blobs = new Map();
    this._load();
  }

  _load() {
    if (!this._file || !fs.existsSync(this._file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._file, "utf8"));
      for (const [key, blob] of Object.entries(data?.passwords ?? {})) {
        if (key && typeof blob === "string") this._blobs.set(key, blob);
      }
    } catch (err) {
      console.error(`[storage] Could not read ${this._file}: ${err.message}. Remembered sudo passwords are ignored.`);
    }
  }

  _save() {
    if (!this._file) return;
    if (this._blobs.size === 0) {
      try {
        fs.rmSync(this._file, { force: true });
      } catch {
        /* nothing to clean up */
      }
      return;
    }
    atomicWrite(this._file, `${JSON.stringify({ version: 1, passwords: Object.fromEntries(this._blobs) }, null, 2)}\n`, 0o600);
  }

  has(key) {
    return this._blobs.has(key);
  }

  /** The password, or null when none is kept or it cannot be decrypted (wrong key). */
  get(key) {
    const blob = this._blobs.get(key);
    if (!blob) return null;
    try {
      return this._decrypt(blob) || null;
    } catch {
      return null;
    }
  }

  /** Remember a password. Throws when it cannot be encrypted or written, so the caller can say so. */
  set(key, password) {
    this._blobs.set(key, this._encrypt(password));
    try {
      this._save();
    } catch (err) {
      this._blobs.delete(key);
      throw err;
    }
  }

  delete(key) {
    if (!this._blobs.delete(key)) return false;
    try {
      this._save();
    } catch (err) {
      console.error(`[storage] Could not update ${this._file}: ${err.message}`);
    }
    return true;
  }
}
