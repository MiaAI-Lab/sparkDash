import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";
import { DelegationDesk, deskBaseUrl } from "../delegationDesk.js";

const DASHBOARD_TOKEN = "dashboard-test-token";
const ADMIN_TOKEN = "desk-admin-secret-7f3a";
const AUTH = { Authorization: `Bearer ${DASHBOARD_TOKEN}` };

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const reservation = createServer();
  const port = await listening(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function status(extra = {}) {
  return {
    version: "abc123",
    roster_error: null,
    routes: [
      {
        key: "deepseek-qualitycorp", provider: "Pi", model: "qualitycorp-oq/DeepSeek", budget: 2, roster_budget: 2, load: 1,
        live: [{ id: "t1", title: "[c4 test] a task", host: "zeppola", source: "t3:~/.t3" }],
        signal: { kind: "saturation", unit: "qualitycorp", age: 4, state: "room", detail: "waiting 0, KV cache n/a", running: 0 },
      },
    ],
    hosts: { zeppola: { age: 5, state: "fresh", errors: {}, quota_errors: {} } },
    claims: [], waiting: [], overrides: {},
    ...extra,
  };
}

/** A fake desk: records each request and answers from `mode`. */
function fakeDesk() {
  const desk = { requests: [], mode: "ok", statusBody: status() };
  desk.server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      desk.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (desk.mode === "hang") return; // never answers
      const send = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && req.url === "/v1/status") return send(200, desk.statusBody);
      if (desk.mode === "unauthorized") return send(401, { error: "unauthorized" });
      if (desk.mode === "locked") return send(400, { error: "the override is held by an open PR; the stepper is locked" });
      if (desk.mode === "gh-failed") return send(502, { error: "gh api failed: HTTP 403" });
      if (desk.mode === "conflict") return send(409, { error: "a PR is already open for this override" });
      if (desk.mode === "echo") return send(400, { error: `bad request with ${req.headers.authorization}` });
      const match = /^\/v1\/overrides\/([^/]+)(\/permanent)?$/.exec(req.url);
      if (!match) return send(404, { error: "unknown endpoint" });
      if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return send(401, { error: "unauthorized" });
      if (req.method === "PUT") {
        const { budget } = JSON.parse(body);
        return send(200, { override: { budget, roster: 2, expires_at: 1_900_000_000, pr: null, set_at: 1_899_985_600 } });
      }
      if (req.method === "DELETE") return send(200, { removed: true });
      if (req.method === "POST" && match[2]) {
        return send(200, {
          override: { budget: 3, roster: 2, expires_at: null, pr: { number: 731, url: "https://github.com/o/r/pull/731", state: "open" }, set_at: 1 },
          pr: { number: 731, url: "https://github.com/o/r/pull/731" },
        });
      }
      return send(404, { error: "unknown endpoint" });
    });
  });
  return desk;
}

