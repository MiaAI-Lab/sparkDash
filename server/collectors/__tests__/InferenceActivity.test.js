import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { activityUrl, approvedLabels, InferenceActivityStore, parseActivity, readActivity } from "../InferenceActivity.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const LABELS = ["service-a", "user-1"];
const payload = (overrides = {}) => ({
  available: true, generatedAt: new Date(NOW).toISOString(),
  active: [{ principal: "service-a", model: "model-a", count: 2, oldest_age_ms: 900, newest_age_ms: 100 }],
  recent: [{ principal: "user-1", model: "model-a", durationMs: 400, ageMs: 1000 }],
  overflowed: false, ...overrides,
});

test("source URL accepts explicit private literals, not DNS, credentials, public or link-local targets", () => {
  for (const host of ["127.0.0.1", "127.2.3.4", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.2", "[::1]"]) {
    assert.ok(activityUrl(`http://${host}:9001/activity`));
    assert.ok(activityUrl(`https://${host}/activity`));
  }
  for (const url of ["http://localhost/activity", "http://example.com", "http://8.8.8.8", "http://169.254.169.254",
    "http://172.15.0.1", "http://172.32.0.1", "http://0.0.0.0", "http://[fc00::1]", "ftp://127.0.0.1",
    "http://user:password@127.0.0.1", "http://127.0.0.1?token=x", "http://127.0.0.1?", "http://127.0.0.1#",
    "http://127.0.0.1:0", "http://127.0.0.1:99999", "http://127.1", "http://2130706433", "http://0x7f000001",
    "http://127.0.0.1\\@example.com", "http://[::ffff:127.0.0.1]"]) assert.equal(activityUrl(url), null, url);
});

test("approved labels are explicit non-secret names, deduplicated and bounded", () => {
  assert.deepEqual(approvedLabels("service-a, user-1,service-a"), LABELS);
  for (const label of ["Bearer secret", "sk-secret", "192.168.1.2", "email@example.com", "a".repeat(65), "f".repeat(32)]) {
    assert.deepEqual(approvedLabels(label), []);
  }
  assert.deepEqual(approvedLabels(Array.from({ length: 257 }, (_, n) => `service-${n}`).join(",")), []);
});

test("normalization supports the router schema without retaining keys, prompts, IPs or headers", () => {
  const parsed = parseActivity(payload({
    active: [{ ...payload().active[0], principal: "Bearer sk-secret", prompt: "private-prompt", headers: "private-header", ip: "private-ip" }],
    recent: [{ ...payload().recent[0], model: "sk-secret", api_key: "private-key", requestId: "private-id" }],
    unrelated: "private-data",
  }), LABELS, NOW);
  assert.deepEqual(parsed.active, [{ principal: "unknown", model: "model-a", count: 2, oldestAgeMs: 900, newestAgeMs: 100 }]);
  assert.equal(parsed.recent[0].model, "unknown");
  assert.equal(parsed.recent[0].status, null);
  assert.doesNotMatch(JSON.stringify(parsed), /Bearer|sk-secret|private-/);
});

test("missing, malformed or stale summaries cannot claim measured zero", () => {
  const malformed = [null, [], payload({ available: false }), payload({ active: undefined }), payload({ recent: undefined }),
    payload({ active: [null] }), payload({ active: [payload().active[0], payload().active[0]] }),
    payload({ active: [{ ...payload().active[0], count: 0 }] }),
    payload({ active: [{ ...payload().active[0], count: true }] }),
    payload({ active: [{ ...payload().active[0], newest_age_ms: 1000 }] }),
    payload({ active: [{ ...payload().active[0], oldest_age_ms: -1 }] }),
    payload({ recent: [{ ...payload().recent[0], durationMs: Infinity }] }),
    payload({ recent: [{ ...payload().recent[0], status: 99 }] }),
    payload({ generatedAt: "invalid" }), payload({ generatedAt: new Date(NOW - 30001).toISOString() }),
    payload({ generatedAt: new Date(NOW + 10001).toISOString() })];
  for (const source of malformed) assert.equal(parseActivity(source, LABELS, NOW), null);
  assert.deepEqual(parseActivity(payload({ active: [], recent: [] }), LABELS, NOW).active, []);
});

test("camel-case ages, row bounds, freshness and recent retention are explicit", () => {
  const parsed = parseActivity(payload({
    active: Array.from({ length: 300 }, (_, n) => ({ principal: "service-a", model: `model-${n}`, count: 1, oldestAgeMs: 30, newestAgeMs: 0 })),
    recent: Array.from({ length: 30 }, () => payload().recent[0]),
  }), LABELS, NOW);
  assert.equal(parsed.active.length, 256);
  assert.equal(parsed.recent.length, 24);
  assert.equal(parsed.overflowed, true);
  assert.equal(parseActivity(payload({ recent: [{ ...payload().recent[0], ageMs: 600001 }] }), LABELS, NOW).recent.length, 0);
});

test("model labels reject URLs, IPs and recognizable credential-like path segments", () => {
  for (const model of ["org/sk-secret", "http://192.168.1.2", "org/192.168.1.2", "org/eyJtoken", "Bearer-secret"]) {
    assert.equal(parseActivity(payload({ active: [{ ...payload().active[0], model }] }), LABELS, NOW).active[0].model, "unknown");
  }
  assert.equal(parseActivity(payload({ active: [{ ...payload().active[0], model: "organization/model-name" }] }), LABELS, NOW).active[0].model, "organization/model-name");
});

test("disabled or invalid configuration does no source I/O and does not expose the URL", async () => {
  let reads = 0;
  for (const config of [{ url: "" }, { url: "http://public.example/secret" }, { url: "http://127.0.0.1/activity", labelNames: "" }]) {
    const store = new InferenceActivityStore({ labelNames: "service-a", ...config, read: async () => { reads += 1; }, now: () => NOW });
    await store.refreshIfDue();
    assert.equal(store.snapshot().available, false);
    assert.deepEqual(store.snapshot().active, []);
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /http|secret/);
  }
  assert.equal(reads, 0);
});

