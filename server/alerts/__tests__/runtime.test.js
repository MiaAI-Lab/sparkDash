/**
 * Runtime + REST surface: off means no evaluation and no writes; on means the
 * engine runs per snapshot; /api/alerts/* masks URLs and sends test messages.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createAlertsRuntime, registerAlertRoutes } from "../runtime.js";
import { clock, stubFetch, unit } from "./fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-alerts-runtime-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const quiet = { log() {}, warn() {}, error() {} };
let n = 0;
const freshFile = () => path.join(dir, `alerts-${++n}.json`);

test("disabled: no evaluation, no notification, no file written", () => {
  const file = freshFile();
  const fetch = stubFetch();
  const now = clock();
  const rt = createAlertsRuntime({ filePath: file, isEnabled: () => false, now, fetchImpl: fetch, log: quiet });
  let evaluated = 0;
  const original = rt.engine.evaluate.bind(rt.engine);
  rt.engine.evaluate = (...args) => (evaluated++, original(...args));
  rt.start();
  for (let i = 0; i < 5; i++) {
    rt.tick([unit({ online: false })]);
    now.advance(120_000);
  }
  assert.equal(evaluated, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(rt.snapshotBlock(), null, "no alerts key in the WS payload while off");
  assert.deepEqual(rt.status().active, []);
});

test("enabled: evaluates per snapshot, fires after `for`, persists, and switching off clears", async () => {
  const file = freshFile();
  const fetch = stubFetch();
  const now = clock();
  let on = true;
  const rt = createAlertsRuntime({ filePath: file, isEnabled: () => on, now, fetchImpl: fetch, log: quiet });
  rt.updateConfig({ channels: [{ name: "Hook", type: "webhook", url: "http://127.0.0.1:5699/hook" }] });
  rt.tick([unit({ online: false })]);
  assert.equal(rt.status().pending.length, 0, "ticks before start() are ignored (monitors not up yet)");
  rt.start();
  rt.tick([unit({ online: false })]);
  assert.equal(rt.status().pending.length, 1);
  now.advance(60_000);
  rt.tick([unit({ online: false })]);
  assert.equal(rt.snapshotBlock().active.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 1);
  assert.equal(JSON.parse(fetch.calls[0].body).alerts[0].rule, "unit_offline");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.state.firing.length, 1);

  // A restarted runtime resumes the firing alert with its original startsAt.
  const rt2 = createAlertsRuntime({ filePath: file, isEnabled: () => true, now, fetchImpl: fetch, log: quiet });
  rt2.start();
  now.advance(5_000);
  rt2.tick([unit({ online: false })]);
  assert.equal(rt2.status().active[0].startsAt, saved.state.firing[0].startsAt);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 1, "no duplicate notification after the restart");

  on = false;
  rt.tick([unit({ online: false })]);
  assert.equal(rt.snapshotBlock(), null);
  assert.deepEqual(rt.status().active, []);
});

async function serve(rt) {
  const app = express();
  app.use(express.json());
  registerAlertRoutes(app, rt);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("REST: config is masked, a masked PUT keeps the secret, validation is 400", async (t) => {
  const file = freshFile();
  const sent = stubFetch();
  const rt = createAlertsRuntime({ filePath: file, isEnabled: () => true, fetchImpl: sent, log: quiet });
  const api = await serve(rt);
  t.after(api.close);

  const secret = "https://ntfy.sh/very-secret-topic-ab12";
  let r = await api.call("PUT", "/api/alerts/config", {
    channels: [{ name: "Phone", type: "ntfy", url: secret }],
    rules: { disk_usage: { warningPct: 80 } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.channels[0].url, "https://ntfy.sh…ab12");
  assert.ok(!JSON.stringify(r.body).includes("very-secret"));
  assert.deepEqual(r.body.rules.find((x) => x.id === "disk_usage").overrides, { warningPct: 80 });

  r = await api.call("GET", "/api/alerts/config");
  const shown = r.body.channels[0];
  r = await api.call("PUT", "/api/alerts/config", { channels: [{ ...shown, minSeverity: "critical" }] });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.channels[0].url, secret, "masked value kept the stored URL");
  assert.equal(onDisk.channels[0].minSeverity, "critical");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  r = await api.call("PUT", "/api/alerts/config", { channels: [{ name: "x", type: "ntfy", url: "ftp://nope" }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /http/);

  // Test message to the stored channel: the server resolves the real URL.
  r = await api.call("POST", "/api/alerts/test", { channelId: shown.id });
  assert.deepEqual(r.body, { ok: true, status: 200 });
  assert.equal(sent.calls.at(-1).url, secret);
  assert.equal(sent.calls.at(-1).headers.Title, "sparkDash test notification");
  r = await api.call("POST", "/api/alerts/test", { channelId: shown.id });
  assert.equal(r.status, 429, "a second test right away is refused");

  // Draft (unsaved) channel.
  r = await api.call("POST", "/api/alerts/test", { channel: { name: "Draft", type: "slack", url: "http://127.0.0.1:5699/slack" } });
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(JSON.parse(sent.calls.at(-1).body)), ["text"]);

  r = await api.call("POST", "/api/alerts/test", { channelId: "missing" });
  assert.equal(r.status, 404);

  r = await api.call("GET", "/api/alerts");
  assert.deepEqual(Object.keys(r.body).sort(), ["active", "enabled", "pending", "recent"]);
});

test("REST: a failing channel reports the error instead of throwing", async (t) => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const rt = createAlertsRuntime({ filePath: freshFile(), isEnabled: () => true, fetchImpl: stubFetch(200, { throws: refused }), log: quiet });
  const api = await serve(rt);
  t.after(api.close);
  await api.call("PUT", "/api/alerts/config", { channels: [{ name: "Dead", type: "webhook", url: "http://127.0.0.1:1/x" }] });
  const id = (await api.call("GET", "/api/alerts/config")).body.channels[0].id;
  const r = await api.call("POST", "/api/alerts/test", { channelId: id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: false, error: "fetch failed (ECONNREFUSED)" });
  const status = (await api.call("GET", "/api/alerts/config")).body.channels[0].status;
  assert.equal(status.lastError, "fetch failed (ECONNREFUSED)");
});
