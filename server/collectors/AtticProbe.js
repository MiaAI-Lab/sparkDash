/**
 * AtticProbe — spark-attic on a GB10: whether it is installed and running, and
 * how much of the display carveout it lends to CUDA programs.
 *
 * spark-attic's atticd keeps a keyless status file
 * (/run/spark-attic/status.json, mode 0644, no key or address in it) that it
 * rewrites at least every `every_s` seconds and removes when it stops. Its
 * unit is attic.service; only the unit's systemd state is read.
 *
 * Command: one read-only shell line as the SSH user (no root, no socket, no
 * key, no new port). Every line it prints starts with "attic-probe ", so a
 * login banner is never read as data.
 */
import { ATTIC_PROBE_TIMEOUT_MS, HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";
import fs from "fs";
import path from "path";

/** atticd's keyless status file. */
export const ATTIC_STATUS_FILE = "/run/spark-attic/status.json";
/** spark-attic's systemd unit (atticd). */
export const ATTICD_UNIT = "attic.service";
/** A status file not rewritten for this many of its own periods means atticd is not running. */
export const STALE_PERIODS = 3;

const STATUS_DIR = path.posix.dirname(ATTIC_STATUS_FILE);

/**
 * POSIX sh, for the SSH user's login shell (bash, zsh or dash): the node's
 * clock, the status file (or why it cannot be read), and the unit's state.
 */
export const ATTIC_PROBE_COMMAND = [
  `printf 'attic-probe now %s\\n' "$(date +%s)"`,
  `if [ -d ${STATUS_DIR} ] && [ ! -x ${STATUS_DIR} ]; then printf 'attic-probe file unreadable\\n'; ` +
    `elif [ ! -e ${ATTIC_STATUS_FILE} ]; then printf 'attic-probe file none\\n'; ` +
    `elif [ ! -r ${ATTIC_STATUS_FILE} ]; then printf 'attic-probe file unreadable\\n'; ` +
    `else printf 'attic-probe json '; head -c 4096 ${ATTIC_STATUS_FILE} | tr -d '\\n'; printf '\\n'; fi`,
  `systemctl show -p LoadState -p ActiveState ${ATTICD_UNIT} 2>/dev/null | sed "s/^/attic-probe unit ${ATTICD_UNIT} /"`,
].join("; ");

const LINE = /^attic-probe (\S+)(?: (.*))?$/;
/** The status fields, all unknown: what a stale, unreadable or not understood status file carries. */
const NO_STATUS = Object.freeze({
  why: null,
  version: null,
  driver: null,
  mode: null,
  validated: null,
  validatedAt: null,
  sizeMib: null,
  freeMib: null,
  largestMib: null,
  lentMib: null,
  drainingMib: null,
  clients: null,
  ageS: null,
  everyS: null,
});
const UNIT_LINE = /^(\S+) (LoadState|ActiveState)=(\S*)$/;
const NO_UNIT = Object.freeze({ present: null, active: null, state: null });

/**
 * @param {unknown} v
 * @returns {number | null} a finite number ≥ 0, else null
 */
function count(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * attic.service as `systemctl show` reported it; nulls when it said nothing
 * (no systemd, or no bus to ask). `active` is true while it runs, false when
 * it is stopped or failed, and null while it starts or stops.
 * @param {{ LoadState?: string, ActiveState?: string } | undefined} u
 */
function unitState(u) {
  const load = u?.LoadState || null;
  const active = u?.ActiveState || null;
  if (load == null) return { ...NO_UNIT };
  if (load === "not-found") return { present: false, active: false, state: "not installed" };
  let running = null;
  if (active === "active" || active === "reloading") running = true;
  else if (active === "inactive" || active === "failed") running = false;
  return { present: true, active: running, state: active };
}

/**
 * spark-attic's status file at the node's own time. Only a fresh file
 * (rewritten within STALE_PERIODS of its period) carries numbers: a stale one
 * says when it was written and nothing about what is lent now.
 * @param {string} text
 * @param {number | null} now
 */
function readStatus(text, now) {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return { ...NO_STATUS, status: "unreadable", why: "the status file is not JSON" };
  }
  if (!s || typeof s !== "object" || s.name !== "spark-attic") {
    return { ...NO_STATUS, status: "unreadable", why: "not a spark-attic status file" };
  }
  const everyS = count(s.every_s);
  const updated = count(s.updated);
  const ageS = now != null && updated != null ? now - updated : null;
  const version = str(s.version);
  if (ageS == null || !everyS) return { ...NO_STATUS, status: "unknown", version, ageS, everyS };
  if (Math.abs(ageS) > STALE_PERIODS * everyS) return { ...NO_STATUS, status: "stale", version, ageS, everyS };
  return {
    status: s.state === "ready" || s.state === "refusing" ? s.state : "unknown",
    why: str(s.why),
    version,
    driver: str(s.driver),
    mode: str(s.mode),
    validated: typeof s.validated === "boolean" ? s.validated : null,
    validatedAt: str(s.validated_at),
    sizeMib: count(s.size_mib),
    freeMib: count(s.free_mib),
    largestMib: count(s.largest_mib),
    lentMib: count(s.lent_mib),
    drainingMib: count(s.draining_mib),
    clients: count(s.clients),
    ageS,
    everyS,
  };
}

/**
 * What spark-attic does on the unit. Numbers come only from a fresh status
 * file, which wins wherever atticd runs; a stale or unreadable one is never
 * taken for atticd running, and "off" and "not installed" need systemd's word.
 */
function stateOf(attic, atticd) {
  if (attic?.status === "ready") return "lending";
  if (attic?.status === "refusing") {
    // atticd lends only on a validated driver; with no driver loaded the reason is the driver, not validation
    const waitsForValidation = attic.validated === false && attic.driver != null && attic.driver !== "none";
    return waitsForValidation ? "unvalidated" : "refusing";
  }
  if (attic?.status === "stale" && atticd.present === true && atticd.active === false) return "off";
  if (attic) return "unknown";
  if (atticd.present === false) return "not installed";
  if (atticd.present === true && atticd.active === false) return "off";
  return "unknown";
}

/**
 * Normalize the probe's output into the fields the UI needs.
 * Pure (no I/O) — exported for unit tests.
 *
 * @param {string} out
 * @returns {object}
 */
export function parseAtticProbe(out) {
  let now = null;
  let file = null;
  let json = null;
  let seen = false;
  /** @type {Record<string, { LoadState?: string, ActiveState?: string }>} */
  const units = {};
  for (const raw of String(out ?? "").split("\n")) {
    const m = LINE.exec(raw.trimEnd());
    if (!m) continue;
    const [, key, rest = ""] = m;
    if (key === "now") {
      seen = true;
      now = /^\d+$/.test(rest) ? Number(rest) : null;
    } else if (key === "file" && (rest === "none" || rest === "unreadable")) {
      seen = true;
      file = rest;
    } else if (key === "json") {
      seen = true;
      file = "json";
      json = rest;
    } else if (key === "unit") {
      const u = UNIT_LINE.exec(rest);
      if (u) (units[u[1]] ??= {})[u[2]] = u[3];
    }
  }
  if (!seen) return null;

  const atticd = unitState(units[ATTICD_UNIT]);
  let attic = null;
  if (file === "json") attic = readStatus(json, now);
  else if (file === "unreadable") attic = { ...NO_STATUS, status: "unreadable", why: `cannot read ${ATTIC_STATUS_FILE}` };
  return {
    available: true,
    state: stateOf(attic, atticd),
    attic,
    atticd,
    error: null,
  };
}

export class AtticProbe {
  /**
   * @param {object} spark
   */
  constructor(spark) {
    this.spark = spark;
    this.error = null;
  }

  /** @param {object} spark */
  setTarget(spark) {
    this.spark = spark ?? this.spark;
    this.error = null;
  }

  dispose() {}

  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Local Docker: the status file and systemd live on the host, so enter the
   * host mount namespace (same approach as nvidia-smi and the Tailnet probe).
   * @param {string} cmd
   * @returns {Promise<string>}
   */
  async _execLocal(cmd) {
    const { execFile } = await import("child_process");
    const useHostNs = this._hasHostProc();
    const file = useHostNs ? "nsenter" : "sh";
    const args = useHostNs
      ? ["--mount=" + path.join(HOST_PATHS.PROC, "1", "ns", "mnt"), "--", "sh", "-c", cmd]
      : ["-c", cmd];
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: ATTIC_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || "").trim() || err.message));
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Never throws — on failure returns `_default()` with `error` set.
   * @returns {Promise<object>}
   */
  async probe() {
    let out;
    try {
      out = this.spark?.isLocal
        ? await this._execLocal(ATTIC_PROBE_COMMAND)
        : await sshExec(this.spark, ATTIC_PROBE_COMMAND, { timeoutMs: ATTIC_PROBE_TIMEOUT_MS });
    } catch (err) {
      this.error = err.message || "carveout probe failed";
      return this._default();
    }

    const parsed = parseAtticProbe(out);
    if (!parsed) {
      this.error = "Unrecognised carveout probe output";
      return this._default();
    }
    this.error = null;
    return parsed;
  }

  _default() {
    return {
      available: false,
      state: "unknown",
      attic: null,
      atticd: { ...NO_UNIT },
      error: this.error,
    };
  }
}
