/**
 * Regression: ds4/sglang changes must not break vLLM or llama.cpp paths.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { readServerGenerationTokens } from "../LlmStreaming.js";

const VLLM_METRICS = `vllm:prompt_tokens_total{engine="0"} 1000.0
vllm:generation_tokens_total{engine="0"} 500.0
vllm:num_requests_running{engine="0"} 2.0
vllm:num_requests_waiting{engine="0"} 1.0
vllm:kv_cache_usage_perc{engine="0"} 0.42
vllm:num_preemptions_total{engine="0"} 3.0
vllm:prefix_cache_hits_total{engine="0"} 10.0
vllm:prefix_cache_queries_total{engine="0"} 20.0
vllm:spec_decode_num_accepted_tokens_total{engine="0"} 8.0
vllm:spec_decode_num_draft_tokens_total{engine="0"} 10.0
`;

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textRes(txt, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => txt,
    json: async () => ({}),
  };
}

test("vLLM detect: /v1/models + vllm /metrics → vllm (not ds4/sglang)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const hits = [];
  probe._fetch = async (url) => {
    const u = String(url);
    hits.push(u.replace(/^https?:\/\/[^/]+/, ""));
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "meta-llama/Llama-3.1-8B", max_model_len: 8192 }] });
    }
    if (u.endsWith("/metrics")) return textRes(VLLM_METRICS);
    if (u.endsWith("/get_server_info") || u.endsWith("/server_info")) {
      return jsonRes({}, 404);
    }
    return jsonRes({}, 404);
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "vllm");
  assert.ok(!hits.includes("/get_server_info") || hits.includes("/metrics"));
});

test("vLLM probe: counter diffs + tiles; skips get_server_info when known vllm", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.lastTokenCounts = { input: 1000, output: 500 };
  const hits = [];
  probe._fetch = async (url) => {
    const u = String(url);
    hits.push(u.replace(/^https?:\/\/[^/]+/, ""));
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        data: [{ id: "meta-llama/Llama-3.1-8B", max_model_len: 8192 }],
      });
    }
    if (u.endsWith("/metrics")) {
      return textRes(
        VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")
      );
    }
    if (u.includes("get_server_info") || u.includes("server_info")) {
      assert.fail("known vllm must not probe SGLang server_info");
    }
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.backend, "vllm");
  assert.equal(snap.modelId, "meta-llama/Llama-3.1-8B");
  assert.equal(snap.contextLength, 8192);
  assert.ok(Math.abs(snap.generationTps - 200) < 2, `generationTps ${snap.generationTps}`);
  assert.ok(Math.abs(snap.prefillTps - 100) < 2, `prefillTps ${snap.prefillTps}`);
  assert.equal(snap.slotsActive, 2);
  assert.equal(snap.requestsWaiting, 1);
  assert.equal(snap.kvCacheUsage, 0.42);
  assert.equal(snap.preemptionsTotal, 3);
  assert.equal(snap.prefixCacheHitRate, 0.5);
  assert.equal(snap.mtpAcceptanceRate, 0.8);
  assert.equal(snap.available, true);
  assert.ok(!hits.some((h) => h.includes("get_server_info")));
});

test("vLLM idle: flat counters → 0 tok/s (not sticky gauge logic)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "m", max_model_len: 4096 }] });
    }
    if (u.endsWith("/metrics")) return textRes(VLLM_METRICS);
    return jsonRes({}, 404);
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "vllm");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
});

test("vLLM prefill uses TTFT histogram sum when it advances", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastTtftSum = 10;
  const body = `${VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")}
vllm:time_to_first_token_seconds_sum{engine="0"} 10.05
`;
  probe._applyVllmMetrics(body, 2);
  assert.equal(probe.generationTps, 200); // (900-500)/2
  // Δprompt 200 / Δttft 0.05s = 4000 tok/s, not smeared 200/2=100
  assert.equal(probe.prefillTps, 4000);
});

test("vLLM prefill falls back to poll dt when TTFT sum is flat", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastTtftSum = 10;
  const body = `${VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")}
vllm:time_to_first_token_seconds_sum{engine="0"} 10.0
`;
  probe._applyVllmMetrics(body, 2);
  assert.equal(probe.prefillTps, 100); // (1200-1000)/2
});

test("vLLM prefill uses live iteration tokens before decode starts", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastIterSum = 2000;
  const prefillBody = `${VLLM_METRICS}
vllm:iteration_tokens_total_sum{engine="0"} 3600.0
`;
  probe._applyVllmMetrics(prefillBody, 2);
  // Δiter 1600 / 2s, generation flat → live prefill during PREFILL
  assert.equal(probe.prefillTps, 800);
  assert.equal(probe.generationTps, 0);
});

test("vLLM prefill still counts when first decode tokens share the poll", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastIterSum = 2000;
  probe._applyVllmMetrics(
    `${VLLM_METRICS.replace("500.0", "700.0")}
vllm:iteration_tokens_total_sum{engine="0"} 4200.0
`,
    2
  );
  // Δiter 2200 − Δgen 200 = 2000 prefill tokens / 2s
  assert.equal(probe.prefillTps, 1000);
  assert.equal(probe.generationTps, 100);
});

test("vLLM decode-only iteration surplus is treated as spec noise, not prefill", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastIterSum = 2000;
  probe._applyVllmMetrics(
    `${VLLM_METRICS.replace("500.0", "900.0")}
vllm:iteration_tokens_total_sum{engine="0"} 2480.0
`,
    2
  );
  // Δiter 480, Δgen 400 → surplus 80 < 50% of decode → ignore
  assert.equal(probe.generationTps, 200);
  assert.equal(probe.prefillTps, 0);
});

test("vLLM /metrics body is not misread as ds4", () => {
  assert.equal(LlmProbe._metricsLookLikeDs4(VLLM_METRICS), false);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 0, output: 0 };
  probe._applyVllmMetrics(VLLM_METRICS, 2);
  assert.equal(probe.generationTps, 250); // 500/2
  assert.equal(probe.prefillTps, 500); // 1000/2
  // sticky sglang state must remain unused
  assert.equal(probe._sglangStickyTps, null);
});

test("llama.cpp detect: /slots array wins over OpenAI paths", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([{ id: 0, n_decoded: 10, n_prompt_tokens_processed: 5, state: "idle" }]);
    }
    if (u.endsWith("/v1/models")) {
      assert.fail("llama.cpp /slots hit should short-circuit before /v1/models");
    }
    return jsonRes({}, 404);
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, false);
  assert.equal(probe.backendType, "llama.cpp");
});

test("llama.cpp probe: slot deltas → tok/s; props for model", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.slotState.set(0, { decoded: 10, prompted: 5 });
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([
        {
          id: 0,
          n_decoded: 50,
          n_prompt_tokens_processed: 25,
          is_processing: true,
          state: "busy",
        },
      ]);
    }
    if (u.endsWith("/props")) {
      return jsonRes({
        model_alias: "Qwen2.5-7B",
        model_path: "/models/qwen.gguf",
        total_context_length: 32768,
      });
    }
    if (u.includes("get_server_info") || u.endsWith("/metrics")) {
      assert.fail("llama.cpp path must not use OpenAI/ds4/sglang endpoints");
    }
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.backend, "llama.cpp");
  assert.equal(snap.modelId, "Qwen2.5-7B");
  assert.equal(snap.modelPath, "/models/qwen.gguf");
  assert.equal(snap.contextLength, 32768);
  assert.equal(snap.slotsTotal, 1);
  assert.equal(snap.slotsActive, 1);
  assert.equal(snap.generationTps, 20); // (50-10)/2
  assert.equal(snap.prefillTps, 10); // (25-5)/2
  assert.equal(snap.totalOutputTokens, 50);
  assert.equal(snap.available, true);
  assert.equal(snap.cachedPrefillTps, null);
  assert.equal(snap.uncachedPrefillTps, null);
});

test("llama.cpp probe: n_prompt_tokens_cache → cached vs uncached prefill", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.slotState.set(0, { decoded: 10, prompted: 5 });
  probe.lastPrefillKinds = { cached: 10, computed: 5 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([
        {
          id: 0,
          n_decoded: 50,
          n_prompt_tokens_processed: 25,
          n_prompt_tokens_cache: 40,
          is_processing: true,
        },
      ]);
    }
    if (u.endsWith("/props")) return jsonRes({ model_alias: "m" });
    return jsonRes({}, 404);
  };
  const snap = await probe.probe();
  assert.equal(snap.prefillTps, 10); // processed (25-5)/2
  assert.equal(snap.uncachedPrefillTps, 10); // (25-5)/2
  assert.equal(snap.cachedPrefillTps, 15); // (40-10)/2
});

test("llama.cpp: n_prompt_tokens_processed 0 is not treated as missing", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.slotState.set(0, { decoded: 10, prompted: 0 });
  probe.lastPrefillKinds = { cached: 10, computed: 0 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([
        {
          id: 0,
          n_decoded: 10,
          n_prompt_tokens_processed: 0,
          n_prompt_tokens: 100,
          n_prompt_tokens_cache: 100,
          state: "idle",
        },
      ]);
    }
    if (u.endsWith("/props")) return jsonRes({ model_alias: "m" });
    return jsonRes({}, 404);
  };
  const snap = await probe.probe();
  assert.equal(snap.uncachedPrefillTps, 0);
  assert.equal(snap.cachedPrefillTps, 45); // (100-10)/2
});

test("llama.cpp idle: unchanged slot counters → 0 tok/s", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = Date.now();
  probe.lastProbeTime = Date.now() - 2000;
  probe.slotState.set(0, { decoded: 50, prompted: 25 });
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([
        { id: 0, n_decoded: 50, n_prompt_tokens_processed: 25, state: "idle" },
      ]);
    }
    if (u.endsWith("/props")) return jsonRes({ model_alias: "m" });
    return jsonRes({}, 404);
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "llama.cpp");
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
});

test("readServerGenerationTokens: still reads vllm:generation_tokens_total", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => textRes(VLLM_METRICS);
  try {
    const n = await readServerGenerationTokens("http://10.0.0.1:8000");
    assert.equal(n, 500);
  } finally {
    globalThis.fetch = orig;
  }
});

test("known llama.cpp redetect still uses /slots (not forced OpenAI)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.backendType = "llama.cpp";
  probe.serverIsOpenAI = false;
  const hits = [];
  probe._fetch = async (url) => {
    const u = String(url);
    hits.push(u.replace(/^https?:\/\/[^/]+/, ""));
    if (u.endsWith("/slots")) {
      return jsonRes([{ id: 0, n_decoded: 1, state: "idle" }]);
    }
    return jsonRes({}, 404);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "llama.cpp");
  assert.equal(probe.serverIsOpenAI, false);
  assert.ok(hits.includes("/slots"));
});
