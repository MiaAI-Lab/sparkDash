import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchHelper, parseHelperUrl, normalizeOccupancyPayload } from "../policy.js";
import { projectOccupancy } from "../projector.js";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const lookup = async () => [{ address: "127.0.0.1", family: 4 }];

test("helper URL rejects userinfo and non-http protocols before any connection", async () => {
  await assert.rejects(fetchHelper("http://user:secret@127.0.0.1/occupancy"), /userinfo/);
  await assert.rejects(fetchHelper("file:///etc/passwd"), /http or https/);
  assert.throws(() => parseHelperUrl("ftp://127.0.0.1/occupancy"), /http or https/);
});

test("forbidden DNS answers are rejected and a pinned connection ignores a later lookup", async () => {
  let fetches = 0;
  const server = await listen((_req, res) => {
    fetches += 1;
    res.end(JSON.stringify({ schemaVersion: 1, observedAt: 5, adapters: {}, rows: [] }));
  });
  const port = server.address().port;
  await assert.rejects(
    fetchHelper(`http://rebind.example:${port}/occupancy`, {
      allowlist: new Set(["rebind.example"]),
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    /forbidden address/
  );
  assert.equal(fetches, 0);

  const ok = await fetchHelper(`http://pinned.invalid:${port}/occupancy`, {
    allowlist: new Set(["pinned.invalid"]),
    lookup,
  });
  assert.equal(ok.rows.length, 0);
  assert.equal(fetches, 1);
  server.close();
});

test("redirects are not followed and oversized bodies fail", async () => {
  let evil = 0;
  const evilServer = await listen((_req, res) => {
    evil += 1;
    res.end("nope");
  });
  const server = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evilServer.address().port}/steal` });
    res.end();
  });
  await assert.rejects(
    fetchHelper(`http://pinned.invalid:${server.address().port}/occupancy`, {
      allowlist: new Set(["pinned.invalid"]),
      lookup,
    }),
    /redirects are not followed/
  );
  assert.equal(evil, 0);
  server.close();

  const huge = await listen((_req, res) => {
    res.end(JSON.stringify({ rows: "x".repeat(50_000) }));
  });
  await assert.rejects(
    fetchHelper(`http://pinned.invalid:${huge.address().port}/occupancy`, {
      allowlist: new Set(["pinned.invalid"]),
      lookup,
      maxBytes: 1000,
    }),
    /size cap/
  );
  huge.close();
  evilServer.close();
});

test("a helper 401 stays a helper error and is not a dashboard 401", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  try {
    await fetchHelper(`http://pinned.invalid:${server.address().port}/occupancy`, {
      allowlist: new Set(["pinned.invalid"]),
      lookup,
      token: "wrong",
    });
    assert.fail("expected the helper refusal to reject");
  } catch (err) {
    assert.equal(err.status, 502);
    assert.match(err.message, /Helper answered HTTP 401/);
  } finally {
    server.close();
  }
});

test("ACP metadata age never becomes generation and unmapped rows stay unassigned", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const helpers = [
    {
      id: "mac",
      enabled: true,
      routes: [{ harness: "opencode", sparkId: "mama", port: 8000, cwdPrefix: "/work/a" }],
    },
    {
      id: "other",
      enabled: true,
      routes: [{ harness: "hermes", sparkId: "mama", port: 8000 }],
    },
  ];
  const caches = new Map([
    [
      "mac",
      {
        observedAt: now,
        rows: [
          {
            harness: "opencode",
            sessionId: "same",
            title: "Mapped",
            cwd: "/work/a/app",
            updatedAt: "2026-10-12T11:59:00Z",
            activity: "generating",
            activityProvenance: "native",
            origin: { host: "mama", port: 8000 },
            originProvenance: "native",
          },
          {
            harness: "opencode",
            sessionId: "loose",
            title: "Unmapped",
            cwd: "/elsewhere",
            updatedAt: "2026-10-12T11:59:30Z",
            activity: "generating",
            activityProvenance: "native",
          },
        ],
        adapters: { opencode: { coverage: "supported", stale: false } },
      },
    ],
    [
      "other",
      {
        observedAt: now,
        rows: [
          {
            harness: "hermes",
            sessionId: "same",
            title: "Native",
            cwd: "",
            updatedAt: "2026-10-12T11:00:00Z",
            activity: "generating",
            activityProvenance: "native",
            origin: null,
            originProvenance: "none",
          },
        ],
        adapters: { hermes: { coverage: "supported", stale: false } },
      },
    ],
  ]);
  const projected = projectOccupancy({
    helpers,
    caches,
    sparks: [{ id: "mama", name: "mama", lanIp: "10.0.0.8", llmPorts: [8000] }],
    now,
    maxAgeMs: 12 * 60 * 60 * 1000,
  });
  const rows = projected.bySpark.mama["8000"];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.source === "opencode").badge, "unknown");
  assert.equal(rows.find((row) => row.source === "hermes").badge, "generating");
  assert.equal(projected.unmapped, 1);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows.some((row) => "cwd" in row), false);
});

