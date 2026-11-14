/**
 * WP0 of the quality bench: the engine record, the prompt-logprobs probe and the noise floor.
 * The fetches are injected; nothing here touches the network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  engineRecordFromModels,
  engineRecordLine,
  noiseSummary,
  planPasses,
  probeEngine,
  probePromptLogprobs,
  thinkingWarnings,
} from "../qualityEngine.js";

/** The RTX 6000 pair's `/v1/models` entry after TensorFold patch 0100 (2026-11-05). */
const TENSORFOLD_MODELS = {
  object: "list",
  data: [
    {
      id: "GLM-5.3-Flash",
      object: "model",
      owned_by: "tensorfold",
      context_length: 875520,
      max_model_len: 875520,
      reasoning: { default_enabled: false, default_effort: "high", supported_efforts: ["max", "high", "low"] },
      tensorfold: {
        engine_version: "1.1.9",
        git_commit: "f350cd3ea253a042e205746928271f9d8f71a82d",
        patches: "19c01c48633b3158",
        backend: "cuda",
        quantization: { quant_method: "exl3", bits: 4, codebook: "mcg", head_bits: 16, scope: "glm53_routed_experts_only" },
        compute_dtype: "bfloat16",
        checkpoint: "/model",
        checkpoint_sha256: "8be9949d8f6aef14f299194d51069efae530aafdfb5a991560bcae65d8537f7f",
        kv_cache_dtype: "fp8",
        tensor_parallel: 2,
        context: 875520,
        speculative: { enabled: true, kind: "DFlash2", name: "/dflash2" },
        tokenizer_sha256: "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d",
        tokenizer_name: "TokenizersBackend",
        prompt_bos: false,
        prompt_logprobs_cap: 128,
      },
    },
  ],
};

/** A vLLM-shaped prompt_logprobs reply: position 0 null, the actual token outside the top-K at position 1. */
function logprobReply(k, { positions = 10, promptTokenIds = true } = {}) {
  const rows = [null];
  for (let i = 1; i < positions; i++) {
    const row = {};
    for (let j = 0; j < k; j++) row[String(1000 + j)] = { logprob: -0.1 * (j + 1), rank: j + 1, decoded_token: `t${j}` };
    if (i === 1) row["3974"] = { logprob: -10.3, rank: 660, decoded_token: " quick" };
    rows.push(row);
  }
  return {
    choices: [{ text: " The", prompt_logprobs: rows, ...(promptTokenIds ? { prompt_token_ids: Array.from({ length: positions }, (_, i) => i) } : {}) }],
    usage: { prompt_tokens: positions, completion_tokens: 1 },
    exact_mode: "exact",
  };
}

const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test("engineRecordFromModels reads TensorFold's build object", () => {
  const rec = engineRecordFromModels(TENSORFOLD_MODELS, { health: { version: "1.1.9", backend: "cuda", device: "RTX PRO 6000" } });
  assert.equal(rec.backend, "tensorfold");
  assert.equal(rec.modelId, "GLM-5.3-Flash");
  assert.equal(rec.engineVersion, "1.1.9");
  assert.equal(rec.gitCommit, "f350cd3ea253a042e205746928271f9d8f71a82d");
  assert.equal(rec.patches, "19c01c48633b3158");
  assert.equal(rec.device, "RTX PRO 6000");
  assert.equal(rec.checkpointSha256, "8be9949d8f6aef14f299194d51069efae530aafdfb5a991560bcae65d8537f7f");
  assert.deepEqual(rec.quantization, { quant_method: "exl3", bits: 4, codebook: "mcg", head_bits: 16, scope: "glm53_routed_experts_only" });
  assert.equal(rec.computeDtype, "bfloat16");
  assert.equal(rec.kvCacheDtype, "fp8");
  assert.equal(rec.tensorParallel, 2);
  assert.equal(rec.contextLength, 875520);
  assert.equal(rec.speculative.kind, "DFlash2");
  assert.equal(rec.tokenizerSha256.length, 64);
  assert.equal(rec.promptBos, false);
  assert.equal(rec.promptLogprobsCap, 128);
  assert.equal(engineRecordLine(rec), "tensorfold 1.1.9 · exl3 4-bit glm53_routed_experts_only · KV fp8 · TP 2 · spec DFlash2 · ckpt 8be9949d8f6a");
});

