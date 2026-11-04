/**
 * The MQTT bridge is driven entirely through injected dependencies, so these
 * tests exercise the real class against a stub client — no broker needed.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  ACK_TIMEOUT_MS,
  MAX_IN_FLIGHT,
  MAX_PENDING_DISCOVERY_REMOVALS,
  MAX_PENDING_REMOVALS,
  MqttPublisher,
} from "../MqttPublisher.js";

/**
 * Stub mqtt.js client capturing the calls the publisher makes. With `autoAck`
 * (the default) every publish completes at once; otherwise its callback waits
 * in `calls.pending` until the test calls `ack()`.
 */
function fakeClient({ autoAck = true, ...overrides } = {}) {
  const calls = { publishes: [], pending: [], ended: 0, endForce: null, handlers: {} };
  const client = {
    connected: true,
    publish(topic, payload, opts, cb) {
      calls.publishes.push({ topic, payload: String(payload), opts: opts ?? {} });
      if (autoAck) cb?.();
      else calls.pending.push(cb);
    },
    end(force) {
      calls.ended += 1;
      calls.endForce = force;
      // Like mqtt.js: closing fails every outstanding publish.
      for (const cb of calls.pending.splice(0)) cb?.(new Error("Connection closed"));
    },
    on(event, fn) {
      calls.handlers[event] = fn;
    },
    ...overrides,
  };
  return { client, calls };
}

const ENABLED = { mqttEnabled: true, mqttUrl: "mqtt://broker.local:1883", mqttUsername: "", mqttTopicPrefix: "sparkdash" };

/** Build a publisher wired to a stub client; `connect` records every attempt. */
function harness({ settings = {}, client: clientOverrides = {}, now, publisher: publisherOpts = {} } = {}) {
  let current = { ...ENABLED, ...settings };
  const attempts = [];
  const warnings = [];
  const { client, calls } = fakeClient(clientOverrides);
  const publisher = new MqttPublisher({
    getSettings: () => current,
    env: {},
    connect: (url, opts) => {
      attempts.push({ url, opts });
      return client;
    },
    log: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    ...(now ? { now } : {}),
    ...publisherOpts,
  });
  const h = {
    publisher,
    client,
    calls,
    attempts,
    warnings,
    set(patch) {
      current = { ...current, ...patch };
    },
    /** Fire a lifecycle event on the stub client, like mqtt.js would. */
    fire(event, ...args) {
      calls.handlers[event]?.(...args);
    },
    /** Connect, let the broker accept, and forget the availability announcement. */
    ready() {
      publisher.applySettings();
      h.fire("connect");
      while (calls.pending.length) h.ack();
      calls.publishes.length = 0;
    },
    /** Complete the oldest outstanding publish (optionally with an error). */
    ack(err) {
      calls.pending.shift()?.(err);
    },
    topics(from = 0) {
      return calls.publishes.slice(from).map((p) => p.topic);
    },
  };
  return h;
}

test("disabled: no connection is attempted and nothing is published", () => {
  const h = harness({ settings: { mqttEnabled: false } });
  h.publisher.applySettings();
  h.publisher.publishEvent({ type: "spark.offline", message: "x" });
  h.publisher.publishFleet([{ id: "alpha", online: true }]);
  assert.equal(h.attempts.length, 0);
  assert.equal(h.calls.publishes.length, 0);
});

test("applySettings connects, sends credentials, and publishes dashboard availability on connect", () => {
  const h = harness();
  h.publisher.applySettings();
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].url, "mqtt://broker.local:1883");
  assert.match(h.attempts[0].opts.clientId, /^sparkdash-[0-9a-f]{8}$/);
  assert.equal(h.attempts[0].opts.reconnectPeriod, 5_000);
  // The will mirrors our own availability so a crashed dashboard reads 0 at the broker.
  assert.deepEqual(h.attempts[0].opts.will, {
    topic: "sparkdash/dashboard/status",
    payload: "0",
    qos: 0,
    retain: true,
  });
  h.fire("connect");
  assert.deepEqual(h.calls.publishes, [
    { topic: "sparkdash/dashboard/status", payload: "1", opts: { qos: 1, retain: true } },
  ]);
});

test("the broker password comes from the environment, the username from settings", () => {
  let current = { ...ENABLED, mqttUsername: "mia" };
  const attempts = [];
  const publisher = new MqttPublisher({
    getSettings: () => current,
    env: { SPARKDASH_MQTT_PASSWORD: "hunter2" },
    connect: (url, opts) => {
      attempts.push({ url, opts });
      return fakeClient().client;
    },
  });
  publisher.applySettings();
  assert.equal(attempts[0].opts.username, "mia");
  assert.equal(attempts[0].opts.password, "hunter2");
  // A settings PUT that changes nothing relevant must not reconnect…
  publisher.applySettings();
  assert.equal(attempts.length, 1);
  // …but a username change applies live, without touching the password.
  current = { ...current, mqttUsername: "" };
  publisher.applySettings();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].opts.username, undefined);
  assert.equal(attempts[1].opts.password, "hunter2");
});

