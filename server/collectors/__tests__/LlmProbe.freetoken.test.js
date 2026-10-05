/** FreeToken /v1/stats detection, normalization, and failure semantics. */
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

function statusRes(status) {
  return { ok: false, status, json: async () => ({}) };
}

const models = {
  data: [{ id: "Qwen3.8-Flash-Next-NVFP4", owned_by: "FreeToken", context_length: 131072 }],
};

function stats(overrides = {}) {
  return {
    instance_id: "instance-a",
    throughput: { decode_tps: 31.25, prefill_tps: 125.5 },
    requests: {
      active: 0,
      completed: 4,
      prompt_tokens_total: 1200,
      completion_tokens_total: 480,
      ttft_mean_ms: 250,
      p95_ms: 1400,
    },
    kv: { used_pages: 50, total_pages: 100 },
    model: { ctx: 262144 },
    ...overrides,
  };
}

test("strict FreeToken stats fallback requires stable identity and valid core telemetry", () => {
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats()), true);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: "instance-a" }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: 12, throughput: {}, requests: {}, model: {} }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: "instance-a", throughput: {}, requests: {}, model: {} }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: "instance-a", throughput: [], requests: {}, model: {} }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: "instance-a", throughput: {}, requests: [], model: {} }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken({ instance_id: "instance-a", throughput: {}, requests: {} }), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats({ throughput: { decode_tps: -1, prefill_tps: 1 } })), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats({ throughput: { decode_tps: null, prefill_tps: 1 } })), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats({ throughput: { decode_tps: Infinity, prefill_tps: 1 } })), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats({ requests: { ...stats().requests, active: -1 } })), false);
  assert.equal(LlmProbe._statsLookLikeFreeToken(stats({ requests: { ...stats().requests, completion_tokens_total: 2.5 } })), false);
});

test("detects FreeToken from owned_by and does not repeat /slots once known", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8095);
  const seen = [];
  probe._fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/v1/models")) return jsonRes(models);
    return statusRes(404);
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "freetoken");
  await probe._detectServerType();
  assert.equal(seen.filter((url) => url.endsWith("/slots")).length, 1);
});

test("unknown OpenAI backends retain EXL3 fallback when /v1/stats is absent", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8095);
  probe._fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/slots") || path.endsWith("/v1/stats") || path.endsWith("/metrics")) return statusRes(404);
    if (path.endsWith("/v1/models")) return jsonRes({ data: [{ id: "local", owned_by: "local" }] });
    if (path.endsWith("/server_info") || path.endsWith("/get_server_info")) return statusRes(404);
    if (path.endsWith("/health")) return jsonRes({ ok: true, busy: false, backend: "exl3" });
    return statusRes(404);
  };
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "exl3");
});

test("strict stats fallback identifies FreeToken but generic instance_id does not", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8095);
  probe._fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/slots")) return statusRes(404);
    if (path.endsWith("/v1/models")) return jsonRes({ data: [{ id: "local", owned_by: "local" }] });
    if (path.endsWith("/v1/stats")) return jsonRes(stats());
    return statusRes(404);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "freetoken");

  probe._resetDetection();
  probe._fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/slots")) return statusRes(404);
    if (path.endsWith("/v1/models")) return jsonRes({ data: [{ id: "local", owned_by: "local" }] });
    if (path.endsWith("/v1/stats")) return jsonRes({ instance_id: "generic" });
    if (path.endsWith("/metrics") || path.endsWith("/health")) return statusRes(404);
    return statusRes(404);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "vllm");
});

test("maps official gauges and latency fields without mislabeling mean TTFT as p95", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe._applyFreeTokenStats(stats(), 2);
  assert.equal(probe.generationTps, 31.25);
  assert.equal(probe.prefillTps, 125.5);
  assert.equal(probe.requestsRunning, 0);
  assert.equal(probe.slotsActive, 0);
  assert.equal(probe.slotsTotal, null);
  assert.equal(probe.totalOutputTokens, 480);
  assert.equal(probe.totalPromptTokens, 1200);
  assert.equal(probe.contextLength, 262144);
  assert.equal(probe.kvCacheUsage, 0.5);
  assert.equal(probe.ttftSeconds, 0.25);
  assert.equal(probe.ttftP95Seconds, null);
  assert.equal(probe.e2eP95Seconds, 1.4);
  assert.equal(probe.requestsWaiting, null);
  assert.equal(probe.preemptionsTotal, null);
  assert.equal(probe.prefixCacheHitRate, null);
  assert.equal(probe.mtpAcceptanceRate, null);
});

