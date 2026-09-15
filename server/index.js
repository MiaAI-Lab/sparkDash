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
import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import { initiateSparkShutdown, shutdownErrorStatus } from "./shutdown.js";
import { AutoPowerManager } from "./autopower/AutoPowerManager.js";
import { createAutoPowerProbe } from "./autopower/probe.js";
import { registerAutoPowerRoutes } from "./autopower/autopowerRoutes.js";
import { loadAutoPowerConfig, getAutoPowerConfig } from "./autopower/store.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
} from "./collectors/DecodeBench.js";
import {
  prefillBenchManager,
  PREFILL_BENCH_DEFAULTS,
} from "./collectors/PrefillBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import { llmDaily } from "./collectors/LlmDaily.js";
import { compareSemver, getLatestRelease } from "./collectors/HermesReleases.js";
// ─── Model launcher (isolated module — see server/models/ModelLauncher.js) ───
import { initModelLauncher } from "./models/ModelLauncher.js";
import { registerModelRoutes } from "./models/modelRoutes.js";
import { loadSchedulerConfig } from "./models/schedulerStore.js";

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
const AI_PROXY_PORT = parseInt(process.env.AI_PROXY_PORT || "3001", 10);
const DEV_ENGINE_API_PORT = parseInt(process.env.DEV_ENGINE_API_PORT || "10000", 10);
const DEV_ENGINE_WEBUI_PORT = parseInt(process.env.DEV_ENGINE_WEBUI_PORT || "10001", 10);

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
  // A spark registered into a partially-hidden UI must obey the current
  // viewport set immediately, not after the next visibility change.
  updateMonitorStates();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  clearTimeout(actionGraceTimers.get(id));
  actionGraceTimers.delete(id);
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

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

app.use(express.json());

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── AI Proxy bridge ─────────────────────────────────────
// Proxies the (proprietary) AI proxy's observer API through the sparkDash
// server so the browser never needs CORS and the integration stays self-
// contained. Routes are unauthenticated like the rest of the LAN dashboard.
// *_HOST env vars name the machine the service actually runs on (deployment
// config — same convention as MODEL_REPOS_BASE); unset means co-located with
// the dashboard, which keeps the loopback defaults for single-host installs.
const AI_PROXY_HOST = process.env.AI_PROXY_HOST || "";
const AI_PROXY_BASE = `http://${AI_PROXY_HOST || "127.0.0.1"}:${AI_PROXY_PORT}`;
const AI_PROXY_TIMEOUT_MS = 5000;