test("events stream to {prefix}/events with QoS 1 and the EventLog record verbatim", () => {
  const h = harness();
  h.publisher.applySettings();
  const event = { id: 7, ts: 1234, type: "spark.offline", severity: "warn", sparkId: "alpha", sparkName: "Alpha", message: "Alpha went offline" };
  h.publisher.publishEvent(event);
  assert.deepEqual(h.calls.publishes, [
    { topic: "sparkdash/events", payload: JSON.stringify(event), opts: { qos: 1 } },
  ]);
  // A custom prefix changes the topic, not the payload.
  h.set({ mqttTopicPrefix: "home/fleet" });
  h.publisher.publishEvent({ ...event, id: 8 });
  assert.equal(h.calls.publishes[1].topic, "home/fleet/events");
});

test("the fleet publishes retained availability plus a metrics payload per unit", () => {
  const h = harness();
  h.ready();
  h.publisher.publishFleet([
    { snapshot: { id: "alpha", online: true, uptime: 100 } }, // wrapped provenance form
    { id: "beta", online: false }, // bare snapshot
  ]);
  assert.equal(h.calls.publishes.length, 4);
  assert.deepEqual(
    h.calls.publishes.filter((p) => p.topic.startsWith("sparkdash/status/")),
    [
      { topic: "sparkdash/status/alpha", payload: "1", opts: { retain: true } },
      { topic: "sparkdash/status/beta", payload: "0", opts: { retain: true } },
    ]
  );
  // The metrics payload is the unit's Prometheus series as JSON: up + what was
  // measured. Retained, so a fresh subscriber sees the last state immediately.
  assert.equal(h.calls.publishes[1].topic, "sparkdash/metrics/alpha");
  assert.equal(h.calls.publishes[1].opts.qos, 0);
  assert.equal(h.calls.publishes[1].opts.retain, true);
  const alpha = JSON.parse(h.calls.publishes[1].payload);
  assert.equal(typeof alpha.ts, "number");
  assert.equal(alpha.up, 1);
  assert.equal(alpha.uptime_seconds, 100);
  // An offline unit says so on its metrics topic too ("sparkdash_up 0 and nothing else").
  assert.equal(h.calls.publishes[3].topic, "sparkdash/metrics/beta");
  assert.equal(h.calls.publishes[3].opts.retain, true);
  const beta = JSON.parse(h.calls.publishes[3].payload);
  assert.deepEqual(beta, { ts: beta.ts, up: 0 });
});

test("a Spark id is percent-encoded into its topics", () => {
  const h = harness();
  h.ready();
  h.publisher.publishFleet([{ id: "spark one", online: true, uptime: 5 }]);
  assert.deepEqual(
    h.calls.publishes.map((p) => p.topic),
    ["sparkdash/status/spark%20one", "sparkdash/metrics/spark%20one"]
  );
});

test("publishes are skipped while the broker is disconnected — never thrown, never queued", () => {
  const h = harness({ client: { connected: false } });
  h.publisher.applySettings();
  h.publisher.publishEvent({ type: "x", message: "y" });
  h.publisher.publishFleet([{ id: "alpha", online: true }]);
  h.fire("connect");
  assert.equal(h.calls.publishes.length, 0);
});

test("garbage entries are ignored", () => {
  const h = harness();
  h.ready();
  h.publisher.publishFleet(null);
  h.publisher.publishFleet([null, {}, { snapshot: {} }, { online: true }]);
  assert.equal(h.calls.publishes.length, 0);
});

test("a changed broker URL or prefix reopens the connection", () => {
  const h = harness();
  h.publisher.applySettings();
  h.set({ mqttUrl: "mqtts://broker.local:8883" });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 1);
  assert.equal(h.calls.endForce, true);
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1].url, "mqtts://broker.local:8883");
  h.set({ mqttTopicPrefix: "home" });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 2);
  assert.equal(h.attempts.length, 3);
  assert.equal(h.attempts[2].opts.will.topic, "home/dashboard/status");
});

test("disabling tears the connection down", () => {
  const h = harness();
  h.publisher.applySettings();
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 1);
  // Late publishes after teardown are silent no-ops.
  h.publisher.publishEvent({ type: "x", message: "y" });
  assert.equal(h.calls.publishes.length, 0);
});

test("stop() marks the dashboard offline, waits for the broker's ack, then closes", async () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  const stopped = h.publisher.stop();
  assert.deepEqual(h.calls.publishes, [
    { topic: "sparkdash/dashboard/status", payload: "0", opts: { qos: 1, retain: true } },
  ]);
  // The connection must stay open until the broker has acknowledged the "0".
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.ended, 0);
  h.ack();
  await stopped;
  assert.equal(h.calls.ended, 1);
  assert.equal(h.calls.endForce, true);
  assert.deepEqual(h.warnings, []);
});

test("stop() gives up waiting after its timeout and still closes", async () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  await h.publisher.stop({ timeoutMs: 10 });
  assert.equal(h.calls.ended, 1);
  assert.match(h.warnings.join("\n"), /not acknowledged before shutdown/);
});

