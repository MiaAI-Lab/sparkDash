/**
 * Pico (pico-dgx-ds4) decode from the engine's own front-end log.
 *
 * Pico publishes no counters, gauges or stats endpoint, so other clients'
 * traffic cannot be read over HTTP. Its front end (`dsfront`) does write one
 * line per finished request to stderr, which the recipe's service script
 * redirects to a file:
 *
 *   req 630 session 1881682407850016: prompt 55675 (cached 0), completion 1421, tool_calls; ttft 5.692 s, 128.8 tok/s
 *
 * This module follows that file. It finds the `dsfront serve` process that
 * listens on the probed port, opens whatever regular file its stderr points
 * to (through /proc, so no path is configured and nothing is assumed about the
 * install directory), and reads only the bytes appended since the last read.
 * It never reads history: following starts at the end of the file.
 *
 * What it yields is what the engine measured, placed in time: a request that
 * ended at the read that saw it, with `completion / tok_s` seconds of decode
 * before that. The decode rate is the tokens those requests produced inside a
 * trailing one-minute window. A request still running is not in the log yet, so the
 * figure trails live traffic by up to one request and is labelled as such.
 *
 * Read-only, Linux units only. Any failure (no such process, stderr not a
 * regular file, no permission, SSH down) leaves the source unavailable and the
 * probe behaves exactly as it does without it.
 */
import fs from "node:fs";
import path from "node:path";
import { HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";

/** The front end's process name (comm) in the pico-dgx-ds4 recipe. */
const FRONT_COMM = "dsfront";
/** `dsfront serve` listens here when no `--listen` is given. */
const FRONT_DEFAULT_PORT = 18890;
/**
 * Trailing window the decode rate is taken over. A request is only known once
 * it has ended, so the window must be longer than ordinary requests: with a
 * short one the figure would sit at zero while requests run and flash when
 * they end. A minute keeps back-to-back traffic steady.
 */
export const PICO_LOG_WINDOW_MS = 60_000;
/** Minimum spacing between reads of the log. */
export const PICO_LOG_MIN_INTERVAL_MS = 4_000;
/** Most bytes taken per read; a longer backlog is drained over the next reads. */
export const PICO_LOG_MAX_READ_BYTES = 256 * 1024;
/** After a failed lookup the process list is not searched again for this long. */
const REDISCOVER_INTERVAL_MS = 30_000;
/** A gap between reads longer than this cannot place its requests in time: they count as tokens, not as rate. */
const MAX_PLACEABLE_GAP_MS = 60_000;
/** A partial last line longer than this is not a request line; drop it. */
const MAX_PARTIAL_LINE = 4_096;
const SSH_MARK = "SPARKDASH_PICO_LOG";

const REQUEST_LINE =
  /^req (\d+) session \S+: prompt (\d+) \(cached (\d+)\), completion (\d+), [a-z_]+; ttft (\d+(?:\.\d+)?) s, (\d+(?:\.\d+)?) tok\/s\s*$/;

/**
 * @typedef {{ reqId: number, promptTokens: number, cachedTokens: number, completionTokens: number,
 *   ttftSeconds: number, decodeTps: number }} PicoRequest
 */

/**
 * Finished requests in a piece of the log. `carry` is the unfinished last line
 * of the previous piece; the unfinished last line of this one is returned as
 * `rest`. Lines that are not a finished request are ignored.
 * @param {string} text
 * @param {string} [carry]
 * @returns {{ requests: PicoRequest[], rest: string }}
 */
export function parsePicoFrontLog(text, carry = "") {
  const lines = (carry + (typeof text === "string" ? text : "")).split("\n");
  let rest = lines.pop() ?? "";
  if (rest.length > MAX_PARTIAL_LINE) rest = "";
  /** @type {PicoRequest[]} */
  const requests = [];
  for (const line of lines) {
    const m = REQUEST_LINE.exec(line);
    if (!m) continue;
    const request = {
      reqId: Number(m[1]),
      promptTokens: Number(m[2]),
      cachedTokens: Number(m[3]),
      completionTokens: Number(m[4]),
      ttftSeconds: Number(m[5]),
      decodeTps: Number(m[6]),
    };
    if (Object.values(request).every((v) => Number.isFinite(v) && v >= 0)) requests.push(request);
  }
  return { requests, rest };
}

/**
 * Decode tok/s over the window that ends at `nowMs`, from requests that have
 * finished. Each request's tokens are spread evenly over its own decode time
 * (`completion / tok_s`, ending when it was seen); only the part inside the
 * window counts.
 * @param {{ endMs: number, completionTokens: number, decodeTps: number }[]} placed
 * @param {number} nowMs
 * @param {number} [windowMs]
 * @returns {number}
 */
export function picoWindowDecodeTps(placed, nowMs, windowMs = PICO_LOG_WINDOW_MS) {
  if (!Array.isArray(placed) || !(windowMs > 0)) return 0;
  const from = nowMs - windowMs;
  let tokens = 0;
  for (const r of placed) {
    if (!(r.completionTokens > 0) || !(r.endMs > from)) continue;
    const end = Math.min(r.endMs, nowMs);
    const decodeMs = r.decodeTps > 0 ? (r.completionTokens / r.decodeTps) * 1000 : 0;
    if (!(decodeMs > 0)) {
      tokens += r.completionTokens;
      continue;
    }
    const start = r.endMs - decodeMs;
    const overlap = end - Math.max(start, from);
    if (overlap > 0) tokens += r.completionTokens * Math.min(1, overlap / decodeMs);
  }
  return tokens / (windowMs / 1000);
}

/** True when `argv` is a `dsfront serve` that listens on `port`. */
export function picoFrontListensOn(argv, port) {
  if (!Array.isArray(argv) || !argv.includes("serve")) return false;
  const listens = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === "--listen") listens.push(argv[i + 1]);
  if (listens.length === 0) return port === FRONT_DEFAULT_PORT;
  return listens.some((addr) => typeof addr === "string" && addr.endsWith(`:${port}`));
}

