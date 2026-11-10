/**
 * Long-lived nvidia-smi readers.
 *
 * `nvidia-smi --query-gpu=... -lms N` and `nvidia-smi dmon -d N` keep printing
 * a sample every interval, so one process can replace a spawn per poll. This
 * module supervises such a process and keeps its latest complete sample:
 *
 *   - stdout is split into whole lines (a partial line waits for the rest);
 *   - a sample is only trusted while it is younger than `staleAfterMs`
 *     (3 intervals, at least 3 s); after that, or after the process exits,
 *     `read()` returns null instead of the last good value;
 *   - an exited process is restarted with exponential backoff, a silent one
 *     is killed and restarted;
 *   - `dispose()` and process exit kill the child.
 *
 * The child must be the reader itself (`exec nvidia-smi ...`), so a signal
 * sent to it reaches nvidia-smi. If Node dies without running its exit hooks
 * (SIGKILL), nvidia-smi's next write hits a closed pipe and it exits on
 * SIGPIPE, so an orphan lives for at most one interval.
 */

/** Never call a sample stale sooner than this, even at 1 s intervals. */
const MIN_STALE_MS = 3000;
/** No output at all for this long means the process is wedged. */
const MIN_HANG_MS = 15_000;
/** SIGTERM grace before SIGKILL. */
const KILL_GRACE_MS = 2000;
/** A line longer than this is not nvidia-smi output; drop it. */
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_STDERR_LENGTH = 4096;

/** Children still running, killed synchronously if the process exits first. */
const liveChildren = new Set();
let exitHookInstalled = false;

function track(child) {
  liveChildren.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const c of liveChildren) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

/** @param {number} intervalMs */
export function staleAfterMs(intervalMs) {
  return Math.max(MIN_STALE_MS, 3 * intervalMs);
}

/**
 * Groups `--query-gpu` loop output into one sample per tick. Each tick prints
 * one line per GPU in index order, with no separator between ticks, so a tick
 * ends when the index stops increasing. Once the GPU count is known, a tick is
 * published as soon as it has that many lines instead of when the next begins.
 * Lines with the wrong field count (error text) are ignored.
 * @param {{ fieldCount: number, indexField: number }} shape
 * @returns {{ onLine: (line: string) => string | null, reset: () => void }}
 */
export function gpuQueryAssembler({ fieldCount, indexField }) {
  let block = [];
  let lastIndex = -1;
  let published = false;
  let expected = 0;
  return {
    onLine(line) {
      const fields = line.split(",");
      const index = Number(fields[indexField]?.trim());
      if (fields.length !== fieldCount || fields[indexField]?.trim() === "" || !Number.isInteger(index)) return null;
      let sample = null;
      if (index <= lastIndex) {
        if (!published && block.length) sample = block.join("\n");
        expected = block.length;
        block = [];
        published = false;
      }
      block.push(line);
      lastIndex = index;
      if (expected > 0 && block.length >= expected) {
        // A card that appears mid-tick grows the expected count.
        expected = block.length;
        sample = block.join("\n");
        published = true;
      }
      return sample;
    },
    reset() {
      block = [];
      lastIndex = -1;
      published = false;
      expected = 0;
    },
  };
}

/** `dmon` prints `#` header lines (repeated now and then) and one data line per GPU. */
export function dmonAssembler() {
  return {
    onLine: (line) => (line.startsWith("#") || !line.trim() ? null : line),
    reset() {},
  };
}

export class NvidiaSmiStream {
  /**
   * @param {object} opts
   * @param {() => import("child_process").ChildProcess} opts.spawn starts the loop-mode process
   * @param {{ onLine: (line: string) => string | null, reset: () => void }} opts.assembler
   * @param {number} opts.intervalMs loop interval the process prints at
   * @param {(info: { code: number | null, signal: string | null, error?: Error, stderr: string, hadSample: boolean }) => void} [opts.onExit]
   *   called after every exit, before the restart is scheduled
   * @param {() => number} [opts.now]
   * @param {number} [opts.initialBackoffMs]
   * @param {number} [opts.maxBackoffMs]
   */
  constructor({ spawn, assembler, intervalMs, onExit = () => {}, now = Date.now, initialBackoffMs = 1000, maxBackoffMs = 30_000 }) {
    this._spawn = spawn;
    this._assembler = assembler;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs(intervalMs);
    this._hangAfterMs = Math.max(MIN_HANG_MS, 5 * intervalMs);
    this._onExitCb = onExit;
    this._now = now;
    this._initialBackoffMs = initialBackoffMs;
    this._maxBackoffMs = maxBackoffMs;
    this._backoffMs = initialBackoffMs;
    this._child = null;
    this._buffer = "";
    this._stderr = "";
    this._spawnedAt = 0;
    this._lastOutputAt = 0;
    this._gotSampleSinceSpawn = false;
    /** @type {{ value: string, at: number } | null} */
    this._sample = null;
    this._restartTimer = null;
    this._waiters = new Set();
    this._terminating = new WeakSet();
    this._disposed = false;
    /** Processes started so far (exposed for tests and diagnostics). */
    this.spawnCount = 0;
  }

