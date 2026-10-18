import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmProbe } from "../LlmProbe.js";

// Sanitized v0.1.45 shapes: /slots looks like llama.cpp but has no n_decoded.
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});
const idleSlots = () => Array.from({ length: 4 }, (_, slot) => ({ slot, state: "idle", held_tokens: 1000 }));
const metrics = (live = {}) => ({
  engine: { model: "fixture-model", max_context: 262144, version: "0.1.45" },
  live: { state: "idle", parallel: 4, running: 0, queued: 0, waiting: 0, admitting: 0,
    tok_s: null, prefill_tok_s_mean: null, slots: idleSlots(), ...live },
  totals: { since: 100, requests: 3, prompt_tokens: 9000, reused: 1000, output_tokens: 700 },
});
function setup(body = metrics()) {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  const state = { body, health: { service: "strata", status: "ok", loaded: true, max_context: 262144 }, status: 200, modelStatus: 200, models: ["fixture-model"], calls: [] };
  probe._fetch = async (url, timeout, init) => {
    const path = new URL(url).pathname;
    state.calls.push({ path, init });
    if (path === "/health") return response(state.health);
    if (path === "/slots") return response([{ id: 0, n_ctx: 262144, is_processing: true, n_prompt_tokens: 1000 }]);
    if (path === "/v1/models") return response({ data: state.models.map((id) => ({ id })) }, state.modelStatus);
    if (path === "/metrics") return response(state.body, state.status);
    return response({}, 404);
  };
  return { probe, state };
}

test("Strata health wins over llama.cpp-compatible slots; native JSON is requested", async () => {
  const { probe, state } = setup();
  const snap = await probe.probe();
  assert.equal(snap.backend, "strata");
  assert.equal(snap.available, true);
  assert.equal(snap.modelId, "fixture-model");
  assert.equal(snap.contextLength, 262144);
  assert.equal(snap.slotsTotal, 4);
  assert.equal(snap.slotsActive, 0);
  assert.equal(snap.totalPromptTokens, 9000);
  assert.equal(snap.totalOutputTokens, 700);
  assert.equal(snap.totalCachedTokens, 1000);
  assert.ok(!state.calls.some(({ path }) => path === "/slots" || path === "/metrics/prometheus"));
  assert.equal(state.calls.find(({ path }) => path === "/metrics").init.headers.Accept, "application/json");
});

test("unrelated health payloads retain llama.cpp detection", async () => {
  for (const health of [{ status: "ok" }, { service: "other" }, ["strata"], null]) {
    const { probe, state } = setup();
    state.health = health;
    await probe._detectServerType();
    assert.equal(probe.backendType, "llama.cpp");
  }
});

test("Strata model aliases retain the single engine context limit", async () => {
  const { probe, state } = setup();
  state.models = ["fixture-model", "fixture-alias", "fixture-quant", "fixture-version"];
  const snap = await probe.probe();
  assert.deepEqual(snap.models, state.models);
  assert.equal(snap.contextLength, 262144);
});

test("four decoding slots prefer aggregate window TPS without multiplying it", async () => {
  const slots = idleSlots().map((s) => ({ ...s, state: "decoding", tok_s: 10 }));
  const { probe } = setup(metrics({ state: "generating", running: 4, slots, tok_s: 87.25, prefill_tok_s_mean: 999 }));
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 87.25);
  assert.equal(snap.generationTpsSource, "window");
  assert.equal(snap.decodeActive, true);
  assert.equal(snap.prefillActive, false);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.slotsActive, 4);
  assert.equal(snap.requestsRunning, 4);
});

test("newest request reading does not hide decode in other slots", async () => {
  const slots = [{ slot: 0, state: "decoding", tok_s: 20.5 }, { slot: 1, state: "reading" },
    { slot: 2, state: "decoding", tok_s: 30 }, { slot: 3, state: "idle", tok_s: 999 }];
  const { probe } = setup(metrics({ state: "reading", running: 3, queued: 2, waiting: 1, admitting: 1,
    slots, tok_s: null, prefill_tok_s_mean: 1200 }));
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 50.5);
  assert.equal(snap.generationTpsSource, "slot-mean");
  assert.equal(snap.decodeActive, true);
  assert.equal(snap.prefillActive, true);
  assert.equal(snap.prefillTps, 1200);
  assert.equal(snap.slotsActive, 3);
  assert.equal(snap.slotsTotal, 4);
  // queued is the FIFO gauge; engine wait/admission counts may overlap it.
  assert.equal(snap.requestsWaiting, 2);
});

