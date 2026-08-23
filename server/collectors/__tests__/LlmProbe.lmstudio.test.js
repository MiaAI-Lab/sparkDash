/**
 * LM Studio (OpenAI-compatible, no live counters).
 *
 * Real behavior (LM Studio 0.4.21): /v1/models reports `owned_by:
 * "organization_owner"`, the native list lives at /api/v0/models (with
 * `state`, `max_context_length`, `loaded_context_length`), and EVERY unknown
 * path answers HTTP 200 + {"error": "Unexpected endpoint or method. (...)"} —
 * which LM Studio logs as an ERROR. Before this backend existed, sparkDash
 * read that 200 as "SGLang answered" and hit /get_server_info, /metrics,
 * /get_model_info and /model_info every 2 s (plus /metrics + /get_server_info
 * every 400 ms during a showcase). These tests lock in: detect from owned_by,
 * never touch those paths, poll the model list slowly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LlmProbe } from "../LlmProbe.js";
import { pollServerGenerationRates } from "../LlmStreaming.js";

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const OPENAI_MODELS = {
  data: [
    { id: "ornith-1.5-35b-a3b@q5_k_m", object: "model", owned_by: "organization_owner" },
    { id: "qwen/qwen3.6-27b", object: "model", owned_by: "organization_owner" },
  ],
  object: "list",
};

const V0_MODELS = {
  data: [
    {
      id: "text-embedding-nomic-embed-text-v1.5",
      object: "model",
      type: "embeddings",
      state: "loaded",
      max_context_length: 2048,
    },
    {
      id: "ornith-1.5-35b-a3b@q4_k_m",
      object: "model",
      type: "vlm",
      state: "not-loaded",
      max_context_length: 262144,
    },
    {
      id: "ornith-1.5-35b-a3b@q5_k_m",
      object: "model",
      type: "vlm",
      state: "loaded",
      max_context_length: 262144,
      loaded_context_length: 131072,
    },
  ],
  object: "list",
};

const NEVER = ["/metrics", "/get_server_info", "/server_info", "/get_model_info", "/model_info"];

/** LM Studio-shaped fetch stub: unknown paths → 200 + error envelope. */
function lmStudioFetch(hits, overrides = {}) {
  return async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, "");
    hits.push(p);
    if (p in overrides) return overrides[p];
    if (p === "/v1/models") return jsonRes(OPENAI_MODELS);
    if (p === "/api/v0/models") return jsonRes(V0_MODELS);
    return jsonRes({ error: `Unexpected endpoint or method. (GET ${p})` });
  };
}

test("detect: owned_by organization_owner → lmstudio with no ds4/sglang probes", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  const hits = [];
  probe._fetch = lmStudioFetch(hits);
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "lmstudio");
  for (const p of NEVER) assert.ok(!hits.includes(p), `must not probe ${p}`);
});

test("probe(): loaded LLM + loaded context from /api/v0/models; sglang/metrics paths never hit", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  const hits = [];
  probe._fetch = lmStudioFetch(hits);

  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "lmstudio");
  // First *loaded* LLM/VLM — not the loaded embedding model, not the unloaded q4.
  assert.equal(snap.modelId, "ornith-1.5-35b-a3b@q5_k_m");
  assert.equal(snap.contextLength, 131072);
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.error, null);

  for (const p of NEVER) assert.ok(!hits.includes(p), `must not hit ${p}`);
  // /slots is allowed once on first contact (type unknown), never again.
  assert.ok(hits.filter((h) => h === "/slots").length <= 1);
  assert.ok(hits.includes("/api/v0/models"));

  // Throttled: polls inside the window make no HTTP calls at all.
  const before = hits.length;
  await probe.probe();
  await probe.probe();
  assert.equal(hits.length, before, "no HTTP while inside the LM Studio poll window");
  assert.equal((await probe.probe()).modelId, "ornith-1.5-35b-a3b@q5_k_m");

  // Window elapsed → exactly one model-list read.
  probe._lmStudioLastOkAt = Date.now() - 60_000;
  await probe.probe();
  assert.deepEqual(hits.slice(before), ["/api/v0/models"]);

  // Periodic re-detect (60 s) re-reads /v1/models only — no /slots, no probes.
  const beforeRedetect = hits.length;
  probe._lastDetectAt = 0;
  probe._lmStudioLastOkAt = Date.now();
  await probe.probe();
  assert.deepEqual(hits.slice(beforeRedetect), ["/v1/models"]);
  assert.equal(probe.backendType, "lmstudio");
});