/** Where the front-end's log position stands after a read, by the same rule on every transport. */
function nextOffset({ samePlace, size, offset }) {
  if (!samePlace) return size; // a file not followed before: start at its end, never its history
  if (size < offset) return 0; // truncated in place (the recipe rotates a live log by copy and truncate)
  return offset;
}

/**
 * Local read through /proc. In a container the host's /proc is mounted at
 * HOST_PATHS.PROC; on bare metal that path does not exist and /proc is used.
 * @returns {{ pid: number, inode: number, size: number, offset: number, text: string } | null}
 */
export function readPicoLogLocal({ port, pid, inode, offset, procRoot, maxBytes = PICO_LOG_MAX_READ_BYTES }) {
  const root = procRoot ?? (fs.existsSync(HOST_PATHS.PROC) ? HOST_PATHS.PROC : "/proc");
  const isFront = (candidate) => {
    try {
      if (fs.readFileSync(path.join(root, String(candidate), "comm"), "utf8").trim() !== FRONT_COMM) return false;
      const argv = fs.readFileSync(path.join(root, String(candidate), "cmdline"), "utf8").split("\0");
      return picoFrontListensOn(argv, port);
    } catch {
      return false;
    }
  };
  let found = Number.isInteger(pid) && isFront(pid) ? pid : null;
  if (found == null) {
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      return null;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      if (isFront(Number(name))) {
        found = Number(name);
        break;
      }
    }
  }
  if (found == null) return null;
  let fd;
  try {
    fd = fs.openSync(path.join(root, String(found), "fd", "2"), "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = nextOffset({ samePlace: found === pid && stat.ino === inode, size: stat.size, offset });
    const want = Math.min(stat.size - start, maxBytes);
    const buffer = Buffer.alloc(Math.max(0, want));
    const got = want > 0 ? fs.readSync(fd, buffer, 0, want, start) : 0;
    return { pid: found, inode: stat.ino, size: stat.size, offset: start + got, text: buffer.toString("utf8", 0, got) };
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch { /* already closed */ }
    }
  }
}

