export const KERNEL_JOURNAL_PAGE_SIZE = 10_000;
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
        if (entry._BOOT_ID !== boot || typeof entry.MESSAGE !== "string") {
          throw new KernelJournalOutputError("Invalid kernel journal entry");
        }
        entries++;
        if (entry.MESSAGE.includes("NV_ERR_NO_MEMORY")) totals.nvErr++;
        if (entry.MESSAGE.includes("NVRM: Xid")) {
          totals.xid++;
          const code = /Xid \([^)]*\):\s*(\d+)/.exec(entry.MESSAGE);
          totals.lastXid = code ? `Xid ${code[1]}` : entry.MESSAGE.replace(/[^\x20-\x7e]/g, "").slice(0, 80);
        }
        if (/Out of memory: Killed process|oom-kill:/.test(entry.MESSAGE)) totals.oomKills++;
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
      if (!(err instanceof Error)) throw err;
      this.nextAt = this.now() + this.intervalMs;
      console.warn(`[KernelJournal] Scan failed; retaining the last complete reading: ${err.message}`);
    }
    return this.value;
  }
}