test("polling coalesces concurrent readers, advances ages, clears failures and recovers", async () => {
  let now = NOW;
  let reads = 0;
  let failed = false;
  let finish;
  const store = new InferenceActivityStore({ url: "http://127.0.0.1/activity", labelNames: LABELS.join(","), now: () => now,
    read: async () => {
      reads += 1;
      if (reads === 1) await new Promise((resolve) => { finish = resolve; });
      if (failed) throw new Error("Bearer private-key http://private.example");
      return payload({ generatedAt: new Date(now).toISOString() });
    },
  });
  const first = store.refreshIfDue();
  const second = store.refreshIfDue();
  assert.equal(reads, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(store.snapshot().available, true);
  now += 4000;
  await store.refreshIfDue();
  assert.equal(reads, 1);
  assert.equal(store.snapshot().active[0].oldestAgeMs, 4900);
  now += 31000;
  assert.equal(store.snapshot().available, false);
  assert.deepEqual(store.snapshot().active, []);
  failed = true;
  await store.refreshIfDue();
  assert.equal(store.snapshot().error, "activity-source-unavailable");
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /private-|Bearer|http/);
  now += 5000;
  failed = false;
  await store.refreshIfDue();
  assert.equal(store.snapshot().available, true);
});

test("clock rollback beyond future tolerance makes cached summaries unavailable", async () => {
  let now = NOW;
  const store = new InferenceActivityStore({ url: "http://127.0.0.1/activity", labelNames: LABELS.join(","),
    read: async () => payload(), now: () => now });
  await store.refreshIfDue();
  now = NOW - 10_000;
  assert.equal(store.snapshot().available, true);
  now -= 1;
  assert.equal(store.snapshot().available, false);
  assert.deepEqual(store.snapshot().active, []);
  assert.deepEqual(store.snapshot().recent, []);
  assert.equal(store.snapshot().generatedAt, null);
});

async function source(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP source reads JSON but rejects redirects, errors, HTML, bad JSON and oversized bodies", async (t) => {
  let redirected = 0;
  const base = await source(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/redirect") { res.writeHead(302, { Location: `${base}/target` }); return res.end(); }
    if (req.url === "/target") redirected += 1;
    if (req.url === "/error") { res.writeHead(503); return res.end("private-error"); }
    if (req.url === "/html") { res.setHeader("Content-Type", "text/html"); return res.end("private-page"); }
    if (req.url === "/invalid") return res.end("not JSON");
    if (req.url === "/large") return res.end(JSON.stringify({ data: "x".repeat(65536) }));
    if (req.url === "/chunked") { res.write("x".repeat(65500)); return res.end("x".repeat(100)); }
    res.end(JSON.stringify(payload()));
  });
  assert.equal((await readActivity(`${base}/ok`)).active[0].count, 2);
  for (const suffix of ["redirect", "error", "html", "invalid", "large", "chunked"]) {
    await assert.rejects(readActivity(`${base}/${suffix}`));
  }
  assert.equal(redirected, 0);
});

test("HTTP body stalls are bounded by the five-second timeout", { timeout: 6500 }, async (t) => {
  const base = await source(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
  await assert.rejects(readActivity(base));
});