async function aiProxyFetch(path, init) {
  const res = await fetch(`${AI_PROXY_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(AI_PROXY_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/**
 * Shared handler for GET endpoints that forward to the observer API.
 * On any upstream failure responds 502 so the UI can show a graceful
 * offline state instead of a generic fetch error.
 */
async function aiProxyGet(req, res, path) {
  try {
    const query = new URLSearchParams(req.query);
    const qs = query.toString() ? `?${query.toString()}` : "";
    const { status, json } = await aiProxyFetch(`${path}${qs}`, { method: "GET" });
    res.status(status).json(json);
  } catch (err) {
    res.status(502).json({ error: `AI proxy unreachable (${err.message || String(err)})` });
  }
}

app.get("/api/ai-proxy/streams", (req, res) => {
  void aiProxyGet(req, res, "/observer/api/streaming");
});

app.get("/api/ai-proxy/active-requests", (req, res) => {
  void aiProxyGet(req, res, "/observer/api/active-requests");
});

app.get("/api/ai-proxy/statistics", (req, res) => {
  void aiProxyGet(req, res, "/observer/api/statistics");
});

/** Kill a streaming request by id. */
app.post("/api/ai-proxy/cancel/:id", async (req, res) => {
  try {
    const id = encodeURIComponent(String(req.params.id));
    const { status, json } = await aiProxyFetch(`/observer/api/cancel/${id}`, {
      method: "POST",
    });
    res.status(status).json(json);
  } catch (err) {
    res.status(502).json({ error: `AI proxy unreachable (${err.message || String(err)})` });
  }
});

/** Cancel a non-streaming request by id. */
app.post("/api/ai-proxy/cancel-request/:id", async (req, res) => {
  try {
    const id = encodeURIComponent(String(req.params.id));
    const { status, json } = await aiProxyFetch(`/observer/api/cancel-request/${id}`, {
      method: "POST",
    });
    res.status(status).json(json);
  } catch (err) {
    res.status(502).json({ error: `AI proxy unreachable (${err.message || String(err)})` });
  }
});

/**
 * Resolve the request's origin hostname (domain-agnostic): builds a base
 * URL pointing at the host the dashboard is served from, so links work under
 * any domain/IP, not just localhost.
 */
function requestBaseUrl(req, port) {
  const host = req.headers.host || "localhost";
  // Strip a trailing :port (but not IPv6 brackets) — hostname only.
  const hostname = host.startsWith("[") ? host.split("]")[0] + "]" : host.split(":")[0];
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${hostname}:${port}`;
}

/**
 * Browser-facing base URL for an integrated service. When its host is
 * configured (service runs on another machine), the link must point THERE —
 * the dashboard's own host would be a dead port. Unconfigured = co-located:
 * derive from the request so LAN/domain access keeps working.
 */
function integrationBaseUrl(req, host, port) {
  if (!host) return requestBaseUrl(req, port);
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${host}:${port}`;
}

/**
 * Base observer URL for "jump to proxy" links. With AI_PROXY_HOST set the
 * proxy lives on another machine and the link must carry that hostname;
 * otherwise the proxy is co-located and the request's own hostname applies.
 */
app.get("/api/ai-proxy/observer-url", (req, res) => {
  res.json({ url: `${integrationBaseUrl(req, AI_PROXY_HOST, AI_PROXY_PORT)}/observer` });
});

// ─── Spark Dev Engine bridge ─────────────────────────────
// Proxies the Spark Dev Engine REST API (port 10000) through the sparkDash
// server so the browser never needs CORS. Like the AI proxy bridge, routes are
// unauthenticated like the rest of the LAN dashboard. On any upstream failure
// respond 502 so the UI can show a graceful offline state.
const DEV_ENGINE_API_HOST = process.env.DEV_ENGINE_API_HOST || "";
const DEV_ENGINE_WEBUI_HOST = process.env.DEV_ENGINE_WEBUI_HOST || "";
const DEV_ENGINE_API_BASE = `http://${DEV_ENGINE_API_HOST || "127.0.0.1"}:${DEV_ENGINE_API_PORT}`;
const DEV_ENGINE_TIMEOUT_MS = 5000;

async function devEngineFetch(path, init) {
  const res = await fetch(`${DEV_ENGINE_API_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(DEV_ENGINE_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function devEngineGet(req, res, path) {
  try {
    const query = new URLSearchParams(req.query);
    const qs = query.toString() ? `?${query.toString()}` : "";
    const { status, json } = await devEngineFetch(`${path}${qs}`, { method: "GET" });
    res.status(status).json(json);
  } catch (err) {
    res.status(502).json({ error: `Dev engine unreachable (${err.message || String(err)})` });
  }
}

async function devEnginePost(req, res, path) {
  try {
    const { status, json } = await devEngineFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    res.status(status).json(json);
  } catch (err) {
    res.status(502).json({ error: `Dev engine unreachable (${err.message || String(err)})` });
  }
}

app.get("/api/dev-engine/status", (req, res) => {
  void devEngineGet(req, res, "/api/status");
});

app.get("/api/dev-engine/tickets", (req, res) => {
  void devEngineGet(req, res, "/api/tickets");
});

/**
 * Active plans (plan generation runs that have not produced a ticket yet).
 * The engine returns the full plan markdown in `content`; the dashboard only
 * needs the summary fields, so it is dropped here and replaced with
 * `content_length` to keep the 5s poll small.
 */
app.get("/api/dev-engine/plans", async (req, res) => {
  try {
    const query = new URLSearchParams(req.query);
    const qs = query.toString() ? `?${query.toString()}` : "";
    const { status, json } = await devEngineFetch(`/api/plans${qs}`, { method: "GET" });
    const slim = Array.isArray(json)
      ? json.map(({ content, ...rest }) => ({
          ...rest,
          content_length: typeof content === "string" ? content.length : 0,
        }))
      : json;
    res.status(status).json(slim);
  } catch (err) {
    res.status(502).json({ error: `Dev engine unreachable (${err.message || String(err)})` });
  }
});

app.get("/api/dev-engine/running-tasks", (req, res) => {
  void devEngineGet(req, res, "/api/running-tasks");
});

app.get("/api/dev-engine/slots-config", (req, res) => {
  void devEngineGet(req, res, "/api/slots-config");
});

app.post("/api/dev-engine/slots-config", (req, res) => {
  void devEnginePost(req, res, "/api/slots-config");
});

/** Web UI base URL for "jump to engine" links — configured host, else request origin. */
app.get("/api/dev-engine/webui-url", (req, res) => {
  res.json({ url: integrationBaseUrl(req, DEV_ENGINE_WEBUI_HOST, DEV_ENGINE_WEBUI_PORT) });
});

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

app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  // REST snapshot consumers (e.g. the standalone showcase page with no WS
  // tab open) get a short grace so they read a fresh poll, not a stale cache.
  if (monitor.isPaused()) grantActionGrace(req.params.id, METRICS_GRACE_MS);
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
 * POST body: { port?, concurrencies: number[], maxTokens?, promptType? }
 * promptType is structured | prose | code | json (default structured).
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
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prefill benchmark is already running for this Spark" });
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
      promptType: req.body?.promptType,
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
 * Prefill throughput + TTFT at selected context sizes (up to 300k).
 *
 * POST body: { port?, contextSizes: number[] }
 * Returns 202 job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/prefill-bench", (req, res) => {
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
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A decode benchmark is already running for this Spark" });
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
    const job = prefillBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      contextSizes: req.body?.contextSizes,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = prefillBenchManager.getActive(spark.id);
  const history = prefillBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = prefillBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: PREFILL_BENCH_DEFAULTS,
  });
});

app.delete("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  prefillBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job);
});

app.delete("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.cancel(spark.id, req.params.benchId);
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
// Shutdown helpers live in server/shutdown.js: remote Sparks run the host script
// over SSH (sudo -n /usr/local/bin/spark-shutdown, passwordless), the local Spark
// reaches host systemd via nsenter when running inside the sparkDash container.
// Wake-on-LAN helper is server/wol.js.
// These routes are unauthenticated like the rest of the LAN dashboard — do not
// expose port 5555 beyond a trusted network.

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
      // The local Spark resolves after the ack window (power-off queued, host
      // still up for a few seconds), so this loop and the JSON response finish.
      const message = await initiateSparkShutdown(spark);
      results.push({ id: spark.id, ok: true, message });
      grantActionGrace(spark.id, SHUTDOWN_GRACE_MS);
    } catch (err) {
      const msg = err.message || String(err);
      console.warn(`[shutdown-all] ${spark.id} failed: ${msg}`);
      results.push({ id: spark.id, ok: false, error: msg });
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
      grantActionGrace(spark.id, WAKE_GRACE_MS);
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

    try {
      const message = await initiateSparkShutdown(spark);
      res.json({ success: true, message, output: message });
      grantActionGrace(req.params.id, SHUTDOWN_GRACE_MS);
    } catch (err) {
      const msg = err.message || String(err);
      console.warn(`[shutdown] ${spark.id} failed: ${msg}`);
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
      grantActionGrace(req.params.id, WAKE_GRACE_MS);
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

// ─── Model launcher (Overview panel: start/stop model repos on their Sparks) ───
// Registered before the static handler; every path is /api-scoped. The
// forceBroadcast reference is a hoisted function declaration below, so the
// launcher can push job/probe/scheduler changes to clients immediately
// instead of waiting for the next poll tick. getSpark hands the launcher the
// live SparkRegistry lookup (including the encrypted-at-rest SSH password) —
// model scripts run on the Spark assigned to each card, over SSH, so the
// dashboard itself is machine-agnostic.
const modelLauncher = initModelLauncher({
  onStatusChange: () => forceBroadcast(),
  getSpark: (id) => registry.getSpark(id),
});
registerModelRoutes(app, modelLauncher, { forceBroadcast });
// ─── Spark AutoPower (idle shutdown + scheduled wake) ───
// Watches the AI proxy (in-flight requests) and the dev engine (slots,
// tickets, plan runs). After AUTOPOWER idle minutes of verified quiet inside
// the configured watch span it shuts the remote Sparks down; at the wake time
// it wakes them again. Head goes down last / up first: the proxy lives on it.
const autoPower = new AutoPowerManager({
  probe: createAutoPowerProbe({ aiProxyFetch, devEngineFetch }),
  // Only the remote Sparks — the dashboard host itself is never touched.
  getSparks: () => registry.sparks.filter((s) => s.kind === "spark" && !s.isLocal),
  isOnline: (id) => Boolean(monitors.get(id)?.online),
  shutdownSpark: (spark) => initiateSparkShutdown(spark),
  wakeSpark: (spark) => {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      return Promise.reject(
        new Error(`No MAC address for ${spark.name} (wake it once manually / set an override)`)
      );
    }
    return sendWol(cleanMac, broadcastForLanIp(spark.lanIp));
  },
  onAction: (id, kind) =>
    grantActionGrace(id, kind === "wake" ? WAKE_GRACE_MS : SHUTDOWN_GRACE_MS),
  getConfig: getAutoPowerConfig,
});
registerAutoPowerRoutes(app, autoPower);

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

/** Active WS clients — zero means nothing renders, so nothing polls. */
let activeClientCount = 0;

/**
 * Per-client viewport set (client sends {type:"visibility",sparks:[ids]}).
 * null = never reported → treat as watching everything, which keeps
 * pre-visibility clients and the connect→first-report window behaving
 * exactly like before.
 */
function clientWatches(client, id) {
  return client._visibleIds == null || client._visibleIds.has(id);
}

/**
 * Action grace: after WoL / shutdown the machine's transition must stay
 * observable even while its overview card is scrolled out of view.
 * id -> Timeout; presence keeps that monitor polling regardless of viewport.
 */
const actionGraceTimers = new Map();
const WAKE_GRACE_MS = 4 * 60_000; // WoL → BIOS → boot → sshd
const SHUTDOWN_GRACE_MS = 90_000; // watch the offline transition
const METRICS_GRACE_MS = 60_000; // REST snapshot consumers (showcase page)

function grantActionGrace(id, ms) {
  clearTimeout(actionGraceTimers.get(id));
  actionGraceTimers.set(
    id,
    setTimeout(() => {
      actionGraceTimers.delete(id);
      updateMonitorStates();
    }, ms)
  );
  updateMonitorStates();
}

function updateMonitorStates() {
  for (const [id, monitor] of monitors) {
    // Grace outranks everything (wake/shutdown/metrics consumers may act with
    // zero open tabs); otherwise a monitor polls only while some live client
    // can actually see its graphs.
    const watched =
      actionGraceTimers.has(id) ||
      (activeClientCount > 0 &&
        [...wss.clients].some((c) => clientWatches(c, id)));
    if (watched) monitor.resume();
    else monitor.pause();
  }
}

wss.on("connection", (ws) => {
  activeClientCount++;
  ws._visibleIds = null;
  console.log(`[ws] client connected (${activeClientCount} active)`);
  // Resume polling now that a client is watching (until its first report
  // narrows the set below).
  updateMonitorStates();
  // Send the initial snapshot through the same path the broadcast uses so the
  // new client benefits from the same payload format (and bufferedAmount
  // guard, although a freshly-open socket trivially passes it).
  broadcastPayload(buildSnapshotPayload());
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || msg.type !== "visibility") return;
    ws._visibleIds = Array.isArray(msg.sparks)
      ? new Set(msg.sparks.filter((s) => typeof s === "string"))
      : null; // malformed → conservative "watching everything"
    updateMonitorStates();
  });
  ws.on("close", () => {
    activeClientCount = Math.max(0, activeClientCount - 1);
    console.log(`[ws] client disconnected (${activeClientCount} active)`);
    updateMonitorStates();
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
    // Model launcher block, namespaced under one key so the merge surface
    // stays a single added property. Contains no Date.now()-derived value
    // (see ModelLauncher.snapshotPayload) so this string stays byte-identical
    // between ticks and the diff cache below keeps skipping idle broadcasts.
    models: modelLauncher.snapshotPayload(),
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
loadSchedulerConfig();
loadAutoPowerConfig();
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
  // Model launcher probe + scheduler timers. Deliberately not tied to
  // updateMonitorStates(): the night shift must run with zero tabs open.
  modelLauncher.startTimers();
  // AutoPower shares the "night shift" rationale: it must run with zero tabs open.
  autoPower.start();
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
    prefillBenchManager.interruptAll(
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
  // Finalize model jobs so polls after a --watch/reload don't 404. Does NOT
  // touch the Sparks' scripts or containers — a restart of the dashboard must
  // never take someone's running model with it.
  try {
    modelLauncher.stopTimers();
    autoPower.stop();
    modelLauncher.interruptAll(
      "Interrupted — sparkDash restarted while the script was running (the script and any container it started keep running on its Spark)"
    );
  } catch (err) {
    console.error("[sparkDash] failed to finalize model jobs:", err.message);
  }
  try {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
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
