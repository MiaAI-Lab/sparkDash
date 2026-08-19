/**
 * Unit tests for model id normalization (HF hub cache paths) and SGLang detection helpers.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeModelId, LlmProbe } from "../LlmProbe.js";

test("normalizeModelId: HF hub cache snapshot path → org/name", () => {
  const raw =
    "/root/.cache/huggingface/models--thinkingmachines--Inkling-Small-NVFP4/snapshots/b6a99534467840620d411e4cd4ad5819b2610d9c";
  assert.equal(normalizeModelId(raw), "thinkingmachines/Inkling-Small-NVFP4");
});

test("normalizeModelId: models--org--name directory only", () => {
  assert.equal(
    normalizeModelId("/data/hub/models--meta-llama--Llama-3.1-8B-Instruct"),
    "meta-llama/Llama-3.1-8B-Instruct"
  );
});

test("normalizeModelId: already short id unchanged", () => {
  assert.equal(normalizeModelId("Qwen/Qwen2.5-7B-Instruct"), "Qwen/Qwen2.5-7B-Instruct");
});

test("normalizeModelId: null/empty → null", () => {
  assert.equal(normalizeModelId(null), null);
  assert.equal(normalizeModelId(""), null);
  assert.equal(normalizeModelId("   "), null);
});

test("normalizeModelId: huggingface/hub cache path with hub/ segment", () => {
  assert.equal(
    normalizeModelId(
      "/root/.cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4-Flash-0731/snapshots/9e165c30e2704aec5d9d593cce3eebd58bbef1cb"
    ),
    "deepseek-ai/DeepSeek-V4-Flash-0731"
  );
});

test("applyModelRef via sglang info: hub path → short id, no modelPath clutter", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe._applySglangServerInfo(
    {
      model_path:
        "/root/.cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4-Flash-0731/snapshots/abc",
      context_length: 128000,
      internal_states: [{ last_gen_throughput: 0 }],
    },
    2
  );
  assert.equal(probe.modelId, "deepseek-ai/DeepSeek-V4-Flash-0731");
  assert.equal(probe.modelPath, null);
});

test("_probeIsSglang: true when /get_server_info returns JSON object", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  probe._fetch = async (url) => {
    if (String(url).endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.4.0", model_path: "org/model" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await probe._probeIsSglang(), true);
});

test("_probeIsSglang: false when endpoints missing", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8000);
  probe._fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await probe._probeIsSglang(), false);
});

test("_detectServerType: owned_by sglang → sglang without server_info", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe._fetch = async (url) => {
    if (String(url).endsWith("/slots")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (String(url).endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "org/model", owned_by: "sglang" }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "sglang");
});

test("_detectServerType: OpenAI models + get_server_info → sglang", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "/root/.cache/huggingface/models--thinkingmachines--Inkling-Small-NVFP4/snapshots/abc",
            },
          ],
        }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.5.0" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "sglang");
});

test("_detectServerType: OpenAI models without SGLang endpoints → vllm", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "meta-llama/Llama-3.1-8B" }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "vllm");
});

test("_sglangLastGenThroughput: reads internal_states when totals missing", () => {
  assert.equal(
    LlmProbe._sglangLastGenThroughput({
      internal_states: [{ last_gen_throughput: 29.746 }],
    }),
    29.746
  );
  assert.equal(
    LlmProbe._sglangLastGenThroughput({
      last_gen_throughput: 12.5,
      internal_states: [{ last_gen_throughput: 1 }],
    }),
    12.5
  );
  assert.equal(
    LlmProbe._sglangLastGenThroughput({
      internal_states: [
        { last_gen_throughput: 10 },
        { last_gen_throughput: 40 },
      ],
    }),
    40
  );
  assert.equal(LlmProbe._sglangLastGenThroughput({}), null);
});

test("_applySglangServerInfo: last_gen_throughput when no total_* counters", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  const info = {
    context_length: 1048576,
    max_total_num_tokens: 2178048,
    max_running_requests: 16,
    model_path:
      "/root/.cache/huggingface/models--thinkingmachines--Inkling-Small-NVFP4/snapshots/abc",
    internal_states: [{ last_gen_throughput: 29.746 }],
  };
  // First sample seeds sticky gauge but stays 0 (stale leftover)
  probe._applySglangServerInfo(info, 2);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.contextLength, 1048576);
  assert.equal(probe.slotsTotal, 16);
  assert.equal(probe.modelId, "thinkingmachines/Inkling-Small-NVFP4");

  // Unchanged sticky value → still 0
  probe._applySglangServerInfo(info, 2);
  assert.equal(probe.generationTps, 0);

  // Value moves → live
  probe._applySglangServerInfo(
    { ...info, internal_states: [{ last_gen_throughput: 41.2 }] },
    2
  );
  assert.equal(probe.generationTps, 41.2);
});

test("_applySglangServerInfo: does not overwrite max_model_len with KV pool size", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.contextLength = 1048576; // already from /v1/models max_model_len
  probe._applySglangServerInfo(
    {
      context_length: null,
      max_total_tokens: null,
      max_total_num_tokens: 2178048,
      max_req_input_len: 1048570,
    },
    2
  );
  assert.equal(probe.contextLength, 1048576);
});

test("_sglangStickyThroughput: expires to 0 after live window", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  assert.equal(probe._sglangStickyThroughput(10), 0); // seed
  assert.equal(probe._sglangStickyThroughput(20), 20); // change → live
  probe._sglangStickyTps.liveUntil = Date.now() - 1;
  assert.equal(probe._sglangStickyThroughput(20), 0);
});

test("_applySglangServerInfo: prefers total_* counter diffs over last_gen", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.lastTokenCounts = { input: 100, output: 50 };
  probe._applySglangServerInfo(
    {
      total_input_tokens: 300,
      total_output_tokens: 150,
      internal_states: [{ last_gen_throughput: 999 }],
    },
    2
  );
  assert.equal(probe.generationTps, 50); // (150-50)/2
  assert.equal(probe.prefillTps, 100); // (300-100)/2
  assert.equal(probe.totalOutputTokens, 150);
});

test("probe: modern sglang without totals still reports last_gen tok/s", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  let gen = 30;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "inkling-small", owned_by: "sglang", max_model_len: 1048576 }],
        }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      const throughput = gen;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model_path: "/data/models--org--Name/snapshots/x",
          context_length: 1048576,
          internal_states: [{ last_gen_throughput: throughput }],
        }),
      };
    }
    if (u.endsWith("/get_model_info") || u.endsWith("/model_info")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/metrics")) {
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const seed = await probe.probe();
  assert.equal(seed.generationTps, 0);
  gen = 41.2;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();
  assert.equal(snap.backend, "sglang");
  assert.equal(snap.generationTps, 41.2);
  assert.equal(snap.available, true);
});

test("_applySglangMetrics: cached_tokens_total vs prompt_tokens_total", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe._applySglangMetrics(
    [
      "sglang:generation_tokens_total 10",
      "sglang:prompt_tokens_total 100",
      'sglang:cached_tokens_total{cache_source="device"} 40',
      "sglang:num_running_reqs 1",
    ].join("\n") + "\n",
    2
  );
  assert.equal(probe.cachedPrefillTps, 0);
  assert.equal(probe.uncachedPrefillTps, 0);

  probe._applySglangMetrics(
    [
      "sglang:generation_tokens_total 30",
      "sglang:prompt_tokens_total 140",
      'sglang:cached_tokens_total{cache_source="device"} 80',
      'sglang:cached_tokens_total{cache_source="host"} 80',
      "sglang:num_running_reqs 1",
    ].join("\n") + "\n",
    2
  );
  assert.equal(probe.generationTps, 10); // (30-10)/2
  assert.equal(probe.prefillTps, 20); // (140-100)/2
  assert.equal(probe.uncachedPrefillTps, 20);
  // device L1 only — do not sum HiCache host/storage layers
  assert.equal(probe.cachedPrefillTps, 20); // (80-40)/2
});

test("_applySglangPrefillSplit does not clobber server_info tok/s", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.lastTokenCounts = { input: 100, output: 50 };
  probe._applySglangServerInfo(
    { total_input_tokens: 300, total_output_tokens: 150 },
    2
  );
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 100);
  probe._applySglangPrefillSplit(
    [
      "sglang:generation_tokens_total 9999",
      "sglang:prompt_tokens_total 140",
      'sglang:cached_tokens_total{cache_source="device"} 80',
    ].join("\n") + "\n",
    2
  );
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 100);
  assert.equal(probe.lastTokenCounts.output, 150);
  assert.equal(probe.cachedPrefillTps, 0); // first split sample seeds
});
