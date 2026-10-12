/**
 * Wires alert notifications into the server: evaluated after each fleet
 * snapshot (the broadcast tick), configured through /api/alerts/*, and gated
 * by the `alertsEnabled` setting.
 *
 * The opt-in gates everything outbound and every change:
 *   - off: tick() does not evaluate, so nothing fires and nothing is sent;
 *   - off: POST /api/alerts/test and PUT /api/alerts/config answer 409. A save
 *     resolves channel hosts (the save-time policy check), so refusing it keeps
 *     "off" meaning no DNS and no HTTP at all; with alerts on and no channel,
 *     nothing is sent either, so there is nothing to configure in advance.
 * Reads (GET) work either way, with URLs masked.
 *
 * Channel URLs live in the encrypted secrets store; alerts.json has the rest.
 * A plaintext URL left in alerts.json by an earlier build is moved into the
 * store when the server starts, whatever the switch says — that is a cleanup
 * of a secret at rest, not an outbound request.
 */
import { AlertEngine } from "./engine.js";
import { Notifier } from "./notifier.js";
import { OutboundPolicyError, POLICY_BLOCKED, resolveChannelTarget } from "./outbound.js";
import {
  ValidationError,
  loadAlertsFile,
  publicConfig,
  saveAlertsFile,
  validateChannel,
  validateConfig,
} from "./store.js";
import { MAX_NAME_CHARS, capText } from "./text.js";
import { loadAlertChannelUrls, saveAlertChannelUrls } from "../secretsStore.js";

const TEST_COOLDOWN_MS = 2_000;
export const ALERTS_OFF_MESSAGE = "Alerts are off. Turn them on in Settings → Alerts first.";

/**
 * The Activity event for one channel send. Names the channel and what was in
 * it; never the URL, never anything the server answered.
 */
export function notificationEvent({ channel, group, ok, status, reason }) {
  const firing = group.firing || [];
  const resolved = group.resolved || [];
  const items = [...firing, ...resolved];
  const units = new Set(items.map((a) => a.unitId));
  const what = group.test ? "Test notification" : group.reminder ? "Alert reminder" : "Alert notification";
  let contents = "";
  if (items.length === 1) {
    const a = items[0];
    contents = `: ${firing.length ? a.severity : "resolved"} · ${a.unitName} ${a.label || a.ruleName}`;
  } else if (items.length > 1) {
    contents = `: ${[firing.length ? `${firing.length} firing` : "", resolved.length ? `${resolved.length} resolved` : ""].filter(Boolean).join(", ")}`;
  }
  const target = `"${capText(channel.name, MAX_NAME_CHARS)}" (${channel.type})`;
  const message = ok ? `${what} sent to ${target}${contents}` : `${what} to ${target} failed: ${reason}${contents}`;
  const only = units.size === 1 ? items[0] : null;
  return {
    type: ok ? "alert.notify.sent" : "alert.notify.failed",
    severity: ok ? "info" : "error",
    sparkId: only ? only.unitId : null,
    sparkName: only ? only.unitName : null,
    message: capText(message, 240),
    data: {
      channelId: channel.id,
      channelType: channel.type,
      test: Boolean(group.test),
      reminder: Boolean(group.reminder),
      firing: firing.length,
      resolved: resolved.length,
      ...(ok ? { status } : { reason }),
    },
  };
}

/**
 * @param {{
 *   filePath: string,
 *   isEnabled: () => boolean,
 *   now?: () => number,
 *   fetchImpl?: (url: string, init: object) => Promise<Response>,
 *   lookup?: Function,
 *   log?: Pick<Console, "error" | "warn" | "log">,
 *   timeoutMs?: number,
 *   secrets?: { load: () => Map<string, string>, save: (urls: Map<string, string>) => void },
 *   recordEvent?: (event: object) => unknown,
 * }} opts
 */
