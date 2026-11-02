import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { HomeAssistantProvider, parseHomeAssistantState } from "../providers/HomeAssistantProvider.js";
import { PowerMeterProvider } from "../providers/PowerMeterProvider.js";

const TOKEN = "test-token-123";

/** A tiny fake Home Assistant: REST states plus the WebSocket statistics API. */
async function fakeHomeAssistant({ states = {}, metadata = [], statistics = {}, acceptToken = TOKEN } = {}) {
  const seen = { rest: [], ws: [] };
  const server = http.createServer((req, res) => {
    seen.rest.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${acceptToken}`) {
      res.writeHead(401).end();
      return;
    }
    const entity = decodeURIComponent(req.url.replace("/api/states/", ""));
    if (!(entity in states)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"message":"Entity not found."}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(states[entity]));
  });
  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.4" }));
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data));
      seen.ws.push(msg);
      if (msg.type === "auth") {
        socket.send(JSON.stringify({ type: msg.access_token === acceptToken ? "auth_ok" : "auth_invalid" }));
      } else if (msg.type === "recorder/get_statistics_metadata") {
        socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: metadata }));
      } else if (msg.type === "recorder/statistics_during_period") {
        socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: statistics }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    seen,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(resolve);
      }),
  };
}

const quietLogger = { warn() {}, log() {}, error() {} };

test("state parsing converts units, prefers last_reported and never invents zero", () => {
  const base = { last_reported: "2026-10-29T21:36:28.000Z", last_updated: "2026-10-29T21:30:00.000Z" };
  assert.deepEqual(parseHomeAssistantState({ ...base, state: "55.5", attributes: { unit_of_measurement: "W" } }), {
    watts: 55.5,
    atMs: Date.parse(base.last_reported),
  });
  assert.equal(parseHomeAssistantState({ ...base, state: "0.2", attributes: { unit_of_measurement: "kW" } }).watts, 200);
  assert.equal(parseHomeAssistantState({ ...base, state: "-0.4", attributes: { unit_of_measurement: "W" } }).watts, 0);
  for (const body of [
    { ...base, state: "unavailable", attributes: { unit_of_measurement: "W" } },
    { ...base, state: "unknown" },
    { ...base, state: "", attributes: { unit_of_measurement: "W" } },
    { ...base, state: "12", attributes: { unit_of_measurement: "kWh" } },
    { ...base, state: "-40", attributes: { unit_of_measurement: "W" } },
  ]) {
    const reading = parseHomeAssistantState(body);
    assert.equal(reading.watts, null, JSON.stringify(body));
    assert.ok(reading.error);
  }
  assert.equal(parseHomeAssistantState({ state: "5", last_updated: base.last_updated, attributes: { unit_of_measurement: "W" } }).atMs, Date.parse(base.last_updated));
});

test("the provider refuses to start without its token variable", () => {
  assert.throws(
    () => new HomeAssistantProvider({ type: "homeassistant", url: "https://ha.lan" }, { env: {} }),
    /environment variable SPARKDASH_HA_TOKEN is not set/
  );
});

test("readPower sends the bearer token and reports per-channel failures", async (t) => {
  const ha = await fakeHomeAssistant({
    states: {
      "sensor.outlet_3_power": { state: "57.2", last_reported: "2026-10-29T21:36:28Z", attributes: { unit_of_measurement: "W" } },
      "sensor.outlet_4_power": { state: "unavailable", last_reported: "2026-10-29T21:36:28Z", attributes: {} },
    },
  });
  t.after(ha.close);
  const provider = new HomeAssistantProvider(
    { type: "homeassistant", url: `${ha.url}/` },
    { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger }
  );
  assert.ok(provider instanceof PowerMeterProvider);
  assert.deepEqual(provider.describe(), { type: "homeassistant", target: ha.url });
  assert.equal(provider.supportsHistory, true);
  assert.doesNotMatch(JSON.stringify(provider), new RegExp(TOKEN));
  const readings = await provider.readPower(["sensor.outlet_3_power", "sensor.outlet_4_power", "sensor.gone"]);
  assert.equal(readings.get("sensor.outlet_3_power").watts, 57.2);
  assert.deepEqual(readings.get("sensor.outlet_4_power"), { watts: null, atMs: Date.parse("2026-10-29T21:36:28Z"), error: "entity is unavailable" });
  assert.equal(readings.get("sensor.gone").error, "entity not found");
  assert.ok(ha.seen.rest.every((r) => r.auth === `Bearer ${TOKEN}`));

  const wrong = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { SPARKDASH_HA_TOKEN: "nope" } });
  const rejected = await wrong.readPower(["sensor.outlet_3_power"]);
  assert.match(rejected.get("sensor.outlet_3_power").error, /rejected the token \(HTTP 401\)/);
});

test("readHistory authenticates over WebSocket and returns watt periods per channel", async (t) => {
  const start = Date.parse("2026-10-29T20:00:00Z");
  const ha = await fakeHomeAssistant({
    metadata: [
      { statistic_id: "sensor.outlet_3_power", has_mean: true, mean_type: 1, statistics_unit_of_measurement: "W", unit_class: "power" },
      { statistic_id: "sensor.outlet_energy", has_mean: false, mean_type: 0, statistics_unit_of_measurement: "kWh", unit_class: "energy" },
    ],
    statistics: {
      "sensor.outlet_3_power": [
        { start, end: start + 300_000, mean: 56.8, max: 64.5 },
        { start: new Date(start + 300_000).toISOString(), end: new Date(start + 600_000).toISOString(), mean: 57.1, max: 60 },
        { start: start + 600_000, end: start + 900_000, mean: null, max: null },
      ],
    },
  });
  t.after(ha.close);
  const provider = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger });
  const history = await provider.readHistory(["sensor.outlet_3_power", "sensor.outlet_energy", "sensor.unknown"], {
    fromMs: start,
    toMs: start + 3_600_000,
    period: "5minute",
  });
  assert.deepEqual(history.get("sensor.outlet_3_power"), [
    { startMs: start, endMs: start + 300_000, meanW: 56.8, maxW: 64.5 },
    { startMs: start + 300_000, endMs: start + 600_000, meanW: 57.1, maxW: 60 },
  ]);
  assert.deepEqual(history.get("sensor.outlet_energy"), []);
  assert.deepEqual(history.get("sensor.unknown"), []);
  const request = ha.seen.ws.find((m) => m.type === "recorder/statistics_during_period");
  assert.equal(request.period, "5minute");
  assert.deepEqual(request.units, { power: "W" });
  assert.equal(request.start_time, new Date(start).toISOString());
  await assert.rejects(provider.readHistory(["sensor.outlet_3_power"], { fromMs: start, toMs: start + 1, period: "week" }), /unsupported/);
});

test("readHistory rejects a token Home Assistant does not accept", async (t) => {
  const ha = await fakeHomeAssistant();
  t.after(ha.close);
  const provider = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { SPARKDASH_HA_TOKEN: "wrong" } });
  await assert.rejects(provider.readHistory(["sensor.x"], { fromMs: 0, toMs: 1, period: "hour" }), /rejected the token/);
});

// ─── Outbound policy and size caps ──────────────────────────────────────

test("the URL host must pass the outbound policy when the config loads", () => {
  const problems = (url) => HomeAssistantProvider.validate({ type: "homeassistant", url });
  for (const url of ["https://169.254.169.254", "http://[fe80::1]:8123", "http://0.0.0.0:8123", "http://224.0.0.1"]) {
    assert.match(problems(url).join(" "), /outbound policy/, url);
  }
  for (const url of ["https://ha.lan", "http://192.168.1.10:8123", "http://homeassistant.local:8123", "http://127.0.0.1:8123", "http://100.64.0.7:8123"]) {
    assert.deepEqual(problems(url), [], url);
  }
});

test("every poll and history session resolves through the policy and connects only to the checked address", async (t) => {
  const ha = await fakeHomeAssistant({
    states: { "sensor.p3": { state: "61", attributes: { unit_of_measurement: "W" }, last_reported: new Date().toISOString() } },
    metadata: [{ statistic_id: "sensor.p3", has_mean: true, unit_class: "power", statistics_unit_of_measurement: "W" }],
    statistics: { "sensor.p3": [{ start: 0, end: 300_000, mean: 61, max: 70 }] },
  });
  t.after(ha.close);
  const lookups = [];
  // A name no real resolver knows: the request only works if it uses the checked address.
  const url = ha.url.replace("127.0.0.1", "ha.test");
  const provider = new HomeAssistantProvider(
    { type: "homeassistant", url },
    { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger, lookup: async (host) => (lookups.push(host), [{ address: "127.0.0.1", family: 4 }]) }
  );
  assert.equal((await provider.readPower(["sensor.p3"])).get("sensor.p3").watts, 61);
  const history = await provider.readHistory(["sensor.p3"], { fromMs: 0, toMs: 600_000, period: "5minute" });
  assert.equal(history.get("sensor.p3")[0].meanW, 61);
  assert.deepEqual(lookups, ["ha.test", "ha.test"], "resolved once per poll and once per session");
});

test("a host that resolves to a forbidden address is refused before anything is sent", async (t) => {
  const ha = await fakeHomeAssistant({ states: { "sensor.p3": { state: "61", attributes: { unit_of_measurement: "W" } } } });
  t.after(ha.close);
  const provider = new HomeAssistantProvider(
    { type: "homeassistant", url: ha.url.replace("127.0.0.1", "ha.test") },
    { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger, lookup: async () => [{ address: "169.254.169.254", family: 4 }] }
  );
  await assert.rejects(provider.readPower(["sensor.p3"]), /ha\.test resolves to an address the outbound policy does not allow/);
  await assert.rejects(provider.readHistory(["sensor.p3"], { fromMs: 0, toMs: 600_000, period: "hour" }), /outbound policy/);
  assert.deepEqual([ha.seen.rest.length, ha.seen.ws.length], [0, 0]);
  const unresolvable = new HomeAssistantProvider(
    { type: "homeassistant", url: "https://ha.test" },
    { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger, lookup: async () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOTFOUND" })) }
  );
  await assert.rejects(unresolvable.readPower(["sensor.p3"]), /could not resolve ha\.test/);
});

test("responses are size-capped: a state body and a WebSocket message", async (t) => {
  const ha = await fakeHomeAssistant({
    states: { "sensor.big": { state: "61", attributes: { unit_of_measurement: "W", junk: "x".repeat(100_000) } } },
    metadata: [{ statistic_id: "sensor.p3", has_mean: true, unit_class: "power", statistics_unit_of_measurement: "W" }],
    statistics: { "sensor.p3": Array.from({ length: 200 }, (_, i) => ({ start: i * 300_000, end: (i + 1) * 300_000, mean: 61, max: 70 })) },
  });
  t.after(ha.close);
  const provider = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger });
  assert.match((await provider.readPower(["sensor.big"])).get("sensor.big").error, /Home Assistant response exceeded the size cap/);
  const small = new HomeAssistantProvider(
    { type: "homeassistant", url: ha.url },
    { env: { SPARKDASH_HA_TOKEN: TOKEN }, logger: quietLogger, maxMessageBytes: 4096 }
  );
  await assert.rejects(small.readHistory(["sensor.p3"], { fromMs: 0, toMs: 60 * 300_000, period: "5minute" }), /over the size cap/);
  // The default cap takes the same answer.
  const ok = await provider.readHistory(["sensor.p3"], { fromMs: 0, toMs: 200 * 300_000, period: "5minute" });
  assert.equal(ok.get("sensor.p3").length, 200);
});
