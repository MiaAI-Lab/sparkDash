/**
 * systemd.js — node-agent actions: start / stop / restart systemd units.
 *
 * Runs the EXACT systemctl argv (child_process.execFile, no shell → no
 * injection). Unit handling mirrors agent/collectors/systemd.js, but the
 * actions contract (Batch 2B) requires exact-argv execution + ActionResponse
 * (shared/types.ts) rather than a collector snapshot entry.
 *
 * ActionResponse:
 *   { actionId, serviceName, status, ok, message, error, durationMs,
 *     idempotent, at }
 *   status: "success" | "failure" ("running" reserved for async actions the
 *   wiring batch will add; every function here resolves once the command has
 *   finished or been killed).
 *
 * Graceful degradation (never throws, never rejects — always resolves with
 * an ActionResponse):
 *   - systemctl missing (ENOENT)  → ok=false, error="systemctl not found"
 *   - command timeout              → ok=false, error="timeout"
 *   - invalid unit name            → ok=false, error="invalid unit name"
 *     (no command is ever executed for invalid input)
 *
 * Idempotency: start/stop/restart are idempotent commands (idempotent: true).
 * A non-empty opts.actionId also dedupes CONCURRENT identical submissions:
 * the second caller shares the in-flight execution instead of double-running
 * the command (bounded state — released when the command settles).
 */
import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30000;
const UNIT_NAME_RE = /^[A-Za-z0-9._:@~\-]+$/;

/**
 * One action response (shared/types.ts → ActionResponse).
 * @typedef {object} ActionResponse
 * @property {string} actionId
 * @property {string} serviceName
 * @property {"success"|"failure"|"running"} status
 * @property {boolean} ok
 * @property {string} message
 * @property {string|null} error
 * @property {number|null} durationMs
 * @property {boolean} idempotent
 * @property {number} at
 */

/**
 * Exact-argv runner result.
 * @typedef {object} ExecResult
 * @property {number|null} exitCode null when killed or not found
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} notFound binary missing (ENOENT)
 * @property {boolean} timedOut killed by the timeout
 */

/**
 * Run one command with exact argv and a hard timeout. No shell is involved,
 * so every argument passes to the binary verbatim (injection-proof).
 *
 * Shared runner for the actions layer (Batch 2A's docker.js follows the same
 * contract; tests inject a mock with this exact shape).
 * @param {string} file executable name or path
 * @param {string[]} args exact argv
 * @param {{ timeoutMs?: number }} [runOpts]
 * @returns {Promise<ExecResult>}
 */
export function runExec(file, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        const errOut = String(stderr || "");
        if (err) {
          if (err.code === "ENOENT") {
            resolve({
              exitCode: null,
              stdout: out,
              stderr: errOut,
              notFound: true,
              timedOut: false,
            });
            return;
          }
          if (err.killed) {
            resolve({
              exitCode: null,
              stdout: out,
              stderr: errOut,
              notFound: false,
              timedOut: true,
            });
            return;
          }
          const exitCode = typeof err.code === "number" ? err.code : 1;
          resolve({
            exitCode,
            stdout: out,
            stderr: errOut,
            notFound: false,
            timedOut: false,
          });
          return;
        }
        resolve({
          exitCode: 0,
          stdout: out,
          stderr: errOut,
          notFound: false,
          timedOut: false,
        });
      }
    );
  });
}

/**
 * Build a complete ActionResponse with safe defaults.
 * error is truncated to 500 chars (seam contract).
 * @param {{ actionId?: string, serviceName?: string, status?: string, ok?: boolean, message?: string, error?: string|null, durationMs?: number|null, at?: number }} [fields]
 * @returns {ActionResponse}
 */
export function buildActionResponse({
  actionId = "",
  serviceName = "",
  status = "failure",
  ok = false,
  message = "",
  error = null,
  durationMs = null,
  at = Date.now(),
} = {}) {
  return {
    actionId: typeof actionId === "string" ? actionId : "",
    serviceName: typeof serviceName === "string" ? serviceName : "",
    status,
    ok: Boolean(ok),
    message: String(message),
    error: error == null ? null : String(error).slice(0, 500),
    durationMs:
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? durationMs
        : null,
    idempotent: true,
    at: typeof at === "number" ? at : Date.now(),
  };
}

/**
 * True when `name` is a safe systemd unit name: systemd's unit-name charset,
 * no whitespace, no shell metacharacters, ≤ 255 (filesystem limit).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidUnitName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 255 &&
    UNIT_NAME_RE.test(name)
  );
}

/** @type {Map<string, Promise<ActionResponse>>} */
const inFlight = new Map();

