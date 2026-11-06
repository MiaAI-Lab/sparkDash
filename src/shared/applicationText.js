/** Finite, locale-neutral recognition of complete application-authored text. */
export const APPLICATION_TEXT_MAX_LENGTH = 4096;

/** @param {unknown} raw */
export function applicationTextI18n(raw) {
  if (typeof raw !== "string" || raw.length > APPLICATION_TEXT_MAX_LENGTH) return undefined;
  return KNOWN.get(raw);
}

/** Exact current top-level API/auth/settings literals only; no partial matching. */
const KNOWN = new Map([
  ["Spark not found", { key: "server.error.sparkNotFound" }],
  ["Invalid URL", { key: "server.error.invalidUrl" }],
  ["Authentication required", { key: "server.error.authenticationRequired" }],
  ["Remote access requires SPARKDASH_TOKEN", { key: "server.error.remoteTokenRequired" }],
  ["Shutdown initiated", { key: "server.message.shutdownInitiated" }],
  ["GPU clock cap removed", { key: "server.message.gpuCapRemoved" }],
  ["Cancelled", { key: "server.error.cancelled" }],
  ["Cancelled by user", { key: "server.error.cancelled" }],
  ["lanIp or ssh.host required", { key: "server.error.hostRequired" }],
  ["password is required", { key: "server.error.passwordRequired" }],
  ["promptId is required", { key: "server.error.promptIdRequired" }],
  ["body.order must be an array of spark ids", { key: "server.error.orderArray" }],
  ["disabledDevices must be an array", { key: "server.error.disabledDevicesArray" }],
  ["disabledInterfaces must be an array", { key: "server.error.disabledInterfacesArray" }],
  ["llmPorts must be an array", { key: "server.error.llmPortsArray" }],
  ["Invalid port", { key: "server.error.invalidPort" }],
  ["port is required", { key: "server.error.portRequired" }],
  ["port is not configured for this Spark", { key: "server.error.portUnconfigured" }],
  ["Cannot remove the primary LLM port", { key: "server.error.primaryPort" }],
  ["Cannot remove the last LLM port", { key: "server.error.lastPort" }],
  ["Worker nodes do not expose a local LLM API", { key: "server.error.workerApi" }],
  ["LLM monitoring is disabled for this Spark", { key: "server.error.llmDisabled" }],
  ["ComfyUI monitoring is disabled for this Spark", { key: "server.error.comfyDisabled" }],
  ["Select at least one category", { key: "server.error.categoryRequired" }],
  ["Benchmark not found", { key: "server.error.benchmarkNotFound" }],
  ["Showcase session not found", { key: "server.error.showcaseNotFound" }],
  ["Model not found", { key: "server.error.modelNotFound" }],
  ["Job not found (it may have been replaced by a newer one)", { key: "server.error.jobNotFound" }],
]);