test("a row with no timestamp is kept and age never turns it into generating", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const projected = projectOccupancy({
    helpers: [{ id: "mac", enabled: true, routes: [{ harness: "omp", sparkId: "mama", port: 8000 }] }],
    caches: new Map([
      [
        "mac",
        {
          observedAt: now,
          stale: true,
          rows: [
            { harness: "omp", sessionId: "old", cwd: "", updatedAt: "2026-10-01T00:00:00Z", activity: "unknown", activityProvenance: "none" },
            { harness: "omp", sessionId: "untimed", title: "Untimed", cwd: "", updatedAt: "", activity: "generating", activityProvenance: "native" },
          ],
          adapters: { omp: { coverage: "supported", stale: false } },
        },
      ],
    ]),
    sparks: [{ id: "mama", llmPorts: [8000] }],
    now,
    maxAgeMs: 60 * 60 * 1000,
  });
  const rows = projected.bySpark.mama["8000"];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "Untimed");
  assert.equal(rows[0].badge, "unknown");
  assert.equal(rows[0].stale, true);
});

test("two general routes leave the row unmapped and a native endpoint can match", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const row = {
    harness: "hermes",
    sessionId: "n",
    title: "Native",
    cwd: "",
    updatedAt: "2026-10-12T11:00:00Z",
    activity: "stalled",
    activityProvenance: "native",
    origin: { host: "10.0.0.8", port: 8000 },
    originProvenance: "native",
  };
  const ambiguous = projectOccupancy({
    helpers: [{
      id: "mac",
      enabled: true,
      routes: [
        { harness: "hermes", sparkId: "mama", port: 8000 },
        { harness: "hermes", sparkId: "other", port: 8000 },
      ],
    }],
    caches: new Map([["mac", { rows: [row], adapters: {} }]]),
    sparks: [],
    now,
    maxAgeMs: 12 * 60 * 60 * 1000,
  });
  assert.equal(ambiguous.unmapped, 1);

  const native = projectOccupancy({
    helpers: [{ id: "mac", enabled: true, routes: [] }],
    caches: new Map([["mac", { rows: [row], adapters: { hermes: { stale: false } } }]]),
    sparks: [{ id: "mama", name: "mama", lanIp: "10.0.0.8", llmPorts: [8000] }],
    now,
    maxAgeMs: 12 * 60 * 60 * 1000,
  });
  assert.equal(native.bySpark.mama["8000"][0].badge, "stalled");
  assert.equal(native.bySpark.mama["8000"][0].routingProvenance, "native-endpoint");
});

test("normalize strips ACP activity and unknown harnesses", () => {
  const payload = normalizeOccupancyPayload({
    schemaVersion: 1,
    observedAt: 4,
    adapters: { nope: { coverage: "supported" }, opencode: { coverage: "supported", stale: false, rows: 1 } },
    rows: [
      { harness: "nope", sessionId: "x", title: "drop" },
      { harness: "opencode", sessionId: "s", title: "T", activity: "generating", activityProvenance: "native", origin: { host: "h", port: 1 }, originProvenance: "native" },
    ],
  });
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].activity, "unknown");
  assert.equal(payload.rows[0].origin, null);
  assert.equal(payload.adapters.nope, undefined);
});

