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

function freezeProbeClock(t) {
  const now = 10_000;
  t.mock.method(Date, "now", () => now);
  return now;
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

test("vLLM probe: counter diffs + tiles; skips get_server_info when known vllm", async (t) => {
  const now = freezeProbeClock(t);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
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
  assert.equal(snap.kvCacheTokens, null);
  assert.equal(snap.kvCacheTokensAvailable, null);
  assert.equal(snap.kvCacheGb, null); // vLLM reports no pool size
  assert.equal(snap.weightsGb, null);
  assert.equal(snap.preemptionsTotal, 3);
  assert.equal(snap.prefixCacheHitRate, 0.5);
  assert.equal(snap.totalCachedTokens, 10); // prefix_cache_hits_total is token-granular
  assert.equal(snap.mtpAcceptanceRate, 0.8);
  assert.equal(snap.available, true);
  assert.ok(!hits.some((h) => h.includes("get_server_info")));
});

test("vLLM: older gpu_cache_usage_perc stands in for kv_cache_usage_perc", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const legacy = VLLM_METRICS.replace("vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc");
  probe._applyVllmMetrics(legacy, 2);
  assert.equal(probe.kvCacheUsage, 0.42);
  // The current name wins when both are exposed.
  probe._applyVllmMetrics(VLLM_METRICS + 'vllm:gpu_cache_usage_perc{engine="0"} 0.99\n', 2);
  assert.equal(probe.kvCacheUsage, 0.42);
  probe._applyVllmMetrics(VLLM_METRICS.replace(/^vllm:kv_cache_usage_perc.*\n/m, ""), 2);
  assert.equal(probe.kvCacheUsage, null);
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

test("llama.cpp probe: slot deltas → tok/s; props for model", async (t) => {
  const now = freezeProbeClock(t);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
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

test("llama.cpp probe: n_prompt_tokens_cache → cached vs uncached prefill", async (t) => {
  const now = freezeProbeClock(t);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
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
  assert.equal(snap.totalCachedTokens, 40); // n_prompt_tokens_cache cumulative
  assert.equal(snap.uncachedPrefillTps, 10); // (25-5)/2
  assert.equal(snap.cachedPrefillTps, 15); // (40-10)/2
});

test("llama.cpp: n_prompt_tokens_processed 0 is not treated as missing", async (t) => {
  const now = freezeProbeClock(t);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
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

test("vLLM cache_config_info: free tokens from pool size and usage", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const body = [
    'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.4',
    'vllm:cache_config_info{block_size="64",kv_cache_dtype_skip_layers="[]",kv_cache_memory_bytes="15032385536",kv_cache_size_tokens="883552",num_cpu_blocks="None",num_gpu_blocks="553"} 1.0',
  ].join("\n");
  probe._applyVllmMetrics(body, 2);
  assert.equal(probe.kvCacheUsage, 0.4);
  assert.equal(probe.kvCacheTokens, 883552);
  assert.equal(probe.kvCacheMemoryBytes, 15032385536);
  assert.equal(probe.kvCacheTokensAvailable, Math.round(883552 * 0.6));
});

test("vLLM cache_config_info: sums pools across engines and clamps usage", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe._applyVllmMetrics(
    [
      'vllm:kv_cache_usage_perc{engine="0"} 1.4',
      'vllm:cache_config_info{engine="0",kv_cache_size_tokens="1000",kv_cache_memory_bytes="100"} 1',
      'vllm:cache_config_info{engine="1",kv_cache_size_tokens="2000",kv_cache_memory_bytes="50"} 1',
    ].join("\n"),
    2
  );
  assert.equal(probe.kvCacheTokens, 3000);
  assert.equal(probe.kvCacheMemoryBytes, 150);
  assert.equal(probe.kvCacheTokensAvailable, 0);
});

test("vLLM prefill excludes prefix-cache hits; cached vs uncached split", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const base = (prompt, cached, ttft) => `vllm:prompt_tokens_total{engine="0"} ${prompt}
vllm:prompt_tokens_cached_total{engine="0"} ${cached}
vllm:generation_tokens_total{engine="0"} 500.0
vllm:time_to_first_token_seconds_sum{engine="0"} ${ttft}
`;
  probe._applyVllmMetrics(base(100000, 90000, 10), 2); // seed
  // 50,000 new prompt tokens, 49,000 of them from the prefix cache, TTFT +0.5 s
  probe._applyVllmMetrics(base(150000, 139000, 10.5), 2);
  assert.equal(probe.prefillTps, 2000); // 1,000 computed / 0.5 s, not 100,000
  assert.equal(probe.cachedPrefillTps, 24500);
  assert.equal(probe.uncachedPrefillTps, 500);
  assert.equal(probe.totalCachedTokens, 139000);
});

test("vLLM without prompt_tokens_cached_total falls back to prefix_cache_hits_total", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const base = (prompt, hits, ttft) => `vllm:prompt_tokens_total{engine="0"} ${prompt}
vllm:prefix_cache_hits_total{engine="0"} ${hits}
vllm:prefix_cache_queries_total{engine="0"} ${prompt}
vllm:generation_tokens_total{engine="0"} 500.0
vllm:time_to_first_token_seconds_sum{engine="0"} ${ttft}
`;
  probe._applyVllmMetrics(base(10000, 8000, 5), 2);
  probe._applyVllmMetrics(base(20000, 17000, 6), 2);
  assert.equal(probe.prefillTps, 1000); // 1,000 computed / 1 s
  assert.equal(probe.uncachedPrefillTps, 500);
  assert.equal(probe.cachedPrefillTps, 4500);
});

test("vLLM counter reset (engine restart) reads 0 prefill, not a negative or a spike", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  const base = (prompt, cached, ttft) => `vllm:prompt_tokens_total{engine="0"} ${prompt}
vllm:prompt_tokens_cached_total{engine="0"} ${cached}
vllm:generation_tokens_total{engine="0"} 0
vllm:time_to_first_token_seconds_sum{engine="0"} ${ttft}
`;
  probe._applyVllmMetrics(base(500000, 450000, 100), 2);
  probe._applyVllmMetrics(base(1200, 0, 0.4), 2);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps, 0);
  assert.equal(probe.uncachedPrefillTps, 0);
});

