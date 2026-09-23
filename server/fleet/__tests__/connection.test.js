// Tests for server/fleet/connection.js — run with `node --test`.
//
// fetch is stubbed via the `opts.fetch` injection point (equivalent to
// stubbing globalThis.fetch; resolved at call time in the implementation).
// Snapshots are minimal NodeAgentSnapshot-shaped objects (seam:
// shared/types.ts / shared/api.schema.json).

import test from "node:test";
import assert from "node:assert/strict";

import { createFleetConnection } from "../connection.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot(nodeId, v = 1) {
  return {
    nodeId,
    nodeName: nodeId,
    lanIp: "192.168.50.226",
    agentVersion: "0.1.0",
    online: true,
    uptimeSeconds: 100,
    gpu: null,
    cpu: null,
    mem: null,
    disk: [],
    net: [],
    containers: [],
    versions: [],
    services: [],
    memory: null,
    requests: null,
    topology: null,
    polledAt: 1_000_000 + v,
  };
}

/** Deterministic distinct LAN octet per id (100–249). */
function octetFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 250;
  return 100 + h;
}

function node(id, over = {}) {
  const octet = octetFor(id);
  return {
    id,
    name: id,
    endpoint: `192.168.50.${octet}:30091`,
    lanIp: `192.168.50.${octet}`,
    role: "standalone",
    rank: null,
    groupId: null,
    headId: null,
    links: [],
    agentPort: 30091,
    isLocal: false,
    ...over,
  };
}

/**
 * Build a fake fetch with per-URL mutable handlers.
 * handlers: Record<url, ok|fail>, where:
 *   - object  → resolved Response-like { ok, status, json }
 *   - "throw" → rejects (network failure)
 *   - "hang"  → resolves only if aborted (used to prove the timeout wiring)
 * @returns {{fn: Function, calls: Array<{url: string, init?: object}>, set: (url: string, h: unknown) => void}}
 */
function fakeFetch(initial = {}) {
  /** @type {Record<string, unknown>} */
  const handlers = { ...initial };
  /** @type {Array<{url: string, init?: object}>} */
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const h = handlers[u];
    if (h === "throw") throw new Error(`ENETUNREACH ${u}`);
    if (h === "hang") {
      return new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(new Error("aborted"));
            return;
          }
          sig.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }
        // Otherwise it truly hangs — a hang with NO signal would deadlock
        // the poll cycle, so the very fact that "hang" tests complete is
        // itself proof the timeout signal was passed.
      });
    }
    if (typeof h === "object" && h !== null) return h;
    throw new TypeError(`unhandled url ${u}`);
  };
  return {
    fn,
    calls,
    set: (u, h) => {
      handlers[String(u)] = h;
    },
  };
}

/** Response-like with a given body. */
const okRes = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errRes = (status = 500) => ({
  ok: false,
  status,
  json: async () => ({ error: "boom" }),
});

function countFor(calls, url) {
  return calls.filter((c) => c.url === url).length;
}

// ─── createFleetConnection shape ────────────────────────────────────────────

test("createFleetConnection: 3 nodes → FleetConnection with documented surface", () => {
  const { fn } = fakeFetch();
  const conn = createFleetConnection([node("a"), node("b"), node("c")], {
    fetch: fn,
  });
  assert.equal(conn.nodes.length, 3);
  for (const key of [
    "start",
    "stop",
    "getSnapshot",
    "getAllSnapshots",
    "onSnapshot",
    "onStatus",
  ]) {
    assert.equal(typeof conn[key], "function", `conn.${key} is a function`);
  }
  // Defaults (ground truth, no waiting): pollIntervalMs 2000, timeoutMs 5000.
  assert.equal(conn.pollIntervalMs, 2000);
  assert.equal(conn.timeoutMs, 5000);
});

test("createFleetConnection: non-array nodes → TypeError (no crash later)", () => {
  assert.throws(
    () => createFleetConnection(null),
    /nodes must be an array/
  );
});

test("createFleetConnection: records without string ids are skipped, not fatal", () => {
  const { fn } = fakeFetch();
  const conn = createFleetConnection([{ name: "no-id" }, node("ok")], {
    fetch: fn,
  });
  assert.deepEqual(
    conn.nodes.map((n) => n.id),
    ["ok"]
  );
});

// ─── start / stop ───────────────────────────────────────────────────────────

test("start: poll loop begins — first poll lands immediately, interval ticks", async () => {
  const nodes = [node("a"), node("b")];
  const urls = nodes.map((n) => `http://${n.endpoint}/telemetry`);
  const { fn, calls, set } = fakeFetch(
    Object.fromEntries(urls.map((u) => [u, okRes(snapshot("x"))]))
  );
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  // First cycle ran during start().
  for (const u of urls) assert.ok(countFor(calls, u) >= 1, `polled ${u}`);
  // Interval is ticking.
  const before = calls.length;
  await sleep(160); // ~3 more ticks at 50ms
  assert.ok(calls.length > before, "poll loop keeps polling after start");
  await conn.stop();
  // Stop halts the loop.
  const afterStop = calls.length;
  await sleep(160);
  assert.equal(calls.length, afterStop, "no polls after stop");
  // No fetches to unexpected URLs.
  const unique = new Set(calls.map((c) => c.url));
  assert.deepEqual([...unique], urls);
  set; // (kept for symmetry with other tests)
});

