import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelPrices, createModelPricesHandler, LITELLM_PRICES_URL } from "../ModelPrices.js";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-prices-"));

const SAMPLE = {
  "claude-sonnet-4-5": {
    mode: "chat",
    litellm_provider: "anthropic",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    max_input_tokens: 200000,
    max_output_tokens: 64000,
  },
  "text-embedding-3-small": {
    mode: "embedding",
    input_cost_per_token: 2e-8,
    output_cost_per_token: 0,
  },
  "free-model": { mode: "chat", input_cost_per_token: 0, output_cost_per_token: 0 },
  "no-output-cost": { mode: "chat", input_cost_per_token: 1e-6 },
  "junk-entry": { mode: "chat" },
  "not-an-object": "hello",
};

test("parseModelPrices keeps chat-shaped priced entries and drops the rest", () => {
  const rows = parseModelPrices(SAMPLE);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["claude-sonnet-4-5", "free-model"]
  );
  const claude = rows[0];
  assert.equal(claude.provider, "anthropic");
    assert.equal(claude.inputCostPerToken, 3e-6);
  assert.equal(claude.outputCostPerToken, 1.5e-5);
  assert.equal(claude.cacheReadCostPerToken, 3e-7);
  assert.equal(claude.maxInputTokens, 200000);
});

test("parseModelPrices tolerates malformed payloads", () => {
  assert.deepEqual(parseModelPrices(null), []);
  assert.deepEqual(parseModelPrices("nope"), []);
  assert.deepEqual(parseModelPrices({ bad: 42 }), []);
});

test("handler serves the fetched catalog and persists it", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "model-prices.json");
  let fetches = 0;
  const handler = createModelPricesHandler({
    enabled: true,
    cachePath,
    ttlMs: 1000,
    now: () => 1_000_000,
    fetchJson: async () => {
      fetches += 1;
      return SAMPLE;
    },
    log: { warn: () => {} },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.models.length, 2);
  assert.equal(res.body.fetchedAt, 1_000_000);
  assert.equal(res.body.stale, false);
  assert.equal(fetches, 1);
  // Persisted for the offline fallback.
  assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).models.length, 2);
  // A second immediate call is served from the memory cache without refetching.
  const res2 = fakeRes();
  await handler({}, res2);
  assert.equal(fetches, 1);
});

test("handler falls back to the on-disk catalog when the source fails", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "model-prices.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ models: parseModelPrices(SAMPLE), fetchedAt: 1, source: LITELLM_PRICES_URL })
  );
  const handler = createModelPricesHandler({
    enabled: true,
    cachePath,
    ttlMs: 0,
    now: () => 2_000_000,
    fetchJson: async () => {
      throw new Error("offline");
    },
    log: { warn: () => {} },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stale, true);
  assert.equal(res.body.models.length, 2);
});

test("handler returns 502 when there is no cache and the source fails", async () => {
  const handler = createModelPricesHandler({
    enabled: true,
    cachePath: path.join(tmpDir(), "missing.json"),
    ttlMs: 0,
    now: () => 3_000_000,
    fetchJson: async () => {
      throw new Error("offline");
    },
    log: { warn: () => {} },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /price catalog|Try again/);
});

test("handler keeps the disk fallback stale instead of promoting it to fresh", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "model-prices.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ models: parseModelPrices(SAMPLE), fetchedAt: 1, source: LITELLM_PRICES_URL })
  );
  let fetches = 0;
  const handler = createModelPricesHandler({
    enabled: true,
    cachePath,
    ttlMs: 1000,
    retryMs: 0,
    now: () => 2_000_000,
    fetchJson: async () => {
      fetches += 1;
      throw new Error("offline");
    },
    log: { warn: () => {} },
  });
  // The disk copy is seeded into memory: while the refresh keeps failing, every
  // answer must say so via stale:true — never a fresh-looking stale copy.
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stale, true, `request ${i + 1}`);
  }
  assert.equal(fetches, 3);
});

test("handler retries a failed refresh at most once per retry window and shares one attempt", async () => {
  let fetches = 0;
  const handler = createModelPricesHandler({
    enabled: true,
    cachePath: path.join(tmpDir(), "missing.json"),
    ttlMs: 0,
    retryMs: 60_000,
    now: () => 4_000_000,
    fetchJson: async () => {
      fetches += 1;
      throw new Error("offline");
    },
    log: { warn: () => {} },
  });
  // Concurrent requests share the in-flight attempt…
  await Promise.all([handler({}, fakeRes()), handler({}, fakeRes()), handler({}, fakeRes())]);
  const afterBurst = fetches;
  assert.ok(afterBurst >= 1);
  // …and the negative cache holds for the retry window.
  await handler({}, fakeRes());
  await handler({}, fakeRes());
  assert.equal(fetches, afterBurst);
  // The shared attempt resolves for every caller: 502, no cache anywhere.
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 502);
});

test("disabled handler never fetches and points at MODEL_PRICES_FETCH in the 502", async () => {
  let fetches = 0;
  const handler = createModelPricesHandler({
    enabled: false,
    cachePath: path.join(tmpDir(), "missing.json"),
    ttlMs: 0,
    now: () => 5_000_000,
    fetchJson: async () => {
      fetches += 1;
      return SAMPLE;
    },
    log: { warn: () => {} },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(fetches, 0);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /MODEL_PRICES_FETCH/);
});

test("default fetch disables redirects and caps the body size", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "model-prices.json");
  const inits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    inits.push(init);
    return new Response(JSON.stringify(SAMPLE), {
      status: 200,
      headers: { "content-length": String(JSON.stringify(SAMPLE).length) },
    });
  };
  try {
    const handler = createModelPricesHandler({ enabled: true, cachePath, ttlMs: 0, now: () => 6_000_000, log: { warn: () => {} } });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(inits[0]?.redirect, "error");
  } finally {
    globalThis.fetch = realFetch;
  }

  const oversized = "x".repeat(11 * 1024 * 1024);
  globalThis.fetch = async () => new Response(oversized, { status: 200 });
  try {
    const handler = createModelPricesHandler({ enabled: true, cachePath: path.join(dir, "other.json"), ttlMs: 0, now: () => 6_000_001, log: { warn: () => {} } });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
  };
  return res;
}
