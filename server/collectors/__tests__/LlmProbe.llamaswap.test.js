import { test } from "node:test";
import { strict as assert } from "node:assert";

const { LlmProbe } = await import("../LlmProbe.js");
const { engineBaseUrl, parseRunning, resolveLlamaSwapBenchModel, summarizeActivityRow } = await import("../llamaSwap.js");

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const MODELS = {
  data: [
    { id: "MiniMaxAI/MiniMax-Music3", owned_by: "llama-swap", name: "Music 3", status: { value: "unloaded" } },
    { id: "big/chat-model", owned_by: "llama-swap", name: "Chat", context_length: 262144, status: { value: "loaded" } },
    { id: "small/gguf", owned_by: "llama-swap", context_length: 32768, status: { value: "unloaded" } },
  ],
};
const RUNNING_ONE = { running: [{ model: "big/chat-model", state: "ready", proxy: "http://127.0.0.1:5804" }] };
const RUNNING_NONE = { running: [] };

const row = (id, model, out, extra = {}) => ({
  id,
  timestamp: "2026-10-16T23:16:00+05:30",
  model,
  resp_status_code: 200,
  duration_ms: 19686,
  tokens: { input_tokens: 23, cache_tokens: 0, output_tokens: out, prompt_per_second: 153.3, tokens_per_second: 39.29, ...extra },
});

/**
 * llama-swap fixture. `state.running` and `state.activity` can be changed
 * between polls. Every requested URL is recorded so tests can assert that
 * nothing but read-only llama-swap paths were touched.
 */
function swapProbe(state) {
  const probe = new LlmProbe({ id: "spark", isLocal: true, lanIp: "127.0.0.1" }, 8080);
  const seen = [];
  probe._fetch = async (url, _t, init = {}) => {
    seen.push(`${init.method || "GET"} ${url}`);
    const u = new URL(url);
    if (u.port !== "8080") return response({}, 404);
    switch (u.pathname) {
      case "/v1/models":
        return response(MODELS);
      case "/running":
        return response(state.running);
      case "/api/version":
        return response({ version: "v265", commit: "d1e743f" });
      case "/api/metrics/activity": {
        if (state.activity === null) return response({}, 404);
        const minId = Number(u.searchParams.get("min_id") || 0);
        const limit = Number(u.searchParams.get("limit") || 25);
        const rows = state.activity.filter((r) => r.id >= minId);
        // Default order is newest first; the probe asks for ascending when paging forward.
        const ordered = u.searchParams.get("order") === "asc" ? rows : [...rows].reverse();
        return response({ data: ordered.slice(0, limit) });
      }
      default:
        return response({}, 404);
    }
  };
  const engines = [];
  probe._makeEngineProbe = (url) => {
    const engine = {
      url,
      disposed: false,
      probe: async () => state.engine ?? { available: false },
      dispose() {
        this.disposed = true;
      },
    };
    engines.push(engine);
    return engine;
  };
  return { probe, seen, engines };
}

test("owned_by llama-swap classifies without probing for other engines", async () => {
  const { probe, seen } = swapProbe({ running: RUNNING_ONE, activity: [] });
  assert.equal(await probe._classifyOpenAIBackend("llama-swap"), "llama-swap");
  assert.deepEqual(seen, []);
});

test("snapshot names only the loaded model, lists it first, and copies engine counters", async () => {
  const state = {
    running: RUNNING_ONE,
    activity: [row(10, "big/chat-model", 100)],
    engine: { available: true, backend: "tensorfold", modelId: "chat-model-tf", generationTps: 42.5, slotsActive: 1, slotsTotal: 4, contextLength: 262144, kvCacheUsage: 0.25 },
  };
  const { probe, engines } = swapProbe(state);
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "llama-swap");
  assert.equal(snap.modelId, "big/chat-model");
  assert.equal(snap.models[0], "big/chat-model");
  assert.equal(snap.models.length, 3);
  assert.equal(snap.contextLength, 262144);
  assert.equal(snap.generationTps, 42.5);
  assert.equal(snap.slotsTotal, 4);
  assert.equal(snap.kvCacheUsage, 0.25);
  assert.equal(engines.length, 1);
  assert.equal(engines[0].url, "http://127.0.0.1:5804");
  assert.deepEqual(snap.llamaSwap.loaded, ["big/chat-model"]);
  assert.equal(snap.llamaSwap.version, "v265");
  assert.equal(snap.llamaSwap.engine.backend, "tensorfold");
  assert.equal(snap.llamaSwap.models.find((m) => m.id === "big/chat-model").state, "ready");
  assert.equal(snap.llamaSwap.models.find((m) => m.id === "small/gguf").state, "unloaded");
});

