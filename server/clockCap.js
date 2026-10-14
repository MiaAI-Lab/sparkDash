/**
 * GPU clock cap control for Spark nodes.
 *
 * The cap is applied through the narrow sudoers rule on each node
 *   <user> ALL=(root) NOPASSWD: /usr/bin/nvidia-smi -lgc *, /usr/bin/nvidia-smi -rgc
 * and tracked in the marker file ~/.config/sparkdash/gpu-clock-cap on the node
 * itself, written as "<MHz> <boot_id>". The marker's boot_id comes from
 * /proc/sys/kernel/random/boot_id: a reboot clears the cap, so a marker whose
 * boot_id is not the current boot is stale and is reported as stock (no cap).
 *
 * Only preset MHz values are accepted — the requested cap never reaches a
 * shell unless it passed `parseClockCap`. The command strings are built from
 * that validated integer and nothing else (the boot_id is read on the node
 * inside the same shell, never interpolated from server-side input).
 */
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { HOST_PATHS } from "./config.js";
import { sshExec } from "./collectors/ssh.js";
import { chooseLocalInvocation } from "./collectors/HermesProbe.js";

/** Absolute path of nvidia-smi — the only binary the sudoers rule allows. */
export const NVSMI = "/usr/bin/nvidia-smi";

/** Marker file on the node, relative to the SSH user's home. */
export const MARKER_REL_PATH = ".config/sparkdash/gpu-clock-cap";

/**
 * Preset caps in MHz: every 100 MHz from 1800 to 2400 (stock boost is ~2400).
 * Lower caps are not offered.
 */
export const CLOCK_CAP_PRESETS = Object.freeze([1800, 1900, 2000, 2100, 2200, 2300, 2400]);

const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a requested cap: an integer exactly on the preset list. Anything
 * else (floats, strings outside the list, 0, 2500, "abc") throws.
 * @param {unknown} raw
 * @returns {number} validated MHz
 */
export function parseClockCap(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || !CLOCK_CAP_PRESETS.includes(n)) {
    throw new Error(
      `Invalid clock cap ${JSON.stringify(raw ?? null)}: must be one of ${CLOCK_CAP_PRESETS.join(", ")} MHz`
    );
  }
  return n;
}

/** `sudo -n /usr/bin/nvidia-smi -lgc 0,<MHz>` — NOPASSWD per the sudoers rule. */
export function applyCapCommand(mhz) {
  return `sudo -n ${NVSMI} -lgc 0,${parseClockCap(mhz)}`;
}

/** `sudo -n /usr/bin/nvidia-smi -rgc` — reset GPU clocks (revert to stock). */
export function revertCapCommand() {
  return `sudo -n ${NVSMI} -rgc`;
}

/**
 * Write the marker with the boot_id read on the node itself. `b` is captured
 * in the remote shell; the value is never interpolated server-side.
 */
export function writeMarkerCommand(mhz) {
  const cap = parseClockCap(mhz);
  const dir = path.posix.dirname(MARKER_REL_PATH);
  return `mkdir -p ~/${dir} && b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) && [ -n "$b" ] && printf '%s\\n' "${cap} $b" > ~/${MARKER_REL_PATH}`;
}

/** Remove the marker (Unlocked / revert to stock). */
export function removeMarkerCommand() {
  return `rm -f ~/${MARKER_REL_PATH}`;
}

/**
 * One round trip: marker content, current boot_id, live graphics clock, GPU
 * temperature. Sections come back separated by '---'.
 */
export function statusCommand() {
  return [
    `cat ~/${MARKER_REL_PATH} 2>/dev/null`,
    "cat /proc/sys/kernel/random/boot_id 2>/dev/null",
    `${NVSMI} --query-gpu=clocks.gr --format=csv,noheader,nounits 2>/dev/null`,
    `${NVSMI} --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null`,
  ].join("; echo '---'; ");
}

/**
 * Parse the marker's "<MHz> <boot_id>" line.
 * @param {string} text
 * @returns {{ mhz: number, bootId: string } | null}
 */
export function parseMarkerLine(text) {
  const line = String(text ?? "").trim().split("\n")[0]?.trim() || "";
  const m = line.match(/^(\d{3,5})\s+(\S+)$/);
  if (!m) return null;
  const mhz = Number.parseInt(m[1], 10);
  const bootId = m[2];
  if (!Number.isInteger(mhz) || !BOOT_ID_RE.test(bootId)) return null;
  return { mhz, bootId: bootId.toLowerCase() };
}

/**
 * Parse `--query-gpu=clocks.gr --format=csv,noheader,nounits` — one value per
 * GPU. Returns the first parseable clock (Spark nodes are single-GPU); null
 * when nvidia-smi is unavailable or every line is [N/A].
 * @param {string} text
 * @returns {number | null}
 */
