import { randomBytes } from "node:crypto";
import mqtt from "mqtt";
import { unitMetricJson } from "../prometheus.js";
import { dashboardStatusTopic, unitMetricsTopic, unitStatusTopic } from "./topics.js";
import {
  DASHBOARD_HA_ID,
  DEFAULT_DISCOVERY_PREFIX,
  dashboardDiscoveryMessages,
  dashboardDiscoveryTopic,
  nodeId,
  unitDiscoveryMessages,
} from "./haDiscovery.js";

const LOG_QUIET_MS = 30_000;
const DEFAULT_PREFIX = "sparkdash";
/**
 * Publishes handed to the client but not yet acknowledged (QoS 1) or written
 * to the socket (QoS 0). At the cap new publishes are skipped, so a slow or
 * stalled broker costs a bounded amount of memory instead of a growing queue.
 */
export const MAX_IN_FLIGHT = 100;
/**
 * A publish still unacknowledged this long on a live connection means the
 * broker or the socket is wedged: drop the connection and start over.
 */
export const ACK_TIMEOUT_MS = 30_000;
/** How long stop() waits for the broker to acknowledge the offline status. */
export const STOP_TIMEOUT_MS = 1_500;
/**
 * Removed units whose retained topics are still waiting to be cleared. Past
 * this the oldest are forgotten, so removals during a long outage cost a
 * bounded amount of memory.
 */
export const MAX_PENDING_REMOVALS = 100;
/**
 * Home Assistant discovery topics whose removal is still owed to the broker
 * (a unit carries a few dozen). Past this the oldest are forgotten.
 */
export const MAX_PENDING_DISCOVERY_REMOVALS = 2_000;
/**
 * Reading the broker's retained discovery configs after a connect ends once
 * this long passes without another one arriving, or after the max at most.
 */
export const DISCOVERY_READ_QUIET_MS = 1_000;
export const DISCOVERY_READ_MAX_MS = 5_000;

/**
 * Outbound MQTT bridge (opt-in, Settings → MQTT): republishes what sparkDash
 * already holds to a user-configured broker —
 *
 *   {prefix}/events            one JSON EventLog record per accepted event
 *   {prefix}/status/{sparkId}  retained "1"/"0", mirroring sparkdash_up
 *   {prefix}/metrics/{sparkId} retained JSON twin of the unit's Prometheus series
 *   {prefix}/dashboard/status  retained "1" while connected, LWT "0" otherwise
 *   {discovery}/…/config       retained Home Assistant discovery, when enabled
 *
 * Status, metrics and discovery configs are republished only when they change,
 * and all of them again after a reconnect, so a broker restart self-heals. A
 * removed unit's retained topics, and discovery configs for a unit, GPU, LLM
 * port, interface or disk that went away, are cleared at the broker.
 * Switching MQTT publishing off empties the discovery configs before
 * disconnecting (bounded wait).
 *
 * What was published is only remembered in memory, so every connect also
 * reads the broker's retained discovery configs back and reconciles them:
 * ours for a unit no longer in the fleet are emptied, ours for a configured
 * unit are tracked again (an offline unit keeps its entities; a vanished GPU
 * or disk is removed on the next sync). With discovery off, a leftover
 * dashboard config means discovery was left behind, and all of ours are
 * emptied. "Ours" means our node ids and a state topic under our topic
 * prefix, so another sparkDash on the same broker is left alone.
 *
 * Publishing never throws and never blocks a poll loop: while the broker is
 * unreachable the client keeps retrying on its own and publishes are skipped
 * until it is back. Best-effort — a long outage or a slow broker drops
 * messages (at most MAX_IN_FLIGHT are outstanding) instead of queueing them.
 */