test("start is idempotent: two start() calls → one poll loop", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  await conn.start(); // no second loop
  const afterFirst = calls.length;
  await sleep(160);
  const ticks = calls.length - afterFirst;
  // One loop at 50ms over 160ms ≈ 3 ticks; two stacked loops would be ≈ 6.
  assert.ok(ticks >= 2 && ticks <= 5, `single loop tick count was ${ticks}`);
  await conn.stop();
});

test("stop is idempotent: second stop() is a no-op (resolves, no error)", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  await conn.stop();
  const atStop = calls.length;
  await conn.stop(); // no-op
  await conn.stop(); // no-op again
  assert.equal(calls.length, atStop);
});

test("start after stop: a fresh loop is possible", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 40 });
  await conn.start();
  await conn.stop();
  const firstRun = calls.length;
  await conn.start();
  assert.ok(calls.length > firstRun, "polling resumed after restart");
  await conn.stop();
});

// ─── getSnapshot / getAllSnapshots ──────────────────────────────────────────

test("getSnapshot: successful poll → NodeAgentSnapshot cached by registry id", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const payload = snapshot("a");
  const { fn } = fakeFetch({ [url]: okRes(payload) });
  const conn = createFleetConnection(nodes, { fetch: fn });
  assert.equal(conn.getSnapshot("a"), null, "nothing cached before start");
  await conn.start();
  assert.deepEqual(conn.getSnapshot("a"), payload);
  assert.equal(conn.getSnapshot("ghost"), null);
  await conn.stop();
});

test("getAllSnapshots: 3 nodes → Record keyed by nodeId with 3 entries", async () => {
  const nodes = [node("a"), node("b"), node("c")];
  const init = {};
  for (const n of nodes) {
    init[`http://${n.endpoint}/telemetry`] = okRes(snapshot(n.id));
  }
  const { fn } = fakeFetch(init);
  const conn = createFleetConnection(nodes, { fetch: fn });
  await conn.start();
  const all = conn.getAllSnapshots();
  assert.deepEqual(Object.keys(all).sort(), ["a", "b", "c"]);
  assert.equal(all.a.nodeId, "a");
  assert.equal(all.b.nodeId, "b");
  assert.equal(all.c.nodeId, "c");
  // Fresh object per call — mutating the return value cannot corrupt cache.
  all.a = null;
  assert.notEqual(conn.getSnapshot("a"), null);
  await conn.stop();
});

// ─── onSnapshot / onStatus ──────────────────────────────────────────────────

test("onSnapshot: cb called with (nodeId, snapshot) on each successful poll", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  /** @type {Array<[string, object]>} */
  const events = [];
  conn.onSnapshot((nodeId, snap) => events.push([nodeId, snap]));
  await conn.start();
  await sleep(120);
  await conn.stop();
  assert.ok(events.length >= 2, `expected ≥2 snapshot events, got ${events.length}`);
  for (const [id, snap] of events) {
    assert.equal(id, "a");
    assert.equal(snap.nodeId, "a");
  }
  // Ground truth: one snapshot event per successful fetch (no failures here).
  assert.equal(events.length, countFor(calls, url));
});

test("onSnapshot: failed polls emit NOTHING for that node", async () => {
  const nodes = [node("a"), node("b")];
  const ua = `http://${nodes[0].endpoint}/telemetry`;
  const ub = `http://${nodes[1].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [ua]: "throw", [ub]: okRes(snapshot("b")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  const events = [];
  conn.onSnapshot((nodeId) => events.push(nodeId));
  await conn.start();
  await sleep(120);
  await conn.stop();
  assert.ok(events.every((id) => id === "b"), "only node b emitted snapshots");
  assert.equal(countFor(calls, ua) >= 2, true, "a kept being polled despite failure");
});

test("onStatus: online→offline transition emits (nodeId, 'offline'); first success emits 'online'", async () => {
  const nodes = [node("a"), node("b")];
  const ua = `http://${nodes[0].endpoint}/telemetry`;
  const ub = `http://${nodes[1].endpoint}/telemetry`;
  const { fn, set } = fakeFetch({ [ua]: okRes(snapshot("a")), [ub]: "throw" });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  /** @type {Array<[string, string]>} */
  const events = [];
  conn.onStatus((nodeId, status) => events.push([nodeId, status]));

  await conn.start();
  await sleep(60);
  // Ground truth: a went unknown→online (one event); b went unknown→offline
  // (one event). Transitions, not per-poll spam.
  assert.deepEqual(
    events.slice(0, 2).sort(),
    [
      ["a", "online"],
      ["b", "offline"],
    ],
    `initial status events were ${JSON.stringify(events)}`
  );
  assert.ok(!events.some(([, s]) => s !== "online" && s !== "offline"));

  // Now a dies: online → offline exactly once per transition.
  set(ua, "throw");
  const before = events.length;
  await sleep(120); // several cycles of failure — must NOT re-emit
  await conn.stop();
  const transitions = events.slice(before);
  assert.deepEqual(transitions, [["a", "offline"]], "one transition event, not per-poll");
  assert.equal(conn.isOnline("a"), false);
  assert.equal(conn.isOnline("b"), false);
});

