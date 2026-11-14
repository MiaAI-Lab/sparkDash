/**
 * On-unit programs for the Storage Manager. The scripts live in ./scripts as real shell files;
 * this module wraps one of them for the unit and parses what it prints.
 *
 * Nothing from a request ever reaches a shell as script text. The script body and each argument
 * (a path, an image ID) travel base64-encoded and are decoded into variables, then handed to the
 * script as positional parameters. Privilege: root runs it directly, anyone else uses `sudo -n`,
 * or `sudo -S` with a password typed in the dashboard. That password arrives in $SPARKDASH_SUDO_PW
 * (set by the runner from stdin), is moved to a plain variable at once and is only ever piped to sudo.
 */
import fs from "node:fs";
import { hasUnsafeName, parentOf, parseAbsolutePath } from "./policy.js";

const SCRIPT_DIR = new URL("./scripts/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, SCRIPT_DIR), "utf8");

const COMMON = read("common.sh");
/** Delete v2 (stage-then-delete): the perl helper as $SD_PL, then the shared rename/staging functions. */
const SD_PL = read("sdhelper.pl")
  .split("\n")
  .filter((l) => !/^\s*(#.*)?$/.test(l)) // whole-line comments and blank lines: the program travels on a command line
  .join("\n");
const STAGING = `SD_PL='${SD_PL.replaceAll("'", "'\\''")}'\n${read("staging.sh")}`;
const SCRIPTS = Object.freeze({
  status: { body: read("status.sh"), shell: "sh" },
  dirs: { body: read("dirs.sh"), shell: "sh" },
  scan: { body: read("scan.sh"), shell: "bash" },
  // `account`: the acting account (uid, gid, home) is worked out before any sudo and goes in front of the arguments.
  delete: { body: `${STAGING}\n${read("delete.sh")}`, shell: "sh", account: true },
  quarantine: { body: `${STAGING}\n${read("quarantine.sh")}`, shell: "sh", account: true },
  // The same program's read-only `list`, under its own name so it does not wait for the unit lock.
  quarantineList: { body: `${STAGING}\n${read("quarantine.sh")}`, shell: "sh", account: true },
  dockerList: { body: read("docker-list.sh"), shell: "sh" },
  dockerRemove: { body: read("docker-remove.sh"), shell: "sh" },
  dockerRemoveContainers: { body: read("docker-rm.sh"), shell: "sh" },
  // Clear unused build cache on the daemon's own builder (see builderPrune.js).
  dockerBuilderPrune: { body: read("docker-builder-prune.sh"), shell: "sh" },
  context: { body: read("context.sh"), shell: "sh" },
  // Status of, or stop, one scan job (see unit-state.sh).
  job: { body: `${read("unit-state.sh")}\n${read("job.sh")}`, shell: "bash" },
  // Read-only evidence for the delete advisor (see advice.js). Never elevated, never takes the unit lock.
  advise: { body: read("advise.sh"), shell: "sh" },
});
/** Unit lock, scan job records and process identity checks (see the file's header). */
const UNIT_STATE = read("unit-state.sh");
/** How long a program waits for the unit lock before reporting `unit-busy`. */
const UNIT_LOCK_WAIT_SECONDS = 5;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (v) => typeof v === "string" && JOB_ID.test(v);

export const SCAN_MAX_DEPTH = 6;
/** Most rows one scan reports; smaller items are summed into "smaller items" by the dashboard. */
export const SCAN_MAX_ROWS = 4000;
/** The unit gives up on a scan after this long and reports what it has. */
export const SCAN_LIMIT_SECONDS = 900;
/** Folders at the depth limit are measured this many at a time (the unit caps it at its CPU count). */
export const SCAN_PARALLEL = 8;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
/** The acting account, resolved as that account before any sudo: uid, gid and home go in front of "$@". */
const ACCOUNT_ARGS = [
  "SPD_U=$(id -u); SPD_G=$(id -g); SPD_H=${HOME-}",
  '[ -n "$SPD_H" ] || SPD_H=$(getent passwd "$SPD_U" 2>/dev/null | cut -d: -f6)',
  'set -- "$SPD_U" "$SPD_G" "$SPD_H" "$@"',
].join("\n");

/** A sudo password typed in the dashboard, or null. Throws 400 for anything that is not a plain line. */
export function parseSudoPassword(v) {
  if (v === undefined || v === null || v === "") return null;
  // eslint-disable-next-line no-control-regex
  if (typeof v !== "string" || v.length > 256 || /[\r\n\u0000]/.test(v)) {
    throw Object.assign(new Error("sudoPassword must be a single line of at most 256 characters"), { status: 400 });
  }
  return v;
}

function sudoGate(password) {
  return [
    "SUDO_ERR=''",
    "need_sudo() {",
    '  [ -z "$SUDO" ] && return 0',
    "  command -v sudo >/dev/null 2>&1 || { SUDO_ERR=__missing__; return 1; }",
    password
      ? "  SUDO_ERR=$(printf '%s\\n' \"$PW\" | LC_ALL=C sudo -k -S -p '' true 2>&1 >/dev/null) && return 0"
      : "  sudo -n true >/dev/null 2>&1 && return 0",
    "  return 1",
    "}",
    "need_sudo || { case \"$SUDO_ERR\" in",
    '  __missing__) fail no-sudo "sudo is not installed on this Spark" ;;',
    password
      ? [
          '  "") fail bad-password "The sudo password was not accepted" ;;',
          '  *"incorrect password"*|*"Sorry, try again"*|*"password is required"*|*"Authentication failure"*) fail bad-password "The sudo password was not accepted" ;;',
        ].join("\n")
      : '  "") fail no-sudo "This needs administrator rights, and sudo on this Spark asks for a password" ;;',
    '  *) fail no-sudo "sudo refused the request: $(clean "$SUDO_ERR")" ;;',
    "esac; }",
  ].join("\n");
}

/**
 * The program text to send to a unit.
 * @param {keyof typeof SCRIPTS} name
 * @param {{ args?: (string | number)[], elevate?: boolean, password?: boolean, unitLock?: boolean,
 *   job?: string | null, hardLimitSeconds?: number }} [opts]
 *   `password`: a sudo password will arrive on stdin (see runProgram's `input`).
 *   `unitLock`: take the unit lock first (one scan or change at a time per account, even across dashboards);
 *   the program and every process it starts keep it until the last of them is gone.
 *   `job`: a scan job id. Without sudo the program runs in its own session (setsid), records who it is first
 *   thing, and every process carries the job's tag, so the `job` program can stop it. A root process started
 *   through sudo cannot be signalled by the account, so with sudo none of this happens.
 *   `hardLimitSeconds`: the unit ends the program after this long (as root when it runs through sudo).
 *   `lockWaitSeconds`: how long to wait for the unit lock before answering `unit-busy`.
 */
export function buildProgram(name, { args = [], elevate = false, password = false, unitLock = false, job = null, hardLimitSeconds = 0, lockWaitSeconds = UNIT_LOCK_WAIT_SECONDS } = {}) {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`unknown storage program: ${name}`);
  const argList = args.map(String);
  if (argList.some((a) => a.includes("\0"))) throw new Error("argument contains a NUL byte");
  if (job != null && !isJobId(job)) throw new Error("not a job id");
  if (!Number.isInteger(hardLimitSeconds) || hardLimitSeconds < 0) throw new Error("hardLimitSeconds must be a whole number");
  const inner = job ? `${COMMON}\n${UNIT_STATE}\nsd_job_record\n${script.body}` : `${COMMON}\n${script.body}`;
  const capped = hardLimitSeconds > 0 ? `timeout -k 10 ${hardLimitSeconds} ` : "";
  const run = `${capped}${script.shell} -c "$BODY" sparkdash-storage "$@"`;
  const wrapped = unitLock || job != null;
  const lines = [
    "set -u",
    ...(elevate && password
      ? [
          "PW=${SPARKDASH_SUDO_PW-}",
          "unset SPARKDASH_SUDO_PW",
          "spw_sudo() { printf '%s\\n' \"$PW\" | LC_ALL=C sudo -S -p '' \"$@\"; }",
        ]
      : []),
    'SUDO=""',
    elevate ? `[ "$(id -u)" = 0 ] || SUDO="${password ? "spw_sudo" : "sudo -n"}"` : ":",
    COMMON,
    sudoGate(elevate && password),
    "dec() { printf '%s' \"$1\" | base64 -d; }",
    `command -v ${script.shell} >/dev/null 2>&1 || fail no-${script.shell} "${script.shell} is not installed on this Spark"`,
    `BODY=$(dec '${b64(inner)}')`,
    argList.length === 0 ? "set --" : `set -- ${argList.map((a) => `"$(dec '${b64(a)}')"`).join(" ")}`,
    ...(script.account ? [ACCOUNT_ARGS] : []),
    ...(wrapped ? unitStateLines({ unitLock, job, run, lockWaitSeconds }) : [`$SUDO ${run}`]),
  ];
  return lines.join("\n");
}

/** The end of a program that takes the unit lock and/or runs as a stoppable job (see buildProgram). */
function unitStateLines({ unitLock, job, run, lockWaitSeconds }) {
  if (!Number.isInteger(lockWaitSeconds) || lockWaitSeconds < 0) throw new Error("lockWaitSeconds must be a whole number");
  return [
    UNIT_STATE,
    'sd_state_init || fail no-state "The dashboard keeps its state on the Spark in ~/.local/state/sparkdash, which could not be created or is not a private folder of this account"',
    ...(unitLock
      ? [
          `sd_lock ${lockWaitSeconds}`,
          'case $? in 0) ;; 1) fail unit-busy "Another dashboard, or storage work that has not finished yet, is using this Spark\'s storage. Try again in a moment." ;; *) fail no-state "The storage lock on this Spark could not be used" ;; esac',
        ]
      : []),
    ...(job != null
      ? [
          'if [ -z "$SUDO" ]; then',
          `  SPARKDASH_JOB=${job}`,
          '  sd_job_prepare "$SPARKDASH_JOB" || fail no-state "The dashboard\'s job folder on this Spark could not be created"',
          "  SPARKDASH_JOB_DIR=$SD_JOB_DIR",
          "  export SPARKDASH_JOB SPARKDASH_JOB_DIR",
          '  SETSID=""',
          '  setsid -w true >/dev/null 2>&1 && SETSID="setsid -w"',
          `  $SETSID ${run}`,
          "  SD_RC=$?",
          '  sd_job_end "$SD_RC"',
          "else",
          `  $SUDO ${run}`,
          "  SD_RC=$?",
          "fi",
        ]
      : [`$SUDO ${run}`, "SD_RC=$?"]),
    "sd_unlock",
    'exit "$SD_RC"',
  ];
}

/** `KEY=value` lines as [key, value] pairs, in order. */
export function parsePairs(out) {
  const pairs = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) pairs.push([m[1], m[2]]);
  }
  return pairs;
}