test("keeps valid sliding-window gauges after a request becomes idle and clears zero-sample latency", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe._applyFreeTokenStats(stats(), 2);
  probe._applyFreeTokenStats(stats({
    throughput: { decode_tps: 12, prefill_tps: 48 },
    requests: { active: 0, completed: 5, prompt_tokens_total: 1500, completion_tokens_total: 520, ttft_mean_ms: 0, p95_ms: 0 },
  }), 2);
  assert.equal(probe.generationTps, 12);
  assert.equal(probe.prefillTps, 48);
  assert.equal(probe.ttftSeconds, null);
  assert.equal(probe.e2eP95Seconds, null);
});

test("optional FreeToken KV and latency values clear while direct non-JSON bad values stay safe", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe._applyFreeTokenStats(stats(), 2);
  probe._applyFreeTokenStats(stats({
    requests: { ...stats().requests, ttft_mean_ms: -4, p95_ms: "bad" },
    kv: { used_pages: 4, total_pages: 0 },
    model: { ctx: -1 },
  }), 2);
  assert.equal(probe.generationTps, 31.25);
  assert.equal(probe.prefillTps, 125.5);
  assert.equal(probe.kvCacheUsage, null);
  assert.equal(probe.ttftSeconds, null);
  assert.equal(probe.e2eP95Seconds, null);
  assert.equal(probe.contextLength, 262144);

  probe._applyFreeTokenStats(stats({
    throughput: { decode_tps: NaN, prefill_tps: Infinity },
    requests: { ...stats().requests, active: NaN, prompt_tokens_total: Infinity, completion_tokens_total: -1 },
  }), 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.requestsRunning, null);
  assert.equal(probe.totalOutputTokens, 0);
  assert.equal(probe.totalPromptTokens, null);
});

test("instance changes and lifetime counter decreases do not create historical rate spikes", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe._applyFreeTokenStats(stats({ throughput: { decode_tps: 9, prefill_tps: 20 } }), 2);
  probe._applyFreeTokenStats(stats({
    instance_id: "instance-b",
    throughput: { decode_tps: 7, prefill_tps: 15 },
    requests: { active: 1, completed: 0, prompt_tokens_total: 4, completion_tokens_total: 2, ttft_mean_ms: 0, p95_ms: 0 },
  }), 2);
  assert.equal(probe.generationTps, 7);
  assert.equal(probe.prefillTps, 15);
  assert.equal(probe.totalOutputTokens, 2);
  assert.equal(probe.totalPromptTokens, 4);
});

test("populated FreeToken stats HTTP, timeout, malformed JSON, and schema failures clear then recover", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe.serverIsOpenAI = true;
  probe.backendType = "freetoken";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  let mode = "ok";
  probe._fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/v1/models")) return jsonRes(models);
    if (path.endsWith("/v1/stats")) {
      if (mode === "http") return statusRes(500);
      if (mode === "timeout") throw new Error("stats timeout");
      if (mode === "json") return { ok: true, status: 200, json: async () => { throw new Error("bad JSON"); } };
      if (mode === "malformed") return jsonRes({ instance_id: "not-enough" });
      return jsonRes(stats());
    }
    return statusRes(404);
  };
  const populated = await probe.probe();
  assert.equal(populated.available, true);
  assert.equal(populated.generationTps, 31.25);
  for (const failure of ["http", "timeout", "json", "malformed"]) {
    mode = failure;
    const snap = await probe.probe();
    assert.equal(snap.available, false);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.prefillTps, 0);
  }
  mode = "ok";
  const recovered = await probe.probe();
  assert.equal(recovered.available, true);
  assert.equal(recovered.backend, "freetoken");
  assert.equal(recovered.generationTps, 31.25);
});

test("FreeToken stats 403 preserves protected posture and recovers", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe.serverIsOpenAI = true;
  probe.backendType = "freetoken";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  let locked = true;
  probe._fetch = async (url) => {
    if (String(url).endsWith("/v1/models")) return jsonRes(models);
    return locked ? statusRes(403) : jsonRes(stats());
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(probe.authOpen, false);
  locked = false;
  const recovered = await probe.probe();
  assert.equal(recovered.available, true);
  assert.equal(recovered.generationTps, 31.25);
});

test("FreeToken reset returns generic defaults before another detection", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8095);
  probe.backendType = "freetoken";
  probe.serverIsOpenAI = true;
  probe._applyFreeTokenStats(stats(), 2);
  probe._resetDetection();
  assert.equal(probe.backendType, null);
  assert.equal(probe.serverIsOpenAI, null);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.slotsTotal, 0);
  assert.equal(probe.totalOutputTokens, 0);
});