test("engineRecordFromModels: a plain vLLM/llama.cpp entry keeps the model and context, nothing invented", () => {
  const rec = engineRecordFromModels(
    { data: [{ id: "Qwen3-8B", owned_by: "vllm", max_model_len: 32768 }] },
    { version: { version: "0.11.0" } }
  );
  assert.equal(rec.backend, "vllm");
  assert.equal(rec.engineVersion, "0.11.0");
  assert.equal(rec.contextLength, 32768);
  assert.equal(rec.checkpointSha256, null);
  assert.equal(rec.quantization, null);
  const llama = engineRecordFromModels({ data: [{ id: "m.gguf", owned_by: "llamacpp", meta: { n_ctx_train: 8192, n_params: 8e9, size: 5e9 } }] });
  assert.equal(llama.backend, null); // owned_by is not an engine name we trust
  assert.equal(llama.contextLength, 8192);
  assert.equal(llama.params, 8e9);
  assert.equal(engineRecordFromModels(null).modelId, null);
});

test("probePromptLogprobs: vLLM shape, actual token outside the top-K, advertised cap", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse(200, logprobReply(JSON.parse(init.body).prompt_logprobs));
  };
  const cap = await probePromptLogprobs("http://x", "GLM", { fetchImpl, cap: 128 });
  assert.equal(cap.promptLogprobs, true);
  assert.equal(cap.shape, "openai-completions");
  assert.equal(cap.positions, 10);
  assert.equal(cap.aligned, true);
  assert.equal(cap.actualIncluded, true);
  assert.equal(cap.promptTokenIds, true);
  assert.equal(cap.exactMode, "exact");
  assert.equal(cap.cap, 128);
  assert.equal(cap.capSource, "advertised");
  assert.equal(calls.length, 1, "an advertised cap needs no ladder");
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].max_tokens, 1);
  assert.equal(calls[0].prompt_logprobs, 1);
});

test("probePromptLogprobs: the cap ladder stops at the first K the engine takes", async () => {
  const fetchImpl = async (url, init) => {
    const k = JSON.parse(init.body).prompt_logprobs;
    if (k > 20) return jsonResponse(400, { error: { message: "prompt_logprobs must be an integer between 0 and 20" } });
    return jsonResponse(200, logprobReply(k, { promptTokenIds: false }));
  };
  const cap = await probePromptLogprobs("http://x", "m", { fetchImpl });
  assert.equal(cap.promptLogprobs, true);
  assert.equal(cap.cap, 20);
  assert.equal(cap.capSource, "probed");
  assert.equal(cap.promptTokenIds, false);
});