/**
 * The one read-only program a remote read runs. Every interpolated value is a
 * run of digits. The data is followed by an end line of its own, so the bytes
 * read are exact whatever the transport trims.
 */
export function picoLogRemoteProgram({ port, pid, inode, offset, maxBytes = PICO_LOG_MAX_READ_BYTES }) {
  const int = (v) => (/^\d{1,20}$/.test(String(v)) ? String(v) : "0");
  const match =
    port === FRONT_DEFAULT_PORT
      ? `case " $a " in *" serve "*) case " $a " in *" --listen "*":${int(port)} "*) p=$c;; *" --listen "*) ;; *) p=$c;; esac;; esac`
      : `case " $a " in *" serve "*) case " $a " in *" --listen "*":${int(port)} "*) p=$c;; esac;; esac`;
  return [
    `p=""`,
    `for c in $(pgrep -x ${FRONT_COMM} 2>/dev/null); do a=$(tr '\\0' ' ' < /proc/$c/cmdline 2>/dev/null); ${match}; [ -n "$p" ] && break; done`,
    `[ -n "$p" ] || { echo "${SSH_MARK} none"; exit 0; }`,
    `f=/proc/$p/fd/2`,
    `[ -f "$f" ] && [ -r "$f" ] || { echo "${SSH_MARK} none"; exit 0; }`,
    `set -- $(stat -L -c '%s %i' "$f" 2>/dev/null)`,
    `s=$1; i=$2`,
    `[ -n "$s" ] && [ -n "$i" ] || { echo "${SSH_MARK} none"; exit 0; }`,
    `o=${int(offset)}`,
    `if [ "$p" != "${int(pid)}" ] || [ "$i" != "${int(inode)}" ]; then o=$s; elif [ "$s" -lt "$o" ]; then o=0; fi`,
    `n=$((s-o)); [ "$n" -gt ${int(maxBytes)} ] && n=${int(maxBytes)}`,
    `echo "${SSH_MARK} ok $p $i $s $o $n"`,
    `[ "$n" -gt 0 ] && tail -c +$((o+1)) "$f" | head -c "$n"`,
    `printf '\\n%s end\\n' "${SSH_MARK}"`,
    `exit 0`,
  ].join("\n");
}

/** Parse the remote program's answer; null when it found nothing or the answer is not its own. */
export function parsePicoLogRemote(stdout) {
  if (typeof stdout !== "string") return null;
  const newline = stdout.indexOf("\n");
  const header = (newline < 0 ? stdout : stdout.slice(0, newline)).trim().split(" ");
  if (header[0] !== SSH_MARK || header[1] !== "ok") return null;
  if (header.length !== 7 || !header.slice(2).every((v) => /^\d{1,20}$/.test(v))) return null;
  const [pid, , size, offset, count] = header.slice(2).map(Number);
  if (![pid, size, offset, count].every(Number.isSafeInteger)) return null;
  const end = stdout.lastIndexOf(`\n${SSH_MARK} end`);
  if (newline < 0 || end < newline) return null; // cut short: read the same bytes again next time
  // The inode stays a string of digits: it is only ever compared, and may not fit a double.
  return { pid, inode: header[3], size, offset: offset + count, text: stdout.slice(newline + 1, end) };
}

/**
 * Follows one Pico front-end log for one probed port.
 */