test("stop() without a live connection just tears down", async () => {
  const h = harness({ client: { connected: false } });
  h.publisher.applySettings();
  await h.publisher.stop();
  assert.equal(h.calls.publishes.length, 0);
  assert.equal(h.calls.ended, 1);
});

test("nothing throws when a connect attempt fails outright", async () => {
  const publisher = new MqttPublisher({
    getSettings: () => ENABLED,
    env: {},
    log: { warn() {}, error() {} },
    connect: () => {
      throw new Error("bad url");
    },
  });
  publisher.applySettings();
  publisher.publishEvent({ type: "x", message: "y" });
  publisher.publishFleet([{ id: "alpha", online: true }]);
  publisher.removeUnit("alpha");
  await publisher.stop();
});

test("each publisher gets its own client id (PID is 1 in every container)", () => {
  const a = harness();
  const b = harness();
  a.publisher.applySettings();
  b.publisher.applySettings();
  assert.notEqual(a.attempts[0].opts.clientId, b.attempts[0].opts.clientId);
});

test("status and metrics are resent only when they change, and retried after a skipped publish", () => {
  const h = harness();
  h.publisher.applySettings();
  const at = (uptime) => [{ snapshot: { id: "alpha", online: true, uptime } }];
  const topics = (from) => h.calls.publishes.slice(from).map((p) => p.topic);
  h.publisher.publishFleet(at(1));
  let mark = h.calls.publishes.length;
  h.publisher.publishFleet(at(2)); // metrics changed, status did not
  assert.deepEqual(topics(mark), ["sparkdash/metrics/alpha"]);
  h.client.connected = false;
  h.publisher.publishFleet([{ id: "alpha", online: false }]); // skipped: broker down
  h.client.connected = true;
  mark = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "alpha", online: false }]);
  assert.deepEqual(topics(mark), ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]);
});

test("a Spark with id \"dashboard\" does not touch the dashboard's availability topic", () => {
  const h = harness();
  h.publisher.applySettings();
  h.fire("connect");
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "dashboard", online: false }]);
  const topics = h.calls.publishes.slice(mark).map((p) => p.topic);
  assert.deepEqual(topics, ["sparkdash/status/dashboard", "sparkdash/metrics/dashboard"]);
  assert.ok(!topics.includes("sparkdash/dashboard/status"));
});

test("a reconnect resends the retained status and metrics on the next tick", () => {
  const h = harness();
  h.publisher.applySettings();
  const fleet = [{ snapshot: { id: "alpha", online: true, uptime: 1 } }];
  h.publisher.publishFleet(fleet);
  let mark = h.calls.publishes.length;
  h.publisher.publishFleet(fleet); // unchanged: nothing resent
  assert.equal(h.calls.publishes.length, mark);
  h.fire("connect"); // like a restarted broker handing the session back
  mark = h.calls.publishes.length;
  h.publisher.publishFleet(fleet);
  assert.deepEqual(
    h.calls.publishes.slice(mark).map((p) => p.topic),
    ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]
  );
});

test("unacknowledged publishes are capped; skipped state is retried once the broker catches up", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  for (let i = 0; i < MAX_IN_FLIGHT; i += 1) h.publisher.publishEvent({ id: i });
  assert.equal(h.calls.publishes.length, MAX_IN_FLIGHT);
  // At the cap: events are dropped and retained state is skipped, not queued.
  h.publisher.publishEvent({ id: "over" });
  h.publisher.publishFleet([{ id: "alpha", online: true, uptime: 1 }]);
  assert.equal(h.calls.publishes.length, MAX_IN_FLIGHT);
  assert.match(h.warnings.join("\n"), /awaiting the broker; publish skipped/);
  // Two acks free two slots: the skipped status and metrics go out on the next tick.
  h.ack();
  h.ack();
  h.publisher.publishFleet([{ id: "alpha", online: true, uptime: 1 }]);
  assert.deepEqual(h.topics(MAX_IN_FLIGHT), ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]);
});

test("a publish that fails after hand-off is resent on the next tick", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  const fleet = [{ id: "alpha", online: true, uptime: 1 }];
  h.publisher.publishFleet(fleet);
  const mark = h.calls.publishes.length;
  h.ack(new Error("Connection closed")); // status
  h.ack(); // metrics
  h.publisher.publishFleet(fleet);
  assert.deepEqual(h.topics(mark), ["sparkdash/status/alpha"]);
});

test("a connection that stops acknowledging is dropped and reopened", () => {
  let clock = 1_000_000;
  const h = harness({ client: { autoAck: false }, now: () => clock });
  h.ready();
  h.publisher.publishEvent({ id: 1 }); // never acknowledged
  clock += ACK_TIMEOUT_MS - 1;
  h.publisher.publishFleet([]);
  assert.equal(h.attempts.length, 1);
  clock += 1;
  h.publisher.publishFleet([]);
  assert.equal(h.calls.ended, 1);
  assert.equal(h.attempts.length, 2);
  assert.match(h.warnings.join("\n"), /has not acknowledged a publish/);
});