/** First value for each key. */
function firstValues(pairs) {
  const res = {};
  for (const [k, v] of pairs) if (!(k in res)) res[k] = v.slice(0, 300);
  return res;
}

const BAD_OUTPUT = { ok: false, code: "bad-output", message: "The Spark returned an unexpected answer" };

/** Pull RESULT/CODE/MSG out of a program's answer. */
export function programResult(out) {
  const res = firstValues(parsePairs(out));
  if (res.RESULT === "ok") return { ok: true, values: res };
  if (res.RESULT === "error") return { ok: false, code: res.CODE || "failed", message: res.MSG || "The Spark refused the request", values: res };
  return BAD_OUTPUT;
}

const parseCount = (v) => (/^\d+$/.test(v ?? "") ? Number(v) : null);

/**
 * @typedef {{ source: string, fstype: string, mount: string, totalBytes: number, usedBytes: number, availBytes: number }} Filesystem
 */

/** Filesystems worth showing: real disks, once each (a bind mount repeats its device). */
export function parseFilesystems(pairs) {
  const SKIP_TYPES = new Set(["tmpfs", "devtmpfs", "squashfs", "overlay", "efivarfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "ramfs", "fuse.lxcfs"]);
  /** @type {Map<string, Filesystem>} */
  const bySource = new Map();
  for (const [k, v] of pairs) {
    if (k !== "FS") continue;
    const t = v.trim().split(/\s+/);
    if (t.length < 7) continue;
    const [source, fstype, size, used, avail] = t;
    const mount = t.slice(6).join(" ");
    if (SKIP_TYPES.has(fstype) || !source.startsWith("/dev/")) continue;
    if (![size, used, avail].every((n) => /^\d+$/.test(n))) continue;
    const row = { source, fstype, mount, totalBytes: Number(size), usedBytes: Number(used), availBytes: Number(avail) };
    const have = bySource.get(source);
    if (!have || mount.length < have.mount.length) bySource.set(source, row);
  }
  return [...bySource.values()].sort((a, b) => b.totalBytes - a.totalBytes);
}

export function parseStatusOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const pairs = parsePairs(out);
  const v = firstValues(pairs);
  return {
    ok: true,
    user: v.USER || null,
    sudo: ["root", "yes", "no"].includes(v.SUDO) ? v.SUDO : "no",
    filesystems: parseFilesystems(pairs),
    docker: {
      state: ["ok", "missing", "denied", "down"].includes(v.DOCKER) ? v.DOCKER : "down",
      rootDir: v.DOCKER_ROOT || null,
    },
    // Where "Home folder" points: this account's home, or (when the account is root) the people's homes under /home.
    homeDir: v.HOME_DIR && v.HOME_DIR.startsWith("/") ? v.HOME_DIR : null,
    peopleHomes: pairs.filter(([k]) => k === "PEOPLE_HOME").map(([, d]) => d).filter((d) => /^\/home\/[^/]+$/.test(d)),
    // Changes on every reboot: a cached execution context from before it is stale.
    bootId: BOOT_ID.test(v.BOOT_ID ?? "") ? v.BOOT_ID : null,
  };
}

/** The folders inside one folder, for the picker: safe names only, sorted, with whether the list was cut. */
export function parseDirsOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const names = parsePairs(out)
    .filter(([k]) => k === "D")
    .map(([, n]) => n)
    .filter((n) => n !== "" && n !== "." && n !== ".." && !n.includes("/") && !hasUnsafeName(n));
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return { ok: true, dirs: unique.slice(0, DIRS_MAX), more: names.length > DIRS_MAX };
}
export const DIRS_MAX = 800;

