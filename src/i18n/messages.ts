import { i18next } from ".";
import { applicationTextI18n, applicationTextRequiredParams } from "../shared/applicationText.js";
import { activeLocale } from ".";
import type { ActivityEvent, HealthFinding, LocalizedMessage } from "../api/types";

// Literal keys below intentionally keep catalog integrity checking effective.
const t = i18next.t.bind(i18next);

/** Render a server event descriptor without altering its English compatibility message. */
type MessageEvent = Pick<ActivityEvent, "message" | "i18n" | "type" | "sparkName" | "sparkId" | "data">;
export function localizedActivityMessage(event: MessageEvent): string {
  if (activeLocale() === "en") return event.message;
  const meta = event.i18n?.message ?? legacyActivityMeta(event);
  const p = { name: event.sparkName ?? event.sparkId ?? "Spark", ...meta?.params };
  const suffix = / (\([^\n]*°C\))$/.exec(event.message)?.[0] ?? "";
  if (event.type.startsWith("health.")) return localizedHealthEvent(event);
  const bench = /^bench\.(decode|prefill|quality)\.(finished|cancelled|failed)$/.exec(event.type);
  if (bench) {
    const data = event.data as { error?: string; score?: number } | undefined;
    const name = p.name;
    const label = bench[1] === "decode" ? t("activity.type.benchDecode", "Decode bench") : bench[1] === "prefill" ? t("activity.type.benchPrefill", "Prefill bench") : t("activity.type.benchQuality", "Quality bench");
    const detail = data?.error ?? event.message.split(` on ${name}: `)[1] ?? "";
    const score = data?.score != null ? `: ${Math.round(data.score * 10) / 10}%` : /: [\d.]+%$/.exec(event.message)?.[0] ?? "";
    if (bench[2] === "finished") return t("activity.message.benchFinished", "{label} finished on {name}{score}", { label, name, score });
    if (bench[2] === "cancelled") return t("activity.message.benchCancelled", "{label} cancelled on {name}", { label, name });
    return t("activity.message.benchFailed", "{label} failed on {name}{detail}", { label, name, detail: detail ? `：${localizedServerText(detail)}` : "" });
  }
  const llm = /^llm\.(start|stop|attach)\.(requested|completed|cancelled|detached|failed)$/.exec(event.type);
  if (llm) {
    const data = event.data as { launcher?: string; exitCode?: number } | undefined;
    const launcher = data?.launcher ?? (llm[2] === "requested" ? event.message.replace(/^(Starting|Stopping|Opening output of) /, "") : llm[1] === "attach" ? event.message.replace(/^Closed output of /, "") : event.message.replace(/: (start|stop) script.*$|: stopped watching (start|stop) script.*$/, ""));
    if (llm[2] === "requested") {
      if (llm[1] === "start") return t("activity.message.llmStarting", "Starting {launcher}", { launcher });
      if (llm[1] === "stop") return t("activity.message.llmStopping", "Stopping {launcher}", { launcher });
      return t("activity.message.llmOpening", "Opening output of {launcher}", { launcher });
    }
    if (llm[1] === "attach") return t("activity.message.llmClosed", "Closed output of {launcher}", { launcher });
    const action = localizedAction(llm[1]);
    if (llm[2] === "completed") return t("activity.message.llmCompleted", "{launcher}: {action} script finished", { launcher, action });
    if (llm[2] === "cancelled") return t("activity.message.llmCancelled", "{launcher}: {action} script cancelled", { launcher, action });
    if (llm[2] === "detached") return t("activity.message.llmDetached", "{launcher}: stopped watching {action} script", { launcher, action });
    const exit = data?.exitCode != null ? String(data.exitCode) : /\(exit (-?\d+)\)$/.exec(event.message)?.[1];
    return t("activity.message.llmFailed", "{launcher}: {action} script failed{exit}", { launcher, action, exit: exit ? t("activity.message.exitCode", " (exit {code})", { code: exit }) : "" });
  }
  switch (meta?.key) {
    case "activity.message.sparkOnline": return t("activity.message.sparkOnline", "{name} came online", p);
    case "activity.message.sparkOffline": return t("activity.message.sparkOffline", "{name} went offline", p);
    case "activity.message.sparkAdded": return t("activity.message.sparkAdded", "{name} was added", p);
    case "activity.message.sparkRemoved": return t("activity.message.sparkRemoved", "{name} was removed", p);
    case "activity.message.healthCleared": return t("activity.message.healthCleared", "{name}: {finding} is back to normal", p);
    case "activity.message.thermalThrottle": return t("activity.message.thermalThrottle", "{name} started thermal throttling", p) + suffix;
    case "activity.message.thermalThrottleCleared": return t("activity.message.thermalThrottleCleared", "{name} stopped thermal throttling", p) + suffix;
    case "activity.message.hermesAvailable": {
      const commits = (event.data as { behindCommits?: number } | undefined)?.behindCommits ?? Number(/\((\d+) commits? behind\)$/.exec(event.message)?.[1]);
      return t("activity.message.hermesAvailable", "Hermes update available on {name}", p) + (Number.isFinite(commits) && commits > 0 ? t("activity.message.hermesCommits", " ({count} commits behind)", { count: commits }) : "");
    }
    case "activity.message.hermesUpdated": {
      const prefix = `Hermes updated on ${p.name}`;
      const tail = event.message.startsWith(prefix) ? event.message.slice(prefix.length) : "";
      const version = (event.data as { version?: string } | undefined)?.version ?? meta?.params?.version ?? /^ to ([^\n]+)$/.exec(tail)?.[1];
      return t("activity.message.hermesUpdated", "Hermes updated on {name}", p) + (version ? t("activity.message.hermesVersion", " to {version}", { version }) : "");
    }
    case "activity.message.hermesFailed": return t("activity.message.hermesFailed", "Hermes update failed on {name}", p);
    case "activity.message.shutdownRequested": return t("activity.message.shutdownRequested", "Shutdown requested for {name}", p);
    case "activity.message.wakeSent": return t("activity.message.wakeSent", "Wake-on-LAN sent to {name}", p);
    case "activity.message.healthFinding": return t("activity.message.healthFinding", "{name}: {finding}", p);
    default: return event.message;
  }
}

/** Historical records predate descriptors; type plus stored fields is enough for these stable events. */
function legacyActivityMeta(event: MessageEvent): LocalizedMessage | undefined {
  const name = event.sparkName ?? event.sparkId ?? "Spark";
  switch (event.type) {
    case "spark.online": return { key: "activity.message.sparkOnline", params: { name: name ?? "Spark" } };
    case "spark.offline": return { key: "activity.message.sparkOffline", params: { name: name ?? "Spark" } };
    case "spark.added": return { key: "activity.message.sparkAdded", params: { name: name ?? "Spark" } };
    case "spark.removed": return { key: "activity.message.sparkRemoved", params: { name: name ?? "Spark" } };
    case "power.shutdown": return { key: "activity.message.shutdownRequested", params: { name: name ?? "Spark" } };
    case "power.wake": return { key: "activity.message.wakeSent", params: { name: name ?? "Spark" } };
    case "power.shutdown.requested": return { key: "activity.message.shutdownRequested", params: { name: name ?? "Spark" } };
    case "power.wake.sent": return { key: "activity.message.wakeSent", params: { name: name ?? "Spark" } };
    case "gpu.throttle.thermal": return { key: "activity.message.thermalThrottle", params: { name } };
    case "gpu.throttle.cleared": return { key: "activity.message.thermalThrottleCleared", params: { name } };
    case "hermes.update.available": return { key: "activity.message.hermesAvailable", params: { name } };
    case "hermes.update.success": case "hermes.update.completed": return { key: "activity.message.hermesUpdated", params: { name } };
    case "hermes.update.error": case "hermes.update.failed": return { key: "activity.message.hermesFailed", params: { name } };
    default: return undefined;
  }
}