export function parseClocksGr(text) {
  for (const line of String(text ?? "").split("\n")) {
    const v = Number.parseFloat(line.trim());
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return null;
}

/**
 * Parse `--query-gpu=temperature.gpu --format=csv,noheader,nounits` — first
 * parseable value (Spark nodes are single-GPU); null when nvidia-smi is
 * unavailable or the line is [N/A].
 * @param {string} text
 * @returns {number | null} GPU temperature in °C
 */
export function parseTempC(text) {
  for (const line of String(text ?? "").split("\n")) {
    const v = Number.parseFloat(line.trim());
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return null;
}

/**
 * Resolve cap status from the three status sections.
 * @param {string} markerText raw marker file content ("" when missing)
 * @param {string} bootIdText current /proc boot_id ("" when unreadable)
 * @param {string} clocksText clocks.gr query output
 * @returns {{ mhz: number | null, stale: boolean, markerMhz: number | null, graphicsClockMHz: number | null }}
 *   mhz is the effective cap (null = stock/Unlocked); a marker from an earlier
 *   boot is stale → stock, with markerMhz keeping the stale value for the UI.
 */
export function resolveCapStatus(markerText, bootIdText, clocksText) {
  const marker = parseMarkerLine(markerText);
  const currentBoot = String(bootIdText ?? "").trim().split("\n")[0]?.trim().toLowerCase() || "";
  const graphicsClockMHz = parseClocksGr(clocksText);
  if (!marker || !BOOT_ID_RE.test(currentBoot)) {
    return { mhz: null, stale: false, markerMhz: null, graphicsClockMHz };
  }
  const stale = marker.bootId !== currentBoot;
  return {
    mhz: stale ? null : marker.mhz,
    stale,
    markerMhz: stale ? marker.mhz : null,
    graphicsClockMHz,
  };
}

/** Split the '---'-separated status output into its sections. */
export function splitStatusSections(text) {
  const parts = String(text ?? "").split("---");
  return { marker: parts[0] ?? "", bootId: parts[1] ?? "", clocks: parts[2] ?? "", temp: parts[3] ?? "" };
}

/**
 * Run a shell command on the spark — SSH for remote nodes; for the local node,
 * the same host-user drop the collectors/hermes use (setpriv into the SSH user
 * inside the host mount namespace when containerized), so `~` and sudo resolve
 * on the real node. The local side is execFile with an argv array; the command
 * string only ever contains validated constants.
 */
export async function runOnSpark(spark, cmd, timeoutMs = 12000) {
  if (!spark.isLocal) {
    return sshExec(spark, cmd, { timeoutMs });
  }
  const mntNs = fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"))
    ? path.join(HOST_PATHS.PROC, "1", "ns", "mnt")
    : null;
  let passwdText = "";
  try {
    passwdText = fs.readFileSync(
      mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd",
      "utf8"
    );
  } catch {
    passwdText = "";
  }
  const inv = chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    user: spark.ssh?.user,
    cmd,
  });
  return new Promise((resolve, reject) => {
    // Property access on the module object (not an imported binding) so tests
    // can stub the local branch with mock.method(childProcess, "execFile").
    childProcess.execFile(inv.file, inv.args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });
}

/**
 * Read the current cap status from a node.
 * @returns {Promise<{ mhz: number | null, stale: boolean, markerMhz: number | null, graphicsClockMHz: number | null, tempC: number | null }>}
 */
export async function readClockCapStatus(spark) {
  const text = await runOnSpark(spark, statusCommand());
  const { marker, bootId, clocks, temp } = splitStatusSections(text);
  return { ...resolveCapStatus(marker, bootId, clocks), tempC: parseTempC(temp) };
}

/**
 * Apply a preset cap on a node: nvidia-smi -lgc, then marker write + fresh
 * status. Throws on nvidia-smi failure; the UI reports the error verbatim.
 */
export async function applyClockCap(spark, requested) {
  const cap = parseClockCap(requested);
  const smiOutput = await runOnSpark(spark, `${applyCapCommand(cap)} 2>&1`);
  const text = await runOnSpark(spark, `${writeMarkerCommand(cap)}; ${statusCommand()}`);
  const { marker, bootId, clocks } = splitStatusSections(text);
  const status = resolveCapStatus(marker, bootId, clocks);
  // The cap command succeeded but the marker did not land (e.g. boot_id
  // unreadable): report it instead of showing a cap the display can't see.
  if (status.mhz !== cap) {
    throw new Error(`Clock cap applied but the marker write failed on ${spark.id || "node"}`);
  }
  return { ...status, smiOutput };
}

/**
 * Revert to stock (Unlocked): nvidia-smi -rgc, remove the marker, fresh status.
 */
export async function revertClockCap(spark) {
  const smiOutput = await runOnSpark(spark, `${revertCapCommand()} 2>&1`);
  const text = await runOnSpark(spark, `${removeMarkerCommand()}; ${statusCommand()}`);
  const { marker, bootId, clocks } = splitStatusSections(text);
  return { ...resolveCapStatus(marker, bootId, clocks), smiOutput };
}