const BOOT_ID = /^[0-9a-f-]{8,64}$/;
const NAMESPACES = ["mnt", "pid", "user", "net", "cgroup", "uts"];
/** Tool lines of context.sh and the capability each one grants. */
const CONTEXT_TOOLS = { SYSTEMD_RUN: "systemd-run", PERL: "perl", FINDMNT: "findmnt", DOCKER: "docker", BUILDX: "buildx", SETSID: "setsid", FLOCK: "flock" };

/**
 * The execution-context probe (context.sh): who the programs run as, where, and which tools are there.
 * Tolerant: a missing or malformed line reads as unknown (null) or "not available", never as present.
 * `capabilities` is the list features are checked against (see context.js).
 */
export function parseContextOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const v = r.values;
  const uid = parseCount(v.UID);
  const nsId = (x) => (/^\d{1,20}$/.test(x ?? "") ? x : null);
  // eslint-disable-next-line no-control-regex
  const absPath = (x) => (typeof x === "string" && x.startsWith("/") && !/[\u0000-\u001f]/.test(x) ? x : null);
  const namespaces = Object.fromEntries(NAMESPACES.map((k) => [k, nsId(v[`NS_${k.toUpperCase()}`])]));
  const initNamespaces = { mnt: nsId(v.INIT_NS_MNT), pid: nsId(v.INIT_NS_PID) };
  // Known only when PID 1's namespace could be read (root): otherwise null, never a guess.
  const hostPidNs = namespaces.pid && initNamespaces.pid ? namespaces.pid === initNamespaces.pid : null;
  const home = absPath(v.HOME);
  const accountHome = absPath(v.ACCOUNT_HOME);
  const sudo = uid === 0 ? "root" : v.SUDO === "yes" ? "yes" : "no";
  const linger = v.LINGER === "yes" || v.LINGER === "no" ? v.LINGER : "unknown";
  const tools = Object.fromEntries(Object.entries(CONTEXT_TOOLS).map(([key, cap]) => [cap, v[key] === "yes"]));
  const capabilities = [
    ...(uid === 0 ? ["root"] : []),
    ...(sudo === "yes" ? ["sudo-n"] : []),
    ...Object.entries(tools).filter(([, on]) => on).map(([cap]) => cap),
    ...(linger === "yes" ? ["linger"] : []),
    ...(hostPidNs === true ? ["host-pid-ns"] : []),
    ...(home && accountHome && home === accountHome ? ["account-home"] : []),
  ];
  return {
    ok: true,
    uid,
    account: /^[A-Za-z0-9._-]{1,64}$/.test(v.ACCOUNT ?? "") ? v.ACCOUNT : null,
    home,
    accountHome,
    hostname: /^[A-Za-z0-9.-]{1,253}$/.test(v.HOSTNAME ?? "") ? v.HOSTNAME : null,
    bootId: BOOT_ID.test(v.BOOT_ID ?? "") ? v.BOOT_ID : null,
    namespaces,
    initNamespaces,
    hostPidNs,
    inContainer: v.IN_CONTAINER === "1",
    sudo,
    linger,
    tools,
    capabilities,
  };
}