export class MqttPublisher {
  /**
   * @param {{ getSettings: () => object, env?: Record<string, string | undefined>, connect?: typeof mqtt.connect, log?: Pick<Console, "warn" | "error">, now?: () => number }} deps
   */
  constructor({
    getSettings,
    env = process.env,
    connect = mqtt.connect,
    log = console,
    now = Date.now,
    discoveryReadQuietMs = DISCOVERY_READ_QUIET_MS,
    discoveryReadMaxMs = DISCOVERY_READ_MAX_MS,
    retireTimeoutMs = STOP_TIMEOUT_MS,
  } = {}) {
    this._getSettings = getSettings;
    this._env = env;
    this._connect = connect;
    this._log = log;
    this._now = now;
    this._discoveryReadQuietMs = discoveryReadQuietMs;
    this._discoveryReadMaxMs = discoveryReadMaxMs;
    this._retireTimeoutMs = retireTimeoutMs;
    /** @type {import("mqtt").MqttClient | null} */
    this._client = null;
    /** Broker URL, topic base and username the current client was built with, so settings PUTs can no-op. */
    this._url = null;
    this._base = null;
    this._user = null;
    this._lastQuietLog = 0;
    /**
     * Unique per process: PID alone is 1 in every container, and two clients
     * sharing an id kick each other off the broker in a loop.
     */
    this._clientId = `sparkdash-${randomBytes(4).toString("hex")}`;
    /** Last status / metrics payload sent per topic, so unchanged values are not resent. */
    /** @type {Map<string, string>} */
    this._sentState = new Map();
    /** Outstanding publishes: token → time handed to the client (insertion order = oldest first). */
    /** @type {Map<number, number>} */
    this._inFlight = new Map();
    this._seq = 0;
    /**
     * Removed unit ids whose retained topics still need clearing at the broker
     * (insertion order = oldest first). Only kept for the current client's
     * broker and prefix; see removeUnit().
     */
    /** @type {Set<string>} */
    this._removedUnits = new Set();
    /** Bumped whenever pending removals are dropped, so late publish failures from before are not re-queued. */
    this._removalsEpoch = 0;
    /**
     * Discovery configs last built per unit id. Kept across reconnects, so a
     * unit removed meanwhile still has its entities cleared, and an offline
     * unit (whose snapshot no longer says what hardware it has) keeps them.
     */
    /** @type {Map<string, Array<{ topic: string, payload: string }>>} */
    this._discoveryByUnit = new Map();
    /** @type {string[]} */
    this._dashboardDiscoveryTopics = [];
    /** Discovery topics whose empty-payload removal is still owed to the broker (oldest first). */
    /** @type {Set<string>} */
    this._pendingDiscoveryRemovals = new Set();
    /** The read of the broker's retained discovery configs in progress, if any. */
    this._discoveryRead = null;
    /** @type {{ discoveryPrefix: string, messages: Map<string, string> } | null} Configs found by the last read, adopted on the next sync. */
    this._foundDiscovery = null;
    /** A connection kept open only to deliver discovery removals after MQTT was switched off. */
    this._retiring = null;
  }

