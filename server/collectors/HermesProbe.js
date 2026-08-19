/**
 * HermesProbe — checks & updates the Hermes Agent CLI (nousresearch/hermes-agent)
 * on a Spark. Works for local hosts and remote hosts (SSH via sshExec).
 *
 * "Hermes Agent enabled" on a Spark means the user has installed hermes on that
 * machine (they opt in via Edit Spark). We surface:
 *   - installed / version,
 *   - update availability via `hermes update --check` (the documented
 *     script-friendly gate: git fetch origin, compare HEAD..origin/main),
 *   - one-shot `hermes update` over a non-TTY session — stdin EOF means no
 *     interactive prompts, which hermes handles as the desktop-app "Update" path
 *     (updates.non_interactive_local_changes applies).
 *
 * All commands are built to exit 0 regardless of outcome and to carry
 * machine-readable markers, because sshExec rejects on non-zero exit and
 * `hermes update --check` exits 1 legitimately when an update IS available.
 *
 * LOCAL-HOST IDENTITY: the dashboard container runs as root, but hermes and its
 * git repo belong to the host user (spark.ssh.user). Running hermes as root
 * triggered git "dubious ownership" failures, and once patched around with
 * safe.directory it wrote root-owned files into the user's tree (breaking the
 * install). The local path therefore drops to the host user via setpriv
 * (util-linux, present in the container image) using uid/gid/home resolved from
 * the HOST passwd (/host/root/etc/passwd bind mount; plain /etc/passwd for
 * bare-host dev), and runs inside the host mount namespace via nsenter so host
 * git (not installed in the container) and the host filesystem are visible.
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { HOST_PATHS, HERMES_UPDATE_TIMEOUT_MS } from "../config.js";
import { sshExec } from "./ssh.js";
import { parsePendingCommits } from "./HermesReleases.js";

const HERMES_MISSING = "__HERMES_MISSING__";
const HERMES_LAUNCH_FAIL = "__HERMES_LAUNCH_FAIL__";
const CHECK_PHASE = "__CHECK_PHASE__";
const CHECK_EXIT = "__CHECK_EXIT__";
const CHECK_TIMEOUT_MS = 30000;

/** Fallback only: allow git to trust the host-owned repo when we must run as root. */
const GIT_SAFE_ENV =
  "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='safe.directory' GIT_CONFIG_VALUE_0='*'; ";

/**
 * Resolve a username to { uid, gid, home } from a /etc/passwd-style block.
 * Exported for tests; never throws.
 * @param {string} passwdText
 * @param {string|undefined} user
 */
export function parseHostPasswd(passwdText, user) {
  if (typeof passwdText !== "string" || !user) return null;
  for (const line of passwdText.split("\n")) {
    const p = line.split(":");
    if (p.length >= 6 && p[0] === user) {
      const uid = Number(p[2]);
      const gid = Number(p[3]);
      if (Number.isInteger(uid) && Number.isInteger(gid) && uid >= 0 && gid >= 0) {
        return { uid, gid, home: p[5] || `/home/${user}` };
      }
    }
  }
  return null;
}

/**
 * Decide HOW a local hermes command should be executed.
 * Pure + exported for tests. Returns the spawn invocation plus an optional
 * ownership-repair descriptor (run first, as root).
 *
 * @param {object} opts
 * @param {string|null} opts.mntNs  host mount-namespace path (null when running
 *   directly on the host rather than inside the Docker container)
 * @param {string} opts.passwdText  Host passwd file content
 * @param {number} opts.currentUid  uid of the current process
 * @param {string|undefined} opts.user  configured host user (spark.ssh.user)
 * @param {string} opts.cmd  command script to run
 */
export function chooseLocalInvocation({ mntNs, passwdText, currentUid, user, cmd }) {
  const hasNs = Boolean(mntNs);
  const isRoot = Number.isInteger(currentUid) && currentUid === 0;
  const ident = parseHostPasswd(passwdText, user);

  if (ident && isRoot) {
    const fullCmd = `export HOME='${ident.home}'; ${cmd}`;
    const setprivArgs = [
      "setpriv",
      `--reuid=${ident.uid}`,
      `--regid=${ident.gid}`,
      "--init-groups",
      "--",
      "sh",
      "-c",
      fullCmd,
    ];
    return {
      file: hasNs ? "nsenter" : "setpriv",
      args: hasNs ? ["--mount=" + mntNs, "--", ...setprivArgs] : setprivArgs,
      repair: { home: ident.home, uid: ident.uid, gid: ident.gid, mntNs },
    };
  }

  // Cannot drop privileges: run as the current (container) user. Inside the
  // host namespace when available (host git), with safe.directory so git
  // trusts the host-owned repo.
  const fallbackCmd = GIT_SAFE_ENV + cmd;
  if (hasNs) {
    return {
      file: "nsenter",
      args: ["--mount=" + mntNs, "--", "sh", "-c", fallbackCmd],
      repair: null,
    };
  }
  return { file: "sh", args: ["-c", fallbackCmd], repair: null };
}

