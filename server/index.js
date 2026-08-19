import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { SparkRegistry } from "./sparks/SparkRegistry.js";
import { SparkMonitor } from "./sparks/SparkMonitor.js";
import { sshExec, sshTest, llmTest, comfyTest } from "./collectors/ssh.js";
import { comfyCancelJob } from "./collectors/comfyActions.js";
import { validateSparkTarget, createRateLimiter } from "./validate.js";
import { getSettings, updateSettings, loadSettings } from "./settings.js";
import { getPublicSessionSources, loadSessionSources, updateSessionSources } from "./sessionSources.js";
import { loadSessionSourceTokens } from "./secretsStore.js";
import { testSessionSources } from "./collectors/sessionSourceHealth.js";
import { createOccupancyLoop } from "./collectors/occupancyPoller.js";
import { POLL_INTERVAL_LLM } from "./config.js";
import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
} from "./collectors/DecodeBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import { llmDaily } from "./collectors/LlmDaily.js";
import { compareSemver, getLatestRelease } from "./collectors/HermesReleases.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Default to loopback: the dashboard exposes SSH and remote power controls, so it
// should not be reachable on the LAN unless explicitly opted in. Set BIND_HOST to the
// host's LAN IP (or 0.0.0.0) to expose it; docker-compose.yml already sets 0.0.0.0.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "5555", 10);
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);

/** Per-spark LLM HTTP port (1–65535), else env default. */
function resolveLlmPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    // Prefer llmPorts array, fall back to legacy llmPort
    const ports = sparkOrPort.llmPorts;
    if (Array.isArray(ports) && ports.length > 0) {
      const n = ports[0];
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
    const raw = sparkOrPort.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return LLM_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return LLM_PORT;
}

/** Per-spark ComfyUI HTTP port (1–65535), else env default 8188. */
function resolveComfyPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    const raw = sparkOrPort.comfyPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return COMFY_PORT;
}