test("vLLM: the first poll after a detection reset only seeds the counters", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  let metrics = VLLM_METRICS; // lifetime counters: 1000 prompt, 500 generated
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes({ data: [{ id: "m", max_model_len: 4096 }] });
    if (u.endsWith("/metrics")) return textRes(metrics);
    return jsonRes({}, 404);
  };
  // Three failed polls reset detection; each of them still advanced lastProbeTime.
  probe.lastProbeTime = Date.now() - 2000;
  probe._resetDetection();

  const recovery = await probe.probe();
  assert.equal(recovery.backend, "vllm");
  assert.equal(recovery.generationTps, 0, "lifetime counters must not be read as two seconds of work");
  assert.equal(recovery.prefillTps, 0);

  // The poll after that measures normally: +400 generated and +200 prompt over 2 s.
  probe.lastProbeTime = Date.now() - 2000;
  metrics = VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0");
  const next = await probe.probe();
  assert.ok(Math.abs(next.generationTps - 200) < 5, `generationTps ${next.generationTps}`);
  assert.ok(Math.abs(next.prefillTps - 100) < 5, `prefillTps ${next.prefillTps}`);
});

test("llama.cpp: a slot starting a new request does not cancel another slot's tokens", async (t) => {
  const now = freezeProbeClock(t);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8080);
  probe.serverIsOpenAI = false;
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
  probe.slotState.set(0, { decoded: 600, prompted: 900 });
  probe.slotState.set(1, { decoded: 100, prompted: 50 });
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return jsonRes([
        // Slot 0 finished and began a new request: both counters restarted.
        { id: 0, n_decoded: 20, n_prompt_tokens_processed: 30, is_processing: true },
        // Slot 1 kept going: +100 decoded, +40 prompted.
        { id: 1, n_decoded: 200, n_prompt_tokens_processed: 90, is_processing: true },
      ]);
    }
    if (u.endsWith("/props")) return jsonRes({ model_alias: "m", total_context_length: 4096 });
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.generationTps, 50); // slot 1 only: 100 / 2 s
  assert.equal(snap.prefillTps, 20); // slot 1 only: 40 / 2 s
});

test("vLLM prompt_tokens_by_source: prefill counts computed tokens only", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastTtftSum = 10;
  probe.lastPromptCompute = 100;
  probe.lastPrefillKinds = { cached: 800, computed: 100 };
  probe._prefillSplitSource = "cumulative";
  const body = `${VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")}
vllm:prompt_tokens_by_source_total{engine="0",source="local_compute"} 140.0
vllm:prompt_tokens_by_source_total{engine="0",source="local_cache_hit"} 860.0
vllm:prompt_tokens_by_source_total{engine="0",source="external_kv_transfer"} 0.0
vllm:time_to_first_token_seconds_sum{engine="0"} 10.05
`;
  probe._applyVllmMetrics(body, 2);
  assert.equal(probe.generationTps, 200); // (900-500)/2
  // Δcompute 40 / Δttft 0.05s = 800 — not Δprompt 200 / 0.05 = 4000 inflated by cache hits
  assert.equal(probe.prefillTps, 800);
  assert.equal(probe.uncachedPrefillTps, 20); // (140-100)/2
  assert.equal(probe.cachedPrefillTps, 30); // (860-800)/2
});

test("vLLM fully cached prompt reports 0 computed prefill", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastTtftSum = 10;
  probe.lastPromptCompute = 100;
  const body = `${VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")}
vllm:prompt_tokens_by_source_total{engine="0",source="local_compute"} 100.0
vllm:prompt_tokens_by_source_total{engine="0",source="local_cache_hit"} 1000.0
vllm:time_to_first_token_seconds_sum{engine="0"} 10.02
`;
  probe._applyVllmMetrics(body, 2);
  // Δprompt 200 served entirely from cache → Δcompute 0 → no fake prefill burst
  assert.equal(probe.prefillTps, 0);
});

test("vLLM by_source first sample seeds without a prefill spike", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8000);
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe.lastTtftSum = 10;
  const body = `${VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0")}
vllm:prompt_tokens_by_source_total{engine="0",source="local_compute"} 900.0
vllm:prompt_tokens_by_source_total{engine="0",source="local_cache_hit"} 9000.0
vllm:time_to_first_token_seconds_sum{engine="0"} 10.05
`;
  probe._applyVllmMetrics(body, 2);
  // Metric appears mid-run: seed, not 900 / 0.05 = 18000
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.uncachedPrefillTps, 0);
});
