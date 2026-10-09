/**
 * FreeToken detection and /v1/stats mapping.
 * Rates are the server's sliding window, not counter diffs.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

const MODELS = {
  object: "list",
  data: [{ id: "model", object: "model", owned_by: "FreeToken", max_model_len: 131072 }],
};

const STATS = {
  instance_id: "inst-1",
  model: { id: "model", ctx: 131072 },
  throughput: { decode_tps: 42.2, prefill_tps: 800 },
  requests: {
    active: 2,
    completed: 10,
    p95_ms: 1500,
    ttft_mean_ms: 250,
    prompt_tokens_total: 1000,
    completion_tokens_total: 400,
  },
  kv: { used_pages: 3, total_pages: 10, page_size: 16 },
};

test("_detectServerType: owned_by FreeToken → freetoken (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe._fetch = async (url) => {
    if (String(url).endsWith("/v1/models")) return jsonRes(MODELS);
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "freetoken");
});

test("_statsLookLikeFreeToken rejects a partial document", () => {
  assert.equal(LlmProbe._statsLookLikeFreeToken({ ok: true }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(STATS), true);
});

test("_applyFreeTokenStats maps window rates, mean TTFT, and KV without inventing slots", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  probe._applyFreeTokenStats(STATS);
  assert.equal(probe.generationTps, 42.2);
  assert.equal(probe.prefillTps, 800);
  assert.equal(probe.requestsRunning, 2);
  assert.equal(probe.slotsTotal, 0);
  assert.equal(probe.slotsActive, 0);
  assert.equal(probe.requestsWaiting, null);
  assert.equal(probe.preemptionsTotal, null);
  assert.equal(probe.ttftSeconds, 0.25);
  assert.equal(probe.ttftP95Seconds, null);
  assert.equal(probe.e2eP95Seconds, 1.5);
  assert.equal(probe.totalPromptTokens, 1000);
  assert.equal(probe.totalOutputTokens, 400);
  assert.equal(probe.kvCacheUsage, 0.3);
  assert.equal(probe.kvCacheTokens, 160);
  assert.equal(probe.contextLength, 131072);

  probe._applyFreeTokenStats({
    ...STATS,
    instance_id: "inst-2",
    throughput: { decode_tps: 0, prefill_tps: 0 },
    requests: { ...STATS.requests, active: 0, prompt_tokens_total: 10, completion_tokens_total: 4 },
    kv: null,
  });
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.totalOutputTokens, 4);
  assert.equal(probe.kvCacheUsage, null);
  assert.equal(probe.ttftP95Seconds, null);
});

test("probe: FreeToken stats failure clears rates and does not crash", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  probe.backendType = "freetoken";
  probe.serverIsOpenAI = true;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(MODELS);
    if (u.endsWith("/v1/stats")) return notFound();
    return notFound();
  };
  probe.generationTps = 99;
  const snap = await probe.probe();
  assert.equal(snap.backend, "freetoken");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
});

test("probe: a protected /v1/stats is noted as auth-required, rates cleared", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  probe.backendType = "freetoken";
  probe.serverIsOpenAI = true;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes(MODELS);
    if (u.endsWith("/v1/stats")) return jsonRes({ error: "unauthorized" }, 401);
    return notFound();
  };
  probe.generationTps = 99;
  const snap = await probe.probe();
  assert.equal(probe.authOpen, false);
  assert.equal(snap.generationTps, 0);
});