test("publishes resent after a reconnect get a fresh ack deadline", () => {
  let clock = 1_000_000;
  const h = harness({ client: { autoAck: false }, now: () => clock });
  h.ready();
  h.publisher.publishEvent({ id: 1 });
  // A long outage, then mqtt.js reconnects and resends the unacknowledged event.
  clock += 5 * ACK_TIMEOUT_MS;
  h.fire("connect");
  h.publisher.publishFleet([]);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.calls.ended, 0);
});

test("removing a unit clears its retained topics and forgets what was sent", () => {
  const h = harness();
  h.ready();
  const fleet = [{ id: "spark one", online: true, uptime: 1 }];
  h.publisher.publishFleet(fleet);
  const mark = h.calls.publishes.length;
  h.publisher.removeUnit("spark one");
  // A zero-length retained message deletes the retained value at the broker.
  assert.deepEqual(h.calls.publishes.slice(mark), [
    { topic: "sparkdash/status/spark%20one", payload: "", opts: { qos: 1, retain: true } },
    { topic: "sparkdash/metrics/spark%20one", payload: "", opts: { qos: 1, retain: true } },
  ]);
  // Cleared once only.
  const after = h.calls.publishes.length;
  h.publisher.publishFleet([]);
  assert.equal(h.calls.publishes.length, after);
  // Re-added under the same id: its state is published again, not skipped as unchanged.
  h.publisher.publishFleet(fleet);
  assert.deepEqual(h.topics(after), ["sparkdash/status/spark%20one", "sparkdash/metrics/spark%20one"]);
});

test("a unit removed while the broker is down is cleared once it is back", () => {
  const h = harness();
  h.ready();
  h.client.connected = false;
  h.publisher.removeUnit("alpha");
  assert.equal(h.calls.publishes.length, 0);
  h.client.connected = true;
  h.fire("connect");
  assert.deepEqual(
    h.calls.publishes.filter((p) => p.payload === "").map((p) => p.topic),
    ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]
  );
});

test("a failed clear is retried, unless the unit has come back", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  h.publisher.removeUnit("alpha");
  h.ack(new Error("Connection closed"));
  h.ack();
  let mark = h.calls.publishes.length;
  h.publisher.publishFleet([]);
  assert.deepEqual(h.topics(mark), ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]);
  // Fails again, but the unit is re-added before the next tick: publish it, never clear it.
  h.ack(new Error("Connection closed"));
  h.ack();
  mark = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "alpha", online: true, uptime: 1 }]);
  assert.ok(h.calls.publishes.slice(mark).every((p) => p.payload !== ""));
  assert.deepEqual(h.topics(mark), ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]);
});

test("the availability announcement is retried when the cap blocked it at connect", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  for (let i = 0; i < MAX_IN_FLIGHT; i += 1) h.publisher.publishEvent({ id: i });
  h.fire("connect"); // reconnect with a full window: the "1" cannot go out yet
  assert.ok(!h.topics(MAX_IN_FLIGHT).includes("sparkdash/dashboard/status"));
  h.ack();
  h.publisher.publishFleet([]);
  assert.deepEqual(h.topics(MAX_IN_FLIGHT), ["sparkdash/dashboard/status"]);
});

/** Topics of the zero-length retained clears sent since `from`. */
const clears = (h, from = 0) => h.calls.publishes.slice(from).filter((p) => p.payload === "").map((p) => p.topic);

test("removals are not recorded while MQTT has no client", () => {
  const h = harness({ settings: { mqttEnabled: false } });
  h.publisher.applySettings();
  for (let i = 0; i < 3 * MAX_PENDING_REMOVALS; i += 1) h.publisher.removeUnit(`gone-${i}`);
  h.set({ mqttEnabled: true });
  h.publisher.applySettings();
  h.fire("connect");
  h.publisher.publishFleet([]);
  assert.deepEqual(clears(h), []);
});

test("disabling MQTT drops pending clears, including ones failed by the teardown", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  h.publisher.removeUnit("alpha"); // handed off, awaiting PUBACK
  h.client.connected = false;
  h.publisher.removeUnit("beta"); // queued while the broker is down
  h.set({ mqttEnabled: false });
  h.publisher.applySettings(); // end(true) fails alpha's outstanding clears
  h.set({ mqttEnabled: true });
  h.client.connected = true;
  const mark = h.calls.publishes.length;
  h.publisher.applySettings();
  h.fire("connect");
  h.publisher.publishFleet([]);
  assert.deepEqual(clears(h, mark), []);
});

test("changing the topic prefix drops clears queued for the old prefix", () => {
  const h = harness();
  h.ready();
  h.client.connected = false;
  h.publisher.removeUnit("alpha");
  h.set({ mqttTopicPrefix: "other" });
  h.client.connected = true;
  h.publisher.applySettings();
  h.fire("connect");
  h.publisher.publishFleet([]);
  assert.deepEqual(clears(h), []);
});