export function createAlertsRuntime(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || console;
  const secrets = opts.secrets || { load: loadAlertChannelUrls, save: saveAlertChannelUrls };
  const lookupOpts = opts.lookup ? { lookup: opts.lookup } : undefined;
  const loaded = loadAlertsFile(opts.filePath, log);
  let config = loaded.config;
  let savedState = loaded.state;
  let started = false;
  let restored = false;
  let wasEnabled = false;
  const lastTestAt = new Map();

  // ─── Channel URLs from the secrets store (+ migration) ──
  let urls = new Map();
  try {
    urls = secrets.load() || new Map();
  } catch (err) {
    log.error?.(`[alerts] could not read channel URLs from the secrets store: ${err?.message}`);
  }
  let migrated = 0;
  for (const [id, url] of loaded.legacyUrls) {
    if (!urls.has(id)) {
      urls.set(id, url);
      migrated += 1;
    }
  }
  config = { ...config, channels: config.channels.map((c) => ({ ...c, url: urls.get(c.id) || "" })) };
  if (loaded.legacyUrls.size > 0) {
    try {
      secrets.save(new Map(config.channels.filter((c) => c.url).map((c) => [c.id, c.url])));
      saveAlertsFile(opts.filePath, config, savedState);
      log.log?.(`[alerts] moved ${loaded.legacyUrls.size} channel URL(s) from ${opts.filePath} into the encrypted secrets store${migrated < loaded.legacyUrls.size ? " (the store already had some of them)" : ""}`);
    } catch (err) {
      log.error?.(`[alerts] could not move channel URLs into the secrets store (${err?.message}); they stay in ${opts.filePath} until the next save`);
    }
  }
  for (const c of config.channels) {
    if (!c.url) log.warn?.(`[alerts] channel "${c.name}" has no stored URL; enter it again under Settings → Alerts`);
  }

  const recordEvent = (event) => {
    if (!opts.recordEvent) return;
    try {
      opts.recordEvent(event);
    } catch {
      /* the Activity log never breaks a send */
    }
  };

  const notifier = new Notifier({
    fetchImpl: opts.fetchImpl,
    lookup: opts.lookup,
    now,
    log,
    timeoutMs: opts.timeoutMs,
    onResult: (result) => recordEvent(notificationEvent(result)),
  });
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

  /** Save-time DNS check: a host that resolves to a forbidden address is refused now. */
  async function assertResolvesAllowed(channel) {
    try {
      await resolveChannelTarget(new URL(channel.url), lookupOpts);
    } catch (err) {
      // Not resolvable right now is allowed: the check runs again on every send.
      if (err instanceof OutboundPolicyError && err.message === POLICY_BLOCKED) {
        throw new ValidationError(`${channel.name}: ${POLICY_BLOCKED}`);
      }
    }
  }

  async function applyUpdate(body) {
    if (!enabled()) throw new ValidationError(ALERTS_OFF_MESSAGE, 409);
    const next = validateConfig(body, config);
    const before = new Map(config.channels.map((c) => [c.id, c.url]));
    for (const c of next.channels) {
      if (c.url && c.url !== before.get(c.id)) await assertResolvesAllowed(c);
    }
    secrets.save(new Map(next.channels.filter((c) => c.url).map((c) => [c.id, c.url])));
    saveAlertsFile(opts.filePath, next, savedState);
    config = next;
    const ids = new Set(next.channels.map((c) => c.id));
    for (const id of [...notifier.status.keys()]) if (!ids.has(id)) notifier.status.delete(id);
  }

  let updating = Promise.resolve();

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

    /** Validate + persist a PUT body. Throws ValidationError (400, or 409 while off). */
    async updateConfig(body) {
      const run = updating.then(() => applyUpdate(body));
      updating = run.catch(() => {});
      await run;
      return this.publicConfig();
    },

    /**
     * Send one test message. `channel` (optional) is an unsaved draft; its URL
     * may be the masked one, which resolves against the stored channel
     * `channelId`. The result carries a status code or a fixed reason only.
     */
    async test(body) {
      if (!enabled()) throw new ValidationError(ALERTS_OFF_MESSAGE, 409);
      const id = typeof body?.channelId === "string" ? body.channelId : null;
      const stored = id ? config.channels.find((c) => c.id === id) : null;
      let channel;
      if (body?.channel) {
        channel = validateChannel({ ...body.channel, id: stored?.id }, stored || undefined);
        channel.id = stored?.id || "draft";
      } else {
        if (!stored) throw new ValidationError("Unknown channel", 404);
        channel = stored;
      }
      const at = now();
      if (at - (lastTestAt.get(channel.id) || 0) < TEST_COOLDOWN_MS) {
        return { ok: false, error: "Wait a moment before sending another test", rateLimited: true };
      }
      lastTestAt.set(channel.id, at);
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

  app.put("/api/alerts/config", async (req, res) => {
    try {
      res.json(await runtime.updateConfig(req.body));
    } catch (err) {
      const known = err instanceof ValidationError;
      if (!known) console.error("[alerts] saving the alert settings failed:", err?.message);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "Could not save the alert settings" });
    }
  });

  app.post("/api/alerts/test", async (req, res) => {
    try {
      const result = await runtime.test(req.body);
      if (result.rateLimited) return res.status(429).json(result);
      res.json(result);
    } catch (err) {
      const known = err instanceof ValidationError;
      res.status(known ? err.status : 500).json({ ok: false, error: known ? err.message : "Test failed" });
    }
  });
}