const TYPE_NAMES = { d: "dir", f: "file", l: "link", o: "other" };

const normalizePath = (p) => {
  const path = p.replace(/^\/\/+/, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
};
const underRoot = (path, root) => path === root || root === "/" || path.startsWith(`${root}/`);

/**
 * Add own sizes up into folder totals. Each atom's bytes count for its own path and for every folder above
 * it, up to the scanned root: a folder's total is its own size plus everything the atoms say is inside it.
 *
 * Hard links: the sums above count a file once per link. `links` corrects that for every folder that holds a
 * file with more than one link: `m` maps a folder to { occ, once, shared } (bytes counted per link, bytes
 * counted once, and bytes of files that also have links outside the folder); `x` is the set of big files that
 * have other links. A row's `bytes` is then what the folder holds with each file counted once (what `du -s`
 * of that folder alone says) and `sharedBytes` is the part that deleting the folder would NOT free.
 * @param {{ path: string, bytes: number, type: "dir" | "file" | "link" | "other" | null }[]} atoms
 * @param {string} root
 * @param {number} maxRows
 * @param {{ m: Map<string, { occ: number, once: number, shared: number }>, x: Set<string> } | null} [links]
 * @param {{ stamps: { path: string, mtime: number }[], undated?: string[] } | null} [dates]
 *   Dates, added up the same way: `stamps` are newest modification times at or under a path (an entry's own
 *   time, the newest of the small files in a folder, the newest of everything in a folder measured whole). Each
 *   counts for its path and every folder above it, so a row's `modifiedAt` is the newest time of anything in it.
 *   `undated` are folders measured whole whose newest time did not come back: neither they nor any folder above
 *   them gets a date (it would only be a lower bound). A row without a known time has no `modifiedAt`.
 * @returns {{ path: string, bytes: number, type: "dir" | "file" | "link" | "other", sharedBytes: number, modifiedAt?: number }[]}
 */
export function totalsFromAtoms(atoms, root, maxRows, links = null, dates = null) {
  const totals = new Map();
  const types = new Map();
  for (const a of atoms) {
    if (a.type) types.set(a.path, a.type);
    for (let q = a.path; ; q = parentOf(q)) {
      totals.set(q, (totals.get(q) ?? 0) + a.bytes);
      if (q === root) break;
    }
  }
  /** @type {Map<string, number>} newest modification time at or under each path */
  const newest = new Map();
  for (const s of dates?.stamps ?? []) {
    for (let q = s.path; ; q = parentOf(q)) {
      // A folder is never older than anything in it, so once one is at least this new, so is all above it.
      if (newest.get(q) >= s.mtime) break;
      newest.set(q, s.mtime);
      if (q === root) break;
    }
  }
  const unknown = new Set();
  for (const p of dates?.undated ?? []) {
    for (let q = p; !unknown.has(q); q = parentOf(q)) {
      unknown.add(q);
      if (q === root) break;
    }
  }
  const dated = (row) => {
    const t = newest.get(row.path);
    if (t != null && !unknown.has(row.path)) row.modifiedAt = t;
    return row;
  };
  const rows = [...totals].map(([path, bytes]) => {
    const type = types.get(path) ?? "dir";
    const fix = links?.m.get(path);
    if (fix) return dated({ path, bytes: Math.max(0, bytes - fix.occ + fix.once), type, sharedBytes: Math.min(fix.shared, Math.max(0, bytes - fix.occ + fix.once)) });
    // A big file with other links elsewhere: the file's own bytes are shared with them.
    if (links?.x.has(path)) return dated({ path, bytes, type, sharedBytes: bytes });
    return dated({ path, bytes, type, sharedBytes: 0 });
  });
  rows.sort((x, y) => y.bytes - x.bytes || x.path.length - y.path.length);
  const kept = rows.slice(0, maxRows);
  // The folder itself is always there: it is what the page's totals hang from.
  if (!kept.some((r) => r.path === root)) {
    const self = rows.find((r) => r.path === root);
    if (self) kept.push(self);
  }
  return kept;
}

/**
 * Parse a scan answer into rows. Two shapes come back (see scan.sh): sorted rows from one `du`, or own sizes
 * from the parallel scan, which are added up here. Du prints a doubled slash when the folder is "/" on some
 * systems, so paths are normalized; rows that are not an absolute path under the scanned folder are dropped.
 *
 * Dates (parallel scan only): `modifiedAt` is the newest modification time of anything in the row, in whole
 * seconds since 1970, and is left out when not known. `dated` says whether the answer carried dates at all
 * (the serial scan and output from before dates were added do not). A scan stopped by its time limit keeps
 * the dates of files only: a folder's newest time could be in the part it never reached.
 * @returns {{ ok: true, rows: { path: string, bytes: number, type: "dir" | "file" | "link" | "other", sharedBytes: number, modifiedAt?: number }[], unreadable: number, timedOut: boolean, mode: "serial" | "parallel", hardlinks: "exact" | "approx", dated: boolean } | { ok: false, code: string, message: string }}
 */
export function parseScanOutput(out, root, maxRows = SCAN_MAX_ROWS) {
  const text = String(out ?? "");
  const nl = text.indexOf("\n");
  const head = (nl < 0 ? text : text.slice(0, nl)).trim();
  if (head !== "RESULT=ok") {
    const r = programResult(text);
    return r.ok ? BAD_OUTPUT : { ok: false, code: r.code, message: r.message };
  }
  const rows = [];
  /** @type {{ path: string, bytes: number, type: "dir" | "file" | "link" | "other" | null }[]} */
  const atoms = [];
  /** Hard-link corrections (parallel scan): see totalsFromAtoms. */
  const links = { m: new Map(), x: new Set() };
  /** Modification times (parallel scan): see totalsFromAtoms. */
  const stamps = [];
  /** Folders measured whole (T), and those whose newest time came back (N). */
  const whole = [];
  const stamped = new Set();
  let dated = false;
  const trailer = {};
  for (const rec of text.slice(nl + 1).split("\0")) {
    if (rec === "") continue;
    if (rec.startsWith("@@")) {
      const m = /^@@([A-Z]+)=(.*)$/.exec(rec);
      if (m) trailer[m[1]] = m[2];
      continue;
    }
    // Parallel scan records: A (own size of one entry), T (a whole folder), S (small files in a folder),
    // M (hard-link correction for a folder), X (a big file that has other links), N (newest time in a whole folder).
    const kind = rec.slice(0, 2);
    if (kind === "N\t") {
      const f = rec.split("\t");
      const path = normalizePath(f.slice(2).join("\t"));
      const mtime = parseMtime(f[1]);
      dated = true;
      if (mtime != null && path.startsWith("/") && underRoot(path, root)) {
        stamps.push({ path, mtime });
        stamped.add(path);
      }
      continue;
    }
    if (kind === "M\t") {
      const f = rec.split("\t");
      const path = normalizePath(f.slice(4).join("\t"));
      // An empty "shared" field means none.
      const [occ, once, shared] = [f[1], f[2], f[3] === "" ? "0" : f[3]].map((n) => (/^\d+$/.test(n ?? "") ? Number(n) : NaN));
      if ([occ, once, shared].every(Number.isFinite) && path.startsWith("/") && underRoot(path, root)) links.m.set(path, { occ, once, shared });
      continue;
    }
    if (kind === "X\t") {
      const path = normalizePath(rec.slice(2));
      if (path.startsWith("/") && underRoot(path, root)) links.x.add(path);
      continue;
    }
    if (kind === "A\t" || kind === "T\t" || kind === "S\t") {
      const f = rec.split("\t");
      const k = f[0];
      const bytesText = k === "A" ? f[2] : f[1];
      // A and S carry a modification time before the path, except in output from before dates were added.
      // A path always starts with "/" and a time never does, so the two shapes cannot be mistaken.
      let at = k === "A" ? 3 : 2;
      let mtimeText = null;
      if (k !== "T" && f.length > at + 1 && !f[at].startsWith("/")) {
        mtimeText = f[at];
        at += 1;
        dated = true;
      }
      const path = normalizePath(f.slice(at).join("\t"));
      const type = k === "A" ? TYPE_NAMES[f[1]] : k === "T" ? "dir" : null;
      if (!/^\d+$/.test(bytesText ?? "") || (k === "A" && !type) || !path.startsWith("/") || !underRoot(path, root)) continue;
      // "-": the unit could not read a time. Anything else that is not a time: a damaged record.
      if (mtimeText != null && mtimeText !== "-" && parseMtime(mtimeText) == null) continue;
      atoms.push({ path, bytes: Number(bytesText), type });
      const mtime = mtimeText == null ? null : parseMtime(mtimeText);
      if (mtime != null) stamps.push({ path, mtime });
      if (k === "T") whole.push(path);
      continue;
    }
    const a = rec.indexOf("\t");
    const b = a < 0 ? -1 : rec.indexOf("\t", a + 1);
    if (a < 0 || b < 0) continue;
    const size = rec.slice(0, a);
    const type = TYPE_NAMES[rec.slice(a + 1, b)];
    const path = normalizePath(rec.slice(b + 1));
    if (!/^\d+$/.test(size) || !type) continue;
    if (!path.startsWith("/") || !underRoot(path, root)) continue;
    rows.push({ path, bytes: Number(size), type, sharedBytes: 0 });
  }
  const rc = parseCount(trailer.RC);
  const mode = trailer.MODE === "parallel" ? "parallel" : "serial";
  // "exact": every file counted once and shared bytes known. "approx": hard-linked files may be counted in
  // more than one folder (the basic scan, or the hard-link step failed).
  const hardlinks = mode === "parallel" && trailer.HARDLINKS === "exact" ? "exact" : "approx";
  const timedOut = rc === 124;
  const withDates = mode === "parallel" && dated;
  const dates = withDates ? { stamps, undated: whole.filter((p) => !stamped.has(p)) } : null;
  const parallelRows = mode === "parallel" ? totalsFromAtoms(atoms, root, maxRows, hardlinks === "exact" ? links : null, dates) : null;
  // Stopped by the time limit: a folder's newest time could be in the part the scan never reached.
  if (parallelRows && timedOut) for (const r of parallelRows) if (r.type === "dir") delete r.modifiedAt;
  return {
    ok: true,
    rows: parallelRows ?? rows,
    unreadable: parseCount(trailer.UNREADABLE) ?? 0,
    timedOut,
    mode,
    hardlinks,
    dated: withDates,
  };
}

/** Whole seconds since 1970 as the scan prints them, or null. */
function parseMtime(text) {
  if (!/^\d{1,15}$/.test(text ?? "")) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** Docker's own size strings ("83.09GB", "570.4MB", "0B") are decimal units. */
export function parseDockerSize(text) {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?B)/.exec(String(text ?? ""));
  if (!m) return null;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }[m[2].toUpperCase()];
  const n = Number(m[1]);
  return Number.isFinite(n) && mult ? Math.round(n * mult) : null;
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
export const isImageId = (v) => typeof v === "string" && IMAGE_ID.test(v);
const CONTAINER_ID = /^[0-9a-f]{64}$/;
export const isContainerId = (v) => typeof v === "string" && CONTAINER_ID.test(v);
/**
 * Only a container Docker says is in one of these states may be offered for removal. Running, restarting,
 * paused, removing, or anything unexpected: left alone.
 */
const REMOVABLE_STATES = new Set(["exited", "created", "dead"]);
const DOCKER_TIME = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** A container's State.FinishedAt as Docker printed it, or null (missing, malformed, or Docker's zero time for "never"). */
const finishedAtOf = (text) => {
  const m = DOCKER_TIME.exec(String(text ?? "").trim());
  return m && Number(m[1]) >= 2000 ? m[0] : null;
};