test("nothing loaded: no model id, idle engine fields, no nested probe", async () => {
  const state = { running: RUNNING_NONE, activity: [], engine: { available: true, generationTps: 99 } };
  const { probe, engines } = swapProbe(state);
  const snap = await probe.probe();
  assert.equal(snap.backend, "llama-swap");
  assert.equal(snap.modelId, null, "never default to the first listed model");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.contextLength, null);
  assert.equal(snap.llamaSwap.engine, null);
  assert.equal(engines.length, 0);
});

test("polling only ever GETs llama-swap's own read-only paths", async () => {
  const state = { running: RUNNING_ONE, activity: [row(1, "big/chat-model", 5)], engine: { available: true } };
  const { probe, seen } = swapProbe(state);
  for (let i = 0; i < 3; i++) await probe.probe();
  state.running = RUNNING_NONE;
  await probe.probe();
  const allowed = /^GET http:\/\/127\.0\.0\.1:8080\/(v1\/models|running|api\/version|api\/metrics\/activity\?|slots$)/;
  for (const call of seen) assert.match(call, allowed, call);
  assert.ok(!seen.some((c) => c.includes("/upstream/")), "never /upstream/: it loads models");
});

test("token totals count requests completed after the probe started", async () => {
  const state = { running: RUNNING_ONE, activity: [row(7, "big/chat-model", 999)], engine: { available: true } };
  const { probe } = swapProbe(state);
  let snap = await probe.probe();
  assert.equal(snap.totalOutputTokens, 0, "older history seeds the cursor, it is not credited");
  assert.equal(snap.llamaSwap.lastRequest.id, 7);

  state.activity.push(row(8, "big/chat-model", 767), row(9, "big/chat-model", 33, { input_tokens: 100, cache_tokens: 90 }));
  snap = await probe.probe();
  assert.equal(snap.totalOutputTokens, 800);
  assert.equal(snap.totalPromptTokens, 123);
  assert.equal(snap.totalCachedTokens, 90);
  assert.equal(snap.llamaSwap.lastRequest.id, 9);
  assert.equal(snap.llamaSwap.lastRequest.decodeTps, 39.29);

  // Rows with no usage (-1 / 0) add nothing.
  state.activity.push(row(10, "big/chat-model", -1, { input_tokens: -1, tokens_per_second: -1 }));
  snap = await probe.probe();
  assert.equal(snap.totalOutputTokens, 800);
  assert.equal(snap.llamaSwap.lastRequest.decodeTps, null);
});

test("a llama-swap without the Activity API still reports state", async () => {
  const state = { running: RUNNING_ONE, activity: null, engine: { available: true, backend: "vllm", generationTps: 12 } };
  const { probe } = swapProbe(state);
  await probe.probe();
  const snap = await probe.probe();
  assert.equal(snap.modelId, "big/chat-model");
  assert.equal(snap.generationTps, 12);
  assert.equal(snap.llamaSwap.activity, false);
  assert.equal(snap.llamaSwap.lastRequest, null);
});

test("an unreachable engine falls back to llama-swap data with idle counters", async () => {
  const state = { running: RUNNING_ONE, activity: [], engine: { available: false } };
  const { probe } = swapProbe(state);
  const snap = await probe.probe();
  assert.equal(snap.modelId, "big/chat-model");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.llamaSwap.engine.available, false);
  assert.equal(snap.contextLength, 262144, "context still comes from /v1/models");
});