export function localizedAction(action: string): string {
  switch (action) {
    case "start": return t("server.action.start", "start");
    case "stop": return t("server.action.stop", "stop");
    case "attach": return t("server.action.attach", "attach");
    default: return action;
  }
}

function localizedHealthEvent(event: MessageEvent): string {
  const data = event.data as { finding?: HealthFinding; findingId?: string; count?: number; last?: string } | undefined;
  const id = data?.findingId ?? data?.finding?.id ?? event.type.slice(7);
  const name = event.sparkName ?? event.sparkId ?? "Spark";
  if (event.type === "health.cleared") {
    const raw = event.message.slice(event.message.indexOf(": ") + 2).replace(/ is back to normal$/, "");
    return t("activity.message.healthCleared", "{name}: {finding} is back to normal", { name, finding: healthLabel(data?.findingId ?? raw) });
  }
  if (data?.finding) return t("activity.message.healthFinding", "{name}: {finding}", { name, finding: `${localizedHealthField(data.finding, "title")} — ${localizedHealthField(data.finding, "detail")}` });
  const kernel = /: (\d+) new since the last check(?: \(([\s\S]*)\))?$/.exec(event.message);
  if ((id === "xid" || id === "oom") && (kernel || data?.count != null)) return t("activity.message.kernelError", "{finding}: {count} new since the last check{last}", { finding: healthLabel(id), count: Number(data?.count ?? kernel?.[1]), last: (data?.last ?? kernel?.[2]) ? ` (${data?.last ?? kernel?.[2]})` : "" });
  const detail = event.message.includes(" — ") ? event.message.split(" — ").slice(1).join(" — ") : "";
  if (!["thermal", "low-power", "memory", "xid", "oom", "concurrency", "link-speed", "roce-link", "roce-loss"].includes(id)) return event.message;
  const title = event.message.split(" — ")[0].replace(`${name}: `, "");
  const severity = /shutdown temperature|almost exhausted/.test(title) || id === "roce-link" ? "critical" : "warn";
  const finding: HealthFinding = { id: id as HealthFinding["id"], severity, title, detail, hint: "" };
  return t("activity.message.healthFinding", "{name}: {finding}", { name, finding: `${localizedHealthField(finding, "title")}${detail ? ` — ${localizedHealthField(finding, "detail")}` : ""}` });
}

function healthLabel(id: string): string {
  switch (id) {
    case "thermal": case "GPU temperature": return t("activity.health.thermal", "GPU temperature");
    case "low-power": case "GPU power draw": return t("activity.health.power", "GPU power draw");
    case "memory": case "Unified memory": return t("activity.health.memory", "Unified memory");
    case "concurrency": case "Model concurrency": return t("activity.health.concurrency", "Model concurrency");
    case "link-speed": case "Network link speed": return t("activity.health.link", "Network link speed");
    case "roce-link": case "RoCE link": return t("activity.health.roceLink", "RoCE link");
    case "roce-loss": case "RoCE packet loss": return t("activity.health.roceLoss", "RoCE packet loss");
    case "xid": return t("health.xid.title.critical", "NVIDIA Xid error");
    case "oom": return t("health.oom.title.critical", "Kernel killed a process (out of memory)");
    default: return id;
  }
}

/** Render a known health field. Unknown/external content deliberately remains raw. */
export function localizedHealthField(finding: HealthFinding, field: "title" | "detail" | "hint"): string {
  if (activeLocale() === "en") return finding[field];
  const key = finding.i18n?.[field]?.key ?? `health.${finding.id}.${field}${field === "title" ? `.${finding.severity}` : ""}`;
  const p: Record<string, string | number> = { ...healthDetailParams(finding), ...finding.i18n?.detail?.params, ...finding.i18n?.[field]?.params };
  if (field === "detail" && !Object.keys(p).length) return finding.detail;
  const required = applicationTextRequiredParams(key);
  if (required?.some(name => p[name] == null)) return finding[field];
  // A partially described, noncanonical diagnostic must remain visible in full.
  if (field === "detail" && !Object.keys(healthDetailParams(finding)).length) return finding.detail;
  if (p.interface === "The primary interface") p.interface = t("health.link-speed.primaryInterface", "The primary interface");
  switch (key) {
    case "health.thermal.title.warn": return t("health.thermal.title.warn", "GPU is running hot", p);
    case "health.thermal.title.critical": return t("health.thermal.title.critical", "GPU is close to its shutdown temperature", p);
    case "health.memory.title.warn": return t("health.memory.title.warn", "Unified memory is running low", p);
    case "health.memory.title.critical": return t("health.memory.title.critical", "Unified memory is almost exhausted", p);
    case "health.low-power.title.warn": return t("health.low-power.title.warn", "GPU looks stuck in a low-power state", p);
    case "health.xid.title.critical": return t("health.xid.title.critical", "NVIDIA Xid error", p);
    case "health.oom.title.critical": return t("health.oom.title.critical", "Kernel killed a process (out of memory)", p);
    case "health.concurrency.title.warn": return t("health.concurrency.title.warn", "Several models are loaded on this node", p);
    case "health.link-speed.title.warn": return t("health.link-speed.title.warn", "Network link is slower than 1 Gb/s", p);
    case "health.roce-link.title.critical": return t("health.roce-link.title.critical", "{count, plural, one {A RoCE link went down} other {# RoCE links went down}}", { ...p, count: Number(p.count ?? 1) });
    case "health.roce-loss.title.warn": return t("health.roce-loss.title.warn", "RoCE is dropping packets", p);
    case "health.thermal.detail": return t("health.thermal.detail", "{temperature}°C (warns at {warn}°C, critical at {critical}°C).", p);
    case "health.thermal.hint": return t("health.thermal.hint", "Check airflow and the room temperature, and that nothing blocks the vents. Lower the power limit or the load if it keeps climbing.", p);
    case "health.low-power.detail": return t("health.low-power.detail", "{utilisation}% utilisation but only {watts} W for {samples} samples in a row.", p);
    case "health.low-power.hint": return t("health.low-power.hint", "Often a driver or power-management hiccup. A GPU reset or a reboot usually clears it; check dmesg for NVRM errors first.", p);
    case "health.memory.detail": return t("health.memory.detail", "{available} GB available of {total} GB.", p);
    case "health.memory.hint": return t("health.memory.hint", "The kernel may start killing processes. Stop a model you are not using, lower the context length or the GPU memory utilisation.", p);
    case "health.xid.detail": return t("health.xid.detail", "A GPU or driver error was logged by the kernel within the last hour ({count} since boot).", p) + (p.last ? t("health.xid.latest", " Latest: {last}.", { last: p.last }) : "");
    case "health.xid.hint": return t("health.xid.hint", "Look up the Xid code in NVIDIA's Xid catalog. Repeated driver-class Xids point at hardware or a driver bug.", p);
    case "health.oom.detail": return t("health.oom.detail", "The kernel's OOM killer ended a process within the last hour ({count} since boot).", p);
    case "health.oom.hint": return t("health.oom.hint", "Something ran out of memory. Lower the model's memory use or stop other workloads.", p);
    case "health.concurrency.detail": return t("health.concurrency.detail", "{count} different models are serving while {memory}% of memory is in use.", p);
    case "health.concurrency.hint": return t("health.concurrency.hint", "Heavy backends compete for the same unified memory. Stop the ones you are not using to avoid out-of-memory kills.", p);
    case "health.link-speed.detail": return t("health.link-speed.detail", "{interface} negotiated {mbps} Mb/s.", p);
    case "health.link-speed.hint": return t("health.link-speed.hint", "Check the cable and the switch port. A cluster running over a degraded link slows every tensor-parallel step.", p);
    case "health.roce-link.detail": return t("health.roce-link.detail", "{links}.", p);
    case "health.roce-link.hint": return t("health.roce-link.hint", "Check the cable, the transceiver and the switch port. Tensor-parallel and NCCL traffic over this port stalls or falls back to another path.", p);
    case "health.roce-loss.detail": return t("health.roce-loss.detail", "{links}.", p);
    case "health.roce-loss.hint": return t("health.roce-loss.hint", "Rising out_of_buffer, sequence or ack-timeout errors point at congestion or a lossless-network (PFC/ECN) misconfiguration. Compare the PFC and trust settings on every Spark and on the switch.", p);
    default: return finding[field];
  }
}