  /**
   * Apply current settings: connects when enabled, reopens the connection when
   * the broker URL or topic prefix changed, tears down when disabled. Safe to
   * call on every settings PUT — a no-op when nothing relevant changed.
   */
  applySettings() {
    const s = this._getSettings();
    if (!s.mqttEnabled || !s.mqttUrl) return this._retire();
    if (!s.mqttDiscovery) this._clearDiscovery();
    const base = this._prefix();
    const user = s.mqttUsername || "";
    if (this._client && this._url === s.mqttUrl && this._base === base && this._user === user) return;
    // A different broker, prefix or user: removals queued for the old one no longer apply.
    if (this._client) this._teardown();
    // Same client id: a connection still delivering removals would be kicked off anyway.
    this._finishRetiring();
    this._url = s.mqttUrl;
    this._base = base;
    this._user = user;
    let client;
    try {
      client = this._connect(s.mqttUrl, {
        clientId: this._clientId,
        reconnectPeriod: 5_000,
        connectTimeout: 10_000,
        // Never buffer QoS 0 while offline; _publish skips then anyway.
        queueQoSZero: false,
        // Each connect starts its own discovery read; a read cut short by a drop must not resume.
        resubscribe: false,
        username: user || undefined,
        // The password never touches settings.json (it is written world-readable);
        // it comes from the SPARKDASH_MQTT_PASSWORD environment variable.
        password: this._env.SPARKDASH_MQTT_PASSWORD || undefined,
        // LWT: the broker flips our availability to 0 if we die without a clean disconnect.
        will: { topic: dashboardStatusTopic(base), payload: "0", qos: 0, retain: true },
      });
    } catch (err) {
      this._url = null;
      this._base = null;
      this._user = null;
      this._dropPendingRemovals();
      return this._quietLog(`connect failed: ${err?.message}`);
    }
    this._client = client;
    client.on("connect", () => {
      if (this._client !== client) return;
      // Fired on every (re)connect. A restarted broker may have lost the
      // retained state: forget what was sent so the next tick resends it all.
      this._sentState.clear();
      // mqtt.js resends unacknowledged QoS 1 publishes now; restart their ack clocks
      // so an outage is not mistaken for a stalled connection.
      const at = this._now();
      for (const token of this._inFlight.keys()) this._inFlight.set(token, at);
      this._announce();
      this._clearRemovedUnits();
      this._flushDiscoveryRemovals();
      this._readDiscovery(client);
    });
    client.on("message", (topic, payload, packet) => this._onMessage(client, topic, payload, packet));
    client.on("error", (err) => this._quietLog(`broker error: ${err?.message}`));
    // "close" / "reconnect" are expected — MQTT.js retries with reconnectPeriod.
  }

  /** Stream one EventLog record. Called from the EventLog's subscriber list. */
  publishEvent(event) {
    const s = this._getSettings();
    if (!s.mqttEnabled) return;
    this._publish(`${this._prefix()}/events`, JSON.stringify(event), { qos: 1 });
  }

  /**
   * Publish the fleet: retained availability plus a metrics payload per unit,
   * from the same entries the /metrics route renders (`metricsEntries()` output
   * — bare snapshots also work, they just lack collection provenance). The
   * metrics payload is the unit's `unitMetricJson()` with a `ts` added; an
   * offline unit gets `{up: 0}` so the metrics topic shows the unit went down,
   * matching the "sparkdash_up 0 and nothing else" rule.
   * @param {Array<object | { snapshot: object, collected?: object, collectedAt?: object } | null | undefined>} entries
   */
  publishFleet(entries) {
    const s = this._getSettings();
    if (!s.mqttEnabled || !Array.isArray(entries)) return;
    // Called every broadcast tick, so this doubles as the ack watchdog.
    this._checkStall();
    const base = this._prefix();
    const units = [];
    for (const entry of entries) {
      const snap = entry && typeof entry === "object" && entry.snapshot ? entry.snapshot : entry;
      if (!snap?.id) continue;
      units.push({ entry, snap });
      // Re-added under the same id: publish its state, do not clear it.
      this._removedUnits.delete(String(snap.id));
    }
    // Retried every tick until it lands (skipped at connect when at the in-flight cap).
    this._announce();
    this._clearRemovedUnits();
    for (const { entry, snap } of units) {
      const up = snap.online === true;
      this._publishIfChanged(unitStatusTopic(base, snap.id), up ? "1" : "0", () => (up ? "1" : "0"), { retain: true });
      const json = unitMetricJson(entry);
      // Retained, so a new or restarted subscriber sees the last state
      // immediately; the availability topics say how stale it may be. The
      // change check ignores `ts`, which would otherwise differ every tick.
      this._publishIfChanged(
        unitMetricsTopic(base, snap.id),
        JSON.stringify(json),
        () => JSON.stringify({ ts: this._now(), ...json }),
        { qos: 0, retain: true }
      );
    }
    // With discovery on, the sync flushes queued removals once it knows which
    // topics are wanted again; flushing first would delete and recreate them.
    if (s.mqttDiscovery) this._syncDiscovery(units, base, s.mqttDiscoveryPrefix || DEFAULT_DISCOVERY_PREFIX);
    else this._flushDiscoveryRemovals();
  }

