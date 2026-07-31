/**
 * Unit tests for model id normalization (HF hub cache paths) and SGLang detection helpers.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeModelId, LlmProbe, readSglangTokenTotals, readSglangLiveThroughput, readSglangLoads } from "../LlmProbe.js";

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

test("readSglangTokenTotals: top-level counters", () => {
  assert.deepEqual(
    readSglangTokenTotals({ total_input_tokens: 100, total_output_tokens: 50 }),
    { input: 100, output: 50 }
  );
});

test("readSglangTokenTotals: internal_states sum", () => {
  assert.deepEqual(
    readSglangTokenTotals({
      internal_states: [
        { total_input_tokens: 10, total_output_tokens: 5 },
        { total_input_tokens: 20, total_output_tokens: 7 },
      ],
    }),
    { input: 30, output: 12 }
  );
});

test("readSglangTokenTotals: missing → null", () => {
  assert.equal(readSglangTokenTotals({ version: "0.5.0" }), null);
});

test("_getPromMetric: sglang generation_tokens_total", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  const body = `
# HELP sglang:generation_tokens_total Number of generation tokens processed.
# TYPE sglang:generation_tokens_total counter
sglang:prompt_tokens_total{model_name="m"} 1000
sglang:generation_tokens_total{model_name="m"} 2500
sglang:num_requests_running{model_name="m"} 2
`;
  assert.equal(probe._getPromMetric(body, "generation_tokens_total", ["sglang"]), 2500);
  assert.equal(probe._getPromMetric(body, "prompt_tokens_total", ["sglang", "vllm"]), 1000);
  assert.equal(probe._getVllmMetric(body, "generation_tokens_total"), null);
});

test("_applySglangTokenRates: Prometheus sglang counters → tok/s", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  probe.lastTokenCounts = { input: 1000, output: 2500 };
  probe._fetch = async (url) => {
    if (String(url).endsWith("/metrics")) {
      return {
        ok: true,
        status: 200,
        text: async () => `
sglang:prompt_tokens_total 1200
sglang:generation_tokens_total 3100
sglang:num_requests_running 1
`,
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._applySglangTokenRates(2);
  assert.equal(probe.generationTps, 300); // (3100-2500)/2
  assert.equal(probe.prefillTps, 100); // (1200-1000)/2
  assert.equal(probe.totalOutputTokens, 3100);
  assert.equal(probe.requestsRunning, 1);
});

test("_applySglangTokenRates: falls back to server_info totals", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  probe.lastTokenCounts = { input: 0, output: 0 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/metrics")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    if (u.endsWith("/v1/loads")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/get_server_info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_input_tokens: 40, total_output_tokens: 80 }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._applySglangTokenRates(1);
  assert.equal(probe.generationTps, 80);
  assert.equal(probe.prefillTps, 40);
});

test("readSglangLiveThroughput: internal_states last_gen_throughput", () => {
  assert.equal(
    readSglangLiveThroughput({
      internal_states: [{ last_gen_throughput: 33.88617827518577 }],
    }),
    33.89
  );
});

test("readSglangLiveThroughput: sums scheduler shards", () => {
  assert.equal(
    readSglangLiveThroughput({
      internal_states: [{ last_gen_throughput: 10.5 }, { last_gen_throughput: 20.25 }],
    }),
    30.75
  );
});

test("readSglangLoads: idle → busy false, gen_throughput 0", () => {
  const loads = readSglangLoads({
    loads: [{ num_running_reqs: 0, num_waiting_reqs: 0, gen_throughput: 0, num_used_tokens: 0 }],
  });
  assert.equal(loads.busy, false);
  assert.equal(loads.genThroughput, 0);
  assert.equal(loads.running, 0);
});

test("_applySglangTokenRates: idle /v1/loads zeros sticky last_gen", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.generationTps = 99;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/metrics")) {
      return { ok: false, status: 404, text: async () => '{"detail":"Not Found"}' };
    }
    if (u.includes("/v1/loads")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          loads: [{ num_running_reqs: 0, num_waiting_reqs: 0, gen_throughput: 0, num_used_tokens: 0 }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._applySglangTokenRates(2, {
    liveThroughput: 41.23,
    serverInfoProbed: true,
  });
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.requestsRunning, 0);
});

test("_applySglangTokenRates: busy uses sticky last_gen when loads tps is 0", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/metrics")) {
      return { ok: false, status: 404, text: async () => "" };
    }
    if (u.includes("/v1/loads")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          loads: [{ num_running_reqs: 1, num_waiting_reqs: 0, gen_throughput: 0, num_used_tokens: 80 }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._applySglangTokenRates(2, {
    liveThroughput: 41.23,
    serverInfoProbed: true,
  });
  assert.equal(probe.generationTps, 41.23);
  assert.equal(probe.requestsRunning, 1);
});

test("_getPromMetric: accepts sglang_ underscore prefix", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 30000);
  const body = `sglang_generation_tokens_total{model_name="m"} 99\n`;
  assert.equal(probe._getPromMetric(body, "generation_tokens_total", ["sglang"]), 99);
});
