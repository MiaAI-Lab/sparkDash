/**
 * Execution contexts (Storage Manager roadmap §4): how the dashboard reaches a Spark, and which features
 * that allows. The facts come from scripts/context.sh (parsed by parseContextOutput in commands.js); the
 * transport is decided here exactly as runProgram decides it, so the label always matches the real path.
 *
 * - "ssh": `ssh user@host` as that account. Real $HOME, host PID namespace and mounts.
 * - "native-local": the dashboard runs on the Spark itself and commands are its own child processes.
 * - "container-local": the dashboard runs in a container and enters the host's mount namespace (nsenter).
 *   Only the mounts are the host's: the user (usually root), $HOME, the environment and, unless the
 *   container shares it, the PID namespace are the container's.
 */
import { hostMountNs } from "../shutdown.js";

/** @typedef {"ssh" | "native-local" | "container-local"} ContextKind */
/** @typedef {"ssh" | "nsenter" | "local"} Transport */

/**
 * How runProgram reaches the unit (same test, same order).
 * @param {{ isLocal?: boolean }} spark
 * @param {() => string | null} [mountNs]
 * @returns {Transport}
 */
export function transportOf(spark, mountNs = hostMountNs) {
  if (!spark?.isLocal) return "ssh";
  return mountNs() ? "nsenter" : "local";
}

/**
 * @param {Transport} transport
 * @param {{ inContainer?: boolean }} [facts] what the unit-side probe saw
 * @returns {ContextKind}
 */
export function classifyContext(transport, facts = {}) {
  if (transport === "ssh") return "ssh";
  if (transport === "nsenter") return "container-local";
  // A plain child process inside a container sees the container's files, not the Spark's: never "native".
  return facts.inContainer === true ? "container-local" : "native-local";
}

/**
 * What each feature needs. `contexts`: where it is offered at all (with the reason it is not elsewhere);
 * `needs`: capabilities from the probe; `check`: anything finer. A feature with no requirements works in
 * every context, even before the probe has answered. Add entries here rather than testing contexts inline.
 * @type {Record<string, { contexts?: ContextKind[], contextReason?: string,
 *   needs?: { cap: string, reason: (ctx: object) => string }[], check?: (ctx: object) => string | null }>}
 */
export const FEATURES = Object.freeze({
  analyse: {},
  delete: {},
  docker: { needs: [{ cap: "docker", reason: () => "Docker is not installed on this Spark" }] },
  "docker-buildx": {
    needs: [
      { cap: "docker", reason: () => "Docker is not installed on this Spark" },
      { cap: "buildx", reason: () => "docker buildx is not installed on this Spark" },
    ],
  },
  /** Administrator actions with nothing to type: root already, or sudo that asks for no password. */
  "admin-without-password": {
    check: (ctx) => (ctx.capabilities.includes("root") || ctx.capabilities.includes("sudo-n") ? null : "sudo on this Spark asks for a password"),
  },
  /** Stopping a scan and proving it stopped needs the Spark's own process list. */
  "verified-cancel": {
    check: (ctx) =>
      ctx.kind !== "container-local" || ctx.capabilities.includes("host-pid-ns")
        ? null
        : "The dashboard runs in a container that does not share the Spark's process list, so stopping is best effort",
  },
  /** Work that survives a dropped connection (roadmap §5.4). Not offered until a real transient-unit test exists. */
  "supervised-jobs": {
    contexts: ["ssh", "native-local"],
    contextReason: "Long-running supervised jobs are not offered while the dashboard runs in a container",
    needs: [
      { cap: "systemd-run", reason: () => "systemd-run --user is not available on this Spark" },
      { cap: "linger", reason: (ctx) => `Lingering is off for ${ctx.account || "this account"}, so jobs would stop at logout` },
      { cap: "transient-unit", reason: () => "Starting a transient systemd --user unit has not been tested on this Spark" },
    ],
  },
});

/**
 * Whether a feature can be offered in this context, and why not when it cannot.
 * @param {string} feature a key of FEATURES
 * @param {{ kind: ContextKind, capabilities: string[], account?: string | null } | null | undefined} ctx
 * @returns {{ supported: boolean, reason: string | null }}
 */
export function supports(feature, ctx) {
  const f = Object.prototype.hasOwnProperty.call(FEATURES, feature) ? FEATURES[feature] : null;
  if (!f) return { supported: false, reason: `Unknown feature: ${feature}` };
  const hasRules = Boolean(f.contexts || f.needs?.length || f.check);
  if (!hasRules) return { supported: true, reason: null };
  if (!ctx) return { supported: false, reason: "This Spark has not been checked yet" };
  if (f.contexts && !f.contexts.includes(ctx.kind)) return { supported: false, reason: f.contextReason ?? "Not offered in this execution context" };
  for (const n of f.needs ?? []) if (!ctx.capabilities.includes(n.cap)) return { supported: false, reason: n.reason(ctx) };
  const why = f.check ? f.check(ctx) : null;
  return why ? { supported: false, reason: why } : { supported: true, reason: null };
}

/** Every feature with its verdict, for the page. */
export function featureTable(ctx) {
  return Object.fromEntries(Object.keys(FEATURES).map((f) => [f, supports(f, ctx)]));
}