  /**
   * Bring the Home Assistant discovery configs at the broker in line with the
   * fleet. Each config goes through the same change check as status and
   * metrics, so an unchanged fleet costs one comparison per config and a
   * reconnect resends them all. Topics that are no longer produced (hardware,
   * a unit, or the discovery prefix changed) get an empty retained payload,
   * which removes the entity.
   * @param {Array<{ snap: object }>} units
   */
  _syncDiscovery(units, base, discoveryPrefix) {
    this._adoptFoundDiscovery(units, discoveryPrefix);
    const ctx = { prefix: base, discoveryPrefix };
    const dashboard = dashboardDiscoveryMessages(ctx);
    for (const topic of this._dashboardDiscoveryTopics) {
      if (!dashboard.some((m) => m.topic === topic)) this._removeDiscovery(topic);
    }
    this._dashboardDiscoveryTopics = dashboard.map((m) => m.topic);
    // The dashboard device first: unit devices name it as via_device.
    const wanted = [...dashboard];
    const seen = new Set();
    for (const { snap } of units) {
      const id = String(snap.id);
      seen.add(id);
      const previous = this._discoveryByUnit.get(id) ?? [];
      // Offline: its snapshot no longer lists its hardware. Keep the entities;
      // its availability topic already reports the outage. Configs under a
      // former discovery prefix are emptied, not kept: the unit's entities are
      // rebuilt under the current prefix when it comes back.
      if (snap.online !== true) {
        const current = previous.filter((m) => m.topic.startsWith(`${discoveryPrefix}/`));
        for (const m of previous) {
          if (!current.includes(m)) this._removeDiscovery(m.topic);
        }
        if (current.length) this._discoveryByUnit.set(id, current);
        else this._discoveryByUnit.delete(id);
        wanted.push(...current);
        continue;
      }
      const messages = unitDiscoveryMessages(snap, ctx);
      const topics = new Set(messages.map((m) => m.topic));
      for (const m of previous) {
        if (!topics.has(m.topic)) this._removeDiscovery(m.topic);
      }
      this._discoveryByUnit.set(id, messages);
      wanted.push(...messages);
    }
    for (const [id, messages] of this._discoveryByUnit) {
      if (seen.has(id)) continue;
      for (const m of messages) this._removeDiscovery(m.topic);
      this._discoveryByUnit.delete(id);
    }
    // A topic produced again supersedes its queued removal; flush the rest
    // before publishing, so nothing empties a config that was just sent.
    for (const m of wanted) this._pendingDiscoveryRemovals.delete(m.topic);
    this._flushDiscoveryRemovals();
    for (const m of wanted) this._publishIfChanged(m.topic, m.payload, () => m.payload, { qos: 1, retain: true });
  }

  /** Discovery switched off: remove every entity sparkDash created. */
  _clearDiscovery() {
    for (const messages of this._discoveryByUnit.values()) {
      for (const m of messages) this._removeDiscovery(m.topic);
    }
    this._discoveryByUnit.clear();
    for (const topic of this._dashboardDiscoveryTopics) this._removeDiscovery(topic);
    this._dashboardDiscoveryTopics = [];
    this._flushDiscoveryRemovals();
  }

  /**
   * Queue the removal of one discovery config. Like unit clears, nothing is
   * recorded while there is no client, and pending removals are dropped when
   * MQTT is disabled or the broker, prefix or user changes.
   */
  _removeDiscovery(topic) {
    this._sentState.delete(topic);
    if (!this._client) return;
    this._pendingDiscoveryRemovals.delete(topic);
    this._pendingDiscoveryRemovals.add(topic);
    while (this._pendingDiscoveryRemovals.size > MAX_PENDING_DISCOVERY_REMOVALS) {
      const oldest = this._pendingDiscoveryRemovals.values().next().value;
      this._pendingDiscoveryRemovals.delete(oldest);
      this._quietLog(`more than ${MAX_PENDING_DISCOVERY_REMOVALS} discovery removals awaiting the broker; "${oldest}" will not be removed`);
    }
  }

