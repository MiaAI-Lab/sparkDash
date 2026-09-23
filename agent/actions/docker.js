/**
 * docker.js — Docker container actions: start / stop / restart / rm.
 *
 * Batch 2A of the node agent (multi-Spark dashboard). Runs the exact docker
 * CLI command with exact argv — no shell, no injection:
 *
 *   docker start <name>
 *   docker stop  <name>
 *   docker restart <name>
 *   docker rm    <name>
 *
 * Seam types (shared/types.ts):
 *   - ActionResponse — the Promise result of every function in this module
 *   - ActionRequest  — the request fields mirrored into `opts`
 *     (actionId, serviceName, timeoutMs)
 *
 * Exact-argv: every action shells out through
 * `execFile("docker", [verb, name])`. The container name is one argv entry,
 * never routed through a shell: a name containing shell metacharacters
 * ("foo; rm -rf /") is passed to docker verbatim and fails with docker's own
 * "no such container" error. No shell is ever spawned.
 *
 * Status: docker actions complete synchronously, so responses carry
 * "success" / "failure" only. "running" is reserved for long-lived actions
 * (Batch 2B LLM switch) that the orchestrator may report as in-flight.
 *
 * Idempotency: start/stop/restart are idempotent in the docker sense
 * (re-running converges on the same container state — exit 0 either way);
 * rm is NOT (a second rm fails with "no such container").
 *
 * Graceful degradation: when the docker binary is missing (ENOENT), the
 * action resolves a failure ActionResponse with error "docker not found"
 * instead of throwing.
 *
 * Test seam: `opts.execFile` replaces `child_process.execFile` with the same
 * `(file, args, options, callback)` signature — mirrors the collectors'
 * injectable dependency pattern (agent/collectors/docker.js `exec` param,
 * agent/collectors/util.js `runShell`).
 */
import { execFile } from "node:child_process";

/** Default per-command timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30000;
/** Max characters of stderr preserved in ActionResponse.error. */
export const ERROR_MAX_CHARS = 500;
/** Names longer than this are rejected before spawning anything. */
const NAME_MAX_CHARS = 1024;

/**
 * Options accepted by every action in this module.
 * @typedef {object} ActionOptions
 * @property {string} [actionId] unique action id (idempotency key); generated when absent
 * @property {string} [serviceName] service name for audit; defaults to the container name
 * @property {number} [timeoutMs] command timeout in ms; defaults to DEFAULT_TIMEOUT_MS
 * @property {(file: string, args: string[], options: object, cb: (err: Error|null, stdout: string, stderr: string) => void) => void} [execFile]
 *   test seam: replaces child_process.execFile
 */

/**
 * One action response (shared/types.ts → ActionResponse).
 * @typedef {object} ActionResponse
 * @property {string} actionId
 * @property {string} serviceName
 * @property {"success"|"failure"|"running"} status
 * @property {boolean} ok
 * @property {string} message
 * @property {string|null} error
 * @property {number} durationMs
 * @property {boolean} idempotent
 * @property {number} at
 */

/**
 * Validate a container name before spawning.
 * @param {unknown} name
 * @returns {string|null} error message, or null when the name is usable
 */
function nameError(name) {
  if (typeof name !== "string") return "container name must be a string";
  if (name.length === 0) return "container name must be non-empty";
  if (name.length > NAME_MAX_CHARS) return "container name exceeds 1024 chars";
  if (name.includes("\u0000")) return "container name contains NUL";
  if (/\r|\n/.test(name)) return "container name contains line breaks";
  return null;
}

