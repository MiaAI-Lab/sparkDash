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
    /environment variable HOME_ASSISTANT_TOKEN is not set/
  );
  assert.throws(
    () => new HomeAssistantProvider({ type: "homeassistant", url: "https://ha.lan", tokenEnv: "X_TOKEN" }, { env: {} }),
    /X_TOKEN/
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
    { type: "homeassistant", url: `${ha.url}/`, tokenEnv: "HA" },
    { env: { HA: TOKEN }, logger: quietLogger }
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

  const wrong = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { HOME_ASSISTANT_TOKEN: "nope" } });
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
  const provider = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { HOME_ASSISTANT_TOKEN: TOKEN }, logger: quietLogger });
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
  const provider = new HomeAssistantProvider({ type: "homeassistant", url: ha.url }, { env: { HOME_ASSISTANT_TOKEN: "wrong" } });
  await assert.rejects(provider.readHistory(["sensor.x"], { fromMs: 0, toMs: 1, period: "hour" }), /rejected the token/);
});
