import { APPLICATION_TEXT_MAX_LENGTH, applicationTextI18n } from "../../src/shared/applicationText.js";

// Additive metadata is capped at three descriptors and 16 KiB of UTF-8 JSON.
// If either cap would be exceeded, omit metadata; never truncate raw diagnostics.
// Recognition still rejects (rather than truncates) strings over 4096 UTF-16 units.
export const I18N_METADATA_MAX_ENTRIES = 3;
export const I18N_METADATA_MAX_BYTES = 16 * 1024;

function boundedMetadata(entries) {
  const present = entries.filter(([, descriptor]) => descriptor !== undefined);
  if (present.length > I18N_METADATA_MAX_ENTRIES) return undefined;
  const metadata = Object.fromEntries(present);
  try {
    return Buffer.byteLength(JSON.stringify(metadata), "utf8") <= I18N_METADATA_MAX_BYTES ? metadata : undefined;
  } catch {
    return undefined;
  }
}

export function healthI18n(finding) {
  const count = finding.id === "roce-link" ? Number(/^(\d+) RoCE links/.exec(finding.title)?.[1] ?? 1) : undefined;
  return boundedMetadata([
    ["title", { key: `health.${finding.id}.title.${finding.severity}`, ...(count ? { params: { count } } : {}) }],
    ["detail", healthDetail(finding)],
    ["hint", { key: `health.${finding.id}.hint` }],
  ]);
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
  let message;
  switch (event.type) {
    case "spark.online": message = event.message === `${name} came online` ? { key: "event.sparkOnline", params: { name } } : undefined; break;
    case "spark.offline": message = event.message === `${name} went offline` ? { key: "event.sparkOffline", params: { name } } : undefined; break;
    case "spark.added": message = event.message === `${name} was added` ? { key: "event.sparkAdded", params: { name } } : undefined; break;
    case "spark.removed": message = event.message === `${name} was removed` ? { key: "event.sparkRemoved", params: { name } } : undefined; break;
    case "power.shutdown": case "power.shutdown.requested": message = event.message === `Shutdown requested for ${name}` ? { key: "event.shutdownRequested", params: { name } } : undefined; break;
    case "power.wake": case "power.wake.sent": message = event.message === `Wake-on-LAN sent to ${name}` ? { key: "event.wakeSent", params: { name } } : undefined; break;
    default: return undefined;
  }
  return message ? boundedMetadata([["message", message]]) : undefined;
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
    const i18n = error ? boundedMetadata([["error", error]]) : undefined;
    return i18n ? { ...body, i18n } : body;
  }
  if (typeof body.message === "string") {
    const message = applicationTextI18n(body.message);
    const i18n = message ? boundedMetadata([["message", message]]) : undefined;
    if (i18n) return { ...body, i18n };
  }
  return body;
}