  /** Send the queued discovery removals, within the in-flight cap; the rest wait for the next tick. */
  _flushDiscoveryRemovals() {
    if (!this._pendingDiscoveryRemovals.size || !this._client?.connected) return;
    const epoch = this._removalsEpoch;
    for (const topic of [...this._pendingDiscoveryRemovals]) {
      const sent = this._publish(topic, "", { qos: 1, retain: true }, () => {
        // Not if the removals were dropped meanwhile, or the config is wanted again.
        if (this._removalsEpoch === epoch && !this._isDiscoveryTopicWanted(topic)) this._removeDiscovery(topic);
      });
      if (!sent) return;
      this._pendingDiscoveryRemovals.delete(topic);
    }
  }

  /**
   * Fold in the configs the last read found at the broker. One whose unit is
   * gone is queued for removal; one whose unit is still configured is tracked
   * again, so the sync keeps it (offline unit), updates it or removes it (a
   * GPU, port, interface or disk the unit no longer has).
   * @param {Array<{ snap: object }>} units
   */
  _adoptFoundDiscovery(units, discoveryPrefix) {
    const found = this._foundDiscovery;
    if (!found) return;
    this._foundDiscovery = null;
    if (found.discoveryPrefix !== discoveryPrefix) return;
    const unitByNode = new Map(units.map(({ snap }) => [nodeId(snap.id), String(snap.id)]));
    for (const [topic, payload] of found.messages) {
      const node = topic.slice(discoveryPrefix.length + 1).split("/")[1];
      if (node === DASHBOARD_HA_ID) continue; // republished by the sync anyway
      const id = unitByNode.get(node);
      if (id == null) {
        this._removeDiscovery(topic);
        continue;
      }
      const messages = this._discoveryByUnit.get(id) ?? [];
      if (!messages.some((m) => m.topic === topic)) this._discoveryByUnit.set(id, [...messages, { topic, payload }]);
    }
  }

  /**
   * After a connect, read back the retained discovery configs at the broker
   * (see the class comment). With discovery off, only the dashboard's own
   * config is checked first, so a user who never enabled discovery costs one
   * single-topic subscription.
   */
  _readDiscovery(client) {
    this._endDiscoveryRead();
    if (typeof client.subscribe !== "function") return;
    const s = this._getSettings();
    const discoveryPrefix = s.mqttDiscoveryPrefix || DEFAULT_DISCOVERY_PREFIX;
    const base = this._prefix();
    const all = `${discoveryPrefix}/+/+/+/config`;
    if (s.mqttDiscovery) {
      this._startDiscoveryRead(client, all, discoveryPrefix, base, (messages) => {
        if (this._getSettings().mqttDiscovery) this._foundDiscovery = { discoveryPrefix, messages };
      });
      return;
    }
    this._startDiscoveryRead(
      client,
      dashboardDiscoveryTopic(discoveryPrefix),
      discoveryPrefix,
      base,
      (sentinel) => {
        if (!sentinel.size) return;
        this._startDiscoveryRead(client, all, discoveryPrefix, base, (messages) => {
          // Switched back on meanwhile: the sync owns these configs again.
          if (this._getSettings().mqttDiscovery) return;
          for (const topic of messages.keys()) this._removeDiscovery(topic);
          this._flushDiscoveryRemovals();
        });
      },
      { quietOnRefusal: true }
    );
  }

