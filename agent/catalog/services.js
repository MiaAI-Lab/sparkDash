/**
 * sparkdash-node-agent — service registry: join recipes + live state.
 *
 * listServices() produces ServiceInstance[] (shared/types.ts): what SHOULD
 * run (recipe) joined with what IS running (liveState, keyed by port). The
 * live-state producer lands in Batch 1A (telemetry/versions pollers); this
 * module consumes whatever shape it passes, keyed by port.
 *
 * Status rules:
 *  - live entry with a known explicit `status` (loading/wedged/...) → use it
 *  - live entry with running=true → "running"; modelId/engineVersion live
 *  - live entry with running=false, or no live entry → "stopped";
 *    modelId from recipe, engineVersion from the docker image tag
 *    (per shared/types.ts VersionInfo: "from image tag or server_info")
 *  - active = kind==="llm" && status==="running"
 *
 * Pure join: no I/O, no module state.
 */

const VALID_STATUS = new Set(["running", "stopped", "loading", "wedged", "unknown"]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Extract the docker image tag from an image reference.
 * "lmsysorg/sglang:v1.2.0" → "v1.2.0"; "repo/img" → null;
 * "registry:5000/img" → null (the colon is a registry port, not a tag).
 * @param {unknown} image
 * @returns {string|null}
 */
export function imageTag(image) {
  if (typeof image !== "string" || image.length === 0) return null;
  const idx = image.lastIndexOf(":");
  if (idx === -1) return null;
  const tag = image.slice(idx + 1);
  if (tag.length === 0 || tag.includes("/")) return null;
  return tag;
}

/**
 * Live port state (producer: Batch 1A versions/containers pollers).
 * @typedef {object} LivePortState
 * @property {boolean} running
 * @property {string|null} [modelId]
 * @property {string|null} [engineVersion]
 * @property {string} [status] optional explicit status override
 */

/**
 * One service instance, running or configured (shared/types.ts → ServiceInstance).
 * @typedef {object} ServiceInstance
 * @property {string} name
 * @property {string} kind
 * @property {string} engine
 * @property {number} port
 * @property {"running"|"stopped"|"loading"|"wedged"|"unknown"} status
 * @property {string|null} modelId
 * @property {string|null} engineVersion
 * @property {number} footprintMB
 * @property {boolean} active
 * @property {number} polledAt
 */

/**
 * Join recipes with live state into ServiceInstance[].
 *
 * Field defaults for partial recipes (this is the view/join layer — hard
 * validation belongs to recipes.js at load time):
 *  - kind → "other", engine → "other", footprintMB → 0
 *
 * @param {import("./recipes.js").Recipe[]} recipes
 * @param {Record<number|string, LivePortState|null>} [liveState]
 * @returns {ServiceInstance[]}
 * @throws {TypeError} on non-array recipes or missing name/port
 */
export function listServices(recipes, liveState = null) {
  if (!Array.isArray(recipes)) {
    throw new TypeError("recipes must be an array");
  }
  const now = Date.now();
  const liveMap = liveState && typeof liveState === "object" ? liveState : null;

  return recipes.map((r, i) => {
    const label = `recipes[${i}]`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new TypeError(`${label} must be an object`);
    }
    if (typeof r.name !== "string" || r.name.length === 0) {
      throw new TypeError(`${label}.name must be a non-empty string`);
    }
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
      throw new TypeError(`${label}.port must be an integer 1–65535 (got ${JSON.stringify(r.port)})`);
    }
    const kind = typeof r.kind === "string" && r.kind.length > 0 ? r.kind : "other";
    const engine = typeof r.engine === "string" && r.engine.length > 0 ? r.engine : "other";
    let footprintMB = 0;
    if (r.footprintMB !== undefined && r.footprintMB !== null) {
      if (!isFiniteNumber(r.footprintMB) || r.footprintMB < 0) {
        throw new TypeError(
          `${label}.footprintMB must be a non-negative finite number (got ${JSON.stringify(r.footprintMB)})`
        );
      }
      footprintMB = r.footprintMB;
    }

    const live = liveMap ? liveMap[r.port] : undefined;
    const liveObj = live && typeof live === "object" ? live : null;

    let status;
    if (liveObj && VALID_STATUS.has(liveObj.status)) {
      status = liveObj.status;
    } else if (liveObj) {
      status = liveObj.running === true ? "running" : "stopped";
    } else {
      status = "stopped";
    }

    let modelId;
    let engineVersion;
    if (liveObj && status === "running") {
      modelId =
        typeof liveObj.modelId === "string" && liveObj.modelId.length > 0 ? liveObj.modelId : null;
      engineVersion =
        typeof liveObj.engineVersion === "string" && liveObj.engineVersion.length > 0
          ? liveObj.engineVersion
          : null;
    } else {
      modelId = typeof r.modelId === "string" && r.modelId.length > 0 ? r.modelId : null;
      engineVersion = imageTag(r.image);
    }

    return {
      name: r.name,
      kind,
      engine,
      port: r.port,
      status,
      modelId,
      engineVersion,
      footprintMB,
      active: kind === "llm" && status === "running",
      polledAt: now,
    };
  });
}