async function startDashboard(t, env) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-desk-"));
  const sparksPath = path.join(tmp, "sparks.json");
  await writeFile(sparksPath, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env, ...isolatedConfigEnv(tmp), PORT: String(port), BIND_HOST: "0.0.0.0",
      SPARKS_JSON_PATH: sparksPath, SPARKDASH_TOKEN: DASHBOARD_TOKEN, ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(tmp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated dashboard did not start")), 10000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`isolated dashboard exited before startup\n${output}`)); });
    child.stdout.on("data", (data) => {
      if (String(data).includes("server listening")) { clearTimeout(timer); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = (pathname, init = {}) => fetch(`${base}${pathname}`, {
    ...init, headers: { ...AUTH, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  return { call, logs: () => output };
}

async function enablePanel(call) {
  const response = await call("/api/settings", { method: "PUT", body: JSON.stringify({ showDelegationDesk: true }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).showDelegationDesk, true);
}

test("deskBaseUrl accepts plain http(s) and refuses credentials, queries and other schemes", () => {
  assert.equal(deskBaseUrl("https://desk.example.ts.net:8791/"), "https://desk.example.ts.net:8791");
  assert.equal(deskBaseUrl(" http://127.0.0.1:8791 "), "http://127.0.0.1:8791");
  for (const bad of ["", "ftp://desk", "https://user:pw@desk", "https://desk/?token=x", "https://desk/#x", "not a url"]) {
    assert.equal(deskBaseUrl(bad), null, bad);
  }
});

test("a desk that hangs is cut off at the read timeout", async (t) => {
  const desk = fakeDesk();
  desk.mode = "hang";
  const port = await listening(desk.server);
  t.after(() => { desk.server.closeAllConnections(); desk.server.close(); });
  const client = new DelegationDesk({ url: `http://127.0.0.1:${port}`, token: "", statusTimeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(client.status(), (err) => err.status === 503 && /timed out/.test(err.message));
  assert.ok(Date.now() - started < 2000);
});

test("a write the desk never answers is a 504 that says the change may have applied", async (t) => {
  const desk = fakeDesk();
  desk.mode = "hang";
  const port = await listening(desk.server);
  t.after(() => { desk.server.closeAllConnections(); desk.server.close(); });
  const client = new DelegationDesk({ url: `http://127.0.0.1:${port}`, token: ADMIN_TOKEN, writeTimeoutMs: 200 });
  await assert.rejects(client.setOverride("deepseek-qualitycorp", 3), (err) => err.status === 504 && /may or may not have applied/.test(err.message));
  const closed = await freePort();
  const refused = new DelegationDesk({ url: `http://127.0.0.1:${closed}`, token: ADMIN_TOKEN });
  await assert.rejects(refused.setOverride("deepseek-qualitycorp", 3), (err) => err.status === 503 && /connection refused/.test(err.message));
});

test("a read that started before an acknowledged write never answers a read made after it", async () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const pending = [];
  let reads = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") {
      reads += 1;
      const budget = reads === 1 ? 2 : 3;
      return new Promise((resolve) => pending.push(() => resolve(json(status({ routes: [{ ...status().routes[0], budget }] })))));
    }
    return json({ override: { budget: 3, roster: 2, expires_at: 1, pr: null, set_at: 0 } });
  };
  const client = new DelegationDesk({ url: "http://127.0.0.1:1", token: ADMIN_TOKEN, fetchImpl });
  const before = client.status();
  await client.setOverride("deepseek-qualitycorp", 3);
  const after = client.status();
  assert.equal(reads, 2, "the read after the write goes back to the desk");
  // The post-write read lands first; the pre-write one resolving later must not overwrite the cache.
  pending[1]();
  assert.equal((await after).routes[0].budget, 3);
  pending[0]();
  assert.equal((await before).routes[0].budget, 2);
  assert.equal((await after).routes[0].budget, 3);
  assert.equal((await client.status()).routes[0].budget, 3, "the pre-write answer was not cached");
});

test("delegation desk routes: toggle, read pass-through, token-guarded writes", { timeout: 60000 }, async (t) => {
  const desk = fakeDesk();
  const deskPort = await listening(desk.server);
  t.after(() => { desk.server.closeAllConnections(); desk.server.close(); });
  const { call, logs } = await startDashboard(t, {
    DELEGATION_DESK_URL: `http://127.0.0.1:${deskPort}`, DELEGATION_DESK_TOKEN: ADMIN_TOKEN,
  });

  // Off by default: the route refuses and the desk is never contacted.
  const settings = await (await call("/api/settings")).json();
  assert.equal(settings.showDelegationDesk, false);
  assert.equal((await call("/api/delegation-desk")).status, 404);
  assert.equal((await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: '{"budget":3}' })).status, 404);
  assert.equal(desk.requests.length, 0);

  await enablePanel(call);

  // Dashboard auth still applies to the proxy.
  const unauthenticated = await call("/api/delegation-desk", { headers: { Authorization: "Bearer wrong" } });
  assert.equal(unauthenticated.status, 401);

  const read = await call("/api/delegation-desk");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const body = await read.json();
  assert.equal(body.canEdit, true);
  assert.equal(body.routes[0].key, "deepseek-qualitycorp");
  assert.equal(body.routes[0].signal.detail, "waiting 0, KV cache n/a");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(ADMIN_TOKEN));
  assert.equal(desk.requests.at(-1).authorization, undefined, "reads carry no admin token");

  // Cached for a few seconds: a second read does not hit the desk.
  const before = desk.requests.length;
  await call("/api/delegation-desk");
  assert.equal(desk.requests.length, before);

  // Writes forward the admin token, never the dashboard token, and never echo it.
  const put = await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 3 }) });
  assert.equal(put.status, 200);
  const putText = await put.text();
  assert.equal(JSON.parse(putText).override.budget, 3);
  assert.doesNotMatch(putText, new RegExp(ADMIN_TOKEN));
  const forwarded = desk.requests.at(-1);
  assert.equal(forwarded.method, "PUT");
  assert.equal(forwarded.url, "/v1/overrides/deepseek-qualitycorp");
  assert.equal(forwarded.authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.deepEqual(JSON.parse(forwarded.body), { budget: 3 });

  // A write drops the cached status, so the next read is fresh.
  const reads = desk.requests.filter((r) => r.method === "GET").length;
  await call("/api/delegation-desk");
  assert.equal(desk.requests.filter((r) => r.method === "GET").length, reads + 1);

  const removed = await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal(desk.requests.at(-1).method, "DELETE");

  const permanent = await call("/api/delegation-desk/overrides/deepseek-qualitycorp/permanent", { method: "POST", body: "{}" });
  assert.equal(permanent.status, 200);
  assert.equal((await permanent.json()).pr.number, 731);
  assert.equal(desk.requests.at(-1).url, "/v1/overrides/deepseek-qualitycorp/permanent");

  // Bad input is refused here, before the desk sees it.
  const sent = desk.requests.length;
  assert.equal((await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 1.5 }) })).status, 400);
  assert.equal((await call("/api/delegation-desk/overrides/..%2Fstatus", { method: "DELETE" })).status, 400);
  assert.equal(desk.requests.length, sent);

  // A desk 401 is an error, not success, and is not the dashboard's own 401.
  desk.mode = "unauthorized";
  const refused = await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 3 }) });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /refused sparkDash's admin token/);

  // The desk's own refusals keep their status and reason.
  desk.mode = "conflict";
  const conflict = await call("/api/delegation-desk/overrides/deepseek-qualitycorp/permanent", { method: "POST", body: "{}" });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /already open/);

  // A desk that echoes the request's Authorization header still never hands the token on.
  desk.mode = "echo";
  const echoed = await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 3 }) });
  assert.equal(echoed.status, 400);
  const echoedText = await echoed.text();
  assert.doesNotMatch(echoedText, new RegExp(ADMIN_TOKEN));
  assert.match(echoedText, /\[redacted\]/);

  desk.mode = "locked";
  const locked = await call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 4 }) });
  assert.equal(locked.status, 400);
  assert.match((await locked.json()).error, /stepper is locked/);

  assert.doesNotMatch(logs(), new RegExp(ADMIN_TOKEN));
});

