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

test("_probeIsSglang: prefers /server_info and skips deprecated /get_server_info", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  const hits = [];
  probe._fetch = async (url) => {
    const u = String(url);
    hits.push(u.slice(u.lastIndexOf("/")));
    if (u.endsWith("/server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "0.5.0", model_path: "org/model" }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      assert.fail("must not call deprecated /get_server_info when /server_info works");
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await probe._probeIsSglang(), true);
  assert.deepEqual(hits, ["/server_info"]);
});

test("probe: prefers current SGLang endpoints while retaining the served model ID", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  const hits = [];
  probe._fetch = async (url) => {
    const u = String(url);
    const path = u.slice(u.lastIndexOf("/"));
    hits.push(path);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "org/model", owned_by: "sglang", max_model_len: 8192 }],
        }),
      };
    }
    if (u.endsWith("/server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model_path: "org/model",
          context_length: 8192,
          internal_states: [{ last_gen_throughput: 0 }],
        }),
      };
    }
    if (u.endsWith("/model_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ model_path: "org/ShortName" }),
      };
    }
    if (u.endsWith("/get_server_info") || u.endsWith("/get_model_info")) {
      assert.fail(`must not call deprecated ${path} when current endpoints work`);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "sglang");
  assert.equal(snap.modelId, "org/model");
  assert.equal(snap.modelPath, "org/ShortName");
  assert.equal(hits.includes("/get_server_info"), false);
  assert.equal(hits.includes("/get_model_info"), false);
  assert.equal(hits.includes("/server_info"), true);
  assert.equal(hits.includes("/model_info"), true);
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

test("_applySglangLoad: /v1/loads uses num_running_reqs", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  assert.equal(
    probe._applySglangLoad({
      loads: [{ num_running_reqs: 8, num_waiting_reqs: 26 }],
    }),
    true
  );
  assert.equal(probe.slotsActive, 8);
  assert.equal(probe.requestsRunning, 8);
  assert.equal(probe.requestsWaiting, 26);
});

test("_applySglangLoad: /get_load num_reqs is running + waiting", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  assert.equal(
    probe._applySglangLoad([{ num_reqs: 34, num_waiting_reqs: 26 }]),
    true
  );
  assert.equal(probe.slotsActive, 8);
  assert.equal(probe.requestsRunning, 8);
  assert.equal(probe.requestsWaiting, 26);
});

test("_applySglangLoad: empty / unknown payload is a no-op", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  assert.equal(probe._applySglangLoad(null), false);
  assert.equal(probe._applySglangLoad({}), false);
  assert.equal(probe.slotsActive, 0);
});

test("_sglangStickyThroughput: inflight keeps a steady rate after the live window", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  assert.equal(probe._sglangStickyThroughput(40, true), 40);
  probe._sglangStickyTps.liveUntil = Date.now() - 1;
  assert.equal(probe._sglangStickyThroughput(40, true), 40);
  assert.equal(probe._sglangStickyThroughput(40, false), 0);
});

test("probe: reachable SGLang without sleep metric is Active, not Sleeping", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "org/model", owned_by: "sglang", max_model_len: 8192 }],
        }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model_path: "org/model",
          context_length: 8192,
          sleep_on_idle: true,
          internal_states: [{ last_gen_throughput: 0 }],
        }),
      };
    }
    if (u.endsWith("/v1/loads")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ loads: [{ num_running_reqs: 0, num_waiting_reqs: 0 }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "sglang");
  assert.equal(snap.gpuMemoryUtilization, 1);
  assert.equal(snap.totalOutputTokens, 0);
});

test("probe: /v1/loads inflight keeps last_gen on the first sample", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "org/model", owned_by: "sglang", max_model_len: 8192 }],
        }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model_path: "org/model",
          context_length: 8192,
          internal_states: [{ last_gen_throughput: 55.5 }],
        }),
      };
    }
    if (u.endsWith("/v1/loads")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ loads: [{ num_running_reqs: 3, num_waiting_reqs: 1 }] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 55.5);
  assert.equal(snap.slotsActive, 3);
  assert.equal(snap.requestsWaiting, 1);
});

test("_applySglangMetrics: cumulative fallback split is disjoint (cached + computed = prompt)", () => {
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
  assert.equal(probe.cachedPrefillTps, 0); // first split sample seeds
  assert.equal(probe.uncachedPrefillTps, 0);

  probe._applySglangMetrics(
    [
      "sglang:generation_tokens_total 30",
      "sglang:prompt_tokens_total 160",
      'sglang:cached_tokens_total{cache_source="device"} 60',
      'sglang:cached_tokens_total{cache_source="host"} 60',
      "sglang:num_running_reqs 1",
    ].join("\n") + "\n",
    2
  );
  assert.equal(probe.generationTps, 10); // (30-10)/2
  assert.equal(probe.prefillTps, 30); // (160-100)/2
  // device L1 only — do not sum HiCache host/storage layers
  assert.equal(probe.cachedPrefillTps, 10); // (60-40)/2
  // prompt_tokens_total counts the whole prompt, so the computed part is the
  // remainder: ((160-60) - (100-40)) / 2 — not the prompt rate itself
  assert.equal(probe.uncachedPrefillTps, 20);
  assert.equal(probe.cachedPrefillTps + probe.uncachedPrefillTps, probe.prefillTps);
  assert.equal(probe.prefixCacheHitRate, 0.375); // 60 / (60 + 100)
});

