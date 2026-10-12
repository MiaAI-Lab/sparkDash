/**
 * The runtime: the opt-in gates everything outbound, the save-time policy
 * check, channel URLs in the secrets store (with migration), and one Activity
 * event per send that names no URL and quotes no response.
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../../events/EventLog.js";
import { ALERTS_OFF_MESSAGE, createAlertsRuntime, notificationEvent } from "../runtime.js";
import { POLICY_BLOCKED } from "../outbound.js";
import { LEAK, clock, hotUnit, quietLog, receiver, stubFetch, stubLookup, unit } from "./fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-alerts-runtime-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;

/** An in-memory stand-in for the encrypted store. */
function memorySecrets(initial = new Map()) {
  const store = { urls: new Map(initial), saves: 0 };
  store.load = () => new Map(store.urls);
  store.save = (urls) => {
    store.saves += 1;
    store.urls = new Map(urls);
  };
  return store;
}

function setup({ enabled = true, fetchImpl = stubFetch(200), lookup = stubLookup(["192.168.1.20"]), secrets = memorySecrets(), file } = {}) {
  const state = { enabled };
  const now = clock(1_800_000_000_000);
  const events = new EventLog({ now });
  const filePath = file ?? path.join(dir, `alerts-${++n}.json`);
  const rt = createAlertsRuntime({
    filePath,
    isEnabled: () => state.enabled,
    now,
    fetchImpl,
    lookup,
    log: quietLog,
    secrets,
    recordEvent: (e) => events.record(e),
  });
  rt.start();
  return { rt, state, now, events, filePath, secrets, fetchImpl };
}

const CHANNEL = { name: "Phone", type: "ntfy", url: "http://ntfy.lan/sparkdash-secret-topic", enabled: true, minSeverity: "warning" };
const settle = () => new Promise((r) => setTimeout(r, 20));

test("off: tick evaluates nothing, PUT and test answer 409, nothing is fetched or resolved", async () => {
  const lookup = stubLookup(["192.168.1.20"]);
  const { rt, fetchImpl, filePath } = setup({ enabled: false, lookup });
  rt.tick([unit({ online: false, offlineReason: "x" })]);
  assert.equal(rt.engine.pending().length, 0);
  assert.equal(rt.snapshotBlock(), null);
  await assert.rejects(rt.updateConfig({ channels: [CHANNEL] }), (err) => err.status === 409 && err.message === ALERTS_OFF_MESSAGE);
  await assert.rejects(rt.test({ channel: CHANNEL }), (err) => err.status === 409);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(lookup.asked, [], "no DNS either");
  assert.equal(fs.existsSync(filePath), false, "nothing written");
  assert.equal(rt.publicConfig().enabled, false, "reads still work");
});

test("on: a firing alert is sent once per channel and logged in Activity without the URL", async () => {
  const { rt, now, events, fetchImpl } = setup();
  await rt.updateConfig({ rules: { thermal: { forSec: 0 } }, channels: [CHANNEL] });
  rt.tick([hotUnit(91)]);
  await settle();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, CHANNEL.url);
  const [e] = events.list();
  assert.equal(e.type, "alert.notify.sent");
  assert.equal(e.sparkId, "spark-1");
  assert.match(e.message, /^Alert notification sent to "Phone" \(ntfy\): critical · spark-1 GPU is close to its shutdown temperature$/);
  assert.ok(!JSON.stringify(e).includes("secret-topic"));
  assert.deepEqual(rt.snapshotBlock().active.map((a) => a.key), ["spark-1:thermal"]);
  now.advance(1000);
});

test("a failed send is logged as alert.notify.failed with a status code only — no body, no URL", async (t) => {
  const rx = await receiver((_req, res) => {
    res.writeHead(403);
    res.end(`{"error":"bad token ${LEAK}"}`);
  });
  t.after(rx.close);
  const { rt, events } = setup({ fetchImpl: null, lookup: null });
  const url = `http://127.0.0.1:${rx.port}/hook/secret-path`;
  await rt.updateConfig({ rules: { offline: { forSec: 0 } }, channels: [{ ...CHANNEL, type: "webhook", url }] });
  rt.tick([unit({ online: false, offlineReason: "timeout" })]);
  for (let i = 0; i < 50 && events.list().length === 0; i++) await settle();
  assert.equal(rx.requests.length, 1);
  const [e] = events.list();
  assert.equal(e.type, "alert.notify.failed");
  assert.equal(e.severity, "error");
  assert.match(e.message, /failed: HTTP 403/);
  const pub = rt.publicConfig();
  assert.equal(pub.channels[0].status.lastError, "HTTP 403");
  const everything = JSON.stringify({ events: events.list(), pub, status: rt.status() });
  assert.ok(!everything.includes(LEAK), "no response body anywhere");
  assert.ok(!everything.includes("secret-path"), "no URL anywhere");
});

