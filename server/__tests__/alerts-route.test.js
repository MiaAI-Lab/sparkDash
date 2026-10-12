/**
 * /api/alerts end to end on an isolated server: the opt-in gates the config
 * and test routes, a test send to a local receiver reports a status code (never
 * the body), redirects fail, the outbound policy refuses metadata addresses,
 * the URL is in neither alerts.json nor the API, and the send is in Activity.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

const LEAK = "sk-live-LEAKED-0123456789abcdef";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function receiver(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(req.url);
      respond(req, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) };
}

test("alert routes: opt-in gate, no bodies, no redirects, policy, secrets, Activity", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-alerts-route-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...env, BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 5_000)),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };

  const failing = await receiver((_req, res) => {
    res.writeHead(500);
    res.end(`boom ${LEAK}`);
  });
  t.after(failing.close);
  const redirecting = await receiver((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${failing.port}/followed` });
    res.end(LEAK);
  });
  t.after(redirecting.close);
  const channel = { name: "Local", type: "webhook", url: `http://127.0.0.1:${failing.port}/secret-path`, enabled: true, minSeverity: "warning" };

  // Off by default: reads work, writes and sends are refused.
  assert.equal(JSON.parse((await call("GET", "/api/alerts/config")).text).enabled, false);
  assert.equal((await call("PUT", "/api/alerts/config", { channels: [channel] })).status, 409);
  assert.equal((await call("POST", "/api/alerts/test", { channel })).status, 409);
  assert.equal(failing.requests.length, 0);

  assert.equal((await call("PUT", "/api/settings", { alertsEnabled: true })).status, 200);

  // The outbound policy: a metadata address is refused at save.
  const bad = await call("PUT", "/api/alerts/config", { channels: [{ ...channel, url: "http://169.254.169.254/latest" }] });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /not allowed/);

  // Loopback is allowed (validate.js allows it for units too).
  const saved = await call("PUT", "/api/alerts/config", { channels: [channel] });
  assert.equal(saved.status, 200, saved.text);
  const cfg = JSON.parse(saved.text);
  assert.ok(!saved.text.includes("secret-path"), "URL masked in the API");
  const id = cfg.channels[0].id;
  assert.ok(!fs.readFileSync(env.ALERTS_JSON_PATH, "utf8").includes("secret-path"), "no URL in alerts.json");
  assert.ok(!fs.readFileSync(env.SPARKS_SECRETS_PATH, "utf8").includes("secret-path"), "encrypted in the secrets store");

  // A test send: status code only.
  const sent = await call("POST", "/api/alerts/test", { channelId: id });
  assert.equal(sent.status, 200);
  assert.deepEqual(JSON.parse(sent.text), { ok: false, error: "HTTP 500" });
  assert.deepEqual(failing.requests, ["/secret-path"]);

  // A redirect is not followed.
  await new Promise((r) => setTimeout(r, 2_100)); // per-channel test cooldown
  const redirected = await call("POST", "/api/alerts/test", { channel: { ...channel, url: `http://127.0.0.1:${redirecting.port}/r` } });
  assert.deepEqual(JSON.parse(redirected.text), { ok: false, error: "redirect not followed (HTTP 302)" });
  assert.equal(failing.requests.includes("/followed"), false);

  const cfgAfter = (await call("GET", "/api/alerts/config")).text;
  const events = (await call("GET", "/api/events?limit=20")).text;
  const parsed = JSON.parse(events).events.filter((e) => e.type.startsWith("alert.notify."));
  assert.equal(parsed.length, 2);
  assert.match(parsed[1].message, /^Test notification to "Local" \(webhook\) failed: HTTP 500$/);
  for (const text of [sent.text, redirected.text, cfgAfter, events]) {
    assert.ok(!text.includes(LEAK), "no response body leaks");
    assert.ok(!text.includes("secret-path"), "no URL leaks");
  }
});
