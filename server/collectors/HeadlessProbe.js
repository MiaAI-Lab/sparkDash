/**
 * HeadlessProbe — whether a Linux unit runs a graphical desktop, what that
 * desktop costs in memory, and which optional desktop-era services are on.
 *
 * Command: one read-only shell line as the SSH user (no root, no socket, no
 * key, no new port). Every line it prints starts with "headless-probe ", so a
 * login banner is never read as data.
 *
 * The service list is fixed here and never comes from the client: the probe
 * reads these units, and the actions may only change these units.
 */
import { HEADLESS_PROBE_TIMEOUT_MS, HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";
import fs from "fs";
import path from "path";

/**
 * Optional desktop-era services that are commonly idle on an inference box.
 * Deliberately excludes snapd, NetworkManager, ssh, docker, nvidia*, tailscale
 * and anything storage or networking related: stopping those breaks the unit
 * or the dashboard's own access to it.
 */
export const HEADLESS_UNITS = Object.freeze([
  // Printing stack: idle without a printer.
  "cups.service",
  "cups.socket",
  "cups.path",
  // Network printer discovery.
  "cups-browsed.service",
  // Radio stack: idle on a rack box.
  "bluetooth.service",
  // Periodic firmware metadata refresh; the timer is idle between runs.
  "fwupd-refresh.timer",
  // Colour profile daemon for the desktop session.
  "colord.service",
  // Ubuntu error-report uploader.
  "whoopsie.service",
  // Kernel oops reporter.
  "kerneloops.service",
]);

/** The unit that starts the graphical desktop on Ubuntu and DGX OS. */
export const DISPLAY_MANAGER_UNIT = "display-manager.service";

/** Desktop session processes whose resident memory the probe sums. */
export const DESKTOP_PROCESS_PATTERN = "^(gnome-shell|Xorg|Xwayland|mutter|gdm)";

/**
 * POSIX sh, for the SSH user's login shell (bash, zsh or dash): the boot
 * default target, display-manager.service's state, the resident memory of the
 * desktop session processes (and their swap where /proc allows it), and the
 * state of each allow-listed unit.
 */
export const HEADLESS_PROBE_COMMAND = [
  `printf 'headless-probe default %s\\n' "$(systemctl get-default 2>/dev/null)"`,
  `systemctl show -p Id -p LoadState -p ActiveState ${DISPLAY_MANAGER_UNIT} 2>/dev/null | sed 's/^/headless-probe dm /'`,
  `ps -eo pid=,comm=,rss= 2>/dev/null | awk '$2 ~ /${DESKTOP_PROCESS_PATTERN}/ {print $1, $2, $3}' | while read -r pid comm rss; do ` +
    `swap=$(awk '/^VmSwap:/{print $2}' "/proc/$pid/status" 2>/dev/null); [ -n "$swap" ] || swap=-; ` +
    `printf 'headless-probe proc %s %s %s\\n' "$comm" "$rss" "$swap"; done`,
  `for u in ${HEADLESS_UNITS.join(" ")}; do ` +
    `systemctl show -p LoadState -p ActiveState -p UnitFileState "$u" 2>/dev/null | sed "s/^/headless-probe unit $u /"; done`,
].join("; ");

const LINE = /^headless-probe (\S+)(?: (.*))?$/;
const PROPERTY = /^(\w+)=(.*)$/;
const PROCESS = /^(\S+) (\d+) (\d+|-)$/;
const UNIT_LINE = /^(\S+) (LoadState|ActiveState|UnitFileState)=(\S*)$/;

/** A unit the probe could not ask about: every field unknown. */
const NO_UNIT = Object.freeze({ present: null, active: null, enabled: null, state: null });

/** KiB to MiB, one decimal place. */
function mib(kib) {
  return Math.round((kib / 1024) * 10) / 10;
}

/**
 * A unit as `systemctl show` reported it; nulls when it said nothing (no
 * systemd, or no bus to ask). `active` is true while it runs, false when it is
 * stopped or failed, and null while it starts or stops. `enabled` is true only
 * for an enabled unit file, false for a disabled or masked one, and null for
 * states that are neither (static, indirect, generated, transient).
 * @param {{ LoadState?: string, ActiveState?: string, UnitFileState?: string } | undefined} u
 */
function unitState(u) {
  const load = u?.LoadState || null;
  const active = u?.ActiveState || null;
  const file = u?.UnitFileState || null;
  if (load == null) return { ...NO_UNIT };
  if (load === "not-found") return { present: false, active: false, enabled: false, state: "not installed" };
  let running = null;
  if (active === "active" || active === "reloading") running = true;
  else if (active === "inactive" || active === "failed") running = false;
  let enabled = null;
  if (file === "enabled") enabled = true;
  else if (file === "disabled" || file === "masked") enabled = false;
  return { present: true, active: running, enabled, state: active };
}

/**
 * What the unit's desktop is doing. desktop: the display manager runs and the
 * boot default is graphical.target. headless: the display manager is stopped
 * and the boot default is multi-user.target. mixed: the boot default is
 * multi-user.target but the desktop still runs until the next boot. Anything
 * else is unknown, including a stopped display manager whose boot default is
 * still graphical.target (the desktop returns at the next boot).
 * @param {string | null} defaultTarget
 * @param {{ active: boolean | null }} dm
 * @param {number} processCount
 */
function stateOf(defaultTarget, dm, processCount) {
  if (defaultTarget == null) return "unknown";
  let running;
  if (dm.active === true || processCount > 0) running = true;
  else if (dm.active === false) running = false;
  else running = null;
  if (running == null) return "unknown";
  if (defaultTarget === "multi-user.target") return running ? "mixed" : "headless";
  if (defaultTarget === "graphical.target") return running ? "desktop" : "unknown";
  return "unknown";
}

/**
 * Normalize the probe's output into the fields the UI needs.
 * Pure (no I/O) — exported for unit tests.
 *
 * @param {string} out
 * @returns {object | null} null when the output carries no probe line at all
 */
export function parseHeadlessProbe(out) {
  let seen = false;
  let defaultTarget = null;
  /** @type {Record<string, string>} */
  const dmProps = {};
  /** @type {Array<{ name: string, rssMib: number, swapMib: number | null }>} */
  const processes = [];
  /** @type {Record<string, { LoadState?: string, ActiveState?: string, UnitFileState?: string }>} */
  const units = {};
  for (const raw of String(out ?? "").split("\n")) {
    const m = LINE.exec(raw.trimEnd());
    if (!m) continue;
    const [, key, rest = ""] = m;
    if (key === "default") {
      seen = true;
      defaultTarget = rest.trim() || null;
    } else if (key === "dm") {
      seen = true;
      const p = PROPERTY.exec(rest);
      if (p) dmProps[p[1]] = p[2];
    } else if (key === "proc") {
      seen = true;
      const p = PROCESS.exec(rest);
      if (p) {
        processes.push({
          name: p[1],
          rssMib: mib(Number(p[2])),
          swapMib: p[3] === "-" ? null : mib(Number(p[3])),
        });
      }
    } else if (key === "unit") {
      seen = true;
      const u = UNIT_LINE.exec(rest);
      if (u) (units[u[1]] ??= {})[u[2]] = u[3];
    }
  }
  if (!seen) return null;

  const displayManager = { unit: DISPLAY_MANAGER_UNIT, ...unitState(dmProps) };
  const rssMib = processes.length > 0 ? Math.round(processes.reduce((sum, p) => sum + p.rssMib, 0) * 10) / 10 : null;
  // One unreadable VmSwap makes the total unknown rather than a smaller number.
  const swapMib = processes.length > 0 && processes.every((p) => p.swapMib != null)
    ? Math.round(processes.reduce((sum, p) => sum + p.swapMib, 0) * 10) / 10
    : null;
  return {
    available: true,
    state: stateOf(defaultTarget, displayManager, processes.length),
    defaultTarget,
    displayManager,
    desktop: { processes, rssMib, swapMib },
    units: HEADLESS_UNITS.map((unit) => ({ unit, ...unitState(units[unit]) })),
    error: null,
  };
}

export class HeadlessProbe {
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
   * Local Docker: systemd and /proc live on the host, so enter the host mount
   * namespace (same approach as the spark-attic and Tailnet probes).
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
      execFile(file, args, { timeout: HEADLESS_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
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
        ? await this._execLocal(HEADLESS_PROBE_COMMAND)
        : await sshExec(this.spark, HEADLESS_PROBE_COMMAND, { timeoutMs: HEADLESS_PROBE_TIMEOUT_MS });
    } catch (err) {
      this.error = err.message || "desktop probe failed";
      return this._default();
    }

    const parsed = parseHeadlessProbe(out);
    if (!parsed) {
      this.error = "Unrecognised desktop probe output";
      return this._default();
    }
    this.error = null;
    return parsed;
  }

  _default() {
    return {
      available: false,
      state: "unknown",
      defaultTarget: null,
      displayManager: { unit: DISPLAY_MANAGER_UNIT, ...NO_UNIT },
      desktop: { processes: [], rssMib: null, swapMib: null },
      units: HEADLESS_UNITS.map((unit) => ({ unit, ...NO_UNIT })),
      error: this.error,
    };
  }
}
