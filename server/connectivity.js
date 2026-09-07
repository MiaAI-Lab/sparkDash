import { SystemCollector } from "./collectors/SystemCollector.js";
import { HermesProbe } from "./collectors/HermesProbe.js";
import { TailscaleProbe } from "./collectors/TailscaleProbe.js";
import { comfyTest, llmTest, sshTest } from "./collectors/ssh.js";

const RECOVERY = {
  host: {
    local: "Check the host /proc mount and local collector permissions.",
    remote: "Check the host address, SSH user, key/password, and network route.",
  },
  llm: "Start the LLM API on the configured port or disable LLM monitoring.",
  comfy: "Start ComfyUI on the configured port or disable ComfyUI monitoring.",
  hermes: "Install or repair Hermes Agent for the configured host user, or disable Hermes monitoring.",
  tailnet: "Start Tailscale, sign in this unit, or disable Tailnet monitoring.",
};

function roleOf(spark) {
  if (spark?.role === "head" || spark?.role === "worker" || spark?.role === "standalone") {
    return spark.role;
  }
  return spark?.workerNode ? "worker" : "standalone";
}

export function buildConnectivityPlan(spark) {
  const role = roleOf(spark);
  const llmEnabled = role === "head" || (role !== "worker" && spark?.llmMonitoring !== false);
  return [
    { id: "host", label: spark?.isLocal ? "Local collectors" : "Remote SSH", required: true, enabled: true },
    { id: "llm", label: "LLM API", required: llmEnabled, enabled: llmEnabled },
    { id: "comfy", label: "ComfyUI", required: Boolean(spark?.comfyMonitoring), enabled: Boolean(spark?.comfyMonitoring) },
    { id: "hermes", label: "Hermes Agent", required: Boolean(spark?.hermesMonitoring), enabled: Boolean(spark?.hermesMonitoring) },
    { id: "tailnet", label: "Tailnet", required: Boolean(spark?.tailscaleMonitoring), enabled: Boolean(spark?.tailscaleMonitoring) },
  ];
}

export function summarizeConnectivity(plan, results) {
  const capabilities = plan.map((capability) => {
    if (!capability.enabled) {
      return { id: capability.id, label: capability.label, status: "skipped", required: false, message: "Disabled", recovery: null };
    }
    const result = results[capability.id] || { ok: false, message: "Check did not run" };
    const ok = result.ok === true;
    const recovery = ok
      ? null
      : capability.id === "host"
        ? RECOVERY.host[capability.label === "Local collectors" ? "local" : "remote"]
        : RECOVERY[capability.id];
    return {
      id: capability.id,
      label: capability.label,
      status: ok ? "pass" : "fail",
      required: capability.required,
      message: result.message || (ok ? "Available" : "Unavailable"),
      recovery,
    };
  });
  return {
    ok: capabilities.every((capability) => !capability.required || capability.status === "pass"),
    capabilities,
  };
}

function checked(check) {
  return check().catch((error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}

export async function testSparkConnectivity(spark, { llmPort, comfyPort }) {
  const plan = buildConnectivityPlan(spark);
  const enabled = new Set(plan.filter((capability) => capability.enabled).map((capability) => capability.id));
  const entries = await Promise.all([
    checked(async () => {
      if (!spark.isLocal) return sshTest(spark);
      await new SystemCollector(spark).pingHost();
      return { ok: true, message: "Host metrics are readable" };
    }).then((result) => ["host", result]),
    enabled.has("llm")
      ? checked(() => llmTest(spark, llmPort)).then((result) => ["llm", result])
      : Promise.resolve(["llm", { ok: true, message: "Disabled" }]),
    enabled.has("comfy")
      ? checked(() => comfyTest(spark, comfyPort)).then((result) => ["comfy", result])
      : Promise.resolve(["comfy", { ok: true, message: "Disabled" }]),
    enabled.has("hermes")
      ? checked(async () => {
          const result = await new HermesProbe(spark).check();
          return {
            ok: result.installed === true && !result.error,
            message: result.error || (result.installed ? `Installed${result.version ? ` (${result.version})` : ""}` : "Hermes Agent not found"),
          };
        }).then((result) => ["hermes", result])
      : Promise.resolve(["hermes", { ok: true, message: "Disabled" }]),
    enabled.has("tailnet")
      ? checked(async () => {
          const result = await new TailscaleProbe(spark).probe();
          return {
            ok: result.available === true && result.online === true && !result.keyExpired,
            message: result.error || (result.keyExpired ? "Tailscale key expired" : result.online ? "Online" : "Not online"),
          };
        }).then((result) => ["tailnet", result])
      : Promise.resolve(["tailnet", { ok: true, message: "Disabled" }]),
  ]);
  return summarizeConnectivity(plan, Object.fromEntries(entries));
}
