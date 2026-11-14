/**
 * Scan jobs on a unit: their time limits, whether they can be stopped there, and what the `job` program
 * (scripts/job.sh) answers. StorageManager owns the job objects; this module only holds the rules.
 *
 * - A scan without sudo runs in its own session on the unit and records who it is; "Stop scan" signals it
 *   (TERM, grace, KILL) and reports whether it is really gone.
 * - A scan through sudo runs as root, which the account cannot signal: it is not stoppable from here, and the
 *   unit ends it (as root) at a hard limit, so the page can say when it stops by itself.
 * - In container-local context the processes may live in another PID namespace: stopping is best effort.
 */
import { hostMountNs } from "../shutdown.js";
import { SCAN_LIMIT_SECONDS, programResult } from "./commands.js";

/** An administrator scan stops by itself this long after it started (roadmap §5.3: 5 minutes). */
export const ELEVATED_SCAN_CAP_SECONDS = 300;
/** `timeout -k`: after the cap, KILL follows TERM this much later. */
const CAP_KILL_SECONDS = 10;
/** Extra time a scan's last steps may take after its soft limit (see scan.sh's $6). */
const DEADLINE_SLACK_SECONDS = 100;

/**
 * Limits for one scan. `limitSeconds`: the unit stops measuring and reports what it has. `deadlineSeconds`:
 * no step runs past it. `hardLimitSeconds` (capped scans only): the unit kills the whole program.
 * `stopsWithinMs`: after this long nothing of the scan can still be running on the unit.
 * @param {{ capped: boolean }} o
 */
export function scanLimits({ capped }) {
  if (capped) {
    return {
      limitSeconds: ELEVATED_SCAN_CAP_SECONDS - 100,
      deadlineSeconds: ELEVATED_SCAN_CAP_SECONDS - 10,
      hardLimitSeconds: ELEVATED_SCAN_CAP_SECONDS,
      stopsWithinMs: (ELEVATED_SCAN_CAP_SECONDS + CAP_KILL_SECONDS) * 1000,
    };
  }
  const deadline = SCAN_LIMIT_SECONDS + DEADLINE_SLACK_SECONDS;
  return { limitSeconds: SCAN_LIMIT_SECONDS, deadlineSeconds: deadline, hardLimitSeconds: 0, stopsWithinMs: deadline * 1000 };
}

/**
 * @typedef {{ kind: "ssh" | "native-local" | "container-local", accountIsRoot: boolean }} JobContext
 */

/**
 * How programs reach a unit, decided the way runProgram decides it. A seam: the execution-context probe
 * (context.js) can replace it with what the unit itself reported.
 * @param {{ isLocal?: boolean, ssh?: { user?: string } }} spark
 * @returns {JobContext}
 */
export function defaultContextOf(spark) {
  const localRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!spark?.isLocal) return { kind: "ssh", accountIsRoot: spark?.ssh?.user === "root" };
  return { kind: hostMountNs() ? "container-local" : "native-local", accountIsRoot: localRoot };
}

/**
 * What one scan will be on the unit, decided before it starts.
 * @param {JobContext} ctx
 * @param {boolean} elevate sudo was asked for
 */
export function scanPlan(ctx, elevate) {
  // Root needs no sudo: its scan runs as the account itself and can be stopped like any other.
  const viaSudo = elevate && !ctx.accountIsRoot;
  return {
    viaSudo,
    cancellable: !viaSudo,
    cancelBestEffort: !viaSudo && ctx.kind === "container-local",
    limits: scanLimits({ capped: viaSudo }),
  };
}

const OUTCOMES = new Set(["terminated", "already-gone", "not-terminated", "unknown"]);
const STATES = new Set(["running", "gone", "unknown"]);
const LOCKS = new Set(["free", "held", "unknown"]);

/**
 * The `job` program's answer. Anything unexpected is "unknown": never read as stopped.
 * @param {"cancel" | "status"} action
 * @returns {{ ok: true, outcome?: string, state?: string, reason: string, lock: "free" | "held" | "unknown" }
 *   | { ok: false, code: string, message: string }}
 */
export function parseJobOutput(action, out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const v = r.values;
  const reason = /^[a-z-]{1,40}$/.test(v.REASON ?? "") ? v.REASON : "unknown";
  const lock = LOCKS.has(v.LOCK) ? v.LOCK : "unknown";
  if (action === "cancel") return { ok: true, outcome: OUTCOMES.has(v.OUTCOME) ? v.OUTCOME : "unknown", reason, lock };
  return { ok: true, state: STATES.has(v.STATE) ? v.STATE : "unknown", reason, lock };
}

/** Plain words for why a stop could not be confirmed (the `job` program's REASON). */
export function stopReasonText(reason) {
  switch (reason) {
    case "still-running":
      return "Some of its processes were still running after being told to stop.";
    case "pid-namespace":
      return "The dashboard runs in a container that does not see the Spark's processes the way it can signal them.";
    case "no-record":
      return "The scan had not recorded which processes are its own, so nothing was signalled.";
    case "identity":
    case "owner":
    case "boot":
      return "The processes did not match the scan's record, so nothing was signalled.";
    case "no-process-check":
      return "The Spark's process list could not be checked.";
    case "unreachable":
      return "The Spark could not be reached.";
    default:
      return "The Spark did not confirm it.";
  }
}