test("without a token the panel is read-only, writes answer 503, and the rate limit answers 429", { timeout: 60000 }, async (t) => {
  const desk = fakeDesk();
  const deskPort = await listening(desk.server);
  t.after(() => { desk.server.closeAllConnections(); desk.server.close(); });
  const { call } = await startDashboard(t, { DELEGATION_DESK_URL: `http://127.0.0.1:${deskPort}`, DELEGATION_DESK_TOKEN: "" });
  await enablePanel(call);

  const body = await (await call("/api/delegation-desk")).json();
  assert.equal(body.canEdit, false);

  const write = () => call("/api/delegation-desk/overrides/deepseek-qualitycorp", { method: "PUT", body: JSON.stringify({ budget: 3 }) });
  const first = await write();
  assert.equal(first.status, 503);
  assert.match((await first.json()).error, /budget changes not configured/i);
  assert.equal(desk.requests.filter((r) => r.method !== "GET").length, 0);

  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await write()).status);
  assert.equal(statuses.at(-1), 429);
});

test("an unreachable desk answers 503 with a reason, not an empty object", { timeout: 60000 }, async (t) => {
  const closed = await freePort();
  const { call } = await startDashboard(t, { DELEGATION_DESK_URL: `http://127.0.0.1:${closed}`, DELEGATION_DESK_TOKEN: ADMIN_TOKEN });
  await enablePanel(call);
  const response = await call("/api/delegation-desk");
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /Can't reach the delegation desk/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(`${ADMIN_TOKEN}|127\\.0\\.0\\.1|${closed}`));
});
