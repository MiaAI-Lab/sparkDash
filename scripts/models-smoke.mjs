/**
 * Read-only smoke test for the model launcher (dev only — not part of npm test).
 * NEVER starts/stops/restarts a model and never enables the scheduler. It only
 * loads the registry, resolves each model's run target (its assigned Spark,
 * reached over SSH — the dashboard itself is machine-agnostic), runs one probe
 * pass, and prints the WS payload.
 *
 * Run: node scripts/models-smoke.mjs
 */
import { ModelRegistry } from "../server/models/ModelRegistry.js";
import { ModelLauncher } from "../server/models/ModelLauncher.js";
import { listRunningContainers, probeModelPort } from "../server/models/ModelProbe.js";
import { resolveRunTarget } from "../server/models/hostExec.js";
import { SparkRegistry } from "../server/sparks/SparkRegistry.js";

const sparks = new SparkRegistry();
const getSpark = (id) => sparks.getSpark(id);

const reg = new ModelRegistry();
console.log("registry ids:", reg.modelIds);
for (const m of reg.models) {
  console.log(
    ` - ${m.id}: spark=${m.sparkId} dir=${m.dir} start=${m.startScript} stop=${m.stopScript} restart=${m.restartScript} logs=${m.logsScript} container=${m.container} port=${m.port}`
  );
  const t = resolveRunTarget(m, getSpark);
  console.log(
    `     target: ${t.kind === null ? `UNRESOLVED — ${t.error}` : `${t.kind} · ${t.label}`}`
  );
}

console.log("\n-- target exec (read-only, over the assigned Spark's SSH) --");
const first = reg.models.find((m) => m.sparkId) || { id: "local", kind: "local" };
const firstTarget = resolveRunTarget(first, getSpark);
const containers = await listRunningContainers(
  firstTarget.kind === null ? { kind: "local", key: "local", label: "local host" } : firstTarget
);
console.log(
  "docker ps available:",
  containers !== null,
  containers && firstTarget.kind === "ssh" ? `(${containers.size} containers on ${firstTarget.label})` : ""
);
if (containers) {
  console.log(
    "  has vllm-fn:",
    containers.has("vllm-fn"),
    "| has glm53-exl3-head:",
    containers.has("glm53-exl3-head")
  );
}

const probeHost =
  firstTarget.kind === "ssh"
    ? firstTarget.spark.lanIp || firstTarget.spark.ssh?.host || "127.0.0.1"
    : "127.0.0.1";
const port = await probeModelPort(8000, undefined, probeHost);
console.log(`port 8000 /v1/models via ${probeHost}:`, JSON.stringify(port));

console.log("\n-- launcher payload (single probe pass) --");
const launcher = new ModelLauncher({ onStatusChange: () => {}, getSpark });
await launcher.refresh();
const payload = launcher.snapshotPayload();
console.log(JSON.stringify(payload, null, 2));

// Byte-stability of the payload is what keeps index.js's diff cache from
// thrashing: a Date.now() anywhere in here would break it.
const a = JSON.stringify(launcher.snapshotPayload());
await new Promise((r) => setTimeout(r, 1200));
const b = JSON.stringify(launcher.snapshotPayload());
console.log("\npayload stable across 1.2s:", a === b);
console.log("payload bytes:", a.length);
launcher.stopTimers();
process.exit(0);