const DF_KEYS = { Images: "images", Containers: "containers", "Local Volumes": "volumes", "Build Cache": "buildCache" };

/**
 * @typedef {{ id: string, tags: string[], sizeBytes: number | null, created: string | null,
 *   usedBy: { name: string, state: string }[], status: "running" | "stopped" | "unused" | "unknown",
 *   registryDigest: boolean | null }} DockerImage
 *   "unknown": the container listing failed, so nobody can say whether a container uses it (never removable).
 * @typedef {{ id: string, name: string, state: string, imageId: string, created: string | null,
 *   removable: boolean, finishedAt?: string }} DockerContainer
 *   `finishedAt`: when it last stopped, only when Docker reported a real time.
 */
export function parseDockerListOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const pairs = parsePairs(out);
  const usage = {};
  /** @type {Map<string, { name: string, state: string }[]>} */
  const users = new Map();
  /** @type {DockerImage[]} */
  const images = [];
  /** @type {DockerContainer[]} */
  const containers = [];
  for (const [k, v] of pairs) {
    const f = v.split("|");
    if (k === "DF" && f.length >= 5 && DF_KEYS[f[0]]) {
      usage[DF_KEYS[f[0]]] = {
        count: parseCount(f[1]),
        active: parseCount(f[2]),
        sizeBytes: parseDockerSize(f[3]),
        reclaimableBytes: parseDockerSize(f[4]),
      };
    } else if (k === "CTR" && f.length >= 3 && isImageId(f[0])) {
      const list = users.get(f[0]) ?? [];
      list.push({ name: f[1].replace(/^\//, ""), state: f[2] });
      users.set(f[0], list);
      if (isContainerId(f[3])) {
        const container = { id: f[3], name: f[1].replace(/^\//, ""), state: f[2], imageId: f[0], created: f[4] || null, removable: REMOVABLE_STATES.has(f[2]) };
        // Optional sixth field: when it last stopped. Left out when missing, malformed or Docker's "never" (year 1).
        const finished = finishedAtOf(f[5]);
        if (finished) container.finishedAt = finished;
        containers.push(container);
      }
    } else if (k === "IMG" && f.length >= 4 && isImageId(f[0])) {
      const tags = f[3].split(",").filter((t) => t && t !== "<none>:<none>");
      // Optional fifth field, the number of registry digests: false = none recorded (built or loaded here,
      // possibly the only copy), true = it came from or went to a registry, null = not reported.
      const digests = parseCount(f[4]);
      images.push({ id: f[0], tags, sizeBytes: parseCount(f[1]), created: f[2] || null, usedBy: [], status: "unused", registryDigest: digests == null ? null : digests > 0 });
    }
  }
  const containersKnown = r.values.CONTAINERS === "ok";
  for (const img of images) {
    img.usedBy = users.get(img.id) ?? [];
    img.status = img.usedBy.some((c) => c.state === "running" || c.state === "restarting" || c.state === "paused")
      ? "running"
      : img.usedBy.length > 0
        ? "stopped"
        : // No container listed: "unused" only when the listing ran in full (a missing answer fails closed).
          containersKnown
          ? "unused"
          : "unknown";
  }
  images.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  // Stopped ones first (they are what can be cleaned up), newest first within each group.
  containers.sort((a, b) => Number(b.removable) - Number(a.removable) || String(b.created).localeCompare(String(a.created)));
  // What the unit could list: "ok", "partial" (some images could not be read) or "failed".
  const listing = {
    images: ["ok", "partial", "failed"].includes(r.values.IMAGES) ? r.values.IMAGES : "failed",
    containers: containersKnown ? "ok" : "failed",
  };
  return { ok: true, rootDir: r.values.ROOT || null, usage, images, containers, listing };
}

export function parseDockerRemoveOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const removed = [];
  const skipped = [];
  const failed = [];
  for (const [k, v] of parsePairs(out)) {
    const [id, why = ""] = v.split("|");
    if (k === "REMOVED") removed.push(id);
    else if (k === "SKIPPED") skipped.push({ id, reason: why });
    else if (k === "FAILED") failed.push({ id, message: why });
  }
  return { ok: true, removed, skipped, failed };
}

const QUARANTINE_ID = /^[0-9a-f][0-9a-f-]{7,63}$/;
/** A delete v2 recovery record id (the delete's operation id). */
export const isQuarantineId = (v) => typeof v === "string" && QUARANTINE_ID.test(v);
const QUARANTINE_STATES = new Set(["staged", "interrupted", "conflict", "in-place", "gone", "unknown", "unreadable"]);
const fromHex = (h) => (/^(?:[0-9a-f]{2})*$/.test(h ?? "") ? Buffer.from(h, "hex").toString("utf8") : null);

/**
 * The recovery records a quarantine `list` reports (see sdhelper.pl mlist): deletes that were staged and
 * never finished, with what is on disk now.
 * @typedef {{ id: string, state: "staged" | "interrupted" | "conflict" | "in-place" | "gone" | "unknown" | "unreadable",
 *   elevated: boolean, type: "dir" | "file" | "link" | "other", createdAt: number | null, path: string,
 *   stagedPath: string, reason: string | null }} QuarantineItem
 * @returns {{ ok: true, items: QuarantineItem[] } | { ok: false, code: string, message: string }}
 */
export function parseQuarantineOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const items = [];
  for (const [k, v] of parsePairs(out)) {
    if (k !== "ITEM") continue;
    const f = v.split("|");
    if (f.length < 8 || !isQuarantineId(f[0]) || !QUARANTINE_STATES.has(f[1])) continue;
    const [path, stagedPath, reason] = [f[5], f[6], f[7]].map(fromHex);
    if (path == null || stagedPath == null) continue;
    const at = parseCount(f[4]);
    items.push({
      id: f[0],
      state: f[1],
      elevated: f[2] === "1",
      type: TYPE_NAMES[f[3]] ?? "other",
      createdAt: at ? at * 1000 : null,
      path,
      stagedPath,
      reason: reason || null,
    });
  }
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { ok: true, items };
}

/** Text the unit reported hex-encoded: one plain line, control characters shown as "?", at most `max` characters. */
const shownText = (h, max = 300) => {
  const s = fromHex(h);
  // eslint-disable-next-line no-control-regex
  return s == null ? null : s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, max);
};
const ADVISE_TYPES = { d: "dir", f: "file", l: "link", o: "other" };
const USE_HOW = { f: "open", c: "cwd", e: "program", m: "mapped" };
const WALK_STATES = { 0: "complete", 1: "partial", 124: "timeout", "-": "skipped" };
const REPO_STATES = new Set(["ok", "refused", "timeout", "error", "skipped"]);

/**
 * @typedef {{ type: "dir" | "file" | "link" | "other" | null, reported: boolean,
 *   uses: { pid: number, how: "open" | "cwd" | "program" | "mapped", program: string | null, target: string }[], useCount: number,
 *   mounts: { relation: "within" | "around", container: string, source: string, destination: string | null }[], mountCount: number,
 *   walk: "complete" | "partial" | "timeout" | "skipped" | null,
 *   recent: { count: number, newest: number | null, sampleType: "dir" | "file" | "link" | "other", sample: string } | null,
 *   partial: { count: number, sample: string } | null,
 *   credentials: { count: number, sample: string } | null,
 *   repos: { top: string, state: "ok" | "refused" | "timeout" | "error" | "skipped", changed: number, untracked: number,
 *     unpushed: number, remotes: number, stashes: number }[],
 *   gitDirs: { found: number, checked: number } | null,
 *   inRepo: { top: string, relation: "tree" | "history", state: string, changed: number, untracked: number,
 *     tracked: boolean, ignored: boolean } | null }} AdviseEvidence
 *   `type` null: not there. `reported` false: the answer stopped before this path (nothing about it is known).
 *   `walk` null: not looked through (not there, or not reported).
 */

/**
 * The delete advisor's evidence (scripts/advise.sh) for `count` paths, in the order they were sent. Tolerant: a
 * line that does not parse is dropped, a missing one reads as unknown (never as "nothing found"), and anything the
 * unit named is decoded from hex and kept to one plain line.
 * @param {string} out
 * @param {number} count
 * @returns {{ ok: true, now: number | null, uid: number | null, home: string | null,
 *   procs: "all" | "own" | "failed", docker: "ok" | "missing" | "denied" | "down" | "failed", git: "ok" | "old" | "missing",
 *   items: AdviseEvidence[] } | { ok: false, code: string, message: string }}
 */
export function parseAdviseOutput(out, count) {
  const r = programResult(out);
  if (!r.ok) return r;
  /** @type {AdviseEvidence[]} */
  const items = Array.from({ length: count }, () => ({
    type: null,
    reported: false,
    uses: [],
    useCount: 0,
    mounts: [],
    mountCount: 0,
    walk: null,
    recent: null,
    partial: null,
    credentials: null,
    repos: [],
    gitDirs: null,
    inRepo: null,
  }));
  const item = (text) => {
    const n = parseCount(text);
    return n != null && n >= 1 && n <= count ? items[n - 1] : null;
  };
  const head = { now: null, uid: null, home: null, procs: "failed", docker: "failed", git: "missing" };
  // Lines that say what was looked at at all: without them nothing counts as checked.
  let procsSeen = false;
  let dockerSeen = false;
  for (const [k, v] of parsePairs(out)) {
    const f = v.split("|");
    const it = ["NOW", "UID", "HOME_HEX", "PROCS", "DOCKER", "GIT"].includes(k) ? null : item(f[0]);
    switch (k) {
      case "NOW":
        head.now = parseCount(v);
        break;
      case "UID":
        head.uid = parseCount(v);
        break;
      case "HOME_HEX": {
        const h = fromHex(v);
        head.home = h && h.startsWith("/") && !hasUnsafeName(h) ? h : null;
        break;
      }
      case "PROCS":
        if (["all", "own", "failed"].includes(v)) [head.procs, procsSeen] = [v, true];
        break;
      case "DOCKER":
        if (["ok", "missing", "denied", "down", "failed"].includes(v)) [head.docker, dockerSeen] = [v, true];
        break;
      case "GIT":
        if (["ok", "old", "missing"].includes(v)) head.git = v;
        break;
      case "P":
        if (it && f[1] != null) {
          it.reported = true;
          it.type = ADVISE_TYPES[f[1]] ?? null;
        }
        break;
      case "USE": {
        const target = shownText(f[4], 4096);
        if (it && parseCount(f[1]) != null && USE_HOW[f[2]] && target?.startsWith("/") && it.uses.length < 5) {
          it.uses.push({ pid: parseCount(f[1]), how: USE_HOW[f[2]], program: shownText(f[3], 64) || null, target });
        }
        break;
      }
      case "USES":
        if (it) it.useCount = parseCount(f[1]) ?? 0;
        break;
      case "MNT": {
        const [container, source, destination] = [shownText(f[2], 128), shownText(f[3], 4096), shownText(f[4], 4096)];
        if (it && (f[1] === "within" || f[1] === "around") && container && source?.startsWith("/") && it.mounts.length < 5) {
          it.mounts.push({ relation: f[1], container, source, destination: destination || null });
        }
        break;
      }
      case "MNTS":
        if (it) it.mountCount = parseCount(f[1]) ?? 0;
        break;
      case "WALK":
        if (it && f[1] in WALK_STATES) it.walk = WALK_STATES[f[1]];
        break;
      case "RECENT":
        if (it && parseCount(f[1]) != null) it.recent = { count: parseCount(f[1]), newest: parseCount(f[2]), sampleType: ADVISE_TYPES[f[3]] ?? "other", sample: shownText(f[4]) ?? "" };
        break;
      case "PART":
        if (it && parseCount(f[1]) != null) it.partial = { count: parseCount(f[1]), sample: shownText(f[2]) ?? "" };
        break;
      case "CRED":
        if (it && parseCount(f[1]) != null) it.credentials = { count: parseCount(f[1]), sample: shownText(f[2]) ?? "" };
        break;
      case "REPO": {
        const top = shownText(f[1]);
        if (it && top != null && REPO_STATES.has(f[2]) && it.repos.length < 20) {
          const [changed, untracked, unpushed, remotes, stashes] = f.slice(3, 8).map((n) => parseCount(n) ?? 0);
          it.repos.push({ top, state: f[2], changed, untracked, unpushed, remotes, stashes });
        }
        break;
      }
      case "GITDIRS":
        if (it && parseCount(f[1]) != null) it.gitDirs = { found: parseCount(f[1]), checked: parseCount(f[2]) ?? 0 };
        break;
      case "INREPO": {
        const top = shownText(f[1], 4096);
        if (it && top?.startsWith("/") && (f[2] === "tree" || f[2] === "history") && REPO_STATES.has(f[3])) {
          const [changed, untracked] = [parseCount(f[4]) ?? 0, parseCount(f[5]) ?? 0];
          it.inRepo = { top, relation: f[2], state: f[3], changed, untracked, tracked: f[6] === "1", ignored: f[7] === "1" };
        }
        break;
      }
      default:
        break;
    }
  }
  if (!procsSeen) head.procs = "failed";
  if (!dockerSeen) head.docker = "failed";
  for (const it of items) {
    // A listed process or mount counts even when the count line is missing.
    it.useCount = Math.max(it.useCount, it.uses.length);
    it.mountCount = Math.max(it.mountCount, it.mounts.length);
  }
  return { ok: true, ...head, items };
}

/** The script a program runs on the unit (common functions included), for tests that run it directly. */
export function scriptText(name) {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`unknown storage program: ${name}`);
  return `${COMMON}\n${script.body}`;
}

/** Validation for the scan request: a clean absolute folder and a depth in range. */
export function parseScanRequest(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const path = parseAbsolutePath(b.path ?? "/");
  const depth = b.depth === undefined ? 3 : b.depth;
  if (!Number.isInteger(depth) || depth < 1 || depth > SCAN_MAX_DEPTH) {
    throw Object.assign(new Error(`depth must be a whole number from 1 to ${SCAN_MAX_DEPTH}`), { status: 400 });
  }
  if (b.mode !== undefined && b.mode !== "new" && b.mode !== "drill") {
    throw Object.assign(new Error("mode must be new or drill"), { status: 400 });
  }
  return { path, depth, mode: b.mode ?? "new" };
}

export { hasUnsafeName };
