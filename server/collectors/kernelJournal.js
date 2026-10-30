/**
 * Records per bounded read. Kept well inside the 10 MB output buffer the local and SSH command
 * runners allow: kernel messages can reach about 2 KB, and a page that overflows the buffer
 * fails, leaves the cursor unadvanced and then fails identically on every retry, so the
 * counters would never complete their baseline. A smaller page makes the first backfill take
 * longer, during which the counters read unknown rather than wrong.
 */
export const KERNEL_JOURNAL_PAGE_SIZE = 2_000;

/**
 * A journal entry's MESSAGE as text, or null when it is neither a string nor a byte array.
 * journalctl JSON encodes a field containing non-UTF8 or non-printable bytes as an array of
 * unsigned byte values.
 */
function messageText(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Buffer.from(raw).toString("latin1");
  }
  return null;
}
const BOOT_ID = /^[0-9a-f]{32}$/;
const CURSOR = /^[a-zA-Z0-9=;_-]+$/;

class KernelJournalOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "KernelJournalOutputError";
  }
}

/** The timeout runs on the monitored host, inside nsenter/SSH, with no pipeline. */
export function kernelJournalCommand(boot, cursor, timeoutSeconds = 3) {
  const base = `exec timeout --signal=KILL ${timeoutSeconds}s journalctl -k --no-pager -q -o json --output-fields=MESSAGE,_BOOT_ID --show-cursor -n +${KERNEL_JOURNAL_PAGE_SIZE}`;
  const resume = BOOT_ID.test(boot ?? "") && CURSOR.test(cursor ?? "")
    ? `if [ "$boot" = '${boot}' ]; then ${base} --after-cursor='${cursor}'; else ${base}; fi`
    : base;
  return `boot=$(tr -d '-' < /proc/sys/kernel/random/boot_id) || exit 1; printf '%s\\n' "$boot"; ${resume}`;
}

/** One cursor and one in-flight read cover NV_ERR, Xid and OOM counters. */
export class KernelJournal {
  constructor(run, intervalMs, now = Date.now) {
    this.run = run;
    this.intervalMs = intervalMs;
    this.now = now;
    this.boot = null;
    this.cursor = null;
    this.totals = { nvErr: 0, xid: 0, oomKills: 0, lastXid: null };
    this.value = null;
    this.nextAt = 0;
    this.pending = null;
    this.complete = false;
  }

  read() {
    if (this.pending) return this.pending;
    if (this.now() < this.nextAt) return Promise.resolve(this.value);
    this.pending = this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }

  async poll() {
    try {
      const raw = await this.run(kernelJournalCommand(this.boot, this.cursor));
      const lines = raw.trim().split("\n");
      const boot = lines.shift();
      if (!BOOT_ID.test(boot ?? "")) throw new KernelJournalOutputError("Missing kernel boot ID");
      const totals = boot === this.boot ? { ...this.totals } : { nvErr: 0, xid: 0, oomKills: 0, lastXid: null };
      let cursor = boot === this.boot ? this.cursor : null;
      let entries = 0;
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith("-- cursor: ")) {
          cursor = line.slice(11);
          if (!CURSOR.test(cursor)) throw new KernelJournalOutputError("Invalid journal cursor");
          continue;
        }
        const entry = JSON.parse(line);
        // -k implies -b, so a foreign boot ID means the output is not what was asked for.
        if (entry._BOOT_ID !== boot) throw new KernelJournalOutputError("Invalid kernel journal entry");
        // journalctl renders a field holding non-UTF8 or non-printable bytes as an array of byte
        // values rather than a string — a driver logging a hex dump is enough. The record is
        // still consumed, because throwing here would leave the cursor unadvanced and re-read
        // the same page on every poll forever, freezing all three counters at a stale value
        // while new Xids went uncounted.
        const message = messageText(entry.MESSAGE);
        entries++;
        if (message == null) continue;
        if (message.includes("NV_ERR_NO_MEMORY")) totals.nvErr++;
        if (message.includes("NVRM: Xid")) {
          totals.xid++;
          const code = /Xid \([^)]*\):\s*(\d+)/.exec(message);
          totals.lastXid = code ? `Xid ${code[1]}` : message.replace(/[^\x20-\x7e]/g, "").slice(0, 80);
        }
        if (/Out of memory: Killed process|oom-kill:/.test(message)) totals.oomKills++;
      }
      if (entries > 0 && (!cursor || cursor === this.cursor)) {
        throw new KernelJournalOutputError("Kernel journal cursor did not advance");
      }
      this.complete = entries < KERNEL_JOURNAL_PAGE_SIZE;
      this.boot = boot;
      this.cursor = cursor;
      this.totals = totals;
      // Backfill one bounded page per normal GPU poll. Never publish partial since-boot totals.
      if (this.complete) this.value = { ...totals };
      else this.value = null;
      this.nextAt = this.now() + (this.complete ? this.intervalMs : 10_000);
    } catch (err) {
      // Never rethrow: read() is awaited inside the GPU metrics build, and a collector failure
      // must not stop the poll loop. The last complete reading is retained and the cursor is
      // left where it was, so nothing is double counted on the next attempt.
      const message = err instanceof Error ? err.message : String(err);
      this.nextAt = this.now() + this.intervalMs;
      console.warn(`[KernelJournal] Scan failed; retaining the last complete reading: ${message}`);
    }
    return this.value;
  }
}