export class PicoFrontLog {
  /**
   * @param {{ isLocal?: boolean, platform?: string, kind?: string, llmHost?: string }} spark
   * @param {number} port
   * @param {{ now?: () => number, readLocal?: Function, exec?: Function }} [options] replaceable in tests
   */
  constructor(spark, port, options = {}) {
    this.spark = spark;
    this.port = port;
    this._now = typeof options.now === "function" ? options.now : Date.now;
    this._readLocal = typeof options.readLocal === "function" ? options.readLocal : readPicoLogLocal;
    this._exec = typeof options.exec === "function" ? options.exec : sshExec;
    this._busy = false;
    this.reset();
  }

  /** Whether this unit can be read at all: a Linux unit whose engine runs on the unit itself. */
  supported() {
    const s = this.spark;
    if (!s || s.kind === "mac" || s.platform === "windows" || s.platform === "darwin") return false;
    // `llmHost` pins the engine to another machine than the one SSH reaches.
    return !(typeof s.llmHost === "string" && s.llmHost.trim());
  }

  /** Forget the file and everything counted from it (the engine went away or changed). */
  reset() {
    this._pid = null;
    this._inode = null;
    this._offset = 0;
    this._carry = "";
    this._lastReadAt = 0;
    this._lastOkAt = 0;
    this._retryAt = 0;
    this._attached = false;
    /** @type {{ endMs: number, completionTokens: number, decodeTps: number }[]} */
    this._placed = [];
    this._totals = { output: 0, prompt: 0, cached: 0 };
  }

  async _read() {
    const args = { port: this.port, pid: this._pid ?? -1, inode: this._inode ?? -1, offset: this._offset };
    if (this.spark?.isLocal) return this._readLocal(args);
    const stdout = await this._exec(this.spark, picoLogRemoteProgram(args), { timeoutMs: 5_000, maxBuffer: 1024 * 1024 });
    return parsePicoLogRemote(stdout);
  }

  /**
   * Read what the front end appended and return the current figures, or null
   * while the log cannot be followed.
   * @returns {Promise<{ generationTps: number, totalOutputTokens: number, totalPromptTokens: number,
   *   totalCachedTokens: number } | null>}
   */
  async poll() {
    if (!this.supported()) return null;
    const now = this._now();
    const due = now - this._lastReadAt >= PICO_LOG_MIN_INTERVAL_MS && now >= this._retryAt;
    if (due && !this._busy) {
      this._busy = true;
      this._lastReadAt = now;
      try {
        const read = await this._read();
        if (!read) {
          this._detach(now);
        } else {
          const sameFile = read.pid === this._pid && read.inode === this._inode;
          if (!sameFile) {
            // Another process or file: nothing counted from the old one carries over.
            this._carry = "";
            this._placed = [];
          }
          const { requests, rest } = parsePicoFrontLog(read.text, this._carry);
          this._carry = rest;
          const placeable = sameFile && now - this._lastOkAt <= MAX_PLACEABLE_GAP_MS;
          for (const r of requests) {
            this._totals.output += r.completionTokens;
            this._totals.prompt += r.promptTokens;
            this._totals.cached += r.cachedTokens;
            if (placeable) this._placed.push({ endMs: now, completionTokens: r.completionTokens, decodeTps: r.decodeTps });
          }
          this._pid = read.pid;
          this._inode = read.inode;
          this._offset = read.offset;
          this._attached = true;
          this._lastOkAt = now;
        }
      } catch {
        this._detach(now);
      } finally {
        this._busy = false;
      }
    }
    if (!this._attached) return null;
    this._placed = this._placed.filter((r) => r.endMs > now - PICO_LOG_WINDOW_MS);
    return {
      generationTps: picoWindowDecodeTps(this._placed, now),
      totalOutputTokens: this._totals.output,
      totalPromptTokens: this._totals.prompt,
      totalCachedTokens: this._totals.cached,
    };
  }

  /**
   * The log cannot be followed right now. The place in the file and the totals
   * are kept, so a read that finds the same process and file again resumes
   * where it stopped; a different one starts at its end.
   */
  _detach(now) {
    this._attached = false;
    this._placed = [];
    this._retryAt = now + REDISCOVER_INTERVAL_MS;
  }
}