test("probePromptLogprobs: refusals and foreign shapes say why, never throw", async () => {
  const refused = await probePromptLogprobs("http://x", "m", {
    fetchImpl: async () => jsonResponse(400, { error: { message: "logprobs are not supported by this model or backend" } }),
  });
  assert.equal(refused.promptLogprobs, false);
  assert.match(refused.reason, /HTTP 400: logprobs are not supported/);

  const noRows = await probePromptLogprobs("http://x", "m", {
    fetchImpl: async () => jsonResponse(200, { choices: [{ text: "hi" }], usage: { prompt_tokens: 10 } }),
  });
  assert.equal(noRows.promptLogprobs, false);
  assert.equal(noRows.reason, "no prompt_logprobs in the reply");

  const odd = await probePromptLogprobs("http://x", "m", {
    fetchImpl: async () => jsonResponse(200, { choices: [{ prompt_logprobs: [null, [1, 2]] }] }),
  });
  assert.equal(odd.promptLogprobs, false);
  assert.match(odd.reason, /not in the vLLM shape/);

  const down = await probePromptLogprobs("http://x", "m", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(down.promptLogprobs, false);
  assert.match(down.reason, /ECONNREFUSED/);
});

test("probeEngine: record from /v1/models plus TensorFold's /health, capabilities from the probe", async () => {
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    urls.push(url);
    if (url.endsWith("/v1/models")) return jsonResponse(200, TENSORFOLD_MODELS);
    if (url.endsWith("/health")) return jsonResponse(200, { status: "ok", version: "1.1.9", backend: "cuda", device: "RTX" });
    if (url.endsWith("/v1/completions")) return jsonResponse(200, logprobReply(JSON.parse(init.body).prompt_logprobs));
    return jsonResponse(404, {});
  };
  const out = await probeEngine("http://x", { fetchImpl });
  assert.equal(out.modelsReachable, true);
  assert.equal(out.record.backend, "tensorfold");
  assert.equal(out.record.device, "RTX");
  assert.equal(out.capabilities.promptLogprobs, true);
  assert.equal(out.capabilities.cap, 128);
  assert.deepEqual(urls, ["http://x/v1/models", "http://x/health", "http://x/v1/completions"]);

  // An engine that is down: nulls with the models endpoint marked unreachable, no throw.
  const dead = await probeEngine("http://x", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(dead.modelsReachable, false);
  assert.equal(dead.record.modelId, null);
  assert.equal(dead.capabilities.promptLogprobs, false);
});

test("planPasses: primary only, or a repeat plus two serial passes when batched", () => {
  assert.deepEqual(planPasses(4, false), [{ index: 0, kind: "primary", concurrency: 4 }]);
  assert.deepEqual(
    planPasses(4, true).map((p) => [p.kind, p.concurrency]),
    [["primary", 4], ["repeat", 4], ["serial", 1], ["serial", 1]]
  );
  // Already serial: a repeat is the whole noise floor.
  assert.deepEqual(planPasses(1, true).map((p) => [p.kind, p.concurrency]), [["primary", 1], ["repeat", 1]]);
});

test("noiseSummary pairs the extra passes with the primary by id and counts flips", () => {
  const row = (id, category, ok, hash, extra = {}) => ({ id, category, ok, hash, finishReason: "stop", error: null, ...extra });
  const primary = [
    row("qa-01", "qa", true, "a"),
    row("qa-02", "qa", false, "b"),
    row("qa-03", "qa", true, "c"),
    row("mm-01", "mmlu", true, "d"),
    row("mm-02", "mmlu", false, "e", { finishReason: "length" }), // truncated: never paired
    row("mm-03", "mmlu", true, "f", { error: "timeout" }), // error: never paired
  ];
  const repeat = { index: 1, kind: "repeat", concurrency: 4, items: [
    row("qa-01", "qa", true, "a"),
    row("qa-02", "qa", true, "b2"), // flipped
    row("qa-03", "qa", true, "c2"), // same verdict, different reply
    row("mm-01", "mmlu", true, "d"),
    row("mm-02", "mmlu", true, "e2"),
    row("mm-03", "mmlu", true, "f"),
  ] };
  const serial = { index: 2, kind: "serial", concurrency: 1, items: [
    row("qa-01", "qa", false, "x"),
    row("qa-02", "qa", false, "b"),
    row("qa-03", "qa", false, "y"),
    row("mm-01", "mmlu", true, "d"),
  ] };
  const n = noiseSummary(primary, [repeat, serial], 4);
  assert.equal(n.primaryConcurrency, 4);
  assert.equal(n.passes.length, 2);
  const r = n.passes[0];
  assert.equal(r.pairs, 4);
  assert.equal(r.discordant, 1);
  assert.equal(r.identical, 2);
  assert.equal(r.flipPct, 25);
  assert.equal(r.identicalPct, 50);
  assert.deepEqual(r.categories.qa, { pairs: 3, discordant: 1, identical: 1, flipPct: 33.3 });
  assert.deepEqual(r.categories.mmlu, { pairs: 1, discordant: 0, identical: 1, flipPct: 0 });
  const s = n.passes[1];
  assert.equal(s.pairs, 4);
  assert.equal(s.discordant, 2);
  assert.equal(s.flipPct, 50);
  assert.equal(n.repeatFlipPct, 25);
  assert.equal(n.batchFlipPct, 50);
  assert.equal(noiseSummary(primary, [], 4), null);
});

test("thinkingWarnings flags a thinking-off category that reasons or truncates, after 10 rows or at the end", () => {
  const r = (category, i, extra = {}) => ({ id: `${category}-${i}`, category, thinking: false, ok: true, finishReason: "stop", error: null, reasoningTokens: 0, reasoningChars: 0, ...extra });
  const quiet = Array.from({ length: 20 }, (_, i) => r("mmlu", i));
  assert.deepEqual(thinkingWarnings(quiet), []);
  const reasons = quiet.map((x, i) => (i < 3 ? { ...x, reasoningTokens: 40 } : x));
  assert.deepEqual(thinkingWarnings(reasons), [{ kind: "thinkingNotHonoured", category: "mmlu", rows: 20, reasoningRows: 3, truncated: 0 }]);
  const cut = quiet.map((x, i) => (i < 5 ? { ...x, ok: false, finishReason: "length" } : x));
  assert.equal(thinkingWarnings(cut)[0].truncated, 5);
  // too few rows while running; counted at the end
  const few = [r("qa", 1, { reasoningChars: 90 }), r("qa", 2)];
  assert.deepEqual(thinkingWarnings(few), []);
  assert.equal(thinkingWarnings(few, { final: true }).length, 1);
  // thinking-on categories never warn; errors are not rows
  const on = Array.from({ length: 20 }, (_, i) => r("gsm8k", i, { thinking: true, reasoningTokens: 500 }));
  assert.deepEqual(thinkingWarnings(on), []);
  assert.deepEqual(thinkingWarnings(quiet.map((x) => ({ ...x, error: "boom", reasoningTokens: 5 }))), []);
});
