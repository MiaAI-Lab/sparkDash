/**
 * Per-Spark acknowledgements that deleting folders as administrator is allowed (roadmap §3, §5.1).
 *
 * An administrator delete of a folder treats every process running as the Spark's account as having root
 * access: such a process could change the folder while root deletes it. The owner turns this on per Spark
 * and per account by reading and confirming that statement; it is stored here and can be revoked from the
 * Storage page. A typed or remembered sudo password never implies it.
 *
 * Durable store: a file with an unknown version or that cannot be read is left untouched, nothing in it
 * counts, and new acknowledgements are refused until it is fixed or removed (never silently replaced).
 */
import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";

const VERSION = 1;
/** Bumped when the wording the owner confirms changes: older acknowledgements then no longer count. */
export const ACK_WORDING = 1;

const keyOf = (sparkId, account) => `${sparkId}|${account}`;

export class ElevatedDeleteAcks {
  /** @param {{ file: string | null, now?: () => number }} opts `file` null keeps them in memory only. */
  constructor({ file, now = Date.now }) {
    this._file = file;
    this._now = now;
    /** @type {Map<string, { sparkId: string, account: string, user: string | null, acknowledgedAt: number, wording: number }>} */
    this._acks = new Map();
    /** Why the file cannot be used, or null. */
    this._broken = null;
    this._load();
  }

  _load() {
    if (!this._file || !fs.existsSync(this._file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._file, "utf8"));
      if (data?.version !== VERSION || typeof data.acks !== "object" || data.acks === null) {
        this._broken = `unknown version ${JSON.stringify(data?.version)}`;
        return;
      }
      for (const a of Object.values(data.acks)) {
        if (!a || typeof a.sparkId !== "string" || typeof a.account !== "string" || !Number.isFinite(a.acknowledgedAt)) continue;
        if (a.wording !== ACK_WORDING) continue;
        this._acks.set(keyOf(a.sparkId, a.account), {
          sparkId: a.sparkId,
          account: a.account,
          user: typeof a.user === "string" ? a.user : null,
          acknowledgedAt: a.acknowledgedAt,
          wording: a.wording,
        });
      }
    } catch (err) {
      this._broken = err.message;
    }
    if (this._broken) console.error(`[storage] ${this._file} cannot be used (${this._broken}); it is left as it is and administrator folder deletes stay off.`);
  }

  _save() {
    if (!this._file) return;
    atomicWrite(this._file, `${JSON.stringify({ version: VERSION, acks: Object.fromEntries(this._acks) }, null, 2)}\n`, 0o600);
  }

  /** The acknowledgement for this Spark and account, or null. */
  get(sparkId, account) {
    return this._acks.get(keyOf(sparkId, account)) ?? null;
  }

  /** Store an acknowledgement. Throws when the store cannot be written (the caller says so). */
  set(sparkId, account, user = null) {
    if (this._broken) throw Object.assign(new Error(`The acknowledgement store ${this._file} cannot be used: ${this._broken}`), { status: 409, code: "ack-store-broken" });
    const key = keyOf(sparkId, account);
    const prev = this._acks.get(key);
    const ack = { sparkId, account, user, acknowledgedAt: this._now(), wording: ACK_WORDING };
    this._acks.set(key, ack);
    try {
      this._save();
    } catch (err) {
      if (prev) this._acks.set(key, prev);
      else this._acks.delete(key);
      throw err;
    }
    return ack;
  }

  /** Revoke it. True when there was one. */
  delete(sparkId, account) {
    const key = keyOf(sparkId, account);
    const prev = this._acks.get(key);
    if (!prev) return false;
    if (this._broken) throw Object.assign(new Error(`The acknowledgement store ${this._file} cannot be used: ${this._broken}`), { status: 409, code: "ack-store-broken" });
    this._acks.delete(key);
    try {
      this._save();
    } catch (err) {
      this._acks.set(key, prev);
      throw err;
    }
    return true;
  }
}
