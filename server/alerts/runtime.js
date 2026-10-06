/**
 * Wires the alert engine into the server: evaluated after each fleet snapshot
 * (the broadcast tick), configured through /api/alerts/*, and silent unless the
 * `alertsEnabled` setting is on — off means no evaluation, no notification and
 * no file writes from the engine.
 */
import { AlertEngine } from "./engine.js";
import { Notifier } from "./notifier.js";
import {
  ValidationError,
  loadAlertsFile,
  publicConfig,
  saveAlertsFile,
  validateChannel,
  validateConfig,
} from "./store.js";

const TEST_COOLDOWN_MS = 2_000;

/**
 * @param {{
 *   filePath: string,
 *   isEnabled: () => boolean,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 *   log?: Pick<Console, "error" | "warn" | "log">,
 *   timeoutMs?: number,
 * }} opts
 */
export function createAlertsRuntime(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || console;
  const loaded = loadAlertsFile(opts.filePath, log);
  let config = loaded.config;
  let savedState = loaded.state;
  let started = false;
  let restored = false;
  let wasEnabled = false;
  const lastTestAt = new Map();

  const notifier = new Notifier({ fetchImpl: opts.fetchImpl, now, log, timeoutMs: opts.timeoutMs });
  const engine = new AlertEngine({
    now,
    getConfig: () => config,
    notifier,
    log,
    persistState: (state) => {
      saveAlertsFile(opts.filePath, config, state);
      savedState = state;
    },
  });

  const enabled = () => {
    try {
      return Boolean(opts.isEnabled());
    } catch {
      return false;
    }
  };

  return {
    engine,
    notifier,

    /** Monitors are running: snapshots now describe the real fleet. */
    start() {
      started = true;
    },

    /** One evaluation over the fleet snapshot. Never throws. */
    tick(snapshots) {
      if (!started) return;
      if (!enabled()) {
        if (wasEnabled) engine.reset();
        wasEnabled = false;
        return;
      }
      wasEnabled = true;
      try {
        if (!restored) {
          restored = true;
          const n = engine.restore(savedState);
          if (n > 0) log.log?.(`[alerts] resumed ${n} firing alert(s) from ${opts.filePath}`);
        }
        engine.evaluate(snapshots);
      } catch (err) {
        log.error?.(`[alerts] evaluation failed: ${err?.message}`);
      }
    },

    /** `alerts` block for the WebSocket snapshot, or null when off. */
    snapshotBlock() {
      if (!enabled()) return null;
      return { active: engine.active() };
    },

    status() {
      const on = enabled();
      return {
        enabled: on,
        active: on ? engine.active() : [],
        pending: on ? engine.pending() : [],
        recent: engine.recent(),
      };
    },

    publicConfig() {
      return { enabled: enabled(), ...publicConfig(config, notifier.status) };
    },

    /** Validate + persist a PUT body. Throws ValidationError (status 400). */
    updateConfig(body) {
      const next = validateConfig(body, config);
      saveAlertsFile(opts.filePath, next, savedState);
      config = next;
      return this.publicConfig();
    },

    /**
     * Send one test message. `channel` (optional) is an unsaved draft; its URL
     * may be the masked one, which resolves against the stored channel
     * `channelId`.
     */
    async test(body) {
      const id = typeof body?.channelId === "string" ? body.channelId : null;
      const stored = id ? config.channels.find((c) => c.id === id) : null;
      let channel;
      if (body?.channel) {
        channel = validateChannel({ ...body.channel, id: stored?.id }, stored || undefined);
        channel.id = stored?.id || "draft";
      } else {
        if (!stored) throw Object.assign(new ValidationError("Unknown channel"), { status: 404 });
        channel = stored;
      }
      const key = channel.id;
      const at = now();
      if (at - (lastTestAt.get(key) || 0) < TEST_COOLDOWN_MS) {
        return { ok: false, error: "Wait a moment before sending another test", rateLimited: true };
      }
      lastTestAt.set(key, at);
      const result = await notifier.send(channel, { test: true, firing: [], resolved: [] });
      return result.ok ? { ok: true, status: result.status } : { ok: false, error: result.error };
    },
  };
}

/** Register /api/alerts routes (behind the app's auth middleware). */
export function registerAlertRoutes(app, runtime) {
  app.get("/api/alerts", (_req, res) => {
    res.json(runtime.status());
  });

  app.get("/api/alerts/config", (_req, res) => {
    res.json(runtime.publicConfig());
  });

  app.put("/api/alerts/config", (req, res) => {
    try {
      res.json(runtime.updateConfig(req.body));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/alerts/test", async (req, res) => {
    try {
      const result = await runtime.test(req.body);
      if (result.rateLimited) return res.status(429).json(result);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  });
}