// ─── Graceful degradation ───────────────────────────────────────────────────

test("graceful degradation: unreachable node keeps last snapshot, marked offline", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const first = snapshot("a", 1);
  const { fn, set } = fakeFetch({ [url]: okRes(first) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  assert.deepEqual(conn.getSnapshot("a"), first);
  assert.equal(conn.isOnline("a"), true);

  // Node dies.
  set(url, "throw");
  await sleep(120);
  await conn.stop();

  // Last snapshot is RETAINED, not wiped.
  assert.deepEqual(conn.getSnapshot("a"), first);
  assert.deepEqual(conn.getAllSnapshots().a, first);
  assert.equal(conn.isOnline("a"), false);
});

test("degradation: HTTP 500 response → offline, cache retained", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, set } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  set(url, errRes(500));
  await sleep(100);
  await conn.stop();
  assert.equal(conn.isOnline("a"), false);
  assert.ok(conn.getSnapshot("a"), "cache kept");
});

test("degradation: malformed JSON body → offline, no crash", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const bad = {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
  const { fn } = fakeFetch({ [url]: bad });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  const connEvents = [];
  conn.onStatus((id, s) => connEvents.push([id, s]));
  await conn.start(); // must not reject despite the bad body
  assert.equal(conn.isOnline("a"), false);
  assert.equal(conn.getSnapshot("a"), null, "never polled successfully → null");
  assert.deepEqual(connEvents, [["a", "offline"]]);
  await conn.stop();
});

test("degradation: non-object JSON body (array) → offline, no crash", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn } = fakeFetch({ [url]: { ok: true, status: 200, json: async () => [1, 2] } });
  const conn = createFleetConnection(nodes, { fetch: fn });
  await conn.start();
  assert.equal(conn.isOnline("a"), false);
  await conn.stop();
});

test("degradation: node with no endpoint/lanIp → skipped, marked offline, zero fetches", async () => {
  const nodes = [node("a"), node("ghost", { endpoint: "", lanIp: "" })];
  const ua = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [ua]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  await sleep(80);
  await conn.stop();
  // No fetches were ever attempted for the unresolvable node.
  assert.equal(calls.filter((c) => c.url !== ua).length, 0);
  assert.equal(conn.isOnline("ghost"), false);
  assert.equal(conn.getSnapshot("ghost"), null);
});

// ─── Knobs ──────────────────────────────────────────────────────────────────

test("knob pollIntervalMs is honored (non-default 50ms cadence)", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: okRes(snapshot("a")) });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50 });
  assert.equal(conn.pollIntervalMs, 50);
  await conn.start();
  const t0 = Date.now();
  await sleep(250); // ≈ 1 (initial) + 5 ticks expected
  await conn.stop();
  const n = countFor(calls, url);
  const dt = Date.now() - t0;
  // 250ms / 50ms ≈ 5 cycles; tolerate timer drift (min 3, max 7).
  assert.ok(n >= 3 && n <= 7, `expected 3–7 polls in ${dt}ms, got ${n}`);
});

test("knob timeoutMs is wired into fetch (hang aborts → offline)", async () => {
  const nodes = [node("a")];
  const url = `http://${nodes[0].endpoint}/telemetry`;
  const { fn, calls } = fakeFetch({ [url]: "hang" });
  const conn = createFleetConnection(nodes, { fetch: fn, pollIntervalMs: 50, timeoutMs: 50 });
  assert.equal(conn.timeoutMs, 50);
  const t0 = Date.now();
  await conn.start(); // would hang forever if no timeout signal reached fetch
  const dt = Date.now() - t0;
  await conn.stop();
  assert.ok(calls.length >= 1, "fetch was called");
  assert.equal(conn.isOnline("a"), false, "hung node marked offline");
  assert.ok(dt < 1000, `timeout bounded the poll (${dt}ms < 1000ms)`);
  // The signal must actually be an AbortSignal.
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "AbortSignal passed to fetch");
});

// ─── Empty fleet ────────────────────────────────────────────────────────────

test("empty node list: start/stop work, getAllSnapshots() == {}", async () => {
  const { fn, calls } = fakeFetch();
  const conn = createFleetConnection([], { fetch: fn, pollIntervalMs: 50 });
  await conn.start();
  await sleep(100);
  await conn.stop();
  assert.deepEqual(conn.getAllSnapshots(), {});
  assert.equal(calls.length, 0);
});