test("newest request generating still reports another slot prefilling, without stale PP speed", async () => {
  const { probe } = setup(metrics({ state: "generating", running: 2, tok_s: 25, prefill_tok_s_mean: 900,
    slots: [{ slot: 0, state: "reading" }, { slot: 1, state: "decoding", tok_s: 20 }, ...idleSlots().slice(2)] }));
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 25);
  assert.equal(snap.prefillActive, true);
  assert.equal(snap.prefillTps, 0);
});

test("prefill is one reported mean, never multiplied by the number of reading slots", async () => {
  const { probe } = setup(metrics({ state: "reading", running: 4, prefill_tok_s_mean: 1500,
    slots: idleSlots().map((s) => ({ ...s, state: "reading" })) }));
  const snap = await probe.probe();
  assert.equal(snap.prefillTps, 1500);
  assert.equal(snap.prefillActive, true);
  assert.equal(snap.decodeActive, false);
  assert.equal(snap.generationTps, 0);
});

test("missing/invalid rates keep activity without inventing a partial aggregate", async () => {
  for (const invalid of [null, undefined, "20", NaN, Infinity, -1]) {
    const { probe } = setup(metrics({ state: "reading", running: 3, tok_s: invalid, prefill_tok_s_mean: invalid,
      slots: [{ state: "reading" }, { state: "decoding", tok_s: 10 }, { state: "decoding", tok_s: invalid }, { state: "idle" }] }));
    const snap = await probe.probe();
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.prefillTps, 0);
    assert.equal(snap.generationTpsSource, null);
    assert.equal(snap.decodeActive, true);
    assert.equal(snap.prefillActive, true);
  }
});

test("idle clears live rates and flags immediately, even if completed totals jump", async () => {
  const { probe, state } = setup(metrics({ state: "reading", running: 2, prefill_tok_s_mean: 1000,
    slots: [{ state: "reading" }, { state: "decoding", tok_s: 50 }, ...idleSlots().slice(2)] }));
  await probe.probe();
  state.body = metrics({ tok_s: 500, prefill_tok_s_mean: 800 }); // ignore stale gauges at idle
  state.body.totals.output_tokens += 10000;
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.generationTpsSource, null);
  assert.equal(snap.decodeActive, false);
  assert.equal(snap.prefillActive, false);
  assert.equal(snap.slotsActive, 0);
  assert.equal(snap.totalOutputTokens, 10700);
});

test("restart adopts smaller completed totals without deriving a TPS spike", async () => {
  const { probe, state } = setup();
  await probe.probe();
  state.body = metrics();
  state.body.totals = { since: 200, prompt_tokens: 2, output_tokens: 1, reused: 0 };
  const snap = await probe.probe();
  assert.equal(snap.totalPromptTokens, 2);
  assert.equal(snap.totalOutputTokens, 1);
  assert.equal(snap.generationTps, 0);
});

test("solo mode uses the top-level phase when there are no batch slots", async () => {
  const { probe, state } = setup(metrics({ parallel: 0, state: "generating", running: 1, slots: [], tok_s: 42 }));
  let snap = await probe.probe();
  assert.equal(snap.generationTps, 42);
  assert.equal(snap.decodeActive, true);
  state.body = metrics({ parallel: 0, state: "reading", running: 1, slots: [], prefill_tok_s_mean: 700 });
  snap = await probe.probe();
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 700);
  assert.equal(snap.prefillActive, true);
});

test("failed/malformed/protected metrics clear previous throughput", async () => {
  for (const failure of [500, 401, 403, {}, null, { live: null }, "prometheus text"]) {
    const { probe, state } = setup(metrics({ state: "generating", running: 1, tok_s: 42,
      slots: [{ state: "decoding", tok_s: 30 }, ...idleSlots().slice(1)] }));
    await probe.probe();
    if (typeof failure === "number") state.status = failure;
    else state.body = failure;
    const snap = await probe.probe();
    assert.equal(snap.available, false);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.prefillTps, 0);
    assert.equal(snap.decodeActive, false);
    assert.equal(snap.prefillActive, false);
    if (failure === 401 || failure === 403) assert.equal(probe.authOpen, false);
  }
});