test("test send: the API result has a code or a fixed reason, never the body", async (t) => {
  const rx = await receiver((_req, res) => {
    res.writeHead(500);
    res.end(`stack trace ${LEAK}`);
  });
  t.after(rx.close);
  const { rt, events } = setup({ fetchImpl: null, lookup: null });
  const result = await rt.test({ channel: { ...CHANNEL, url: `http://127.0.0.1:${rx.port}/x` } });
  assert.deepEqual(result, { ok: false, error: "HTTP 500" });
  assert.equal(events.list()[0].type, "alert.notify.failed");
  assert.match(events.list()[0].message, /^Test notification to "Phone" \(ntfy\) failed: HTTP 500$/);
  assert.ok(!JSON.stringify(events.list()).includes(LEAK));
});

test("save-time policy: a hostname resolving to a forbidden address is refused; unresolvable is allowed (checked at send)", async () => {
  const { rt } = setup({ lookup: stubLookup(["169.254.169.254"]) });
  await assert.rejects(rt.updateConfig({ channels: [CHANNEL] }), (err) => err.status === 400 && err.message === `Phone: ${POLICY_BLOCKED}`);
  await assert.rejects(rt.updateConfig({ channels: [{ ...CHANNEL, url: "http://169.254.169.254/x" }] }), /not allowed/);

  const offline = setup({
    lookup: async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  await offline.rt.updateConfig({ channels: [CHANNEL] });
  assert.equal(offline.rt.publicConfig().channels.length, 1);
});

test("channel URLs go to the secrets store, alerts.json keeps the rest; GET masks", async () => {
  const { rt, secrets, filePath } = setup();
  const pub = await rt.updateConfig({ channels: [CHANNEL] });
  const id = pub.channels[0].id;
  assert.equal(secrets.urls.get(id), CHANNEL.url);
  const raw = fs.readFileSync(filePath, "utf8");
  assert.ok(!raw.includes("secret-topic"));
  assert.ok(!JSON.stringify(rt.publicConfig()).includes("secret-topic"));
  // Removing the channel removes its URL.
  await rt.updateConfig({ channels: [] });
  assert.equal(secrets.urls.size, 0);
});

test("a plaintext URL in an older alerts.json is moved into the secrets store on load", () => {
  const file = path.join(dir, "legacy-runtime.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, channels: [{ id: "ch_old", name: "Old", type: "ntfy", url: "https://ntfy.example.com/old-topic", enabled: true, minSeverity: "warning" }] }));
  const secrets = memorySecrets();
  const { rt } = setup({ file, secrets });
  assert.equal(secrets.urls.get("ch_old"), "https://ntfy.example.com/old-topic");
  assert.ok(!fs.readFileSync(file, "utf8").includes("old-topic"), "rewritten without the URL");
  assert.equal(rt.publicConfig().channels[0].hasUrl, true);
});

test("notificationEvent: one alert names it, a group counts it, reminders and tests say so", () => {
  const channel = { id: "c", name: "N".repeat(100), type: "discord" };
  const a = { unitId: "u", unitName: "U", severity: "warning", label: "storage is at or above 90%", ruleName: "Storage" };
  const one = notificationEvent({ channel, group: { firing: [a], resolved: [] }, ok: true, status: 204 });
  assert.match(one.message, /: warning · U storage is at or above 90%$/);
  assert.ok(one.message.includes(`"${"N".repeat(59)}…"`), "channel name capped");
  const two = notificationEvent({ channel, group: { firing: [a], resolved: [{ ...a, unitId: "v" }], reminder: true }, ok: false, reason: "HTTP 404" });
  assert.match(two.message, /^Alert reminder to .* failed: HTTP 404: 1 firing, 1 resolved$/);
  assert.equal(two.sparkId, null);
  assert.deepEqual(two.data, { channelId: "c", channelType: "discord", test: false, reminder: true, firing: 1, resolved: 1, reason: "HTTP 404" });
});