test("a swap replaces the nested engine probe", async () => {
  const state = { running: RUNNING_ONE, activity: [], engine: { available: true } };
  const { probe, engines } = swapProbe(state);
  await probe.probe();
  state.running = { running: [{ model: "small/gguf", state: "ready", proxy: "http://127.0.0.1:5805" }] };
  const snap = await probe.probe();
  assert.equal(snap.modelId, "small/gguf");
  assert.equal(snap.contextLength, 32768, "context follows the newly loaded model");
  assert.equal(engines.length, 2);
  assert.equal(engines[0].disposed, true);
  assert.equal(engines[1].url, "http://127.0.0.1:5805");
});

test("a starting model is reported but not treated as loaded", async () => {
  const state = { running: { running: [{ model: "small/gguf", state: "starting", proxy: "http://127.0.0.1:5805" }] }, activity: [] };
  const { probe } = swapProbe(state);
  const snap = await probe.probe();
  assert.equal(snap.modelId, null);
  assert.deepEqual(snap.llamaSwap.starting, ["small/gguf"]);
  assert.deepEqual(snap.llamaSwap.loaded, []);
});

test("parseRunning ignores malformed entries and non-http proxies", () => {
  const parsed = parseRunning({ running: [{ model: "a", state: "ready", proxy: "ftp://x" }, { state: "ready" }, null, { model: " b ", state: "ready", proxy: "http://h:1" }] });
  assert.deepEqual(parsed.ready, ["a", "b"]);
  assert.equal(parsed.entries[0].proxy, null);
  assert.deepEqual(parseRunning(null).entries, []);
});

test("engineBaseUrl swaps a loopback upstream for the address llama-swap is reached at", () => {
  assert.equal(engineBaseUrl("http://127.0.0.1:5804", "http://127.0.0.1:8080"), "http://127.0.0.1:5804");
  assert.equal(engineBaseUrl("http://127.0.0.1:5804", "http://192.168.2.40:8080"), "http://192.168.2.40:5804");
  assert.equal(engineBaseUrl("http://10.0.0.5:9000", "http://192.168.2.40:8080"), "http://10.0.0.5:9000");
  assert.equal(engineBaseUrl("not a url", "http://127.0.0.1:8080"), null);
});

test("summarizeActivityRow clamps llama-swap's -1 placeholders", () => {
  const s = summarizeActivityRow(row(3, "m", -1, { input_tokens: -1, prompt_per_second: -1, tokens_per_second: 0 }));
  assert.equal(s.outputTokens, 0);
  assert.equal(s.inputTokens, 0);
  assert.equal(s.prefillTps, null);
  assert.equal(s.decodeTps, null);
  assert.equal(s.at, Date.parse("2026-10-16T23:16:00+05:30"));
});

const runningFetch = (body, status = 200) => async () => response(body, status);

test("bench model: the loaded model when none or the loaded one is requested", async () => {
  const base = { baseUrl: "http://127.0.0.1:8080", fetch: runningFetch(RUNNING_ONE) };
  assert.equal(await resolveLlamaSwapBenchModel({ ...base, requested: null }), "big/chat-model");
  assert.equal(await resolveLlamaSwapBenchModel({ ...base, requested: "big/chat-model" }), "big/chat-model");
});

test("bench model: refuses a model that would make llama-swap swap", async () => {
  await assert.rejects(
    resolveLlamaSwapBenchModel({ baseUrl: "http://x:8080", requested: "MiniMaxAI/MiniMax-Music3", fetch: runningFetch(RUNNING_ONE) }),
    (err) => err.status === 409 && /not loaded/.test(err.message)
  );
  await assert.rejects(
    resolveLlamaSwapBenchModel({ baseUrl: "http://x:8080", requested: null, fetch: runningFetch(RUNNING_NONE) }),
    (err) => err.status === 409 && /No model is loaded/.test(err.message)
  );
  await assert.rejects(
    resolveLlamaSwapBenchModel({ baseUrl: "http://x:8080", requested: null, fetch: runningFetch({}, 500) }),
    (err) => err.status === 503
  );
});