/**
 * Build a single host command that locates the `hermes` binary and runs the
 * given action. Runs entirely inside the target host (via SSH, or inside the
 * host namespace for local Sparks). The installer symlinks `hermes` into the
 * target user's `~/.local/bin` (or /usr/local/bin for root/FHS), but SSH
 * non-interactive shells usually do NOT source ~/.bashrc, so the bare `hermes`
 * name is unreliable — we bootstrap PATH with the configured user's home
 * explicitly. Falls back to explicit paths, then reports __HERMES_MISSING__
 * (exit 0) when nothing is found.
 */
function buildHermesCmd(spark, actionCmd) {
  const user = spark.ssh?.user || "root";
  return [
    // A previous interrupted `hermes update` can leave a stale git lock
    // (e.g. .git/shallow.lock) that makes every later fetch fail with
    // "Unable to create ... File exists". Clear leftover locks in the hermes
    // repo before running — idempotent and safe (no git is running yet).
    `if [ -d /home/${user}/.hermes ]; then find /home/${user}/.hermes -type f -name '*.lock' -path '*/.git/*' -delete 2>/dev/null; fi`,
    // Explicit PATH bootstrap — never rely on remote shell rc files.
    `export PATH="/home/${user}/.local/bin:/home/${user}/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `BIN=$(command -v hermes)`,
    `if [ -z "$BIN" ]; then BIN=$(ls -d /home/${user}/.local/bin/hermes /usr/local/bin/hermes 2>/dev/null | head -n 1); fi`,
    `if [ -z "$BIN" ]; then echo '${HERMES_MISSING}'; exit 0; fi`,
    `echo "HERMES_BIN=$BIN"`,
    // Surface a broken launcher (e.g. missing venv entry point) instead of
    // silently failing: print the error text + a marker when the binary exists
    // but cannot execute. POSIX-safe (no PIPESTATUS).
    `V=$("$BIN" --version 2>&1); RC=$?; echo "$V" | head -n 1; if [ "$RC" -ne 0 ]; then echo '${HERMES_LAUNCH_FAIL}'; fi`,
    `echo '${CHECK_PHASE}'`,
    actionCmd,
    `echo "${CHECK_EXIT}$?"`,
    "exit 0",
  ].join("; ");
}

const CHECK_ACTION = `"$BIN" update --check 2>&1`;
// stdin from /dev/null guarantees EOF → non-interactive update.
const UPDATE_ACTION = `"$BIN" update 2>&1 < /dev/null`;

/**
 * Parse the `hermes update --check` section of the combined output.
 *
 * `hermes update --check` exits 0 when in sync and 1 both when an update IS
 * available AND when the fetch fails ("✗ Failed to fetch"), so the exit code
 * alone cannot distinguish the two. Report "update available" only when the
 * output explicitly says so; a failed or ambiguous check is reported as an
 * error (updateAvailable null) — never as a phantom update.
 */
function parseCheck(output) {
  const exitMatch = new RegExp(`${CHECK_EXIT}(\\d+)`).exec(output);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  const section = output.split(CHECK_PHASE)[1] || output || "";
  const upToDate = /already up to date/i.test(section);
  const behindText =
    /update available|commits? behind|is behind|behind origin/i.test(section);
  const failedFetch = /failed to fetch|fatal:|unable to/i.test(section);
  const unsupported =
    /unrecognized arguments|unexpected argument|usage:|no such option|--check not/i.test(
      section
    );
  if (unsupported) return { updateAvailable: null, behindCommits: null, unsupported: true };
  // Explicit up-to-date beats anything else.
  if (upToDate) return { updateAvailable: false, behindCommits: null, failed: false };
  // Explicit behind report (with or without a commit count) is authoritative.
  if (behindText) {
    const m = /(\d+)\s+commits?\s+behind/i.exec(section);
    return {
      updateAvailable: true,
      behindCommits: m ? parseInt(m[1], 10) : null,
      failed: false,
    };
  }
  // Fetch failure — no commit comparison happened; report the raw message.
  if (failedFetch) {
    return {
      updateAvailable: null,
      behindCommits: null,
      failed: true,
      error: section.trim().slice(0, 300) || "hermes update --check could not fetch from origin",
    };
  }
  // Clean exit with no "up to date" text: treat as in sync (some versions
  // print a terse output). Anything else (non-zero, no message) is unknown.
  if (exitCode === 0) return { updateAvailable: false, behindCommits: null, failed: false };
  return {
    updateAvailable: null,
    behindCommits: null,
    failed: true,
    error:
      section.trim().slice(0, 300) ||
      `hermes update --check exited ${exitCode} with no usable output`,
  };
}

function parseVersion(output) {
  const m = /\bv?(\d+\.\d+(?:\.\d+)*)/i.exec(output || "");
  return m ? m[1] : null;
}

export class HermesProbe {
  /**
   * @param {object} spark
   */
  constructor(spark) {
    this.spark = spark;
  }

  setTarget(spark) {
    this.spark = spark;
  }

  /** Run a command on the Spark: SSH for remote, host drop + nsenter for local. */
  async _run(cmd, timeoutMs) {
    if (this.spark.isLocal) return this._execLocal(cmd, timeoutMs);
    return sshExec(this.spark, cmd, { timeoutMs });
  }

  /**
   * Execute a hermes command on the local host as the configured host user.
   * See the file header note on identity — this is what keeps hermes's own
   * install intact instead of polluting it with root-owned files.
   */
  async _execLocal(cmd, timeoutMs) {
    const mntNs = fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"))
      ? path.join(HOST_PATHS.PROC, "1", "ns", "mnt")
      : null;
    let passwdText = "";
    try {
      const passwdPath = mntNs
        ? path.join(HOST_PATHS.ROOT, "etc", "passwd")
        : "/etc/passwd";
      passwdText = fs.readFileSync(passwdPath, "utf8");
    } catch {
      passwdText = "";
    }
    const inv = chooseLocalInvocation({
      mntNs,
      passwdText,
      currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
      user: this.spark.ssh?.user,
      cmd,
    });

    if (inv.repair) {
      const r = inv.repair;
      const script =
        `ROOTFILE=$(find '${r.home}/.hermes' -user root -print -quit 2>/dev/null); ` +
        `if [ -n "$ROOTFILE" ]; then chown -R ${r.uid}:${r.gid} '${r.home}/.hermes' 2>/dev/null || true; fi`;
      try {
        await this._spawn(
          r.mntNs ? "nsenter" : "sh",
          r.mntNs
            ? ["--mount=" + r.mntNs, "--", "sh", "-c", script]
            : ["-c", script],
          20000
        );
      } catch {
        /* ownership repair is best-effort — never block hermes on it */
      }
    }

    return this._spawn(inv.file, inv.args, timeoutMs);
  }

  _spawn(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            return reject(new Error(String(stdout || "").trim() || err.message));
          }
          resolve(String(stdout).trim());
        }
      );
    });
  }

  /**
   * Check whether an update is available. Read-only on the target.
   * @returns {Promise<object>} installed / version / updateAvailable / behindCommits /
   *   checkedAt / error (never throws)
   */
  async check() {
    const checkedAt = Date.now();
    const notInstalled = {
      installed: false,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt,
      error: null,
    };
    try {
      const out = await this._run(buildHermesCmd(this.spark, CHECK_ACTION), CHECK_TIMEOUT_MS);
      if (out.includes(HERMES_MISSING)) return notInstalled;
      if (out.includes(HERMES_LAUNCH_FAIL)) {
        return {
          installed: true,
          version: null,
          updateAvailable: null,
          behindCommits: null,
          checkedAt,
          error:
            "hermes is installed but cannot launch (broken install — usually a missing venv entry point). " +
            "Run one-click Update Hermes to attempt an automatic repair.",
        };
      }
      const parsed = parseCheck(out);
      return {
        installed: true,
        version: parseVersion(out),
        updateAvailable: parsed.updateAvailable,
        behindCommits: parsed.behindCommits,
        checkedAt,
        error: parsed.unsupported
          ? "Installed hermes version does not support `hermes update --check` — update hermes manually once to enable monitoring."
          : parsed.error ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/command not found|no such file|no such file or directory/i.test(msg)) {
        return notInstalled;
      }
      return {
        installed: true,
        version: null,
        updateAvailable: null,
        behindCommits: null,
        checkedAt,
        error: msg,
      };
    }
  }

  /**
   * Pending commits on the target's hermes checkout (HEAD..origin/main). Uses
   * git directly on the machine (host git via the namespace for local Sparks) so
   * the update dialog can show exactly what an update would bring instead of a
   * release changelog that may not correspond to any real version bump.
   * Never throws.
   * @returns {Promise<object|null>} { count, headSha, commits: {sha,title}[] }
   */
  async pendingCommits() {
    const user = this.spark.ssh?.user || "root";
    const repo = `/home/${user}/.hermes/hermes-agent`;
    const script = [
      `REPO='${repo}'`,
      `git -C "$REPO" fetch origin --quiet 2>/dev/null || true`,
      `echo __COMMITS__`,
      `git -C "$REPO" log -30 --oneline --format=%H%x09%s HEAD..origin/main 2>/dev/null`,
      `echo __COUNT__`,
      `git -C "$REPO" rev-list --count HEAD..origin/main 2>/dev/null`,
      `echo __HEAD__`,
      `git -C "$REPO" rev-parse --short HEAD 2>/dev/null`,
      `exit 0`,
    ].join("; ");
    try {
      const out = await this._run(script, 45000);
      return parsePendingCommits(out);
    } catch {
      return null;
    }
  }

  /**
   * Run `hermes update`. Exits 0 via the wrapper regardless of hermes's result;
   * success is judged from the output text.
   * @returns {Promise<object>} ok / installed / version / error / output / startedAt / finishedAt
   */
  /**
   * Rebuild the venv entry point directly when the launcher is broken
   * (hermes exists but its venv script is gone). Mirrors what `hermes update`
   * would do, without needing hermes to launch. Best-effort: judged by a
   * subsequent run, never throws.
   * @returns {Promise<boolean>} true when the launcher became usable again
   */
  async _repairVenv() {
    const user = this.spark.ssh?.user || "root";
    const venv = `/home/${user}/.hermes/hermes-agent/venv`;
    const script = [
      `UV='/home/${user}/.hermes/bin/uv'`,
      `if [ ! -x "$UV" ]; then UV=$(command -v uv 2>/dev/null); fi`,
      `if [ -z "$UV" ] || [ ! -x "$UV" ]; then echo '__UV_MISSING__'; exit 0; fi`,
      `cd '/home/${user}/.hermes/hermes-agent' && VIRTUAL_ENV='${venv}' "$UV" pip install -e . >/dev/null 2>&1`,
      `exit 0`,
    ].join("; ");
    try {
      await this._run(script, HERMES_UPDATE_TIMEOUT_MS);
    } catch {
      /* fall through — judged by the retry below */
    }
    try {
      const out = await this._run(buildHermesCmd(this.spark, "exit 0"), 20000);
      return !out.includes(HERMES_LAUNCH_FAIL);
    } catch {
      return false;
    }
  }

  async update() {
    const startedAt = Date.now();
    const finishedAt = () => Date.now();
    try {
      let out = await this._run(
        buildHermesCmd(this.spark, UPDATE_ACTION),
        HERMES_UPDATE_TIMEOUT_MS
      );
      if (out.includes(HERMES_LAUNCH_FAIL)) {
        // hermes cannot even start (usually a lost venv entry point). Repair
        // the venv directly, then retry the update once.
        await this._repairVenv();
        out = await this._run(
          buildHermesCmd(this.spark, UPDATE_ACTION),
          HERMES_UPDATE_TIMEOUT_MS
        );
      }
      if (out.includes(HERMES_MISSING)) {
        return {
          ok: false,
          installed: false,
          version: null,
          error: "hermes binary not found on the machine",
          output: out.slice(-2000),
          startedAt,
          finishedAt: finishedAt(),
        };
      }
      const launchBroken = out.includes(HERMES_LAUNCH_FAIL);
      const looksFailed =
        launchBroken ||
        (/error|traceback|failed/i.test(out) && !/already up to date/i.test(out));
      return {
        ok: !looksFailed,
        installed: true,
        version: parseVersion(out),
        error: launchBroken
          ? "hermes is installed but cannot launch (broken install — the automatic repair could not fix it; reinstall hermes manually)."
          : looksFailed
            ? out.trim().slice(-500) || "hermes update reported an error"
            : null,
        output: out.slice(-2000),
        startedAt,
        finishedAt: finishedAt(),
      };
    } catch (err) {
      return {
        ok: false,
        installed: true,
        version: null,
        error: err instanceof Error ? err.message : String(err),
        output: null,
        startedAt,
        finishedAt: finishedAt(),
      };
    }
  }
}