  /**
   * Subscribe to `filter`, collect the retained configs that are ours, and
   * hand them to `onDone` once they stop arriving; then unsubscribe.
   * @param {(messages: Map<string, string>) => void} onDone
   */
  _startDiscoveryRead(client, filter, discoveryPrefix, base, onDone, { quietOnRefusal = false } = {}) {
    const read = { client, discoveryPrefix, base, messages: new Map(), quiet: null, max: null, bump: null };
    const finish = (ok) => {
      if (this._discoveryRead !== read) return;
      this._discoveryRead = null;
      clearTimeout(read.quiet);
      clearTimeout(read.max);
      try {
        client.unsubscribe(filter);
      } catch {
        /* ignore */
      }
      if (ok && this._client === client) onDone(read.messages);
    };
    read.bump = () => {
      clearTimeout(read.quiet);
      read.quiet = setTimeout(() => finish(true), this._discoveryReadQuietMs);
      read.quiet.unref?.();
    };
    this._discoveryRead = read;
    read.max = setTimeout(() => finish(true), this._discoveryReadMaxMs);
    read.max.unref?.();
    try {
      client.subscribe(filter, { qos: 0 }, (err, granted) => {
        if (err || granted?.[0]?.qos === 128) {
          if (!quietOnRefusal) {
            this._quietLog(
              `could not read the broker's discovery configs (${err?.message ?? "subscription refused"}); entities left from before this start are not cleaned up`
            );
          }
          return finish(false);
        }
        read.bump();
      });
    } catch (err) {
      this._quietLog(`discovery read failed: ${err?.message}`);
      finish(false);
    }
  }

  /** Retained configs arriving for the read in progress; live (non-retained) traffic is ignored. */
  _onMessage(client, topic, payload, packet) {
    const read = this._discoveryRead;
    if (!read || read.client !== client || packet?.retain !== true) return;
    const text = payload == null ? "" : String(payload);
    if (isOurDiscovery(topic, text, read.discoveryPrefix, read.base)) read.messages.set(topic, text);
    read.bump();
  }

  _endDiscoveryRead() {
    const read = this._discoveryRead;
    this._discoveryRead = null;
    this._foundDiscovery = null;
    if (!read) return;
    clearTimeout(read.quiet);
    clearTimeout(read.max);
  }

  /**
   * MQTT switched off (or its URL cleared): empty every discovery config we
   * know of before disconnecting, so Home Assistant does not keep the
   * entities. The connection lives on, detached, until the broker has
   * acknowledged the removals or retireTimeoutMs has passed. They bypass the
   * in-flight cap: one bounded burst, and nothing else uses this connection.
   */
  _retire() {
    const client = this._client;
    const topics = new Set(this._pendingDiscoveryRemovals);
    for (const messages of this._discoveryByUnit.values()) for (const m of messages) topics.add(m.topic);
    for (const topic of this._dashboardDiscoveryTopics) topics.add(topic);
    this._discoveryByUnit.clear();
    this._dashboardDiscoveryTopics = [];
    if (!client?.connected || topics.size === 0) return this._teardown();
    this._teardown({ keepClient: true });
    let left = topics.size;
    const retiring = { client, timer: null };
    this._retiring = retiring;
    retiring.timer = setTimeout(() => {
      this._log.warn(
        `[mqtt] ${left} discovery removals not acknowledged before disconnecting; Home Assistant keeps those entities until MQTT publishing is on again`
      );
      this._finishRetiring();
    }, this._retireTimeoutMs);
    retiring.timer.unref?.();
    const settle = () => {
      left -= 1;
      if (left === 0 && this._retiring === retiring) this._finishRetiring();
    };
    for (const topic of topics) {
      try {
        client.publish(topic, "", { qos: 1, retain: true }, settle);
      } catch {
        settle();
      }
    }
  }

  /** Close the connection kept open by _retire(), if any. */
  _finishRetiring() {
    const retiring = this._retiring;
    if (!retiring) return;
    this._retiring = null;
    clearTimeout(retiring.timer);
    try {
      retiring.client.end(true);
    } catch {
      /* ignore */
    }
  }

  _isDiscoveryTopicWanted(topic) {
    if (this._dashboardDiscoveryTopics.includes(topic)) return true;
    for (const messages of this._discoveryByUnit.values()) {
      if (messages.some((m) => m.topic === topic)) return true;
    }
    return false;
  }