/**
 * SGLang /metrics mock exposing Prometheus counters but no total_* on
 * /server_info (issue #99 build), with /v1/loads as the load signal.
 *
 * `prompt` / `gen` / `cached` are the cumulative counters. Real SGLang only
 * bumps them in observe_one_finished_request(), i.e. at request completion, so
 * they cannot drive a live rate — pass `realtime` to add the per-interval
 * `realtime_tokens_total` series a current build publishes, or omit it to
 * emulate an older build and exercise the counter fallback.
 *
 * @param {{ prompt: number, gen: number, cached?: number, running?: number,
 *   realtime?: { decode: number, compute: number, cache: number } }} state
 */
function sglangCountersMock(state) {
  const body = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return body({ data: [{ id: "org/model", owned_by: "sglang", max_model_len: 8192 }] });
    }
    if (u.endsWith("/server_info")) {
      return body({
        model_path: "org/model",
        context_length: 8192,
        internal_states: [{ last_gen_throughput: 0 }],
      });
    }
    if (u.endsWith("/v1/loads")) {
      return body({ loads: [{ num_running_reqs: state.running ?? 0, num_waiting_reqs: 0 }] });
    }
    if (u.endsWith("/metrics")) {
      const lines = [
        `sglang:prompt_tokens_total ${state.prompt}`,
        `sglang:generation_tokens_total ${state.gen}`,
        `sglang:cached_tokens_total{cache_source="device"} ${state.cached ?? 0}`,
        `sglang:num_running_reqs ${state.running ?? 0}`,
      ];
      const rt = state.realtime;
      if (rt) {
        lines.push(
          `sglang:realtime_tokens_total{engine_type="unified",mode="decode"} ${rt.decode}`,
          `sglang:realtime_tokens_total{engine_type="unified",mode="prefill_compute"} ${rt.compute}`,
          `sglang:realtime_tokens_total{engine_type="unified",mode="prefill_cache"} ${rt.cache}`
        );
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => lines.join("\n") + "\n",
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

function sglangCounterProbe(state) {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe._fetch = sglangCountersMock(state);
  return probe;
}

test("probe: SGLang prefill tok/s returns to 0 once the engine goes idle (#99)", async () => {
  const state = { prompt: 1000, gen: 500, running: 0 };
  const probe = sglangCounterProbe(state);

  await probe.probe(); // seed baselines

  // Busy window: 400 prompt + 200 generation tokens in 2s.
  state.prompt += 400;
  state.gen += 200;
  state.running = 1;
  probe.lastProbeTime = Date.now() - 2000;
  const busy = await probe.probe();
  assert.equal(busy.prefillTps, 200);
  assert.equal(busy.generationTps, 100);

  // Engine idle again: counters frozen, nothing running.
  state.running = 0;
  for (const _ of [1, 2]) {
    probe.lastProbeTime = Date.now() - 2000;
    await probe.probe();
  }
  const idle = await probe.probe();
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.prefillTps, 0);
});

test("probe: first SGLang poll seeds the prompt baseline, not a lifetime spike (#99)", async () => {
  const probe = sglangCounterProbe({ prompt: 228_000, gen: 65_000, running: 0 });

  await probe.probe(); // fresh probe — dtSec is far outside the window

  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe(); // idle engine, counters unchanged
  assert.equal(snap.prefillTps, 0); // not lifetimePrompt / dtSec = 114000
  assert.equal(snap.generationTps, 0);
});

test("probe: server_info totals stay authoritative over Prometheus counters", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastTokenCounts = { input: 100, output: 50 };
  const json = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return json({ data: [{ id: "org/model", owned_by: "sglang", max_model_len: 8192 }] });
    }
    if (u.endsWith("/server_info")) {
      return json({ model_path: "org/model", total_input_tokens: 300, total_output_tokens: 150 });
    }
    if (u.endsWith("/metrics")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () =>
          [
            "sglang:prompt_tokens_total 999999",
            "sglang:generation_tokens_total 999999",
            'sglang:cached_tokens_total{cache_source="device"} 80',
          ].join("\n") + "\n",
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };

  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 50); // (150-50)/2 from server_info
  assert.equal(snap.prefillTps, 100); // (300-100)/2 — not the Prometheus counters
});