/** @returns {string} a fresh action id */
function freshActionId() {
  return `act-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {unknown} raw @returns {string} trimmed text truncated to ERROR_MAX_CHARS */
function truncate(raw) {
  const t = String(raw ?? "").trim();
  return t.length > ERROR_MAX_CHARS ? t.slice(0, ERROR_MAX_CHARS) : t;
}

/**
 * Build the ActionResponse.
 * @param {"start"|"stop"|"restart"|"rm"} verb
 * @param {string} name
 * @param {object} o resolved options
 * @param {{ok: boolean, status: string, error: string|null, detail: string, durationMs: number}} r
 * @returns {ActionResponse}
 */
function respond(verb, name, o, r) {
  const actionId =
    typeof o.actionId === "string" && o.actionId.trim() !== "" ? o.actionId : freshActionId();
  const serviceName =
    typeof o.serviceName === "string" && o.serviceName.trim() !== "" ? o.serviceName : name;
  return {
    actionId,
    serviceName,
    status: r.status,
    ok: r.ok,
    message: `docker ${verb} ${name} → ${r.detail}`,
    error: r.ok ? null : r.error,
    durationMs: r.durationMs,
    idempotent: verb !== "rm",
    at: Date.now(),
  };
}

/**
 * Run one docker action with exact argv.
 *
 * Error mapping (verified against Node v24.21 child_process.execFile):
 *   - exit 0                        → ok, status "success"
 *   - err.code === "ENOENT"         → error "docker not found"
 *   - err.killed === true / SIGTERM → error "timeout"
 *   - non-zero exit                 → error = stderr (≤ 500 chars) or fallback
 *
 * @param {"start"|"stop"|"restart"|"rm"} verb
 * @param {unknown} name
 * @param {ActionOptions} [opts]
 * @returns {Promise<ActionResponse>} never rejects
 */
function runAction(verb, name, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const execFileFn = typeof o.execFile === "function" ? o.execFile : execFile;
  const startedAt = Date.now();

  const invalid = nameError(name);
  if (invalid) {
    // Fail fast without spawning: out-of-bounds input → reasonable error.
    return Promise.resolve(
      respond(verb, String(name).slice(0, 32), o, {
        ok: false,
        status: "failure",
        error: `invalid container name: ${invalid}`,
        detail: "invalid container name",
        durationMs: 0,
      })
    );
  }

  const timeoutMs =
    typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
      ? Math.round(o.timeoutMs)
      : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    /** @param {{ok: boolean, status: string, error: string|null, detail: string, durationMs: number}} r */
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(respond(verb, name, o, r));
    };

    execFileFn("docker", [verb, name], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (!err) {
        return finish({ ok: true, status: "success", error: null, detail: "exit 0", durationMs });
      }
      if (err.code === "ENOENT") {
        return finish({
          ok: false,
          status: "failure",
          error: "docker not found",
          detail: "docker not found",
          durationMs,
        });
      }
      if (err.killed === true || err.code === "ERR_CHILD_PROCESS_TIMEOUT") {
        return finish({
          ok: false,
          status: "failure",
          error: "timeout",
          detail: `timeout after ${timeoutMs}ms`,
          durationMs,
        });
      }
      const code = typeof err.code === "number" ? err.code : null;
      const errorText =
        truncate(stderr) ||
        (code != null
          ? `docker ${verb} exited with code ${code}`
          : truncate(err.message) || "docker command failed");
      return finish({
        ok: false,
        status: "failure",
        error: errorText,
        detail: `exit ${code ?? "?"}`,
        durationMs,
      });
    });
  });
}

/**
 * Start a container. `docker start <name>`.
 * Idempotent: starting an already-running container exits 0.
 * @param {string} name container name (or id)
 * @param {ActionOptions} [opts]
 * @returns {Promise<ActionResponse>}
 */
export function startContainer(name, opts) {
  return runAction("start", name, opts);
}

/**
 * Stop a container. `docker stop <name>`.
 * Idempotent: stopping a stopped container exits 0.
 * @param {string} name container name (or id)
 * @param {ActionOptions} [opts]
 * @returns {Promise<ActionResponse>}
 */
export function stopContainer(name, opts) {
  return runAction("stop", name, opts);
}

/**
 * Restart a container. `docker restart <name>`.
 * Idempotent: restart converges on running either way.
 * @param {string} name container name (or id)
 * @param {ActionOptions} [opts]
 * @returns {Promise<ActionResponse>}
 */
export function restartContainer(name, opts) {
  return runAction("restart", name, opts);
}

/**
 * Remove a container. `docker rm <name>`.
 * NOT idempotent: a second rm fails with "no such container".
 * @param {string} name container name (or id)
 * @param {ActionOptions} [opts]
 * @returns {Promise<ActionResponse>}
 */
export function removeContainer(name, opts) {
  return runAction("rm", name, opts);
}