test("protected models and endpoint changes clear Strata activity and rate source", async () => {
  const { probe, state } = setup(metrics({ state: "generating", running: 1, tok_s: 42,
    slots: [{ state: "decoding", tok_s: 30 }, ...idleSlots().slice(1)] }));
  await probe.probe();
  state.modelStatus = 401;
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.decodeActive, false);
  probe.setPort(8001);
  assert.equal(probe.generationTpsSource, null);
  assert.equal(probe.decodeActive, false);
});

test("periodic health failure retains Strata instead of using its compatibility shim", async () => {
  const { probe, state } = setup();
  await probe.probe();
  state.health = null;
  state.calls = [];
  probe._lastDetectAt = 0;
  const snap = await probe.probe();
  assert.equal(snap.backend, "strata");
  assert.equal(snap.available, true);
  assert.ok(!state.calls.some(({ path }) => path === "/slots"));
});

test("another server answering /health on the port replaces a remembered Strata", async () => {
  const { probe, state } = setup();
  await probe.probe();
  assert.equal(probe.backendType, "strata");
  state.health = { status: "ok" };
  await probe._detectServerType();
  assert.equal(probe.backendType, "llama.cpp");
});

test("an engine payload without max_context keeps the context from /v1/models", async () => {
  const body = metrics();
  delete body.engine.max_context;
  const { probe } = setup(body);
  const fetchOnce = probe._fetch;
  probe._fetch = async (url, ...rest) =>
    new URL(url).pathname === "/v1/models"
      ? response({ data: [{ id: "fixture-model", max_model_len: 131072 }] })
      : fetchOnce(url, ...rest);
  const snap = await probe.probe();
  assert.equal(snap.backend, "strata");
  assert.equal(snap.contextLength, 131072);
});

test("unloaded engine clears activity and is not presented as a loaded idle model", async () => {
  const { probe } = setup(metrics({ state: "unloaded", tok_s: 999, prefill_tok_s_mean: 999 }));
  const snap = await probe.probe();
  assert.equal(snap.backend, "strata");
  assert.equal(snap.available, false);
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.decodeActive, false);
  assert.equal(snap.prefillActive, false);
});

test("out-of-slot work prevents publishing an incomplete fallback aggregate", async () => {
  const { probe } = setup(metrics({ state: "reading", running: 2, outside_slots: 1,
    slots: [{ state: "decoding", tok_s: 20 }, ...idleSlots().slice(1)] }));
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.generationTpsSource, null);
  assert.equal(snap.decodeActive, true);
});

test("malformed batch slots cannot be treated as solo prefill", async () => {
  for (const slots of [{}, null, undefined]) {
    const { probe } = setup(metrics({ state: "reading", running: 4, prefill_tok_s_mean: 700, slots }));
    const snap = await probe.probe();
    assert.equal(snap.available, false);
    assert.equal(snap.prefillTps, 0);
  }
});

test("outside-slot prefill reports its mean only with unfinished engine progress", async () => {
  const { probe, state } = setup(metrics({ state: "reading", running: 4, outside_slots: 4,
    prompt_read: 120000, prompt_total: 260000, prefill_tok_s_mean: 6300 }));
  let snap = await probe.probe();
  assert.equal(snap.prefillTps, 6300);
  assert.equal(snap.prefillActive, true);
  assert.equal(snap.requestsRunning, 4);
  assert.equal(snap.slotsActive, 0);
  assert.equal(snap.slotsTotal, 4);
  for (const progress of [{ prompt_read: null }, { prompt_read: 0 },
    { prompt_read: 260000 }, { prompt_total: null }, { outside_slots: 0 }, { outside_slots: "4" }]) {
    state.body = metrics({ state: "reading", running: 4, outside_slots: 4,
      prompt_read: 120000, prompt_total: 260000, prefill_tok_s_mean: 6300, ...progress });
    snap = await probe.probe();
    assert.equal(snap.prefillTps, 0);
    assert.equal(snap.prefillActive, true);
  }
  state.body = metrics({ outside_slots: 0, prefill_tok_s_mean: 6300 });
  snap = await probe.probe();
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.prefillActive, false);
});

test("unknown outside-slot counts cannot authorize a partial decode aggregate", async () => {
  for (const outside_slots of ["1", NaN, null, -1]) {
    const { probe } = setup(metrics({ state: "reading", running: 2, outside_slots,
      slots: [{ state: "decoding", tok_s: 20 }, { state: "reading" }, ...idleSlots().slice(2)] }));
    const snap = await probe.probe();
    assert.equal(snap.decodeActive, true);
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.generationTpsSource, null);
  }
});