/** Historical snapshots may lack metadata. Extract only complete, known evaluator formats. */
function healthDetailParams(finding: HealthFinding): Record<string, string | number> {
  const raw = finding.detail;
  const parse = (pattern: RegExp, names: string[]) => {
    const m = pattern.exec(raw);
    return m ? Object.fromEntries(names.map((name, i) => [name, m[i + 1] ?? ""])) : {};
  };
  switch (finding.id) {
    case "thermal": return parse(/^(\d+)°C \(warns at (\d+)°C, critical at (\d+)°C\)\.$/, ["temperature", "warn", "critical"]);
    case "low-power": return parse(/^(\d+)% utilisation but only ([\d.]+) W for (\d+) samples in a row\.$/, ["utilisation", "watts", "samples"]);
    case "memory": return parse(/^([\d.]+) GB available of ([\d.]+) GB\.$/, ["available", "total"]);
    case "concurrency": return parse(/^(\d+) different models are serving while (\d+)% of memory is in use\.$/, ["count", "memory"]);
    case "link-speed": return parse(/^(.+) negotiated ([\d.]+) Mb\/s\.$/, ["interface", "mbps"]);
    case "xid": case "oom": return parse(/^.+ within the last hour \((\d+) since boot\)\.(?: Latest: ([\s\S]*)\.)?$/, ["count", "last"]);
    case "roce-link": case "roce-loss": return { links: raw.replace(/\.$/, ""), count: Number(/^(\d+) RoCE links/.exec(finding.title)?.[1] ?? 1) };
    default: return {};
  }
}