test("at most MAX_PENDING_REMOVALS clears are kept, oldest dropped first", () => {
  const h = harness();
  h.ready();
  h.client.connected = false;
  const extra = 5;
  for (let i = 0; i < MAX_PENDING_REMOVALS + extra; i += 1) h.publisher.removeUnit(`u${i}`);
  h.client.connected = true;
  h.fire("connect");
  const cleared = clears(h);
  assert.equal(cleared.length, 2 * MAX_PENDING_REMOVALS);
  assert.equal(cleared[0], `sparkdash/status/u${extra}`);
  assert.equal(cleared.at(-1), `sparkdash/metrics/u${MAX_PENDING_REMOVALS + extra - 1}`);
});

test("a stall reconnect keeps a clear that was still awaiting the broker", () => {
  let clock = 1_000_000;
  const h = harness({ client: { autoAck: false }, now: () => clock });
  h.ready();
  h.publisher.removeUnit("alpha");
  clock += ACK_TIMEOUT_MS;
  const mark = h.calls.publishes.length;
  // Watchdog: the teardown fails the outstanding clears, then the reconnect resends them.
  h.publisher.publishFleet([]);
  assert.equal(h.attempts.length, 2);
  assert.deepEqual(clears(h, mark), ["sparkdash/status/alpha", "sparkdash/metrics/alpha"]);
});

// ─── Home Assistant discovery ────────────────────────────

const DISCOVERY = { mqttDiscovery: true, mqttDiscoveryPrefix: "homeassistant" };

/** Config messages only (the `…/config` topics Home Assistant listens on). */
const configs = (h, from = 0) => h.calls.publishes.slice(from).filter((p) => p.topic.endsWith("/config"));

const alpha = (extra = {}) => ({ snapshot: { id: "alpha", name: "Alpha", kind: "spark", online: true, uptime: 10, ...extra } });

const ONLINE_CONFIG = "homeassistant/binary_sensor/sparkdash_alpha/online/config";
const DASHBOARD_CONFIG = "homeassistant/binary_sensor/sparkdash-dashboard/connected/config";

test("discovery is opt-in even when publishing is on", () => {
  const h = harness();
  h.ready();
  h.publisher.publishFleet([alpha()]);
  assert.equal(configs(h).length, 0);
});

test("discovery configs are published when the fleet first appears, not on every tick", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const first = configs(h);
  assert.ok(first.length >= 3); // online, uptime + the dashboard's own sensor
  for (const c of first) assert.deepEqual(c.opts, { qos: 1, retain: true });
  const online = first.find((c) => c.topic === ONLINE_CONFIG);
  assert.ok(online, "no online binary_sensor config");
  assert.equal(JSON.parse(online.payload).state_topic, "sparkdash/status/alpha");
  // The dashboard device goes first: unit devices name it as via_device.
  assert.equal(first[0].topic, DASHBOARD_CONFIG);
  assert.equal(JSON.parse(first[0].payload).state_topic, "sparkdash/dashboard/status");
  // Same fleet again: nothing changed, so nothing is resent.
  const before = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  assert.deepEqual(configs(h, before), []);
  // A GPU appears: exactly its configs (plus the board power sensor) are added.
  h.publisher.publishFleet([
    alpha({ metrics: { gpu: { gpus: [{ index: 0, usage: 5, temperature: 40, power: { draw: 9 }, vram: { used: 1, total: 2 } }] } } }),
  ]);
  const added = configs(h, before);
  assert.equal(added.length, 5);
  for (const c of added) assert.ok(c.topic.includes("/gpu_0_") || c.topic.endsWith("/power/config"), c.topic);
});

test("a unit removed from the fleet gets its discovery configs emptied", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const announced = configs(h).filter((c) => c.topic.includes("sparkdash_alpha")).map((c) => c.topic);
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([]);
  assert.deepEqual(clears(h, mark).sort(), announced.sort());
  // Sent once: the next tick has nothing more to remove.
  const mark2 = h.calls.publishes.length;
  h.publisher.publishFleet([]);
  assert.deepEqual(clears(h, mark2), []);
});

test("hardware that goes away has its entities removed", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  const gpu = { gpus: [{ index: 0, usage: 5, temperature: 40, power: { draw: 9 }, vram: { used: 1, total: 2 } }] };
  h.publisher.publishFleet([alpha({ metrics: { gpu } })]);
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  const removed = clears(h, mark);
  assert.equal(removed.length, 5);
  for (const t of removed) assert.ok(t.includes("/gpu_0_") || t.endsWith("/power/config"), t);
});

test("an offline unit keeps its entities — its availability topic reports the outage", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const before = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "alpha", online: false }]);
  assert.equal(configs(h, before).length, 0);
  assert.deepEqual(
    h.calls.publishes.slice(before).filter((p) => p.topic === "sparkdash/status/alpha").map((p) => p.payload),
    ["0"]
  );
});

test("a reconnect resends the discovery configs on the next tick, even for an offline unit", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const announced = configs(h).map((c) => c.topic);
  h.fire("connect"); // like a restarted broker handing the session back
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "alpha", online: false }]);
  assert.deepEqual(configs(h, mark).map((c) => c.topic).sort(), announced.sort());
});