/**
 * In-flight dedupe by actionId: concurrent calls with the same non-empty
 * actionId share one execution; settled ids are released (bounded state).
 * The wrapped fn must resolve — action functions always resolve with an
 * ActionResponse; an unexpected rejection is converted to a failure
 * ActionResponse rather than propagated.
 * @param {string|undefined} actionId
 * @param {() => Promise<ActionResponse>} fn
 * @returns {Promise<ActionResponse>}
 */
export function withIdempotency(actionId, fn) {
  if (typeof actionId !== "string" || actionId.length === 0) return Promise.resolve().then(fn);
  const existing = inFlight.get(actionId);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(fn)
    .catch((err) =>
      buildActionResponse({
        actionId,
        status: "failure",
        ok: false,
        message: `internal error: ${String(err?.message || err)}`,
        error: String(err?.message || err),
      })
    )
    .finally(() => inFlight.delete(actionId));
  inFlight.set(actionId, p);
  return p;
}

/**
 * Run one systemctl action with exact argv and map it to an ActionResponse.
 * @param {"start"|"stop"|"restart"} action
 * @param {string} unit
 * @param {{ actionId?: string, serviceName?: string, timeoutMs?: number|null }} [opts]
 * @param {{ exec?: (file: string, args: string[], runOpts?: {timeoutMs?: number}) => Promise<ExecResult> }} [deps]
 * @returns {Promise<ActionResponse>}
 */
export function runUnitAction(action, unit, opts = {}, deps = {}) {
  const o = opts || {};
  const d = deps || {};
  const exec = typeof d.exec === "function" ? d.exec : runExec;
  const actionId = typeof o.actionId === "string" ? o.actionId : "";
  const serviceName =
    typeof o.serviceName === "string" && o.serviceName.length > 0
      ? o.serviceName
      : typeof unit === "string"
        ? unit
        : "";
  const timeoutMs =
    Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

  return withIdempotency(actionId, async () => {
    if (!isValidUnitName(unit)) {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "failure",
        ok: false,
        message: `invalid unit name: ${JSON.stringify(String(unit).slice(0, 80))}`,
        error: "invalid unit name",
      });
    }
    const t0 = Date.now();
    const r = await exec("systemctl", [action, unit], { timeoutMs });
    const durationMs = Date.now() - t0;
    if (r.notFound) {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "failure",
        ok: false,
        message: "systemctl not found",
        error: "systemctl not found",
        durationMs,
      });
    }
    if (r.timedOut) {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "failure",
        ok: false,
        message: `systemctl ${action} ${unit} → timed out after ${timeoutMs}ms (state unknown)`,
        error: "timeout",
        durationMs,
      });
    }
    if (r.exitCode === 0) {
      return buildActionResponse({
        actionId,
        serviceName,
        status: "success",
        ok: true,
        message: `systemctl ${action} ${unit} → exit 0`,
        error: null,
        durationMs,
      });
    }
    return buildActionResponse({
      actionId,
      serviceName,
      status: "failure",
      ok: false,
      message: `systemctl ${action} ${unit} → exit ${r.exitCode}`,
      error: r.stderr.trim() || `exit ${r.exitCode}`,
      durationMs,
    });
  });
}

/**
 * Start a systemd unit (`systemctl start <unit>`).
 * @param {string} unit
 * @param {{ actionId?: string, serviceName?: string, timeoutMs?: number|null }} [opts]
 * @param {{ exec?: (file: string, args: string[], runOpts?: {timeoutMs?: number}) => Promise<ExecResult> }} [deps]
 * @returns {Promise<ActionResponse>}
 */
export function startUnit(unit, opts, deps) {
  return runUnitAction("start", unit, opts, deps);
}

/**
 * Stop a systemd unit (`systemctl stop <unit>`).
 * @param {string} unit
 * @param {{ actionId?: string, serviceName?: string, timeoutMs?: number|null }} [opts]
 * @param {{ exec?: (file: string, args: string[], runOpts?: {timeoutMs?: number}) => Promise<ExecResult> }} [deps]
 * @returns {Promise<ActionResponse>}
 */
export function stopUnit(unit, opts, deps) {
  return runUnitAction("stop", unit, opts, deps);
}

/**
 * Restart a systemd unit (`systemctl restart <unit>`).
 * @param {string} unit
 * @param {{ actionId?: string, serviceName?: string, timeoutMs?: number|null }} [opts]
 * @param {{ exec?: (file: string, args: string[], runOpts?: {timeoutMs?: number}) => Promise<ExecResult> }} [deps]
 * @returns {Promise<ActionResponse>}
 */
export function restartUnit(unit, opts, deps) {
  return runUnitAction("restart", unit, opts, deps);
}