  /**
   * A unit was deleted: clear its retained status and metrics topics so
   * subscribers do not keep seeing a unit that no longer exists. If the broker
   * is unreachable (or refuses), the clear is retried on later ticks.
   *
   * Pending clears are bounded: none are recorded while there is no client
   * (MQTT disabled or unconfigured), they are dropped when MQTT is disabled or
   * the broker, prefix or user changes, and at most MAX_PENDING_REMOVALS are
   * kept (oldest dropped first). A stall reconnect keeps them.
   */
  removeUnit(sparkId) {
    if (sparkId == null || sparkId === "" || !this._client) return;
    const id = String(sparkId);
    const base = this._prefix();
    this._sentState.delete(unitStatusTopic(base, id));
    this._sentState.delete(unitMetricsTopic(base, id));
    this._queueRemoval(id);
    this._clearRemovedUnits();
  }

  /**
   * Graceful shutdown: publish our own availability as 0 and wait (bounded) for
   * the broker to acknowledge it before closing the connection.
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  async stop({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
    const client = this._client;
    if (client?.connected) {
      const topic = dashboardStatusTopic(this._base ?? this._prefix());
      const acked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const done = (err) => {
          clearTimeout(timer);
          resolve(!err);
        };
        try {
          client.publish(topic, "0", { qos: 1, retain: true }, done);
        } catch (err) {
          done(err);
        }
      });
      if (!acked) {
        this._log.warn("[mqtt] offline status not acknowledged before shutdown; the broker's last-will message will mark the dashboard offline");
      }
    }
    this._finishRetiring();
    this._teardown();
  }

  /** Our own availability: retained "1", resent after every reconnect. */
  _announce() {
    if (!this._base) return;
    this._publishIfChanged(dashboardStatusTopic(this._base), "1", () => "1", { qos: 1, retain: true });
  }

  /** Send an empty retained message (which deletes the retained value) to each removed unit's topics. */
  _clearRemovedUnits() {
    if (!this._removedUnits.size || !this._client?.connected) return;
    const base = this._prefix();
    const epoch = this._removalsEpoch;
    const retry = (id) => {
      if (this._removalsEpoch === epoch) this._queueRemoval(id);
    };
    for (const id of [...this._removedUnits]) {
      let handedOff = true;
      for (const topic of [unitStatusTopic(base, id), unitMetricsTopic(base, id)]) {
        const sent = this._publish(topic, "", { qos: 1, retain: true }, () => retry(id));
        if (!sent) handedOff = false;
      }
      if (handedOff) this._removedUnits.delete(id);
    }
  }

  /** Record a pending clear, forgetting the oldest beyond MAX_PENDING_REMOVALS. */
  _queueRemoval(id) {
    this._removedUnits.add(id);
    while (this._removedUnits.size > MAX_PENDING_REMOVALS) {
      const oldest = this._removedUnits.values().next().value;
      this._removedUnits.delete(oldest);
      this._quietLog(`more than ${MAX_PENDING_REMOVALS} removed units awaiting the broker; retained topics for "${oldest}" will not be cleared`);
    }
  }

  _dropPendingRemovals() {
    this._removedUnits.clear();
    this._pendingDiscoveryRemovals.clear();
    this._removalsEpoch += 1;
  }

  /**
   * Publish `render()` only when `key` differs from what was last sent on the
   * topic. The cache is updated only on a real send, and forgotten again if
   * delivery fails, so a skipped or failed publish is retried on the next tick.
   */
  _publishIfChanged(topic, key, render, opts) {
    if (this._sentState.get(topic) === key) return;
    const sent = this._publish(topic, render(), opts, () => {
      if (this._sentState.get(topic) === key) this._sentState.delete(topic);
    });
    if (sent) this._sentState.set(topic, key);
  }