test("a config whose delivery fails is resent on the next tick", () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const sent = h.calls.publishes.map((p) => p.topic);
  const failedTopic = sent.indexOf(ONLINE_CONFIG);
  assert.ok(failedTopic >= 0);
  for (let i = 0; i < sent.length; i++) h.ack(i === failedTopic ? new Error("Connection closed") : undefined);
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  assert.deepEqual(configs(h, mark).map((c) => c.topic), [ONLINE_CONFIG]);
});

test("switching discovery off removes every entity it created", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const announced = configs(h).map((c) => c.topic);
  const mark = h.calls.publishes.length;
  h.set({ mqttDiscovery: false });
  h.publisher.applySettings();
  assert.deepEqual(clears(h, mark).sort(), announced.sort());
  // Turned back on: everything is announced again.
  h.set({ mqttDiscovery: true });
  h.publisher.applySettings();
  const mark2 = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  assert.deepEqual(configs(h, mark2).map((c) => c.topic).sort(), announced.sort());
});

test("discovery removals made while disconnected are sent on reconnect, once", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const announced = configs(h).map((c) => c.topic);
  h.client.connected = false;
  h.set({ mqttDiscovery: false });
  h.publisher.applySettings(); // clears discovery while the broker is unreachable
  h.client.connected = true;
  const mark = h.calls.publishes.length;
  h.fire("connect");
  assert.deepEqual(clears(h, mark).sort(), announced.sort());
  const mark2 = h.calls.publishes.length;
  h.fire("connect");
  assert.deepEqual(clears(h, mark2), []);
});

test("changing the discovery prefix moves the entities", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const old = configs(h).map((c) => c.topic);
  h.set({ mqttDiscoveryPrefix: "ha" });
  h.publisher.applySettings(); // no reconnect: broker, prefix and user are unchanged
  assert.equal(h.attempts.length, 1);
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  assert.deepEqual(clears(h, mark).sort(), old.sort());
  const moved = configs(h, mark).filter((c) => c.payload !== "").map((c) => c.topic);
  assert.deepEqual(moved.sort(), old.map((t) => t.replace(/^homeassistant\//, "ha/")).sort());
});

test("changing the discovery prefix empties an offline unit's configs under the old prefix", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  const old = configs(h).map((c) => c.topic);
  h.set({ mqttDiscoveryPrefix: "ha" });
  h.publisher.applySettings();
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([{ id: "alpha", online: false }]);
  assert.deepEqual(clears(h, mark).sort(), old.sort());
  // Only the dashboard's own config moves now; alpha's wait for it to come back.
  assert.deepEqual(
    configs(h, mark).filter((c) => c.payload !== "").map((c) => c.topic),
    [DASHBOARD_CONFIG.replace(/^homeassistant\//, "ha/")]
  );
  // Back online: the entities are rebuilt under the current prefix.
  const mark2 = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  const moved = configs(h, mark2).filter((c) => c.payload !== "").map((c) => c.topic);
  const expected = old.filter((t) => t !== DASHBOARD_CONFIG).map((t) => t.replace(/^homeassistant\//, "ha/"));
  assert.deepEqual(moved.sort(), expected.sort());
});

test("a topic produced again is not emptied by a removal still queued for it", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  h.client.connected = false;
  h.publisher.publishFleet([]); // alpha removed while the broker is down: removals queued
  h.client.connected = true;
  h.fire("connect");
  // The connect handler flushed them; queue them again, then bring alpha back before any flush.
  h.client.connected = false;
  h.publisher.publishFleet([alpha()]);
  h.publisher.publishFleet([]);
  h.client.connected = true;
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  const sent = h.calls.publishes.slice(mark).filter((p) => p.topic === ONLINE_CONFIG);
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].payload, "");
});

test("a removal that fails after hand-off is retried, unless the config is wanted again", () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  while (h.calls.pending.length) h.ack();
  h.publisher.publishFleet([]);
  const removalCount = h.calls.pending.length;
  assert.ok(removalCount > 0);
  for (let i = 0; i < removalCount; i++) h.ack(new Error("Connection closed"));
  const mark = h.calls.publishes.length;
  h.publisher.publishFleet([]);
  assert.equal(clears(h, mark).length, removalCount);
  // Fail them again, but the unit is back: its configs are published, not emptied.
  for (let i = 0; i < removalCount; i++) h.ack(new Error("Connection closed"));
  const mark2 = h.calls.publishes.length;
  h.publisher.publishFleet([alpha()]);
  assert.deepEqual(clears(h, mark2), []);
  assert.ok(configs(h, mark2).some((c) => c.topic === ONLINE_CONFIG));
});

test("disabling MQTT drops pending discovery removals", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  h.publisher.publishFleet([alpha()]);
  h.client.connected = false;
  h.publisher.publishFleet([]); // removals queued
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  h.set({ mqttEnabled: true });
  h.publisher.applySettings();
  h.client.connected = true;
  const mark = h.calls.publishes.length;
  h.fire("connect");
  assert.deepEqual(clears(h, mark), []);
});

