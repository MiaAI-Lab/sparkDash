/**
 * hostExec — run a model script where its Spark lives, streaming.
 *
 * This is the one primitive the launcher needs that nothing else in the repo
 * provides: `sshExec`/`execFile` buffer the whole output, but a model's
 * `start.sh` can run for twenty minutes (`docker pull`, weight load, then a
 * terminal-attached `docker logs -f`) and the UI must watch it live.
 *
 * Two transports, chosen per model by `resolveRunTarget` (the model's assigned
 * Spark decides — the dashboard itself is machine-agnostic):
 *
 *  - `kind: "ssh"` (the normal path): `sshpass -e ssh … user@host '<cmd>'`,
 *    invocation built by the shared `sshCommandSpec` so auth handling can
 *    never drift from the collectors' `sshExec`. Killing = SIGTERM/SIGKILL to
 *    the local ssh process group; the remote sshd tears the session down with
 *    it, and containers already handed to dockerd survive (same ownership
 *    story as the local path). Passwords travel in the child env only.
 *  - `kind: "local"` (dev on a host, or a local Spark without SSH config):
 *    the original mechanism, imported verbatim from HermesProbe —
 *
 *      nsenter --mount=/host/proc/1/ns/mnt -- setpriv --reuid=… --regid=… \
 *        --init-groups -- sh -c "<cmd>"
 *
 *    `chooseLocalInvocation` resolves uid/gid/HOME from the HOST passwd
 *    (`/host/root/etc/passwd`) so the script writes files as the host user
 *    (no root-owned garbage in the repo, no git "dubious ownership"), and
 *    `nsenter --mount` gives us the host's `docker` CLI + socket, which the
 *    container image does not have.
 *
 * Killing is uniform: the child is its own process group (`detached`), so a
 * cancel can SIGTERM/SIGKILL the whole tree — `sh`, `docker`, the trailing
 * `docker logs -f` — while the *containers* those commands started stay owned
 * by dockerd and survive. That is why job liveness is derived from the
 * container/port probe, never from the job's exit code.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { HOST_PATHS, MODEL_HOST_USER } from "../config.js";
import { chooseLocalInvocation } from "../collectors/HermesProbe.js";
import { sshCommandSpec } from "../collectors/ssh.js";

/** Host mount namespace path, or null when running directly on a host (dev). */
export function hostMountNs() {
  const p = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Host passwd text (for uid/gid resolution), best-effort. */
export function hostPasswdText(mntNs) {
  const p = mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd";
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Quote a string for POSIX sh single quotes. Used for every interpolated
 * value so a config value can never become shell syntax.
 * @param {string} value
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that runs `script` (with optional args) inside
 * `dir`. Exported for tests — the shape is asserted there.
 * @param {{dir: string, script: string, args?: string[]}} opts
 */
export function buildScriptCommand({ dir, script, args = [] }) {
  const argStr = args.length ? ` ${args.map((a) => shQuote(a)).join(" ")}` : "";
  return [
    dirGuard(dir),
    scriptGuard(script),
    // `exec` replaces the shell so signals reach the script itself, and the
    // exit code we observe is the script's.
    `exec bash ${shQuote(`./${script}`)}${argStr}`,
  ].join("; ");
}

function dirGuard(dir) {
  return `cd ${shQuote(dir)} || { echo "[hostExec] repo directory missing: ${dir}" >&2; exit 127; }`;
}

function scriptGuard(script) {
  return `test -f ${shQuote(script)} || { echo "[hostExec] script not found: ${script}" >&2; exit 127; }`;
}

/**
 * Build one command that runs several scripts in sequence (an exclusive Start
 * has to stop the incumbent first, and the transcript must show both).
 *
 * Unlike the single-script form this cannot use `exec` (there is more than one
 * step), so the wrapper shell stays as the group leader — which is fine, the
 * kill path targets the whole process group either way. Each step reports its
 * own exit code; a failed step does not abort the chain, because "stop failed
 * but start succeeded" is a much more useful transcript than a silent abort.
 *
 * A chain must live on ONE machine; when an exclusive Start crosses Sparks the
 * job manager groups steps per target and runs one chained command per Spark.
 *
 * @param {{dir: string, script: string, args?: string[], label?: string}[]} steps
 */
export function buildChainedCommand(steps) {
  const parts = [];
  for (const [i, s] of steps.entries()) {
    const argStr = s.args?.length ? ` ${s.args.map((a) => shQuote(a)).join(" ")}` : "";
    parts.push(
      `echo ""`,
      `echo "=== ${s.label || s.script} (${s.dir}) ==="`,
      dirGuard(s.dir),
      scriptGuard(s.script),
      `bash ${shQuote(`./${s.script}`)}${argStr}; __rc=$?; echo "[exit] ${s.script}: ${'$'}__rc"`
    );
  }
  // Propagate the LAST step's code — that is the action the user asked for.
  parts.push(`exit $__rc`);
  return parts.join("; ");
}

// ─── Target resolution ────────────────────────────────────

/**
 * Decide where a model's scripts run: on the Spark assigned to the card, not
 * on the machine the dashboard happens to be hosted by. Both Sparks are SSH
 * configured (password auth today, keys after the migration — the builder in
 * collectors/ssh.js handles both), so the normal verdict is `kind: "ssh"`.
 *
 * @param {{ id?: string, sparkId?: string }} model
 * @param {(id: string) => object|null} getSpark SparkRegistry lookup — MUST
 *   return the in-memory spark INCLUDING ssh.password (registry getSpark).
 * @returns {{ kind: "ssh"|"local", key: string, label: string, spark?: object }
 *          | { kind: null, error: string }}
 */
export function resolveRunTarget(model, getSpark) {
  const id = model?.id || "?";
  if (!model?.sparkId) {
    return {
      kind: null,
      error: `Model ${id} has no Spark assigned — open its gear menu and pick the machine where its scripts live.`,
    };
  }
  const spark = typeof getSpark === "function" ? getSpark(model.sparkId) : null;
  if (!spark) {
    return {
      kind: null,
      error: `Spark "${model.sparkId}" assigned to model ${id} is not registered — add the Spark or reassign the model.`,
    };
  }
  const host = spark.ssh?.host || spark.lanIp;
  const user = spark.ssh?.user;
  if (host && user) {
    const name = spark.name || spark.id;
    return {
      kind: "ssh",
      spark,
      key: `ssh:${spark.id}`,
      label: `${name} (${user}@${host})`,
    };
  }
  if (spark.isLocal) {
    return { kind: "local", spark, key: `local:${spark.id}`, label: "local host" };
  }
  return {
    kind: null,
    error: `Spark "${spark.id}" has no SSH host/user and is not local — cannot run model scripts on it.`,
  };
}

// ─── Streaming execution ──────────────────────────────────

/**
 * Shared streaming machinery: spawn `file argv` detached (own process group),
 * stream both pipes, resolve when the child exits; never rejects on a
 * non-zero exit (the exit code is reported instead — a failing `stop.sh` is
 * data, not an exception). Used verbatim by both transports.
 *
 * @returns {Promise<{ code: number|null, signal: string|null, timedOut: boolean,
 *   cancelled: boolean, spawned: boolean, error: string|null }>}
 */
function spawnStreaming(file, args, env, { onData, timeoutMs, signal, killGraceMs = 3000 }) {
  return new Promise((resolve) => {
    /** @type {import("child_process").ChildProcess} */
    let child;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        spawned: false,
        error: `Failed to launch ${file}: ${err?.message || err}`,
      });
      return;
    }

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    const killGroup = (sig) => {
      // Negative pid → the whole process group (ssh/sh + docker + any `logs -f`).
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const terminate = (reason) => {
      if (settled || killTimer) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancel") cancelled = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        graceTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
        graceTimer.unref?.();
        killGroup("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    const timeoutTimer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => terminate("timeout"), timeoutMs)
        : null;
    timeoutTimer?.unref?.();

    const onAbort = () => terminate("cancel");
    if (signal) {
      if (signal.aborted) terminate("cancel");
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const emit = (stream) => (buf) => {
      if (!onData) return;
      try {
        onData(String(buf), stream);
      } catch {
        /* transcript sink must never kill the pipe */
      }
    };
    child.stdout?.on("data", emit("stdout"));
    child.stderr?.on("data", emit("stderr"));

    // EPIPE/ENOENT from a missing nsenter/setpriv/ssh/sshpass, or a mid-flight spawn error.
    child.on("error", (err) => {
      finish(null, null, `spawn error: ${err?.message || err}`);
    });

    child.on("close", (code, sig) => finish(code, sig, null));

    function finish(code, sig, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        code: Number.isInteger(code) ? code : null,
        signal: sig || null,
        timedOut,
        cancelled,
        spawned: true,
        error,
      });
    }
  });
}

/**
 * Stream a host command on the LOCAL host (nsenter path). Kept for dev-on-host and
 * for Sparks registered as local without SSH config; the launcher routes
 * through spawnOnTarget, which picks this for `kind: "local"`.
 *
 * @param {string} cmd shell body
 * @param {object} [opts]
 * @param {(chunk: string, stream: "stdout"|"stderr") => void} [opts.onData]
 * @param {number} [opts.timeoutMs] hard cap; on expiry the process group is killed
 * @param {AbortSignal} [opts.signal] caller-driven cancel (same kill path)
 * @param {string} [opts.user] host account to drop to (default MODEL_HOST_USER)
 * @param {number} [opts.killGraceMs] grace before SIGKILL after SIGTERM
 * @returns {Promise<{ code: number|null, signal: string|null, timedOut: boolean,
 *   cancelled: boolean, spawned: boolean, error: string|null }>}
 */
export function spawnOnHost(cmd, opts = {}) {
  const { user = MODEL_HOST_USER } = opts;

  const mntNs = hostMountNs();
  const passwdText = hostPasswdText(mntNs);
  const inv = chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    user,
    cmd,
  });

  return spawnStreaming(inv.file, inv.args, { ...process.env, TERM: "dumb" }, opts);
}