  /**
   * The latest complete sample, or null when there is no fresh one. Starts
   * the process on first use. While a just-started process has not printed
   * its first sample yet, waits up to `waitMs` for it.
   * @param {{ waitMs?: number }} [opts]
   * @returns {Promise<string | null>}
   */
  async read({ waitMs = 0 } = {}) {
    if (this._disposed) return null;
    if (!this._child && !this._restartTimer) this._start();
    this._killIfHung();
    const fresh = this._fresh();
    if (fresh != null) return fresh;
    if (waitMs <= 0 || !this._child || this._gotSampleSinceSpawn) return null;
    return new Promise((resolve) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(waiter.timer);
          this._waiters.delete(waiter);
          resolve(value);
        },
        timer: setTimeout(() => waiter.resolve(null), waitMs),
      };
      waiter.timer.unref?.();
      this._waiters.add(waiter);
    });
  }

  /** Stop for good: cancel any restart and kill the process. */
  dispose() {
    this._disposed = true;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    this._sample = null;
    this._settleWaiters(null);
    const child = this._child;
    this._child = null;
    if (child) this._terminate(child);
  }

  get running() {
    return this._child != null;
  }

  _fresh() {
    if (!this._sample) return null;
    return this._now() - this._sample.at <= this.staleAfterMs ? this._sample.value : null;
  }

  _start() {
    this._buffer = "";
    this._stderr = "";
    this._gotSampleSinceSpawn = false;
    this._assembler.reset();
    let child;
    try {
      child = this._spawn();
      this.spawnCount += 1;
    } catch (error) {
      this._exited({ code: null, signal: null, error: /** @type {Error} */ (error), stderr: "" });
      return;
    }
    this._child = child;
    this._spawnedAt = this._now();
    this._lastOutputAt = 0;
    track(child);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this._onData(child, chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (this._stderr.length < MAX_STDERR_LENGTH) this._stderr += chunk;
    });
    child.on("error", (error) => this._onChildGone(child, { code: null, signal: null, error }));
    child.on("close", (code, signal) => this._onChildGone(child, { code, signal }));
    // Polling owns the lifetime; a reader must never keep Node alive by itself.
    child.unref?.();
    /** @type {any} */ (child.stdout)?.unref?.();
    /** @type {any} */ (child.stderr)?.unref?.();
  }

  _onData(child, chunk) {
    if (child !== this._child) return;
    this._lastOutputAt = this._now();
    this._buffer += chunk;
    let newline;
    while ((newline = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newline).replace(/\r$/, "");
      this._buffer = this._buffer.slice(newline + 1);
      const sample = this._assembler.onLine(line);
      if (sample != null) this._publish(sample);
    }
    if (this._buffer.length > MAX_LINE_LENGTH) this._buffer = "";
  }

  _publish(value) {
    this._sample = { value, at: this._now() };
    this._gotSampleSinceSpawn = true;
    this._backoffMs = this._initialBackoffMs;
    this._settleWaiters(value);
  }

  _onChildGone(child, info) {
    liveChildren.delete(child);
    if (child !== this._child) return;
    this._child = null;
    this._exited({ ...info, stderr: this._stderr.trim() });
  }

  _exited(info) {
    const hadSample = this._gotSampleSinceSpawn;
    // A dead reader's last line is not a current measurement.
    this._sample = null;
    this._settleWaiters(null);
    try {
      this._onExitCb({ ...info, hadSample });
    } catch {
      /* diagnostics only */
    }
    if (this._disposed) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._maxBackoffMs, this._backoffMs * 2);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._disposed && !this._child) this._start();
    }, delay);
    this._restartTimer.unref?.();
  }

  _killIfHung() {
    const child = this._child;
    if (!child) return;
    const lastSign = this._lastOutputAt || this._spawnedAt;
    if (this._now() - lastSign > this._hangAfterMs) this._terminate(child);
  }

  _terminate(child) {
    if (this._terminating.has(child)) return;
    this._terminating.add(child);
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
    child.once?.("close", () => clearTimeout(timer));
  }

  _settleWaiters(value) {
    for (const waiter of [...this._waiters]) waiter.resolve(value);
  }
}
