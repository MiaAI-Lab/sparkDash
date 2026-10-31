import { APPLICATION_TEXT_MAX_LENGTH, applicationTextI18n } from "../../src/shared/applicationText.js";

export function healthI18n(finding) {
  const count = finding.id === "roce-link" ? Number(/^(\d+) RoCE links/.exec(finding.title)?.[1] ?? 1) : undefined;
  return {
    title: { key: `health.${finding.id}.title.${finding.severity}`, ...(count ? { params: { count } } : {}) },
    detail: healthDetail(finding),
    hint: { key: `health.${finding.id}.hint` },
  };
}

/** Finite complete templates only; retain unmatched diagnostics verbatim. */
function healthDetail(finding) {
  if (typeof finding.detail !== "string" || finding.detail.length > APPLICATION_TEXT_MAX_LENGTH) return undefined;
  const patterns = {
    thermal: [/^(\d+)°C \(warns at ([\d.]+)°C, critical at ([\d.]+)°C\)\.$/, ["temperature", "warn", "critical"]],
    "low-power": [/^(\d+)% utilisation but only ([\d.]+) W for (\d+) samples in a row\.$/, ["util", "power", "samples"]],
    memory: [/^([\d.]+) GB available of ([\d.]+) GB\.$/, ["available", "total"]],
    xid: [/^A GPU or driver error was logged by the kernel within the last hour \((\d+) since boot\)\.(?: Latest: ([^\n]+)\.)?$/, ["count", "last"]],
    oom: [/^The kernel's OOM killer ended a process within the last hour \((\d+) since boot\)\.$/, ["count"]],
    concurrency: [/^(\d+) different models are serving while (\d+)% of memory is in use\.$/, ["count", "percent"]],
    "link-speed": [/^([^\n]+) negotiated ([\d.]+) Mb\/s\.$/, ["device", "speed"]],
  };
  const entry = patterns[finding.id];
  if (!entry) return undefined;
  const matched = entry[0].exec(finding.detail);
  return matched ? { key: `health.${finding.id}.detail`, params: Object.fromEntries(entry[1].map((name, i) => [name, matched[i + 1] ?? ""])) } : undefined;
}

/** Derived only for API output; event storage remains the original English record. */
export function eventI18n(event) {
  const name = event.sparkName || event.sparkId || "Spark";
  switch (event.type) {
    case "spark.online": return event.message === `${name} came online` ? { message: { key: "event.sparkOnline", params: { name } } } : undefined;
    case "spark.offline": return event.message === `${name} went offline` ? { message: { key: "event.sparkOffline", params: { name } } } : undefined;
    case "spark.added": return event.message === `${name} was added` ? { message: { key: "event.sparkAdded", params: { name } } } : undefined;
    case "spark.removed": return event.message === `${name} was removed` ? { message: { key: "event.sparkRemoved", params: { name } } } : undefined;
    case "power.shutdown": case "power.shutdown.requested": return event.message === `Shutdown requested for ${name}` ? { message: { key: "event.shutdownRequested", params: { name } } } : undefined;
    case "power.wake": case "power.wake.sent": return event.message === `Wake-on-LAN sent to ${name}` ? { message: { key: "event.wakeSent", params: { name } } } : undefined;
    default: return undefined;
  }
}

/**
 * Adds presentation metadata to a top-level response only. English fields and
 * nested payloads are deliberately left unchanged for API compatibility.
 * @param {unknown} body
 */
export function responseI18n(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.i18n) return body;
  if (typeof body.error === "string") {
    const error = applicationTextI18n(body.error);
    return error ? { ...body, i18n: { error } } : body;
  }
  if (typeof body.message === "string") {
    const message = applicationTextI18n(body.message);
    if (message) return { ...body, i18n: { message } };
  }
  return body;
}