/** Render API errors, connectivity checks, and job status without changing raw diagnostics. */
export function localizedServerMessage(meta: LocalizedMessage | undefined, fallback: string): string {
  if (activeLocale() === "en") return fallback;
  const recognized = applicationTextI18n(fallback);
  meta ??= recognized ?? { key: "server.error.unexpected" };
  const p = { ...(recognized?.key === meta.key ? recognized.params : {}), ...meta.params };
  if (["server.error.unexpected", "server.job.error", "server.connection.raw", "server.progress.running"].includes(meta.key)) p.detail = fallback;
  if (applicationTextRequiredParams(meta.key)?.some(name => p[name] == null)) return fallback;
  if (typeof p.action === "string") p.action = localizedAction(p.action);
  if (typeof p.label === "string") p.label = localizedFieldLabel(p.label);
  if (p.label === "Start script") p.label = t("server.action.startScript", "Start script");
  if (p.label === "Stop script") p.label = t("server.action.stopScript", "Stop script");
  if (typeof p.scope === "string") p.scope = localizedScope(p.scope);
  switch (meta.key) {
    case "server.throttle.none": return t("server.throttle.none", "Clocks not limited", p);
    case "server.throttle.flags1": return t("server.throttle.flags1", "HW thermal slowdown", p);
    case "server.throttle.flags2": return t("server.throttle.flags2", "SW thermal slowdown", p);
    case "server.throttle.flags3": return t("server.throttle.flags3", "HW thermal slowdown · SW thermal slowdown", p);
    case "server.throttle.flags4": return t("server.throttle.flags4", "SW power cap", p);
    case "server.throttle.flags5": return t("server.throttle.flags5", "HW thermal slowdown · SW power cap", p);
    case "server.throttle.flags6": return t("server.throttle.flags6", "SW thermal slowdown · SW power cap", p);
    case "server.throttle.flags7": return t("server.throttle.flags7", "HW thermal slowdown · SW thermal slowdown · SW power cap", p);
    case "server.throttle.flags8": return t("server.throttle.flags8", "HW slowdown", p);
    case "server.throttle.flags10": return t("server.throttle.flags10", "SW thermal slowdown · HW slowdown", p);
    case "server.throttle.flags12": return t("server.throttle.flags12", "SW power cap · HW slowdown", p);
    case "server.throttle.flags14": return t("server.throttle.flags14", "SW thermal slowdown · SW power cap · HW slowdown", p);
    case "server.quality.keysStale": return t("server.quality.keysStale", "{correct}/{total} keys, {stale} stale", p);
    case "server.quality.keys": return t("server.quality.keys", "{correct}/{total} keys", p);
    case "server.quality.rules": return t("server.quality.rules", "{passed}/{total} rules", p);
    case "server.quality.parsed": return t("server.quality.parsed", "parsed {count}", p);
    case "server.quality.noAnswer": return t("server.quality.noAnswer", "no 'Answer:' line", p);
    case "server.quality.unreadable": return t("server.quality.unreadable", "could not read the 'Answer:' line", p);
    case "server.posture.badKey": return t("server.posture.badKey", "Bad API key", p);
    case "server.posture.authRequired": return t("server.posture.authRequired", "Auth required", p);
    case "server.posture.keyed": return t("server.posture.keyed", "API key · {scope}", p);
    case "server.posture.open": return t("server.posture.open", "Open · {scope}", p);
    case "server.posture.rejected": return t("server.posture.rejected", "Configured API key was rejected (401/403) · {scope} target ({host}).", p);
    case "server.posture.requiredDetail": return t("server.posture.requiredDetail", "API key required · {scope} target ({host}). Based on the configured probe host, not the process bind address.", p);
    case "server.posture.keyedDetail": return t("server.posture.keyedDetail", "Using configured API key · {scope} target ({host}). Based on the configured probe host, not the process bind address.", p);
    case "server.posture.openDetail": return t("server.posture.openDetail", "Unauthenticated · {scope} target ({host}). Based on the configured probe host, not the process bind address.", p);
    case "server.error.toolUnknown": return t("server.error.toolUnknown", "Unknown benchmark type \"{type}\"", p);
    case "server.error.toolUnknownOption": return t("server.error.toolUnknownOption", "Unknown option \"{option}\"", p);
    case "server.error.toolAbsolute": return t("server.error.toolAbsolute", "{label} must be an absolute path (or start with ~/)", p);
    case "server.error.toolTraversal": return t("server.error.toolTraversal", "{label} must not contain ..", p);
    case "server.error.toolText": return t("server.error.toolText", "{label} must be text", p);
    case "server.error.toolUrl": return t("server.error.toolUrl", "{label} is not a valid URL", p);
    case "server.error.toolUrlScheme": return t("server.error.toolUrlScheme", "{label} must start with http:// or https://", p);
    case "server.error.toolUrlCredentials": return t("server.error.toolUrlCredentials", "{label} must not contain credentials (use the API key field)", p);
    case "server.error.toolLinkLocal": return t("server.error.toolLinkLocal", "{label} points at a link-local address, which is not allowed", p);
    case "server.error.toolLong": return t("server.error.toolLong", "{label} is too long", p);
    case "server.error.toolBool": return t("server.error.toolBool", "{label} must be on or off", p);
    case "server.error.toolWhole": return t("server.error.toolWhole", "{label} must be a whole number", p);
    case "server.error.toolMin": return t("server.error.toolMin", "{label} must be at least {min}", p);
    case "server.error.toolMax": return t("server.error.toolMax", "{label} must be at most {max}", p);
    case "server.error.toolNumber": return t("server.error.toolNumber", "{label} must be a number", p);
    case "server.error.toolChoice": return t("server.error.toolChoice", "{label} must be one of {choices}", p);
    case "server.error.toolEmpty": return t("server.error.toolEmpty", "{label} must not be empty", p);
    case "server.error.toolSingleLine": return t("server.error.toolSingleLine", "{label} must be a single line", p);
    case "server.error.toolFormat": return t("server.error.toolFormat", "{label} has an invalid format", p);
    case "server.error.toolCharacter": return t("server.error.toolCharacter", "{label} contains an invalid character", p);
    case "server.error.toolBytes": return t("server.error.toolBytes", "{label} is longer than {max} KiB", p);
    case "server.error.toolJsonObject": return t("server.error.toolJsonObject", "{label} must be a JSON object", p);
    case "server.error.toolJson": return t("server.error.toolJson", "{label} is not valid JSON", p);
    case "server.error.toolList": return t("server.error.toolList", "{label} must be a non-empty list", p);
    case "server.error.toolItems": return t("server.error.toolItems", "{label} has too many items", p);
    case "server.error.toolItem": return t("server.error.toolItem", "{label} has an invalid item \"{item}\"", p);
    case "server.error.toolEntry": return t("server.error.toolEntry", "{label} has an invalid entry \"{entry}\"", p);
    case "server.error.toolUnsettable": return t("server.error.toolUnsettable", "{label} cannot be set", p);
    case "server.error.toolPromptConflict": return t("server.error.toolPromptConflict", "Use either the system prompt text or the system prompt file, not both", p);
    case "server.error.toolContextConflict": return t("server.error.toolContextConflict", "Use either a single context pressure or a sweep, not both", p);
    case "server.error.toolScenarioConflict": return t("server.error.toolScenarioConflict", "A short run and a specific scenario list cannot be combined", p);
    case "server.error.toolExtraCount": return t("server.error.toolExtraCount", "Too many additional arguments", p);
    case "server.error.toolExtraText": return t("server.error.toolExtraText", "Additional arguments must be text", p);
    case "server.error.toolExtraFlag": return t("server.error.toolExtraFlag", "Additional argument \"{argument}\" is not a valid flag", p);
    case "server.error.toolManaged": return t("server.error.toolManaged", "{argument} is controlled by sparkDash (or looks like it) and cannot be set here", p);
    case "server.error.toolExtraDenied": return t("server.error.toolExtraDenied", "Additional argument \"{argument}\" is not allowed", p);
    case "server.error.toolExtraCharacters": return t("server.error.toolExtraCharacters", "Additional argument \"{argument}\" has unsupported characters", p);
    case "server.error.toolExtraSecrets": return t("server.error.toolExtraSecrets", "Additional arguments must not carry secrets (use the API key field)", p);
    case "server.error.toolKeyFormat": return t("server.error.toolKeyFormat", "API key has an invalid format", p);
    case "server.error.toolSavedKey": return t("server.error.toolSavedKey", "The saved API key can only be used with this Spark's own server; type a key to use another URL", p);
    case "server.error.toolResultLarge": return t("server.error.toolResultLarge", "The result file is too large to load here.", p);
    case "server.error.toolResultMissing": return t("server.error.toolResultMissing", "No result file exists for this run (yet).", p);
    case "server.error.toolOutputLarge": return t("server.error.toolOutputLarge", "The output was too large to read", p);
    case "server.error.toolNoAnswer": return t("server.error.toolNoAnswer", "The Spark did not answer in time", p);
    case "server.error.toolGithub": return t("server.error.toolGithub", "GitHub did not answer from the Spark.", p);
    case "server.error.toolWatchLimit": return t("server.error.toolWatchLimit", "Stopped watching after the time limit. The run may still be going on the Spark.", p);
    case "server.error.toolStartExit": return t("server.error.toolStartExit", "Could not reach the Spark or start the run (exit {code}).", p);
    case "server.error.toolConnectionLost": return t("server.error.toolConnectionLost", "Lost the connection to the Spark before the run reported its result.", p);
    case "server.error.hermesRepairFailed": return t("server.error.hermesRepairFailed", "hermes is installed but cannot launch (broken install — the automatic repair could not fix it; reinstall hermes manually).", p);
    case "server.error.hermesUpdateFailed": return t("server.error.hermesUpdateFailed", "hermes update reported an error", p);
    case "server.error.hostInput": return t("server.error.hostInput", "Enter a host", p);
    case "server.error.invalidUrl": return t("server.error.invalidUrl", "Invalid URL", p);
    case "server.error.sshpassMissing": return t("server.error.sshpassMissing", "sshpass is not installed. Install it with: sudo apt-get install sshpass", p);
    case "server.error.invalidSparkId": return t("server.error.invalidSparkId", "Invalid Spark id: allowed characters are a-z A-Z 0-9 . _ -, length 1–64, and reserved names are not allowed", p);
    case "server.error.dispatcherTimeout": return t("server.error.dispatcherTimeout", "dispatcher close timed out", p);
    case "server.error.aborted": return t("server.error.aborted", "aborted", p);
    case "server.error.timeout": return t("server.error.timeout", "timeout", p);
    case "server.error.cpuCounters": return t("server.error.cpuCounters", "invalid /proc/stat CPU counters", p);
    case "server.error.remoteCpuCounters": return t("server.error.remoteCpuCounters", "invalid remote /proc/stat CPU counters", p);
    case "server.error.windowsCpu": return t("server.error.windowsCpu", "no CPU load from Win32_Processor", p);
    case "server.error.historyFormat": return t("server.error.historyFormat", "unrecognised format", p);
    case "server.error.jobNonce": return t("server.error.jobNonce", "invalid job nonce", p);
    case "server.error.emptyKey": return t("server.error.emptyKey", "key file is empty", p);
    case "server.error.shortCiphertext": return t("server.error.shortCiphertext", "ciphertext too short", p);
    case "server.error.sshConfig": return t("server.error.sshConfig", "SSH config missing for {id}: host={host}, user={user}", p);
    case "server.error.sshPassword": return t("server.error.sshPassword", "SSH password auth selected for {id} but no password is set (Edit Spark once — passwords are stored encrypted and survive restarts)", p);
    case "server.error.resolveSshUser": return t("server.error.resolveSshUser", "Refusing to run as the dashboard user: cannot resolve SSH user {user} in the host passwd file. Set the Spark's SSH user.", p);
    case "server.error.switchUser": return t("server.error.switchUser", "Cannot switch to user \"{user}\" (uid {uid}) from uid {current}; refusing to run as the wrong user.", p);
    case "server.error.hermesFetch": return t("server.error.hermesFetch", "hermes update --check could not fetch from origin", p);
    case "server.error.hermesCheckExit": return t("server.error.hermesCheckExit", "hermes update --check exited {code} with no usable output", p);
    case "server.error.hermesBroken": return t("server.error.hermesBroken", "hermes is installed but cannot launch (broken install — usually a missing venv entry point). Run one-click Update Hermes to attempt an automatic repair.", p);
    case "server.error.hermesUnsupported": return t("server.error.hermesUnsupported", "Installed hermes version does not support `hermes update --check` — update hermes manually once to enable monitoring.", p);
    case "server.error.connectionUnreachable": return t("server.error.connectionUnreachable", "unreachable", p);
    case "server.error.connectionTimeout": return t("server.error.connectionTimeout", "connection timed out", p);
    case "server.error.connectionRefused": return t("server.error.connectionRefused", "connection refused", p);
    case "server.error.connectionRoute": return t("server.error.connectionRoute", "no route to host", p);
    case "server.error.connectionAuth": return t("server.error.connectionAuth", "SSH authentication failed — check the key or user for this unit", p);
    case "server.error.sparkNotFound": return t("server.error.sparkNotFound", "Spark not found", p);
    case "server.error.remoteTokenRequired": return t("server.error.remoteTokenRequired", "Remote access requires SPARKDASH_TOKEN", p);
    case "server.error.restartUnsupported": return t("server.error.restartUnsupported", "Restart is only available when sparkDash runs in Docker with restart: always", p);
    case "server.error.hostRequired": return t("server.error.hostRequired", "lanIp or ssh.host required", p);
    case "server.error.passwordRequired": return t("server.error.passwordRequired", "password is required", p);
    case "server.error.promptIdRequired": return t("server.error.promptIdRequired", "promptId is required", p);
    case "server.error.disabledDevicesArray": return t("server.error.disabledDevicesArray", "disabledDevices must be an array", p);
    case "server.error.disabledInterfacesArray": return t("server.error.disabledInterfacesArray", "disabledInterfaces must be an array", p);
    case "server.error.llmPortsArray": return t("server.error.llmPortsArray", "llmPorts must be an array", p);
    case "server.error.llmPortsValid": return t("server.error.llmPortsValid", "llmPorts must contain at least one valid port 1–65535", p);
    case "server.error.llmPortValid": return t("server.error.llmPortValid", "llmPort must be an integer 1–65535", p);
    case "server.error.portValid": return t("server.error.portValid", "port must be an integer 1–65535", p);
    case "server.error.unexpected": return t("server.error.unexpected", "The server could not complete the request. Details: {detail}", p);
    case "server.message.shutdownInitiated": return t("server.message.shutdownInitiated", "Shutdown initiated", p);
    case "server.message.wakeSent": return t("server.message.wakeSent", "Magic packet sent to {mac} via {broadcast}", p);
    case "server.connection.disabled": return t("server.connection.disabled", "Disabled", p);
    case "server.connection.available": return t("server.connection.available", "Available", p);
    case "server.connection.unavailable": return t("server.connection.unavailable", "Unavailable", p);
    case "server.connection.raw": return t("server.connection.raw", "Check result: {detail}", p);
    case "server.connection.label.host.local": return t("server.connection.label.host.local", "Local collectors", p);
    case "server.connection.label.host.remote": return t("server.connection.label.host.remote", "Remote SSH", p);
    case "server.connection.label.llm": return t("server.connection.label.llm", "LLM API", p);
    case "server.connection.label.comfy": return t("server.connection.label.comfy", "ComfyUI", p);
    case "server.connection.label.hermes": return t("server.connection.label.hermes", "Hermes Agent", p);
    case "server.connection.label.tailnet": return t("server.connection.label.tailnet", "Tailnet", p);
    case "server.connection.recovery.host": return t("server.connection.recovery.host", "Check the host connection and collector permissions.", p);
    case "server.connection.recovery.hostLocal": return t("server.connection.recovery.hostLocal", "Check the host /proc mount and local collector permissions.", p);
    case "server.connection.recovery.hostRemote": return t("server.connection.recovery.hostRemote", "Check the host address, SSH user, key/password, and network route.", p);
    case "server.connection.recovery.llm": return t("server.connection.recovery.llm", "Start the LLM API on the configured port or disable LLM monitoring.", p);
    case "server.connection.recovery.comfy": return t("server.connection.recovery.comfy", "Start ComfyUI on the configured port or disable ComfyUI monitoring.", p);
    case "server.connection.recovery.hermes": return t("server.connection.recovery.hermes", "Install or repair Hermes Agent for the configured host user, or disable Hermes monitoring.", p);
    case "server.connection.recovery.tailnet": return t("server.connection.recovery.tailnet", "Start Tailscale, sign in this unit, or disable Tailnet monitoring.", p);
    case "server.job.error": return t("server.job.error", "Job failed: {detail}", p);
    case "server.job.status.running": return t("server.job.status.running", "{action} job is running for {launcher}", p);
    case "server.job.status.completed": return t("server.job.status.completed", "{action} job completed for {launcher}", p);
    case "server.job.status.cancelled": return t("server.job.status.cancelled", "{action} job was cancelled for {launcher}", p);
    case "server.job.status.detached": return t("server.job.status.detached", "Stopped watching {launcher}", p);
    case "server.progress.starting": return t("server.progress.starting", "Starting…", p);
    case "server.progress.connecting": return t("server.progress.connecting", "Connecting to LLM…", p);
    case "server.progress.readingModels": return t("server.progress.readingModels", "Reading /v1/models…", p);
    case "server.progress.cancelling": return t("server.progress.cancelling", "Cancelling…", p);
    case "server.progress.interrupted": return t("server.progress.interrupted", "Interrupted", p);
    case "server.progress.failed": return t("server.progress.failed", "Failed", p);
    case "server.progress.cancelled": return t("server.progress.cancelled", "Cancelled", p);
    case "server.progress.done": return t("server.progress.done", "Done", p);
    case "server.progress.running": return t("server.progress.running", "Running: {detail}", p);
    case "server.error.cancelled": return t("server.error.cancelled", "Cancelled by user", p);
    case "server.error.invalidLlmPort": return t("server.error.invalidLlmPort", "Invalid LLM port", p);
    case "server.error.modelNotFound": return t("server.error.modelNotFound", "Model not found", p);
    case "server.error.authRequired": return t("server.error.authRequired", "Authentication required", p);
    case "server.error.invalidPort": return t("server.error.invalidPort", "Invalid port", p);
    case "server.error.portUnconfigured": return t("server.error.portUnconfigured", "port is not configured for this Spark", p);
    case "server.error.portRequired": return t("server.error.portRequired", "port is required", p);
    case "server.error.apiKeyRequired": return t("server.error.apiKeyRequired", "apiKey is required (use \"\" to clear)", p);
    case "server.error.hostRequiredFull": return t("server.error.hostRequiredFull", "lanIp or ssh.host is required", p);
    case "server.error.orderArray": return t("server.error.orderArray", "body.order must be an array of spark ids", p);
    case "server.error.orderArrayRegistry": return t("server.error.orderArrayRegistry", "order must be an array of spark ids", p);
    case "server.error.windowsLauncher": return t("server.error.windowsLauncher", "Starting and stopping models from sparkDash is not supported on Windows PCs", p);
    case "server.error.modelJobRunning": return t("server.error.modelJobRunning", "A job is running for this model. Cancel it first.", p);
    case "server.error.jobNotFound": return t("server.error.jobNotFound", "Job not found (it may have been replaced by a newer one)", p);
    case "server.error.comfyDisabled": return t("server.error.comfyDisabled", "ComfyUI monitoring is disabled for this Spark", p);
    case "server.error.domains": return t("server.error.domains", "Only 'storage' and 'llm' domains are supported", p);
    case "server.error.hermesDisabled": return t("server.error.hermesDisabled", "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)", p);
    case "server.error.primaryPort": return t("server.error.primaryPort", "Cannot remove the primary LLM port", p);
    case "server.error.lastPort": return t("server.error.lastPort", "Cannot remove the last LLM port", p);
    case "server.error.workerApi": return t("server.error.workerApi", "Worker nodes do not expose a local LLM API", p);
    case "server.error.llmDisabled": return t("server.error.llmDisabled", "LLM monitoring is disabled for this Spark", p);
    case "server.error.showcaseRunning": return t("server.error.showcaseRunning", "A prompt showcase is already running for this Spark", p);
    case "server.error.showcaseRunningManager": return t("server.error.showcaseRunningManager", "A showcase is already running for this Spark", p);
    case "server.error.prefillRunning": return t("server.error.prefillRunning", "A prefill benchmark is already running for this Spark", p);
    case "server.error.decodeRunning": return t("server.error.decodeRunning", "A decode benchmark is already running for this Spark", p);
    case "server.error.qualityRunning": return t("server.error.qualityRunning", "A quality benchmark is already running for this Spark", p);
    case "server.error.benchRunning": return t("server.error.benchRunning", "A benchmark is already running for this Spark", p);
    case "server.error.clearBenchRunning": return t("server.error.clearBenchRunning", "Cannot clear history while a benchmark is running", p);
    case "server.error.clearShowcaseRunning": return t("server.error.clearShowcaseRunning", "Cannot clear history while a showcase is running", p);
    case "server.error.benchNotFound": return t("server.error.benchNotFound", "Benchmark not found", p);
    case "server.error.showcaseNotFound": return t("server.error.showcaseNotFound", "Showcase session not found", p);
    case "server.error.categoryRequired": return t("server.error.categoryRequired", "Select at least one category", p);
    case "server.error.offlineSkipped": return t("server.error.offlineSkipped", "Offline — skipped", p);
    case "server.error.wolUnsupported": return t("server.error.wolUnsupported", "DGX Spark does not support Wake-on-LAN", p);
    case "server.error.wolUnsupportedNic": return t("server.error.wolUnsupportedNic", "DGX Spark does not support Wake-on-LAN. The onboard NIC does not wake from a magic packet.", p);
    case "server.error.macMissing": return t("server.error.macMissing", "No MAC address (enP7s7 not seen yet; set override in Edit Spark)", p);
    case "server.error.macNotDetected": return t("server.error.macNotDetected", "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.", p);
    case "server.error.globalBenchCap": return t("server.error.globalBenchCap", "Global active benchmark cap reached; wait for a job to finish", p);
    case "server.error.benchRate": return t("server.error.benchRate", "Too many benchmark requests; try again shortly", p);
    case "server.error.benchCooldown": return t("server.error.benchCooldown", "Benchmark cooldown is active; wait before starting another job", p);
    case "server.error.requestRate": return t("server.error.requestRate", "Too many requests; try again shortly", p);
    case "server.error.testRate": return t("server.error.testRate", "Too many test requests; try again shortly", p);
    case "server.error.statusRate": return t("server.error.statusRate", "Too many status requests; try again shortly", p);
    case "server.error.launcherRate": return t("server.error.launcherRate", "Too many start/stop requests; try again shortly", p);
    case "server.error.cancelRate": return t("server.error.cancelRate", "Too many cancellation requests; try again shortly", p);
    case "server.error.directoryRequired": return t("server.error.directoryRequired", "Directory is required", p);
    case "server.error.directoryLong": return t("server.error.directoryLong", "Directory path is too long", p);
    case "server.error.directoryAbsolute": return t("server.error.directoryAbsolute", "Directory must be an absolute path (or start with ~/) using letters, digits and . _ - @ + = , /", p);
    case "server.error.directoryTraversal": return t("server.error.directoryTraversal", "Directory must not contain ..", p);
    case "server.error.nameRequired": return t("server.error.nameRequired", "Name is required", p);
    case "server.error.nameLong": return t("server.error.nameLong", "Name is too long (80 characters max)", p);
    case "server.error.launcherPort": return t("server.error.launcherPort", "Port must be 1-65535", p);
    case "server.error.modelStillRunningRemove": return t("server.error.modelStillRunningRemove", "This model is still running. Stop it first, then remove it.", p);
    case "server.error.modelStillRunningEdit": return t("server.error.modelStillRunningEdit", "This model is still running. Stop it before changing its directory or scripts.", p);
    case "server.error.launcherStopTimeout": return t("server.error.launcherStopTimeout", "Stop script did not finish in time and was cancelled", p);
    case "server.error.launcherWatcherTimeout": return t("server.error.launcherWatcherTimeout", "Stopped watching after 6 hours. The script keeps running; open the output again to re-attach.", p);
    case "server.error.launcherDisconnected": return t("server.error.launcherDisconnected", "Connection to the Spark ended unexpectedly", p);
    case "server.error.noQualityContext": return t("server.error.noQualityContext", "Nothing to run — every selected long size exceeds the model context", p);
    case "server.error.concurrencyRequired": return t("server.error.concurrencyRequired", "Select at least one concurrency level (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, or 32)", p);
    case "server.error.interruptedRestart": return t("server.error.interruptedRestart", "Interrupted — server restarted while the benchmark was running", p);
    case "server.error.invalidSshUser": return t("server.error.invalidSshUser", "Invalid SSH user (allowed: letters, digits, . _ -)", p);
    case "server.error.sshPort": return t("server.error.sshPort", "SSH port must be an integer from 1 to 65535", p);
    case "server.error.configId": return t("server.error.configId", "Spark config must have an 'id'", p);
    case "server.error.fromPort": return t("server.error.fromPort", "fromPort must be an integer 1–65535", p);
    case "server.error.toPort": return t("server.error.toPort", "toPort must be an integer 1–65535", p);
    case "server.error.registryPersistence": return t("server.error.registryPersistence", "Registry persistence failed", p);
    case "server.error.secretsPersistence": return t("server.error.secretsPersistence", "Secrets persistence failed", p);
    case "server.error.historyAge": return t("server.error.historyAge", "olderThanMs must be a positive number", p);
    case "server.error.historyConfirm": return t("server.error.historyConfirm", "deleting all permanent history needs confirm=delete-all-history", p);
    case "server.error.historyQuery": return t("server.error.historyQuery", "pass month=YYYY-MM, or all=true&confirm=delete-all-history", p);
    case "server.error.runNotFound": return t("server.error.runNotFound", "Run not found", p);
    case "server.error.toolRunning": return t("server.error.toolRunning", "Another Tool Eval Bench job is running on this Spark", p);
    case "server.error.toolRunningWait": return t("server.error.toolRunningWait", "Another Tool Eval Bench job is running on this Spark. Wait for it or stop it first.", p);
    case "server.error.noInstall": return t("server.error.noInstall", "No install is in progress", p);
    case "server.error.resultRead": return t("server.error.resultRead", "The stored result could not be read", p);
    case "server.error.runStopDelete": return t("server.error.runStopDelete", "Stop the run before deleting it.", p);
    case "server.error.runUnknown": return t("server.error.runUnknown", "Could not confirm the run has ended. Stop it, or delete again with force.", p);
    case "server.error.rootLauncher": return t("server.error.rootLauncher", "Refusing to run launcher scripts as root; configure a non-root SSH user.", p);
    case "server.error.hermesSshUser": return t("server.error.hermesSshUser", "Invalid SSH user for Hermes (allowed: letters, digits, . _ -)", p);
    case "server.error.hermesBinary": return t("server.error.hermesBinary", "hermes binary not found on the machine", p);
    case "server.error.emptyStream": return t("server.error.emptyStream", "Empty response body (streaming unsupported?)", p);
    case "server.error.modelsUnreachable": return t("server.error.modelsUnreachable", "OpenAI-compatible /v1/models unreachable", p);
    case "server.error.slotsUnreachable": return t("server.error.slotsUnreachable", "llama.cpp /slots unreachable", p);
    case "server.error.allocatePort": return t("server.error.allocatePort", "Failed to allocate local port", p);
    case "server.error.invalidTunnelPort": return t("server.error.invalidTunnelPort", "Invalid LLM port for SSH tunnel", p);
    case "server.error.sshCommand": return t("server.error.sshCommand", "SSH command must be a non-empty string", p);
    case "server.error.noFirstToken": return t("server.error.noFirstToken", "No first token", p);
    case "server.error.sparkExists": return t("server.error.sparkExists", "Spark {id} already exists", p);
    case "server.error.sparkMissingId": return t("server.error.sparkMissingId", "Spark {id} not found", p);
    case "server.error.invalidTarget": return t("server.error.invalidTarget", "Invalid or disallowed {field}: {target}", p);
    case "server.error.sshHostDenied": return t("server.error.sshHostDenied", "SSH host not allowed: {host}", p);
    case "server.error.sshUserDenied": return t("server.error.sshUserDenied", "SSH user not allowed: {user}", p);
    case "server.error.targetAllowlist": return t("server.error.targetAllowlist", "Target {target} is not in the administrator allowlist", p);
    case "server.error.targetResolve": return t("server.error.targetResolve", "Could not resolve allowed target {target}", p);
    case "server.error.targetNoAddress": return t("server.error.targetNoAddress", "Allowed target {target} resolved to no addresses", p);
    case "server.error.targetForbidden": return t("server.error.targetForbidden", "Target {target} resolved to forbidden address {address}", p);
    case "server.error.benchHostDenied": return t("server.error.benchHostDenied", "Remote benchmark host {host} is not allowlisted. Add it to SPARKDASH_BENCH_HOSTS or use a saved Spark LLM target.", p);
    case "server.error.decodeBudget": return t("server.error.decodeBudget", "Decode benchmark exceeds the {limit}-token work budget", p);
    case "server.error.prefillBudget": return t("server.error.prefillBudget", "Prefill benchmark exceeds the {limit}-token work budget", p);
    case "server.error.maxTokens": return t("server.error.maxTokens", "maxTokens must be between {min} and {max}", p);
    case "server.error.temperature": return t("server.error.temperature", "temperature must be between {min} and {max}", p);
    case "server.error.contextRequired": return t("server.error.contextRequired", "Select at least one context size ({range} tokens)", p);
    case "server.error.categoriesRequired": return t("server.error.categoriesRequired", "Select at least one category ({categories})", p);
    case "server.error.promptsArray": return t("server.error.promptsArray", "prompts must be an array of {count} strings (each {length} chars)", p);
    case "server.error.launcherLimit": return t("server.error.launcherLimit", "At most {count} models per Spark", p);
    case "server.error.launcherWindows": return t("server.error.launcherWindows", "LLM launcher is not supported on Windows units ({id})", p);
    case "server.error.scriptName": return t("server.error.scriptName", "{label} must be a file name ending in .sh, like start.sh (letters, digits, . _ -)", p);
    case "server.error.launcherConflict": return t("server.error.launcherConflict", "Another job is running on this Spark ({action} {launcher}). Wait for it or cancel it first.", p);
    case "server.error.macInvalid": return t("server.error.macInvalid", "Invalid MAC address: {mac}", p);
    case "server.error.wolFailed": return t("server.error.wolFailed", "WoL send failed: {detail}", p);
    case "server.error.sparkUnreachable": return t("server.error.sparkUnreachable", "Spark unreachable: {detail}", p);
    case "server.error.sshTunnelStart": return t("server.error.sshTunnelStart", "SSH tunnel failed to start: {detail}", p);
    case "server.error.sshTunnelReady": return t("server.error.sshTunnelReady", "SSH tunnel did not become ready on {target}", p);
    case "server.error.llmTunnel": return t("server.error.llmTunnel", "LLM on {host} is not reachable over the LAN, and SSH tunnel to 127.0.0.1:{port} failed: {detail}", p);
    case "server.error.sshConnect": return t("server.error.sshConnect", "SSH to {target} failed: {detail}", p);
    case "server.error.http": return t("server.error.http", "HTTP {status}: {detail}", p);
    case "server.error.prefillSkipped": return t("server.error.prefillSkipped", "Skipped: {size} plus template and reply does not fit the model context ({tokens} tokens)", p);
    case "server.progress.warming": return t("server.progress.warming", "Warming up…", p);
    case "server.progress.warmingTunnel": return t("server.progress.warmingTunnel", "Warming up via SSH tunnel…", p);
    case "server.progress.calibrating": return t("server.progress.calibrating", "Calibrating…", p);
    case "server.progress.concurrency": return t("server.progress.concurrency", "Running concurrency {count}…", p);
    case "server.progress.prefillingRun": return t("server.progress.prefillingRun", "Prefilling {size} (run {run}/{total})…", p);
    case "server.progress.prefilling": return t("server.progress.prefilling", "Prefilling {size}…", p);
    case "server.progress.tunnel": return t("server.progress.tunnel", "Opening SSH tunnel to 127.0.0.1:{port}…", p);
    case "server.progress.reaching": return t("server.progress.reaching", "Reaching LLM on {target}…", p);
    case "server.progress.qualityQa": return t("server.progress.qualityQa", "QA…", p);
    case "server.progress.qualityReason": return t("server.progress.qualityReason", "Reasoning…", p);
    case "server.progress.qualityArith": return t("server.progress.qualityArith", "Arithmetic chain…", p);
    case "server.progress.qualityTrack": return t("server.progress.qualityTrack", "State tracking…", p);
    case "server.progress.qualityGsm8k": return t("server.progress.qualityGsm8k", "GSM8K…", p);
    case "server.progress.qualityMmlu": return t("server.progress.qualityMmlu", "MMLU…", p);
    case "server.progress.qualityFollow": return t("server.progress.qualityFollow", "Instruction following…", p);
    case "server.progress.qualityLong": return t("server.progress.qualityLong", "Long-context recall…", p);
    case "server.progress.qualityLongSize": return t("server.progress.qualityLongSize", "Long-context recall {size}…", p);
    case "server.connection.notRun": return t("server.connection.notRun", "Check did not run", p);
    case "server.connection.hostReadable": return t("server.connection.hostReadable", "Host metrics are readable", p);
    case "server.connection.windowsNoGpu": return t("server.connection.windowsNoGpu", "SSH works, but no GPU data came back from this Windows PC. For an NVIDIA GPU, install the driver and make sure nvidia-smi.exe runs; an AMD iGPU needs Windows' GPU performance counters.", p);
    case "server.connection.hermesMissing": return t("server.connection.hermesMissing", "Hermes Agent not found", p);
    case "server.connection.keyExpired": return t("server.connection.keyExpired", "Tailscale key expired", p);
    case "server.connection.online": return t("server.connection.online", "Online", p);
    case "server.connection.notOnline": return t("server.connection.notOnline", "Not online", p);
    case "server.connection.installed": return t("server.connection.installed", "Installed", p);
    case "server.connection.installedVersion": return t("server.connection.installedVersion", "Installed ({version})", p);
    case "server.connection.authRequired": return t("server.connection.authRequired", "Auth required (set API key in LLM Settings)", p);
    case "server.connection.model": return t("server.connection.model", "Model: {model}", p);
    case "server.connection.reachable": return t("server.connection.reachable", "reachable", p);
    case "server.connection.ok": return t("server.connection.ok", "ok", p);
    case "server.connection.comfyVersion": return t("server.connection.comfyVersion", "ComfyUI {version}", p);
    case "server.connection.http": return t("server.connection.http", "HTTP {status}", p);
    default: return t("server.error.unexpected", "The server could not complete the request. Details: {detail}", { detail: fallback });
  }
}