  /**
   * Hand one message to the client, within the in-flight cap.
   * @param {(err: Error) => void} [onLateError] called if delivery fails after this returned true
   * @returns {boolean} whether the message was handed to the client
   */
  _publish(topic, payload, opts, onLateError) {
    const client = this._client;
    // Skipping while disconnected keeps a long broker outage from queueing
    // unbounded messages in the client.
    if (!client?.connected) {
      this._quietLog("broker not connected; publish skipped");
      return false;
    }
    if (this._inFlight.size >= MAX_IN_FLIGHT) {
      this._quietLog(`${this._inFlight.size} publishes awaiting the broker; publish skipped`);
      return false;
    }
    const token = ++this._seq;
    this._inFlight.set(token, this._now());
    let returned = false;
    let failedNow = false;
    try {
      // The callback fires on PUBACK for QoS 1, once written (or drained) for
      // QoS 0, and with an error if the connection closes first.
      client.publish(topic, payload, opts, (err) => {
        this._inFlight.delete(token);
        if (!err) return;
        this._quietLog(`publish to ${topic} failed: ${err?.message}`);
        if (returned) onLateError?.(err);
        else failedNow = true;
      });
    } catch (err) {
      this._inFlight.delete(token);
      this._quietLog(`publish failed: ${err?.message}`);
      failedNow = true;
    }
    returned = true;
    return !failedNow;
  }

  /** Reconnect when the oldest outstanding publish has gone unacknowledged too long. */
  _checkStall() {
    if (!this._client?.connected || this._inFlight.size === 0) return;
    const oldest = this._inFlight.values().next().value;
    if (this._now() - oldest < ACK_TIMEOUT_MS) return;
    this._log.warn(`[mqtt] broker has not acknowledged a publish in ${ACK_TIMEOUT_MS / 1000} s; reconnecting`);
    // Same broker and prefix: the clears still apply after the reconnect.
    this._teardown({ keepPendingRemovals: true });
    this.applySettings();
  }

  /** @param {{ keepPendingRemovals?: boolean, keepClient?: boolean }} [opts] keepClient: detach without closing (see _retire) */
  _teardown({ keepPendingRemovals = false, keepClient = false } = {}) {
    const client = this._client;
    this._client = null;
    this._url = null;
    this._base = null;
    this._user = null;
    this._sentState.clear();
    this._inFlight.clear();
    this._endDiscoveryRead();
    // Before end(): it fails every outstanding clear, which must not re-queue them.
    if (!keepPendingRemovals) this._dropPendingRemovals();
    if (!client || keepClient) return;
    try {
      client.end(true); // force: don't wait on in-flight QoS acks during teardown
    } catch {
      /* ignore */
    }
  }

  _prefix() {
    const p = this._getSettings().mqttTopicPrefix;
    return typeof p === "string" && p ? p : DEFAULT_PREFIX;
  }

  /** Rate-limited warn: a down broker must not flood the log every poll tick. */
  _quietLog(message) {
    const now = this._now();
    if (now - this._lastQuietLog < LOG_QUIET_MS) return;
    this._lastQuietLog = now;
    this._log.warn(`[mqtt] ${message}`);
  }
}

/**
 * A retained discovery config this instance published: one of our node ids
 * (`sparkdash_{unit}` or the dashboard's), with a state topic under our topic
 * prefix — so a second sparkDash on the same broker, or anything else using
 * the discovery prefix, is never touched.
 */
function isOurDiscovery(topic, payload, discoveryPrefix, base) {
  if (!payload || !topic.startsWith(`${discoveryPrefix}/`)) return false;
  const parts = topic.slice(discoveryPrefix.length + 1).split("/");
  if (parts.length !== 4 || parts[3] !== "config") return false;
  if (parts[1] !== DASHBOARD_HA_ID && !parts[1].startsWith("sparkdash_")) return false;
  let config;
  try {
    config = JSON.parse(payload);
  } catch {
    return false;
  }
  return typeof config?.state_topic === "string" && config.state_topic.startsWith(`${base}/`);
}

export default MqttPublisher;