test("at most MAX_PENDING_DISCOVERY_REMOVALS discovery removals are kept", () => {
  const h = harness({ settings: DISCOVERY });
  h.ready();
  const fleet = [];
  for (let i = 0; i < 200; i++) fleet.push({ snapshot: { id: `u${i}`, name: `U${i}`, kind: "spark", online: true, uptime: 1 } });
  h.publisher.publishFleet(fleet);
  while (h.calls.pending.length) h.ack();
  const perUnit = configs(h).filter((c) => c.topic.includes("/sparkdash_u0/")).length;
  // Enough units that their removals overflow the cap.
  const units = Math.ceil(MAX_PENDING_DISCOVERY_REMOVALS / perUnit) + 5;
  const big = [];
  for (let i = 0; i < units; i++) big.push({ snapshot: { id: `v${i}`, name: `V${i}`, kind: "spark", online: true, uptime: 1 } });
  h.publisher.publishFleet(big); // also removes the 200 u* units (sent: connected)
  h.client.connected = false;
  h.publisher.publishFleet([]);
  h.client.connected = true;
  const mark = h.calls.publishes.length;
  h.fire("connect");
  // The flush stops at the in-flight cap; acks free room for the rest on later ticks.
  let sent = clears(h, mark).length;
  for (let tick = 0; tick < 100 && sent < MAX_PENDING_DISCOVERY_REMOVALS; tick++) {
    const m = h.calls.publishes.length;
    h.publisher.publishFleet([]);
    sent += clears(h, m).length;
  }
  assert.equal(sent, MAX_PENDING_DISCOVERY_REMOVALS);
  assert.ok(h.warnings.some((w) => w.includes("discovery removals awaiting the broker")));
});

// ─── Discovery cleanup: MQTT switched off, and reconciling after a restart ───

const ALPHA = { snapshot: { id: "alpha", name: "Alpha", kind: "spark", online: true, uptime: 1 } };

/** Model of the broker's retained discovery configs, from everything published. */
function retainedConfigs(publishes, start = new Map()) {
  const m = new Map(start);
  for (const { topic, payload } of publishes) {
    if (!topic.endsWith("/config")) continue;
    if (payload) m.set(topic, payload);
    else m.delete(topic);
  }
  return m;
}

/** MQTT topic filter match (`+` one level, `#` the rest). */
function matches(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/**
 * A stub client backed by retained messages: subscribe acks and then delivers
 * the matching retained ones, like a broker. `refuse` makes the SUBACK a failure.
 */
function brokerClient(retained, { refuse = false } = {}) {
  const subscribes = [];
  return {
    subscribes,
    overrides: {
      subscribe(filter, opts, cb) {
        subscribes.push(filter);
        if (refuse) return cb?.(null, [{ topic: filter, qos: 128 }]);
        cb?.(null, [{ topic: filter, qos: 0 }]);
        for (const [topic, payload] of retained) {
          if (matches(filter, topic)) this._handlers?.message?.(topic, Buffer.from(payload), { retain: true });
        }
      },
      unsubscribe() {},
    },
  };
}

/** Configs a previous process left at the broker for `fleet`. */
function leftBy(fleet, settings = DISCOVERY) {
  const h = harness({ settings });
  h.publisher.applySettings();
  h.publisher.publishFleet(fleet);
  return retainedConfigs(h.calls.publishes);
}

/** A fresh process (`settings`) connecting to a broker holding `retained`. */
function restart(retained, settings = DISCOVERY, opts = {}) {
  const broker = brokerClient(retained, opts);
  const h = harness({ settings, client: broker.overrides, publisher: { discoveryReadQuietMs: 0, discoveryReadMaxMs: 50 } });
  h.client._handlers = h.calls.handlers;
  h.publisher.applySettings();
  h.fire("connect");
  return { h, broker, retained: () => retainedConfigs(h.calls.publishes, retained) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("switching MQTT off empties the discovery configs before disconnecting", () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([ALPHA]);
  while (h.calls.pending.length) h.ack();
  const announced = [...retainedConfigs(h.calls.publishes).keys()];
  assert.ok(announced.length >= 3);
  const mark = h.calls.publishes.length;
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  assert.deepEqual(h.topics(mark).sort(), [...announced].sort());
  assert.ok(h.calls.publishes.slice(mark).every((p) => p.payload === "" && p.opts.retain && p.opts.qos === 1));
  // Held open until the broker acknowledges them all, then closed.
  assert.equal(h.calls.ended, 0);
  while (h.calls.pending.length) h.ack();
  assert.equal(h.calls.ended, 1);
  assert.equal(retainedConfigs(h.calls.publishes).size, 0);
});

test("switching MQTT off bypasses the in-flight cap for the removals", () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([ALPHA]);
  while (h.calls.pending.length) h.ack();
  const announced = retainedConfigs(h.calls.publishes).size;
  for (let i = 0; i < MAX_IN_FLIGHT; i += 1) h.publisher.publishEvent({ id: i });
  const mark = h.calls.publishes.length;
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  assert.equal(h.calls.publishes.slice(mark).filter((p) => p.payload === "").length, announced);
});

test("switching MQTT off gives up waiting for removal acks after its timeout", async () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false }, publisher: { retireTimeoutMs: 5 } });
  h.ready();
  h.publisher.publishFleet([ALPHA]);
  while (h.calls.pending.length) h.ack();
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 0);
  await settle();
  assert.equal(h.calls.ended, 1);
  assert.match(h.warnings.join("\n"), /discovery removals not acknowledged/);
});