test("a helper dropping mid-body settles promptly and removes its abort listener", { timeout: 3000 }, async (t) => {
  const { getEventListeners } = await import("node:events");
  const server = await listen((_req, res) => {
    res.writeHead(200, { "content-length": "10000" });
    res.write('{"rows":[');
    setTimeout(() => res.destroy(), 10);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  let timer;
  try {
    const outcome = await Promise.race([
      fetchHelper(`http://127.0.0.1:${server.address().port}/occupancy`, { signal: controller.signal })
        .then(() => "success", () => "failed"),
      new Promise((resolve) => { timer = setTimeout(() => resolve("unsettled"), 1000); }),
    ]);
    assert.equal(outcome, "failed");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { clearTimeout(timer); controller.abort(); }
});

test("helper health requires the existing versioned occupancy envelope", async () => {
  const { createOccupancyHelper } = await import("../../../scripts/occupancy-helper/index.js");
  const helper = createOccupancyHelper({ adapters: ["omp"], commands: { omp: "" } });
  const valid = helper.payload(42);
  assert.equal(normalizeOccupancyPayload(valid).observedAt, 42);
  assert.equal(normalizeOccupancyPayload(valid).adapters.omp.coverage, "unavailable");
  for (const malformed of [
    {}, [], null, { error: "not occupancy" },
    { ...valid, schemaVersion: 2 }, { ...valid, schemaVersion: undefined },
    { ...valid, observedAt: null }, { ...valid, observedAt: "42" }, { ...valid, observedAt: Infinity },
    { ...valid, rows: {} }, { ...valid, rows: undefined },
    { ...valid, adapters: [] }, { ...valid, adapters: null },
    { ...valid, adapters: { omp: {} } },
    { ...valid, adapters: { omp: { coverage: "supported", stale: false, rows: -1 } } },
  ]) {
    assert.throws(() => normalizeOccupancyPayload(malformed), /occupancy/);
  }
});

test("trickled bodies have an absolute deadline, abort settles, and all requests detach listeners", { timeout: 3000 }, async (t) => {
  const { getEventListeners } = await import("node:events");
  let closed = 0;
  let resolveClosed;
  const bothClosed = new Promise((resolve) => { resolveClosed = resolve; });
  const server = await listen((req, res) => {
    if (req.url === "/good") {
      res.end(JSON.stringify({ schemaVersion: 1, observedAt: 1, adapters: {}, rows: [] }));
      return;
    }
    res.writeHead(200);
    res.write(" ");
    const timer = setInterval(() => res.write(" "), 5);
    res.once("close", () => {
      clearInterval(timer);
      if (++closed === 2) resolveClosed();
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ["deadline", "abort", "good"]) {
    const controller = new AbortController();
    const pending = fetchHelper(`${base}/${mode}`, { signal: controller.signal, timeoutMs: mode === "good" ? 1000 : 150 });
    let timer;
    try {
      if (mode === "abort") timer = setTimeout(() => controller.abort(), 20);
      if (mode === "good") assert.deepEqual((await pending).rows, []);
      else await assert.rejects(pending, mode === "abort" ? /aborted/ : /timed out/);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { clearTimeout(timer); }
  }
  // Wait for the peer-side close events, not merely the promise rejection.
  await bothClosed;
  assert.equal(closed, 2);
});

test("a bearer is refused over LAN HTTP before any request and loopback HTTP remains allowed", async () => {
  let lookups = 0;
  await assert.rejects(fetchHelper("http://lan.example/occupancy", { token: "fixture", allowlist: new Set(["lan.example"]),
    lookup: async () => { lookups++; return [{ address: "10.0.0.4", family: 4 }]; },
  }), /HTTPS/);
  assert.equal(lookups, 1);
  const server = await listen((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture");
    res.end(JSON.stringify({ schemaVersion: 1, observedAt: 1, adapters: {}, rows: [] }));
  });
  try {
    assert.equal((await fetchHelper(`http://127.0.0.1:${server.address().port}`, { token: "fixture" })).schemaVersion, 1);
  } finally { server.close(); }
});

test("normalize fair-shares the row budget across adapters instead of filling helper order", () => {
  const rows = [];
  for (let i = 0; i < 600; i += 1) rows.push({ harness: "openclaw", sessionId: `a${i}` });
  for (let i = 0; i < 5; i += 1) rows.push({ harness: "opencode", sessionId: `b${i}` });
  for (let i = 0; i < 5; i += 1) rows.push({ harness: "omp", sessionId: `c${i}` });
  const payload = normalizeOccupancyPayload({
    schemaVersion: 1,
    observedAt: 1,
    adapters: {
      openclaw: { coverage: "supported", stale: false, rows: 600 },
      opencode: { coverage: "supported", stale: false, rows: 5 },
      omp: { coverage: "supported", stale: false, rows: 5 },
    },
    rows,
  });
  assert.equal(payload.rows.length, 500);
  assert.equal(payload.truncated, true);
  assert.equal(payload.adapters.openclaw.dropped, 110);
  assert.equal(payload.adapters.opencode.dropped, 0);
  assert.equal(payload.adapters.omp.dropped, 0);
  const count = (harness) => payload.rows.filter((row) => row.harness === harness).length;
  assert.equal(count("openclaw"), 490);
  assert.equal(count("opencode"), 5);
  assert.equal(count("omp"), 5);
});

test("normalize reports no truncation when every adapter fits", () => {
  const payload = normalizeOccupancyPayload({
    schemaVersion: 1,
    observedAt: 1,
    adapters: {
      hermes: { coverage: "supported", stale: false, rows: 3 },
      dsh: { coverage: "supported", stale: false, rows: 2 },
    },
    rows: [
      { harness: "hermes", sessionId: "h1" },
      { harness: "hermes", sessionId: "h2" },
      { harness: "hermes", sessionId: "h3" },
      { harness: "dsh", sessionId: "d1" },
      { harness: "dsh", sessionId: "d2" },
    ],
  });
  assert.equal(payload.rows.length, 5);
  assert.equal(payload.truncated, false);
  assert.equal(payload.adapters.hermes.dropped, 0);
  assert.equal(payload.adapters.dsh.dropped, 0);
});

test("normalize does not treat invalid rows as budget pressure", () => {
  const rows = [];
  for (let i = 0; i < 300; i += 1) rows.push({ harness: "hermes", sessionId: `h${i}` });
  for (let i = 0; i < 300; i += 1) rows.push({ harness: "unknown", sessionId: `u${i}` });
  const payload = normalizeOccupancyPayload({
    schemaVersion: 1,
    observedAt: 1,
    adapters: { hermes: { coverage: "supported", stale: false, rows: 300 } },
    rows,
  });
  assert.equal(payload.rows.length, 300);
  assert.equal(payload.truncated, false);
  assert.equal(payload.adapters.hermes.dropped, 0);
});