/**
 * Stream a command on a resolved run target (see resolveRunTarget). Same
 * result shape and same kill semantics on both transports. A target whose SSH
 * invocation cannot be built (missing password, bad host) resolves as a
 * non-spawned error — the job settles with the reason in its transcript,
 * which is what the operator needs to see.
 *
 * @param {ReturnType<typeof resolveRunTarget>} target
 * @param {string} cmd shell body (executed by the remote/default shell as-is)
 * @param {object} [opts] see spawnOnHost
 */
export function spawnOnTarget(target, cmd, opts = {}) {
  if (!target || target.kind === null) {
    return Promise.resolve({
      code: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawned: false,
      error: target?.error || "No run target resolved",
    });
  }
  if (target.kind === "local") return spawnOnHost(cmd, opts);
  try {
    const inv = sshCommandSpec(target.spark, { remoteArgv: [cmd] });
    return spawnStreaming(inv.file, inv.args, { ...inv.env, TERM: "dumb" }, opts);
  } catch (err) {
    return Promise.resolve({
      code: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawned: false,
      error: err?.message || String(err),
    });
  }
}

/**
 * One-shot command with a capped buffered result (probes). Same routing as
 * spawnOnTarget, convenience wrapper for `docker ps`/`git remote`-style reads.
 * Unlike the collectors' sshExec this never throws on a non-zero remote exit —
 * callers here branch on `code` and must distinguish "docker absent" from
 * "SSH dead".
 * @param {ReturnType<typeof resolveRunTarget>} target
 * @param {string} cmd
 * @param {{timeoutMs?: number, user?: string}} [opts]
 */
export async function execOnTarget(target, cmd, opts = {}) {
  let out = "";
  let err = "";
  const res = await spawnOnTarget(target, cmd, {
    timeoutMs: opts.timeoutMs ?? 5000,
    user: opts.user,
    onData: (chunk, stream) => {
      if (stream === "stderr") err += chunk;
      else out += chunk;
      if (out.length > 64_000) out = out.slice(-64_000);
    },
  });
  return { ...res, stdout: out, stderr: err };
}