test("switching MQTT off with discovery off disconnects at once", () => {
  const h = harness({ client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([ALPHA]);
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 1);
});

test("switching MQTT back on closes a connection still delivering removals first", () => {
  const h = harness({ settings: DISCOVERY, client: { autoAck: false } });
  h.ready();
  h.publisher.publishFleet([ALPHA]);
  while (h.calls.pending.length) h.ack();
  h.set({ mqttEnabled: false });
  h.publisher.applySettings();
  h.set({ mqttEnabled: true });
  h.publisher.applySettings();
  assert.equal(h.calls.ended, 1);
  assert.equal(h.attempts.length, 2);
});

test("after a restart, configs left for a deleted unit are emptied; the rest are kept", async () => {
  const beta = { snapshot: { id: "beta", name: "Beta", kind: "spark", online: true, uptime: 1 } };
  const before = leftBy([ALPHA, beta]);
  const { h, broker, retained } = restart(before);
  assert.deepEqual(broker.subscribes, ["homeassistant/+/+/+/config"]);
  await settle();
  h.publisher.publishFleet([ALPHA]); // beta was deleted while sparkDash was down
  const after = retained();
  assert.ok([...before.keys()].some((t) => t.includes("/sparkdash_beta/")));
  assert.ok(![...after.keys()].some((t) => t.includes("/sparkdash_beta/")), "beta's configs remain");
  assert.ok([...after.keys()].some((t) => t.includes("/sparkdash_alpha/")));
});

test("after a restart, an offline unit keeps the entities it had", async () => {
  const gpuAlpha = {
    snapshot: { ...ALPHA.snapshot, metrics: { gpu: { gpus: [{ index: 0, usage: 5, temperature: 40, power: { draw: 9 }, vram: { used: 1, total: 2 } }] } } },
  };
  const before = leftBy([gpuAlpha]);
  const { h, retained } = restart(before);
  await settle();
  h.publisher.publishFleet([{ id: "alpha", online: false }]);
  assert.deepEqual([...retained().keys()].sort(), [...before.keys()].sort());
  // And once it is back without its GPU, the GPU's entities go.
  h.publisher.publishFleet([ALPHA]);
  assert.ok(![...retained().keys()].some((t) => t.includes("gpu_0_")));
  assert.ok([...retained().keys()].some((t) => t.endsWith("sparkdash_alpha/online/config")));
});

test("the restart cleanup leaves other publishers' configs alone", async () => {
  const before = leftBy([ALPHA]);
  const other = leftBy([{ snapshot: { id: "gamma", name: "G", kind: "spark", online: true, uptime: 1 } }], { ...DISCOVERY, mqttTopicPrefix: "lab" });
  const zigbee = new Map([["homeassistant/sensor/0x00158d/temperature/config", JSON.stringify({ state_topic: "zigbee2mqtt/0x00158d" })]]);
  const gammaTopics = [...other.keys()].filter((t) => t.includes("sparkdash_gamma"));
  const { h, retained } = restart(new Map([...before, ...zigbee, ...gammaTopics.map((t) => [t, other.get(t)])]));
  await settle();
  h.publisher.publishFleet([ALPHA]);
  const after = retained();
  assert.ok(after.has("homeassistant/sensor/0x00158d/temperature/config"));
  for (const t of gammaTopics) assert.ok(after.has(t), `another dashboard's ${t} was removed`);
});

test("with discovery off, a restart empties discovery configs left behind", async () => {
  const before = leftBy([ALPHA]);
  const { h, broker, retained } = restart(before, { mqttDiscovery: false, mqttDiscoveryPrefix: "homeassistant" });
  await settle();
  assert.deepEqual(broker.subscribes, [
    "homeassistant/binary_sensor/sparkdash-dashboard/connected/config",
    "homeassistant/+/+/+/config",
  ]);
  h.publisher.publishFleet([ALPHA]);
  assert.equal(retained().size, 0);
});

test("with discovery off and nothing left behind, only the dashboard's config topic is read", async () => {
  const { broker } = restart(new Map(), { mqttDiscovery: false, mqttDiscoveryPrefix: "homeassistant" });
  await settle();
  assert.deepEqual(broker.subscribes, ["homeassistant/binary_sensor/sparkdash-dashboard/connected/config"]);
});

test("a refused discovery read removes nothing and says why", async () => {
  const before = leftBy([ALPHA]);
  const { h, retained } = restart(before, DISCOVERY, { refuse: true });
  await settle();
  h.publisher.publishFleet([]);
  // The deleted unit's configs stay (nothing was read), and the log says so.
  assert.ok([...retained().keys()].some((t) => t.includes("/sparkdash_alpha/")));
  assert.match(h.warnings.join("\n"), /could not read the broker's discovery configs/);
});