/**
 * For legacy stored strings and caught Error.message values, recognize only a
 * small application-owned vocabulary. English remains byte-for-byte raw;
 * other locales receive a summary that keeps the diagnostic visible.
 */
export function localizedServerText(raw: string | null | undefined): string {
  if (!raw || activeLocale() === "en") return raw ?? "";
  const meta = applicationTextI18n(raw);
  if (meta) return localizedServerMessage(meta, raw);
  // Already rendered local validation/toast text can pass through shared banners.
  if (/\p{Script=Han}/u.test(raw)) return raw;
  return localizedServerMessage({ key: "server.error.unexpected", params: { detail: raw } }, raw);
}


function localizedFieldLabel(label: string): string {
  switch (label) {
    case "Base URL": return t("bench.args.base-url.label", "Base URL");
    case "Model": return t("bench.args.model.label", "Model");
    case "Backend label": return t("bench.args.backend.label", "Backend label");
    case "Provider": return t("bench.args.provider.label", "Provider");
    case "Wire format": return t("bench.args.format.label", "Wire format");
    case "API key": return t("bench.args.api-key.label", "API key");
    case "Extra request headers": return t("bench.args.header.label", "Extra request headers");
    case "Session header": return t("bench.args.session-header.label", "Session header");
    case "Short run (core 15)": return t("bench.args.short.label", "Short run (core 15)");
    case "Specific scenarios": return t("bench.args.scenarios.label", "Specific scenarios");
    case "Categories": return t("bench.args.categories.label", "Categories");
    case "Include Hard Mode": return t("bench.args.hardmode.label", "Include Hard Mode");
    case "Hard Mode only": return t("bench.args.hardmode-only.label", "Hard Mode only");
    case "Variant seed": return t("bench.args.variant-seed.label", "Variant seed");
    case "Held-out scenario packs": return t("bench.args.scenario-pack.label", "Held-out scenario packs");
    case "Packs only": return t("bench.args.pack-only.label", "Packs only");
    case "Temperature": return t("bench.args.temperature.label", "Temperature");
    case "Disable thinking": return t("bench.args.no-think.label", "Disable thinking");
    case "Top-p": return t("bench.args.top-p.label", "Top-p");
    case "Top-k": return t("bench.args.top-k.label", "Top-k");
    case "Min-p": return t("bench.args.min-p.label", "Min-p");
    case "Repeat penalty": return t("bench.args.repeat-penalty.label", "Repeat penalty");
    case "Seed": return t("bench.args.seed.label", "Seed");
    case "Backend kwargs (JSON)": return t("bench.args.backend-kwargs.label", "Backend kwargs (JSON)");
    case "Request timeout (s)": return t("bench.args.timeout.label", "Request timeout (s)");
    case "Max turns per scenario": return t("bench.args.max-turns.label", "Max turns per scenario");
    case "Trials": return t("bench.args.trials.label", "Trials");
    case "Parallel scenarios": return t("bench.args.parallel.label", "Parallel scenarios");
    case "Injected tool-error rate": return t("bench.args.error-rate.label", "Injected tool-error rate");
    case "Skip warm-up": return t("bench.args.no-warmup.label", "Skip warm-up");
    case "Skip model pre-flight": return t("bench.args.no-preflight.label", "Skip model pre-flight");
    case "Skip engine probing": return t("bench.args.no-probe-engine.label", "Skip engine probing");
    case "Reference date": return t("bench.args.reference-date.label", "Reference date");
    case "System prompt override": return t("bench.args.system-prompt.label", "System prompt override");
    case "System prompt file": return t("bench.args.system-prompt-file.label", "System prompt file");
    case "Skip tool-call scenarios": return t("bench.args.skip-tool-eval.label", "Skip tool-call scenarios");
    case "Resume run": return t("bench.args.resume.label", "Resume run");
    case "Diff against run": return t("bench.args.diff.label", "Diff against run");
    case "Fail on safety": return t("bench.args.fail-on-safety.label", "Fail on safety");
    case "Quality weight (alpha)": return t("bench.args.alpha.label", "Quality weight (alpha)");
    case "Weight by difficulty": return t("bench.args.weight-by-difficulty.label", "Weight by difficulty");
    case "Label": return t("bench.args.label.label", "Label");
    case "Report directory": return t("bench.args.output-dir.label", "Report directory");
    case "Run throughput benchmark": return t("bench.args.perf.label", "Run throughput benchmark");
    case "Throughput only": return t("bench.args.perf-only.label", "Throughput only");
    case "Prompt tokens": return t("bench.args.pp.label", "Prompt tokens");
    case "Generation tokens": return t("bench.args.tg.label", "Generation tokens");
    case "Context depths": return t("bench.args.depth.label", "Context depths");
    case "Concurrency levels": return t("bench.args.concurrency.label", "Concurrency levels");
    case "Runs per point": return t("bench.args.benchy-runs.label", "Runs per point");
    case "Latency mode": return t("bench.args.benchy-latency-mode.label", "Latency mode");
    case "Extra llama-benchy arguments": return t("bench.args.benchy-args.label", "Extra llama-benchy arguments");
    case "Tokenizer path": return t("bench.args.tokenizer.label", "Tokenizer path");
    case "Run speculative-decoding benchmark": return t("bench.args.spec-bench.label", "Run speculative-decoding benchmark");
    case "Method hint": return t("bench.args.spec-method.label", "Method hint");
    case "Prompt types": return t("bench.args.spec-prompts.label", "Prompt types");
    case "Custom prompt file": return t("bench.args.spec-prompt-file.label", "Custom prompt file");
    case "Runs per cell": return t("bench.args.spec-runs.label", "Runs per cell");
    case "Baseline tokens/s": return t("bench.args.baseline-tgs.label", "Baseline tokens/s");
    case "Prometheus /metrics URL": return t("bench.args.metrics-url.label", "Prometheus /metrics URL");
    case "Pressure ratio": return t("bench.args.context-pressure.label", "Pressure ratio");
    case "Pressure sweep": return t("bench.args.context-pressure-sweep.label", "Pressure sweep");
    case "Sweep steps": return t("bench.args.sweep-steps.label", "Sweep steps");
    case "Context window override": return t("bench.args.context-size.label", "Context window override");
    case "Run GSM8K": return t("bench.args.gsm8k.label", "Run GSM8K");
    case "GSM8K only": return t("bench.args.gsm8k-only.label", "GSM8K only");
    case "Few-shot examples": return t("bench.args.gsm8k-shots.label", "Few-shot examples");
    case "Question limit": return t("bench.args.gsm8k-limit.label", "Question limit");
    case "Shuffle questions": return t("bench.args.gsm8k-shuffle.label", "Shuffle questions");
    case "Run MMLU": return t("bench.args.mmlu.label", "Run MMLU");
    case "MMLU only": return t("bench.args.mmlu-only.label", "MMLU only");
    case "Subjects": return t("bench.args.mmlu-subjects.label", "Subjects");
    case "Run IFEval": return t("bench.args.ifeval.label", "Run IFEval");
    case "IFEval only": return t("bench.args.ifeval-only.label", "IFEval only");
    case "Prompt limit": return t("bench.args.ifeval-limit.label", "Prompt limit");
    case "Run needle-in-a-haystack": return t("bench.args.needle.label", "Run needle-in-a-haystack");
    case "Needle only": return t("bench.args.needle-only.label", "Needle only");
    case "Depths": return t("bench.args.needle-depths.label", "Depths");
    case "Lengths": return t("bench.args.needle-lengths.label", "Lengths");
    case "Run decision-model benchmark": return t("bench.args.decision.label", "Run decision-model benchmark");
    case "Decision only": return t("bench.args.decision-only.label", "Decision only");
    case "Default URL": return t("server.field.defaultUrl", "Default URL");
    case "URL": return "URL";
    default: return label;
  }
}

function localizedScope(scope: string): string {
  switch (scope) {
    case "Local": return t("server.scope.local", "Local");
    case "loopback": return t("server.scope.loopback", "loopback");
    case "Public": return t("server.scope.publicLabel", "Public");
    case "public": return t("server.scope.public", "public");
    case "Host": return t("server.scope.host", "Host");
    case "unknown-host": return t("server.scope.unknown", "unknown-host");
    default: return scope;
  }
}
