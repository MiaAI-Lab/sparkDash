import { applicationTextI18n } from "../../src/shared/applicationText.js";

/**
 * Locale-neutral metadata for application-authored text.  The server always
 * keeps the English field for backwards compatibility; browsers choose how to
 * render this optional descriptor.
 */
const params = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));

/** @param {any} event */
export function eventI18n(event) {
  const name = event.sparkName ?? event.sparkId;
  switch (event.type) {
    case "spark.online": return { message: { key: "activity.message.sparkOnline", params: params({ name }) } };
    case "spark.offline": return { message: { key: "activity.message.sparkOffline", params: params({ name }) } };
    case "spark.added": return { message: { key: "activity.message.sparkAdded", params: params({ name }) } };
    case "spark.removed": return { message: { key: "activity.message.sparkRemoved", params: params({ name }) } };
    case "health.cleared": return { message: { key: "activity.message.healthCleared", params: params({ name, finding: event.data?.findingId ?? event.message?.split(": ").slice(1).join(": ").replace(/ is back to normal$/, "") }) } };
    case "gpu.throttle.thermal": return { message: { key: "activity.message.thermalThrottle", params: params({ name, temperature: event.data?.temperature }) } };
    case "gpu.throttle.cleared": return { message: { key: "activity.message.thermalThrottleCleared", params: params({ name, temperature: event.data?.temperature }) } };
    case "hermes.update.available": return { message: { key: "activity.message.hermesAvailable", params: params({ name, version: event.data?.version }) } };
    case "hermes.update.success": case "hermes.update.completed": return { message: { key: "activity.message.hermesUpdated", params: params({ name, version: event.data?.version }) } };
    case "hermes.update.error": case "hermes.update.failed": return { message: { key: "activity.message.hermesFailed", params: params({ name }) } };
    case "power.shutdown": case "power.shutdown.requested": return { message: { key: "activity.message.shutdownRequested", params: params({ name }) } };
    case "power.wake": case "power.wake.sent": return { message: { key: "activity.message.wakeSent", params: params({ name }) } };
    default:
      if (event.type?.startsWith("health.")) {
        if (event.data?.count != null) return { message: { key: "activity.message.kernelError", params: params({ finding: event.data.findingId, count: event.data.count, last: event.data.last ? ` (${event.data.last})` : "" }) } };
        return { message: { key: "activity.message.healthFinding", params: params({ name, finding: event.data?.finding ? `${event.data.finding.title} — ${event.data.finding.detail}` : event.message }) } };
      }
      if (/^bench\.(decode|prefill|quality)\.(finished|cancelled|failed)$/.test(event.type)) {
        const [, kind, status] = event.type.split(".");
        const label = { decode: "Decode bench", prefill: "Prefill bench", quality: "Quality bench" }[kind];
        const score = event.data?.score != null ? `: ${Math.round(event.data.score * 10) / 10}%` : /: [\d.]+%$/.exec(event.message)?.[0] ?? "";
        const detail = event.data?.error ? `: ${event.data.error}` : "";
        return { message: { key: status === "finished" ? "activity.message.benchFinished" : status === "cancelled" ? "activity.message.benchCancelled" : "activity.message.benchFailed", params: params({ name, label, score, detail }) } };
      }
      if (/^llm\.(start|stop|attach)\.(requested|completed|cancelled|detached|failed)$/.test(event.type)) {
        const [, action, status] = event.type.split(".");
        const key = status === "requested" ? action === "start" ? "llmStarting" : action === "stop" ? "llmStopping" : "llmOpening" : action === "attach" ? "llmClosed" : status === "completed" ? "llmCompleted" : status === "cancelled" ? "llmCancelled" : status === "detached" ? "llmDetached" : "llmFailed";
        return { message: { key: `activity.message.${key}`, params: params({ launcher: event.data?.launcher ?? event.message, action, exit: event.data?.exitCode != null ? ` (exit ${event.data.exitCode})` : "" }) } };
      }
      return undefined;
  }
}

/** @param {{id:string,severity:string,title:string,detail:string,hint:string}} finding */
export function healthI18n(finding) {
  const base = `health.${finding.id}`;
  return {
    title: { key: `${base}.title.${finding.severity}`, ...(finding.id === "roce-link" ? { params: { count: finding._i18nParams?.count ?? 1 } } : {}) },
    detail: { key: `${base}.detail`, ...(finding._i18nParams ? { params: finding._i18nParams } : {}) },
    hint: { key: `${base}.hint` },
  };
}

/** @param {string} error @param {string} key @param {Record<string,string|number>} [params] */
export function apiError(error, key, params) {
  return { error, i18n: { error: { key, ...(params && Object.keys(params).length ? { params } : {}) } } };
}

/** Send a backwards-compatible application error with optional i18n metadata. */
export function withApiError(res, status, error, key, params) {
  return res.status(status).json(apiError(error, key, params));
}

/**
 * JSON response boundary for application-owned errors and success notices.
 * Unknown failures receive a translated summary while their raw diagnostic is
 * preserved in `error`; no external output is rewritten.
 */
export function responseI18n(body) {
  if (!body || typeof body !== "object") return body;
  if (body.i18n) return body;
  if (typeof body.error === "string") {
    const meta = applicationTextI18n(body.error) ?? { key: "server.error.unexpected", params: { detail: body.error } };
    return { ...body, i18n: { error: meta } };
  }
  if (body.message === "Shutdown initiated") return { ...body, i18n: { message: { key: "server.message.shutdownInitiated" } } };
  if (typeof body.message === "string") {
    const match = /^Magic packet sent to (.+) via (.+)$/.exec(body.message);
    if (match) return { ...body, i18n: { message: { key: "server.message.wakeSent", params: { mac: match[1], broadcast: match[2] } } } };
  }
  return body;
}

/** Explicit boundary for batch routes that author each result row. */
export function responseI18nResults(results) {
  return results.map(responseI18n);
}

/** Metadata for application job progress. Unknown process diagnostics retain raw text. */
export function jobTextI18n(text) {
  return applicationTextI18n(text) ?? { key: "server.progress.running", params: { detail: text } };
}

export function jobErrorI18n(error) {
  if (error === "Cancelled by user" || error === "Cancelled") return { key: "server.error.cancelled" };
  return applicationTextI18n(error) ?? { key: "server.error.unexpected", params: { detail: String(error) } };
}