/** Optional Bearer token for a Spark LLM port (from encrypted secrets). */
function resolveLlmApiKey(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

// Rate-limit ephemeral + registered connectivity tests (per client IP)
const allowTest = createRateLimiter(20, 60_000);

// ─── Spark registry ──────────────────────────────────────
const registry = new SparkRegistry();

// ─── Monitor map ─────────────────────────────────────────
const monitors = new Map();

// ─── Start monitor for a Spark ───────────────────────────
function startMonitor(spark) {
  if (monitors.has(spark.id)) return;
  const monitor = new SparkMonitor(spark, {
    onWolMac: (id, mac) => {
      const updated = registry.noteDetectedMac(id, mac);
      if (updated) {
        const mon = monitors.get(id);
        if (mon) mon.updateConfig(registry.getSpark(id));
      }
    },
    // Hermes check / update results must not wait for the next broadcast tick.
    onHermesChange: () => forceBroadcast(),
  });
  monitors.set(spark.id, monitor);
  monitor.start();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (monitor) {
    monitor.stop();
    monitors.delete(id);
  }
}

// ─── Start all monitors from registry ───────────────────
function startAllMonitors() {
  for (const spark of registry.sparks) {
    startMonitor(spark);
  }
}

/** Snapshots in registry tab order (not Map insertion order). */
function orderedSnapshots() {
  return registry.sparkIds
    .map((id) => monitors.get(id))
    .filter(Boolean)
    .map((m) => m.snapshot());
}

// Occupancy is dashboard-level, on LLM cadence, never folded into _pollDomain("llm").
const occupancyLoop = createOccupancyLoop({
  intervalMs: POLL_INTERVAL_LLM,
  getSparks: () => registry.sparks,
  getSources: loadSessionSources,
  getTokens: loadSessionSourceTokens,
  getMaxAgeMs: () => {
    const hours = getSettings().occupancyMaxAgeHours;
    return hours > 0 ? hours * 3600_000 : 0;
  },
  apply(bySpark) {
    for (const [id, monitor] of monitors) {
      monitor.setConversations(bySpark[id] || []);
    }
  },
});

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

app.use(express.json());

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── REST API ────────────────────────────────────────────
// Never return SSH passwords in any response
app.get("/api/sparks", (_req, res) => {
  res.json({ sparks: registry.publicSparks });
});

// Ephemeral connectivity test — does not persist or start a monitor
app.post("/api/sparks/test", async (req, res) => {
  try {
    if (!allowTest(clientKey(req))) {
      return res.status(429).json({ error: "Too many test requests; try again shortly" });
    }
    const body = req.body || {};
    const validationError = validateSparkTarget(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = {
      id: body.id || "ephemeral-test",
      name: body.name || "test",
      lanIp: body.lanIp || "",
      cx7Ip: body.cx7Ip || null,
      isLocal: Boolean(body.isLocal),
      llmPort: resolveLlmPort(body),
      comfyPort: resolveComfyPort(body),
      comfyMonitoring: Boolean(body.comfyMonitoring),
      ssh: {
        host: body.ssh?.host || body.lanIp || "",
        user: body.ssh?.user || "root",
        auth: body.ssh?.auth === "pass" ? "pass" : "key",
        password: body.ssh?.password,
      },
    };
    if (!spark.lanIp && !spark.ssh.host) {
      return res.status(400).json({ error: "lanIp or ssh.host required" });
    }
    const llmPort = resolveLlmPort(spark);
    const comfyPort = resolveComfyPort(spark);
    const [sshResult, llmResult, comfyResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, llmPort),
      spark.comfyMonitoring
        ? comfyTest(spark, comfyPort)
        : Promise.resolve({ ok: true, message: "disabled", skipped: true }),
    ]);
    res.json({
      id: spark.id,
      ssh: sshResult,
      llm: llmResult,
      comfy: comfyResult,
      ok: sshResult.ok || llmResult.ok || (comfyResult.ok && !comfyResult.skipped),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks", (req, res) => {
  try {
    const validationError = validateSparkTarget(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = registry.addSpark(req.body);
    startMonitor(spark);
    res.json({ success: true, spark: registry.toPublic(spark) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/sparks/:id", (req, res) => {
  try {
    const body = req.body || {};
    // Only validate host fields if they are being updated
    if (body.lanIp != null || body.ssh?.host != null || body.ssh?.user != null) {
      const existing = registry.getSpark(req.params.id);
      if (!existing) return res.status(404).json({ error: "Spark not found" });
      const merged = {
        lanIp: body.lanIp ?? existing.lanIp,
        ssh: { ...existing.ssh, ...(body.ssh || {}) },
      };
      const validationError = validateSparkTarget(merged);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    // Password-only update: hot-apply without full monitor restart
    const keys = Object.keys(body).filter((k) => k !== "ssh");
    const sshKeys = body.ssh ? Object.keys(body.ssh) : [];
    const passwordOnly =
      keys.length === 0 &&
      sshKeys.length > 0 &&
      sshKeys.every((k) => k === "password");

    if (passwordOnly && body.ssh?.password) {
      const spark = registry.setPassword(req.params.id, body.ssh.password);
      const mon = monitors.get(req.params.id);
      if (mon) mon.updateConfig(registry.getSpark(req.params.id));
      return res.json({ success: true, spark, hasPassword: true });
    }

    const spark = registry.updateSpark(req.params.id, body);
    // Restart monitor so collectors pick up host/auth/isLocal changes
    stopMonitor(req.params.id);
    startMonitor(spark);
    res.json({
      success: true,
      spark: registry.toPublic(spark),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/sparks/:id", (req, res) => {
  try {
    const removed = registry.removeSpark(req.params.id);
    if (!removed) return res.status(404).json({ error: "Spark not found" });
    stopMonitor(req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder Sparks in the tab bar (persisted to sparks.json)
app.put("/api/sparks/order", (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: "body.order must be an array of spark ids" });
    }
    const sparks = registry.reorderSparks(order);
    res.json({ success: true, sparks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Global settings ──────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    const newSettings = updateSettings(patch);
    // If poll interval changed, restart the broadcast timer
    if (patch.pollIntervalMs != null) {
      restartBroadcast();
    }
    res.json(newSettings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Dashboard-level conversation sources (tokens never returned)
app.get("/api/session-sources", (_req, res) => {
  res.json(getPublicSessionSources());
});

app.patch("/api/session-sources", (req, res) => {
  try {
    res.json(updateSessionSources(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/session-sources/test", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many test requests; try again shortly" });
  }
  try {
    res.json(await testSessionSources(req.body || {}, { getSparks: () => registry.sparks }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  res.json(monitor.snapshot());
});

// Test SSH + LLM connectivity for a registered Spark.
// Optional body.ssh.password is ALWAYS saved (even if the host is down).
app.post("/api/sparks/:id/test", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many test requests; try again shortly" });
  }
  try {
    const body = req.body || {};
    const incomingPassword = body.ssh?.password ?? body.password;
    // Persist password first — does not require host reachability
    if (incomingPassword != null && incomingPassword !== "") {
      registry.setPassword(req.params.id, incomingPassword);
    }

    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const [sshResult, llmResult, comfyResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, resolveLlmPort(spark)),
      spark.comfyMonitoring
        ? comfyTest(spark, resolveComfyPort(spark))
        : Promise.resolve({ ok: true, message: "disabled", skipped: true }),
    ]);
    res.json({
      id: req.params.id,
      ssh: sshResult,
      llm: llmResult,
      comfy: comfyResult,
      ok: sshResult.ok || llmResult.ok || (comfyResult.ok && !comfyResult.skipped),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a ComfyUI job (running interrupt and/or pending dequeue).
app.post("/api/sparks/:id/comfy/cancel", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many requests; try again shortly" });
  }
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.comfyMonitoring) {
      return res.status(400).json({ error: "ComfyUI monitoring is disabled for this Spark" });
    }
    const promptId = req.body?.promptId ?? req.body?.prompt_id;
    if (!promptId || typeof promptId !== "string") {
      return res.status(400).json({ error: "promptId is required" });
    }
    const result = await comfyCancelJob(spark, promptId, resolveComfyPort(spark));
    // Nudge a comfy re-poll so UI updates quickly
    const mon = monitors.get(req.params.id);
    if (mon) void mon._pollDomain?.("comfy");
    res.json({ success: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual metric refresh ──────────────────────────────
app.post("/api/sparks/:id/refresh/:domain", async (req, res) => {
  try {
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const { domain } = req.params;
    if (domain !== "storage") {
      return res.status(400).json({ error: "Only 'storage' domain is supported" });
    }
    await monitor.refreshDomain(domain);
    forceBroadcast();
    res.json({ success: true, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hermes Agent ───────────────────────────────────
// Batch route first (like shutdown-all/wake-all): a plain Sparks-suffixed
// path (3 segments) that cannot be captured by /api/sparks/:id/hermes/* (4).
/** One-click `hermes update` on every Spark with hermes monitoring enabled. */
app.post("/api/sparks/hermes/update-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const monitor = monitors.get(spark.id);
    const entry = { id: spark.id, name: spark.name, ok: false, started: false, skipped: false };
    if (!spark.hermesMonitoring || !monitor) {
      entry.skipped = true;
      entry.reason = spark.hermesMonitoring
        ? "monitor not running"
        : "Hermes Agent monitoring is disabled (enable it in Edit Spark)";
      results.push(entry);
      continue;
    }
    const result = monitor.runHermesUpdate();
    entry.started = Boolean(result.started);
    entry.ok = Boolean(result.started);
    if (!result.started) {
      entry.skipped = true;
      entry.reason = result.reason || "update already running";
    }
    results.push(entry);
  }
  res.json({ success: true, results });
});

/** Re-check for a hermes update now (bypasses the poll cadence). */
app.post("/api/sparks/:id/hermes/check", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.hermesProbe.check();
    monitor.applyHermesCheck(result);
    res.json({ success: true, hermes: monitor.snapshot().hermes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** One-click `hermes update` via SSH. Returns 202; progress via snapshot. */
app.post("/api/sparks/:id/hermes/update", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.runHermesUpdate();
    res.status(result.started ? 202 : 200).json({
      success: result.started,
      reason: result.reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-Spark Hermes update preview: the latest release (cached globally), the
// installed version, the actual pending commits on this Spark (HEAD..origin/main)
// and a resolved `view` so the dialog shows the commit list for minor /
// no-bump updates and the full release changelog only when a real version bump
// is pending.
app.get("/api/sparks/:id/hermes/updates", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });

    const installedVersion = monitor.snapshot().hermes?.version || null;
    const pending = await monitor.hermesProbe.pendingCommits();

    let release = null;
    let releaseError = null;
    try {
      release = await getLatestRelease();
    } catch (err) {
      releaseError = err instanceof Error ? err.message : String(err);
    }

    // Resolve which content the dialog should lead with. A version bump exists
    // only when the latest tagged release is newer than what is installed;
    // otherwise the pending update is commits on main and those are the honest
    // changelog. Without both versions, fall back to the release when available.
    const hasPending = Boolean(pending && pending.commits && pending.commits.length > 0);
    const releaseNewer =
      release?.semver && installedVersion && compareSemver(release.semver, installedVersion) > 0;
    const view = releaseNewer ? "release" : hasPending ? "commits" : "release";

    res.json({
      success: true,
      view,
      release,
      releaseError,
      installedVersion,
      pending,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update SSH password only (works while host is offline)
app.put("/api/sparks/:id/password", (req, res) => {
  try {
    const password = req.body?.password ?? req.body?.ssh?.password;
    if (password == null || password === "") {
      return res.status(400).json({ error: "password is required" });
    }
    const spark = registry.setPassword(req.params.id, password);
    // Refresh monitor with password in memory (no need if already running — updateConfig)
    const mon = monitors.get(req.params.id);
    if (mon) mon.updateConfig(registry.getSpark(req.params.id));
    res.json({ success: true, spark, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled storage devices for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-devices", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledDevices } = req.body;
    if (!Array.isArray(disabledDevices)) {
      return res.status(400).json({ error: "disabledDevices must be an array" });
    }

    const updated = registry.updateSpark(req.params.id, { disabledDevices });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledDevices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled network interfaces for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-interfaces", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledInterfaces } = req.body;
    if (!Array.isArray(disabledInterfaces)) {
      return res.status(400).json({ error: "disabledInterfaces must be an array" });
    }

    const cleaned = disabledInterfaces.filter((n) => typeof n === "string" && n.length > 0);
    const updated = registry.updateSpark(req.params.id, { disabledInterfaces: cleaned });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledInterfaces: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update LLM probe ports for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPorts;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "llmPorts must be an array" });
    }
    const ports = raw
      .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    // Deduplicate
    const unique = [...new Set(ports)];
    if (unique.length === 0) {
      return res.status(400).json({ error: "llmPorts must contain at least one valid port 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    const updated = registry.updateSpark(req.params.id, { llmPorts: unique });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, unique);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backward-compat: update single LLM port (delegates to llm-ports)
app.put("/api/sparks/:id/llm-port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "llmPort must be an integer 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    // Replace the ports list with just this single port
    const updated = registry.updateSpark(req.params.id, { llmPorts: [n] });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, [n]);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPort: n,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add a single LLM port to a Spark (hot — no monitor restart)
app.post("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.port;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    if (currentPorts.includes(n)) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: [...currentPorts, n] });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, llmPorts: updated.llmPorts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an LLM port from a Spark (hot — no monitor restart)
app.delete("/api/sparks/:id/llm-ports/:port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    // Primary (first) port cannot be removed — only additional ports
    if (currentPorts[0] === port) {
      return res.status(400).json({ error: "Cannot remove the primary LLM port" });
    }
    const newPorts = currentPorts.filter((p) => p !== port);
    if (newPorts.length === 0) {
      return res.status(400).json({ error: "Cannot remove the last LLM port" });
    }
    if (newPorts.length === currentPorts.length) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: newPorts });
    registry.clearLlmApiKey(req.params.id, port);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set / clear optional LLM API key for one port (encrypted secrets store)
app.put("/api/sparks/:id/llm-ports/:port/api-key", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      return res.status(400).json({ error: "apiKey is required (use \"\" to clear)" });
    }

    const apiKey = req.body.apiKey == null ? "" : String(req.body.apiKey);
    const publicSpark = registry.setLlmApiKey(req.params.id, port, apiKey);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      spark: publicSpark,
      hasApiKey: registry.hasLlmApiKey(req.params.id, port),
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Daily decode / prefill tok/s rollups (busy samples, last 14 UTC days by default).
 * Query: port (required for multi-port), days (1–30).
 */
app.get("/api/sparks/:id/llm/daily", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const ports =
    Array.isArray(spark.llmPorts) && spark.llmPorts.length
      ? spark.llmPorts
      : [resolveLlmPort(spark)];
  let port = req.query.port != null ? Number(req.query.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  let days = req.query.days != null ? Number(req.query.days) : 14;
  if (!Number.isFinite(days)) days = 14;
  res.json(llmDaily.getSeries(spark.id, port, { days }));
});

/**
 * Decode throughput benchmark (streaming, post-first-token tok/s).
 *
 * POST body: { port?, concurrencies: number[], maxTokens? }
 * Returns immediately with a bench job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let port = req.body?.port != null ? Number(req.body.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  // Resolve model id for this port from live snapshot when possible
  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const benchDebug = Boolean(getSettings().benchDebugTraces);
    const job = decodeBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      concurrencies: req.body?.concurrencies,
      maxTokens: req.body?.maxTokens,
      debug: benchDebug,
      apiKey: resolveLlmApiKey(spark, port),
      sampleHardware:
        benchDebug && monitor
          ? async () => {
              const fromGpu = (gpu, um) =>
                gpu
                  ? {
                      gpuUsage: gpu.usage ?? null,
                      temperature: gpu.temperature ?? null,
                      powerDraw: gpu.power?.draw ?? null,
                      powerLimit: gpu.power?.limit ?? null,
                      vramUsed: gpu.vram?.used ?? null,
                      vramTotal: gpu.vram?.total ?? null,
                      vramAvailable: gpu.vram?.available ?? null,
                      memAvailable: um?.available ?? null,
                    }
                  : null;

              // Local: fresh collect so the timeline isn't stuck on the 2s poll cache.
              // Remote: use snapshot only — SSH collectGpu every 1s is too heavy mid-bench.
              if (spark.isLocal) {
                try {
                  const [gpu, um] = await Promise.all([
                    monitor.collector.collectGpu(),
                    monitor.collector.collectUnifiedMemory(),
                  ]);
                  return fromGpu(gpu, um);
                } catch {
                  /* fall through */
                }
              }
              const snap = monitor.snapshot();
              return fromGpu(snap?.metrics?.gpu, snap?.metrics?.unifiedMemory);
            }
          : null,
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = decodeBenchManager.getActive(spark.id);
  const history = decodeBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = decodeBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: DECODE_BENCH_DEFAULTS,
  });
});

/** Clear finished bench history for a Spark (optional ?port=). Does not cancel a running job. */
app.delete("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  decodeBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job); // already public shape from manager
});

app.delete("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM Prompt Showcase — concurrent streaming demos.
 *
 * POST body: { port, modelId?, maxTokens?, temperature?, thinking?, promptType?, prompts: string[] }
 * Returns 202 { sessionId }; poll GET for deltas; DELETE :sessionId to cancel.
 * Finished runs are archived; GET collection lists history; DELETE collection clears it.
 */
app.post("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  if (req.body?.port == null) {
    return res.status(400).json({ error: "port is required" });
  }
  const port = Number(req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const result = showcaseManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      maxTokens: req.body?.maxTokens,
      temperature: req.body?.temperature,
      thinking: req.body?.thinking,
      promptType: req.body?.promptType,
      prompts: req.body?.prompts,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Active session + finished history summaries (no stream bodies). */
app.get("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  res.json({
    active: showcaseManager.getActive(spark.id),
    history: showcaseManager.getHistory(spark.id),
  });
});

/** Clear finished showcase history for a Spark. Does not cancel a running session. */
app.delete("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a showcase is running" });
  }
  showcaseManager.clearHistory(spark.id);
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const sinceRaw = req.query.since;
  const since =
    sinceRaw != null && sinceRaw !== ""
      ? parseInt(String(sinceRaw), 10)
      : null;
  const session = showcaseManager.getSession(
    spark.id,
    req.params.sessionId,
    Number.isInteger(since) ? since : null
  );
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

app.delete("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const session = showcaseManager.cancel(spark.id, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

// ─── Power management ────────────────────────────────────
// Shutdown uses host script: sudo -n /usr/local/bin/spark-shutdown (passwordless).
// These routes are unauthenticated like the rest of the LAN dashboard — do not
// expose port 5555 beyond a trusted network.

const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";
/**
 * Remote: verify script + passwordless sudo, then background shutdown so SSH
 * returns before the host dies. Failures before backgrounding surface to the UI.
 */
const SHUTDOWN_REMOTE_CMD = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  `sudo -n true || { echo "sudo -n required for ${SHUTDOWN_BIN}" >&2; exit 126; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("; ");

function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
function initiateSparkShutdown(spark) {
  if (spark.isLocal) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn("sudo", ["-n", SHUTDOWN_BIN], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          const msg = err.message || String(err);
          if (/ENOENT|not found/i.test(msg)) {
            reject(new Error(`${SHUTDOWN_BIN} not found on this host`));
          } else {
            reject(new Error(msg));
          }
        });
        child.unref();
        resolve("Shutdown initiated");
      } catch (err) {
        reject(err);
      }
    });
  }

  return sshExec(spark, SHUTDOWN_REMOTE_CMD, { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** Batch routes first so they never collide with /:id/* if routing changes. */
app.post("/api/sparks/shutdown-all", async (_req, res) => {
  const results = [];
  // Remotes first, local last — shutting down the dashboard host mid-loop would
  // skip remaining Sparks.
  const ordered = [
    ...registry.sparks.filter((s) => !s.isLocal),
    ...registry.sparks.filter((s) => s.isLocal),
  ];
  for (const spark of ordered) {
    const monitor = monitors.get(spark.id);
    if (!monitor?.online) {
      results.push({ id: spark.id, ok: false, skipped: true, error: "Offline — skipped" });
      continue;
    }
    try {
      // Local dashboard host: acknowledge before power-off kills this process.
      if (spark.isLocal) {
        results.push({ id: spark.id, ok: true, message: "Shutdown initiated" });
        setImmediate(() => {
          void initiateSparkShutdown(spark).catch((err) => {
            console.error(`[shutdown-all] local ${spark.id}:`, err.message);
          });
        });
        continue;
      }
      await initiateSparkShutdown(spark);
      results.push({ id: spark.id, ok: true });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/wake-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      results.push({
        id: spark.id,
        ok: false,
        error: "No MAC address (enP7s7 not seen yet; set override in Edit Spark)",
      });
      continue;
    }
    try {
      const broadcast = broadcastForLanIp(spark.lanIp);
      const sent = await sendWol(cleanMac, broadcast);
      results.push({ id: spark.id, ok: true, mac: sent.mac, broadcast: sent.broadcast });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/:id/shutdown", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Local: send JSON first, then power off — otherwise the process dies mid-response
    // and the UI shows "Failed to fetch".
    if (spark.isLocal) {
      res.json({ success: true, message: "Shutdown initiated" });
      setImmediate(() => {
        void initiateSparkShutdown(spark).catch((err) => {
          console.error(`[shutdown] local ${spark.id}:`, err.message);
        });
      });
      return;
    }

    try {
      const message = await initiateSparkShutdown(spark);
      res.json({ success: true, message, output: message });
    } catch (err) {
      const msg = err.message || String(err);
      res.status(shutdownErrorStatus(msg)).json({
        error: shutdownErrorStatus(msg) === 503 ? `Spark unreachable: ${msg}` : msg,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks/:id/wake", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Body mac > user override > auto-detected enP7s7
    const cleanMac = normalizeMac(req.body?.mac) || effectiveMac(spark);
    if (!cleanMac) {
      if (req.body?.mac || spark.macAddress) {
        return res.status(400).json({
          error: `Invalid MAC address: ${req.body?.mac || spark.macAddress}`,
        });
      }
      return res.status(400).json({
        error:
          "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.",
      });
    }

    const broadcast = broadcastForLanIp(spark.lanIp);
    try {
      const sent = await sendWol(cleanMac, broadcast);
      res.json({
        success: true,
        message: `Magic packet sent to ${sent.mac} via ${sent.broadcast}`,
        mac: sent.mac,
        broadcast: sent.broadcast,
      });
    } catch (err) {
      res.status(500).json({ error: `WoL send failed: ${err.message || String(err)}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files (built frontend) ───────────────────────
const distDir = path.join(ROOT, "dist");
const indexHtml = path.join(distDir, "index.html");
app.use(express.static(distDir));

// ─── SPA fallback (Express v5 wildcard) ───────────────────
app.get("*splat", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .type("text")
      .send("Frontend not built. Run `npm run build` or use `npm run dev`.");
  }
  res.sendFile(indexHtml);
});

// ─── WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  // Send the initial snapshot through the same path the broadcast uses so the
  // new client benefits from the same payload format (and bufferedAmount
  // guard, although a freshly-open socket trivially passes it).
  broadcastPayload(buildSnapshotPayload());
  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ─── Broadcast snapshot (dynamic interval) ────────────────
let broadcastTimer = null;
let _lastBroadcastPayload = null;

/** Build the snapshot payload string. Centralized so broadcast + refresh share it. */
function buildSnapshotPayload() {
  return JSON.stringify({
    type: "snapshot",
    sparks: orderedSnapshots(),
    refreshInterval: getSettings().pollIntervalMs,
  });
}

/**
 * Send a payload to every open WS client.
 * - Drops clients whose send queue is backlogged (>1 MB) to avoid unbounded
 *   buffering on slow/flaky connections (e.g. phone over spotty WiFi).
 * - Returns the payload so callers can compare against the previous broadcast.
 */
function broadcastPayload(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // OPEN only
    if (client.bufferedAmount > 1_000_000) {
      try {
        client.close(1008, "client too slow");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.send(payload);
    } catch {
      /* per-client send failure — ignore, close handler will clean up */
    }
  });
}

/**
 * Force an immediate broadcast, ignoring the diff cache.
 * Used after a user action (manual refresh / hermes check / update) so the
 * UI reflects the result right away instead of on the next poll tick.
 */
function forceBroadcast() {
  const payload = buildSnapshotPayload();
  _lastBroadcastPayload = payload;
  broadcastPayload(payload);
}

function startBroadcast() {
  const interval = getSettings().pollIntervalMs;
  broadcastTimer = setInterval(() => {
    const payload = buildSnapshotPayload();
    // Skip the broadcast entirely when nothing changed since the last tick.
    // A 1s poll that produces identical snapshots becomes free for idle tabs.
    if (_lastBroadcastPayload !== null && payload === _lastBroadcastPayload) return;
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
  }, interval);
}

function restartBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  _lastBroadcastPayload = null; // force a fresh broadcast on the new cadence
  startBroadcast();
}

// ─── Start ───────────────────────────────────────────────
loadSettings();
startBroadcast();

server.listen(PORT, BIND_HOST, () => {
  console.log(`[sparkDash] server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[sparkDash] WebSocket endpoint ws://${BIND_HOST}:${PORT}/ws`);
  const isLoopback =
    BIND_HOST === "localhost" || BIND_HOST === "::1" || /^127\./.test(BIND_HOST);
  if (isLoopback) {
    console.log("[sparkDash] localhost-only; set BIND_HOST=0.0.0.0 (or a LAN IP) to allow remote access");
  } else {
    console.warn(
      `[sparkDash] WARNING: bound to ${BIND_HOST} — reachable on the LAN. This dashboard is unauthenticated and can SSH into and power off your Sparks; restrict access at the network/firewall layer.`
    );
  }
  startAllMonitors();
  occupancyLoop.start();
});

// ─── Graceful shutdown ─────────────────────────────────
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[sparkDash] ${signal} received, shutting down…`);
  try {
    // Finalize in-flight benches before the process dies so clients polling
    // GET /llm/bench/:id do not hit "Benchmark not found" after --watch reload.
    decodeBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
  } catch (err) {
    console.error("[sparkDash] failed to finalize benchmarks:", err.message);
  }
  try {
    llmDaily.flush();
  } catch (err) {
    console.error("[sparkDash] failed to flush LLM daily history:", err.message);
  }
  try {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
    occupancyLoop.stop();
    for (const m of monitors.values()) m.stop();
    monitors.clear();
  } catch (err) {
    console.error("[sparkDash] error during shutdown:", err.message);
  }
  // Tell WS clients the server is going away, then close the server.
  try {
    wss.clients.forEach((c) => {
      try {
        c.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  wss.close();
  server.close(() => process.exit(0));
  // Safety net: if server.close hangs (lingering keep-alive), force-exit.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, wss };