test("probe(): falls back to /v1/models when /api/v0/models is not the native list", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  const hits = [];
  probe._fetch = lmStudioFetch(hits, {
    "/api/v0/models": jsonRes({ error: "Unexpected endpoint or method. (GET /api/v0/models)" }),
  });
  const snap = await probe.probe();
  assert.equal(snap.backend, "lmstudio");
  assert.equal(snap.modelId, "ornith-1.5-35b-a3b@q5_k_m");
  assert.equal(snap.available, true);
  for (const p of NEVER) assert.ok(!hits.includes(p), `must not hit ${p}`);
});

test("probe(): nothing loaded → first LLM id (JIT-loadable), never an embedding model", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  const hits = [];
  probe._fetch = lmStudioFetch(hits, {
    "/api/v0/models": jsonRes({
      data: [
        { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" },
        { id: "qwen/qwen3.6-27b", type: "llm", state: "not-loaded", max_context_length: 40960 },
      ],
    }),
  });
  const snap = await probe.probe();
  assert.equal(snap.modelId, "qwen/qwen3.6-27b");
  assert.equal(snap.contextLength, 40960);
});

test("probe(): 401 on the model list → protected posture, not available", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  probe.serverIsOpenAI = true;
  probe.backendType = "lmstudio";
  probe._lastDetectAt = Date.now();
  probe._fetch = async () => jsonRes({ error: "unauthorized" }, 401);
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.posture?.auth, "protected");
});

test("probe(): server gone → failure path (not the cached snapshot forever)", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.50.76" }, 1234);
  const hits = [];
  probe._fetch = lmStudioFetch(hits);
  await probe.probe();
  probe._lmStudioLastOkAt = Date.now() - 60_000;
  probe._fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.match(String(snap.error), /ECONNREFUSED/);
});

test("_probeIsSglang: a 200 error envelope is not SGLang", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe._fetch = async (url) =>
    jsonRes({ error: `Unexpected endpoint or method. (GET ${String(url)})` });
  assert.equal(await probe._probeIsSglang(), false);
  // Real server info still counts.
  probe._fetch = async () => jsonRes({ version: "0.5.0", model_path: "org/model" });
  assert.equal(await probe._probeIsSglang(), true);
});

test("_looksLikeServerInfo: envelopes and empties are rejected, real info accepted", () => {
  assert.equal(LlmProbe._looksLikeServerInfo({ error: "x" }), false);
  assert.equal(LlmProbe._looksLikeServerInfo({ error: "x", message: "y" }), false);
  assert.equal(LlmProbe._looksLikeServerInfo({}), false);
  assert.equal(LlmProbe._looksLikeServerInfo([]), false);
  assert.equal(LlmProbe._looksLikeServerInfo(null), false);
  assert.equal(LlmProbe._looksLikeServerInfo({ version: "0.5.0" }), true);
  assert.equal(LlmProbe._looksLikeServerInfo({ model_path: "org/m", error: null }), true);
});

test("unknown OpenAI backend + 200 error envelope on /get_server_info must not become sglang", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = null;
  probe._lastDetectAt = Date.now();
  probe._fetch = async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (p === "/v1/models") return jsonRes({ data: [{ id: "some/model", owned_by: "acme" }] });
    return jsonRes({ error: `Unexpected endpoint or method. (GET ${p})` });
  };
  const snap = await probe.probe();
  assert.notEqual(snap.backend, "sglang");
});

// ─── Showcase server-rate poller ─────────────────────────────

test("pollServerGenerationRates: gives up after a few initial misses on a counter-less backend", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push(p);
    return jsonRes({ error: `Unexpected endpoint or method. (GET ${p})` });
  };
  try {
    const ac = new AbortController();
    const safety = setTimeout(() => ac.abort(), 3_000);
    const res = await pollServerGenerationRates("http://192.168.50.76:1234", ac.signal, 5);
    clearTimeout(safety);
    assert.equal(ac.signal.aborted, false, "returned on its own, not via the safety abort");
    assert.equal(res.samples, 0);
    assert.equal(res.median, null);
    // 3 reads × (/metrics + /get_server_info) — then silence.
    assert.equal(calls.length, 6, `expected 6 requests, got ${calls.length}: ${calls.join(",")}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("pollServerGenerationRates: keeps sampling when counters exist (vLLM regression)", async () => {
  let gen = 1000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (p === "/metrics") {
      gen += 50;
      const txt = `vllm:generation_tokens_total{engine="0"} ${gen}.0\n`;
      return { ok: true, status: 200, text: async () => txt, json: async () => ({}) };
    }
    return jsonRes({}, 404);
  };
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const res = await pollServerGenerationRates("http://10.0.0.1:8000", ac.signal, 5);
    assert.ok(res.samples >= 1, `expected samples, got ${res.samples}`);
    assert.ok(res.median > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