test("_applySglangPrefillSplit keeps server_info tok/s on the counter fallback", () => {
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

test("probe: SGLang keeps the served model ID when native info uses a local path", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = "sglang";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "qwen3.8-27b-sglang",
              owned_by: "sglang",
              max_model_len: 262144,
            },
          ],
        }),
      };
    }
    if (u.endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ model_path: "/model", context_length: 262144 }),
      };
    }
    if (u.endsWith("/get_model_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ model_path: "/model" }),
      };
    }
    if (u.endsWith("/metrics") || u.endsWith("/model_info")) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };

  const snap = await probe.probe();
  assert.equal(snap.modelId, "qwen3.8-27b-sglang");
  assert.equal(snap.modelPath, "/model");
  assert.equal(snap.contextLength, 262144);
});

test("probe: SGLang live tok/s reads realtime_tokens_total, not the finish-only counters", async () => {
  // Real SGLang shape: the cumulative counters sit still for the whole stream
  // (they are only bumped when a request finishes) while the per-interval
  // realtime series move. Differencing the counters is what used to show 0 for
  // the entire stream and then one spike on completion.
  const state = {
    prompt: 248_000,
    gen: 472_000,
    cached: 20_000,
    running: 1,
    realtime: { decode: 5000, compute: 900, cache: 100 },
  };
  const probe = sglangCounterProbe(state);
  await probe.probe(); // seed the realtime baseline

  // 2s of streaming: 70 decoded tokens, 3000 computed + 1000 cached prefill tokens.
  state.realtime = { decode: 5070, compute: 3900, cache: 1100 };
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.equal(snap.generationTps, 35); // 70 / 2 — was 0 before the fix
  assert.equal(snap.uncachedPrefillTps, 1500); // 3000 / 2
  assert.equal(snap.cachedPrefillTps, 500); // 1000 / 2
  assert.equal(snap.prefillTps, 2000); // computed + cached
  assert.equal(snap.prefixCacheHitRate, 0.25); // 1000 / (3000 + 1000)
  assert.equal(snap.totalOutputTokens, 472_000); // lifetime total still from the counter
});

test("probe: SGLang live tok/s returns to 0 when realtime_tokens_total stops moving", async () => {
  const state = {
    prompt: 1000,
    gen: 500,
    running: 1,
    realtime: { decode: 100, compute: 200, cache: 50 },
  };
  const probe = sglangCounterProbe(state);
  await probe.probe();

  state.realtime = { decode: 140, compute: 260, cache: 60 };
  probe.lastProbeTime = Date.now() - 2000;
  assert.equal((await probe.probe()).generationTps, 20);

  // Engine idle: nothing moves, load signal drops.
  state.running = 0;
  probe.lastProbeTime = Date.now() - 2000;
  const idle = await probe.probe();
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.prefillTps, 0);
  assert.equal(idle.cachedPrefillTps, 0);
  assert.equal(idle.uncachedPrefillTps, 0);
});

test("probe: first realtime sample seeds instead of reporting a lifetime rate", async () => {
  const probe = sglangCounterProbe({
    prompt: 228_000,
    gen: 65_000,
    running: 0,
    realtime: { decode: 900_000, compute: 3_000_000, cache: 7_000_000 },
  });

  const first = await probe.probe();
  assert.equal(first.generationTps, 0); // no baseline yet
  assert.equal(first.prefillTps, 0);
});

test("probe: SGLang falls back to the cumulative counters when realtime series are absent", async () => {
  // Older builds publish no realtime_tokens_total; the finish-only counters are
  // then the only source, and the differencing fallback still applies.
  const state = { prompt: 1000, gen: 500, running: 1 };
  const probe = sglangCounterProbe(state);
  await probe.probe();

  state.prompt += 400;
  state.gen += 200;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();
  assert.equal(snap.generationTps, 100);
  assert.equal(snap.prefillTps, 200);
});

test("_applySglangPrefillSplit prefers live prefill rates over server_info totals", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 30000);
  probe.lastTokenCounts = { input: 100, output: 50 };
  probe._applySglangServerInfo(
    { total_input_tokens: 300, total_output_tokens: 150 },
    2
  );
  assert.equal(probe.generationTps, 50);
  assert.equal(probe.prefillTps, 100);

  const live = (decode, compute, cache) =>
    [
      `sglang:realtime_tokens_total{mode="decode"} ${decode}`,
      `sglang:realtime_tokens_total{mode="prefill_compute"} ${compute}`,
      `sglang:realtime_tokens_total{mode="prefill_cache"} ${cache}`,
    ].join("\n") + "\n";

  probe._applySglangPrefillSplit(live(1000, 500, 200), 2); // seed
  probe._applySglangPrefillSplit(live(1400, 900, 300), 2);

  assert.equal(probe.generationTps, 50); // still owned by /server_info, not the live decode series
  assert.equal(probe.prefillTps, 250); // live computed (200) + cached (50), not the totals
  assert.equal(probe.uncachedPrefillTps, 200); // (900-500)/2
  assert.equal(probe.cachedPrefillTps, 50); // (300-200)/2
  assert.equal(probe.prefixCacheHitRate, 0.2); // 50 / (200 + 50)
  assert.equal(probe.lastTokenCounts.output, 150); // untouched
});
