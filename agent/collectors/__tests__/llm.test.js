import test from "node:test";
import assert from "node:assert/strict";
import { collectLlm, normalizeModelId } from "../llm.js";

function http(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

const VLLM_METRICS = [
  "vllm:kv_cache_usage_perc 0.42",
  "vllm:num_requests_running 1",
  "vllm:num_requests_waiting 0",
  "vllm:num_preemptions_total 3",
  "vllm:prefix_cache_hits_total 100",
  "vllm:prefix_cache_queries_total 200",
  "vllm:time_to_first_token_seconds_bucket{le=\"0.5\"} 40",
  "vllm:time_to_first_token_seconds_bucket{le=\"1.0\"} 95",
  "vllm:time_to_first_token_seconds_bucket{le=\"+Inf\"} 100",
  "vllm:time_to_first_token_seconds_count 100",
].join("\n");

function mockFetchVllm() {
  return async (url) => {
    if (url === "http://127.0.0.1:8080/get_server_info") return http(404, "{}");
    if (url === "http://127.0.0.1:8080/v1/models") {
      return http(
        200,
        JSON.stringify({ data: [{ id: "qwen3.8-27b", owned_by: "vllm", max_model_len: 131072 }] })
      );
    }
    if (url === "http://127.0.0.1:8080/metrics") return http(200, VLLM_METRICS);
    throw new Error("unexpected url: " + url);
  };
}

function mockFetchSglang() {
  return async (url) => {
    if (url === "http://127.0.0.1:8081/get_server_info") {
      return http(
        200,
        JSON.stringify({
          model_path: "/models/RadixArk/Qwen3.8-27B-NVFP4",
          context_length: 262144,
          version: "0.4.6",
        })
      );
    }
    if (url === "http://127.0.0.1:8081/v1/loads") {
      return http(200, JSON.stringify([{ num_running_reqs: 2, num_waiting_reqs: 1 }]));
    }
    throw new Error("unexpected url: " + url);
  };
}

test("llm: detects vllm and parses /metrics tiles (ground truth)", async () => {
  const out = await collectLlm([8080], { fetch: mockFetchVllm() });
  assert.equal(out.length, 1);
  const l = out[0];
  assert.equal(l.port, 8080);
  assert.equal(l.backend, "vllm");
  assert.equal(l.modelId, "qwen3.8-27b");
  assert.equal(l.modelPath, "qwen3.8-27b");
  assert.equal(l.contextLength, 131072);
  assert.equal(l.kvCacheUsage, 0.42);
  assert.equal(l.requestsRunning, 1);
  assert.equal(l.requestsWaiting, 0);
  assert.equal(l.preemptionsTotal, 3);
  assert.equal(l.prefixCacheHitRate, 0.5); // 100/200
  assert.equal(l.ttftP95Seconds, 1.0); // p95 of histogram {0.5:40, 1.0:95, Inf:100}, n=100
  assert.equal(l.e2eP95Seconds, null); // no e2e histogram in fixture
  assert.equal(l.itlP95Seconds, null);
  assert.equal(l.mtpAcceptanceRate, null);
});

test("llm: detects sglang via /get_server_info + load probe", async () => {
  const out = await collectLlm([8081], { fetch: mockFetchSglang() });
  const l = out[0];
  assert.equal(l.backend, "sglang");
  assert.equal(l.modelId, "Qwen3.8-27B-NVFP4"); // abs path → leaf name
  assert.equal(l.modelPath, "/models/RadixArk/Qwen3.8-27B-NVFP4");
  assert.equal(l.contextLength, 262144);
  assert.equal(l.version, "0.4.6");
  assert.equal(l.requestsRunning, 2);
  assert.equal(l.requestsWaiting, 1);
});

test("llm: HF hub cache path is shortened for modelId, modelPath suppressed", async () => {
  const cachePath =
    "/root/.cache/huggingface/hub/models--RadixArk--Qwen3.8-27B-NVFP4/snapshots/abc123";
  assert.equal(normalizeModelId(cachePath), "RadixArk/Qwen3.8-27B-NVFP4");
  const out = await collectLlm([8080], {
    fetch: async (url) => {
      if (url === "http://127.0.0.1:8080/get_server_info") return http(404, "{}");
      if (url === "http://127.0.0.1:8080/v1/models") {
        return http(200, JSON.stringify({ data: [{ id: cachePath, owned_by: "vllm" }] }));
      }
      if (url === "http://127.0.0.1:8080/metrics") return http(404, "");
      throw new Error("unexpected url: " + url);
    },
  });
  assert.equal(out[0].modelId, "RadixArk/Qwen3.8-27B-NVFP4");
  assert.equal(out[0].modelPath, null);
});

test("llm: unreachable port → one entry with backend:null", async () => {
  const out = await collectLlm([9999], {
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].port, 9999);
  assert.equal(out[0].backend, null);
  assert.equal(out[0].modelId, null);
  assert.equal(out[0].kvCacheUsage, null);
});

test("llm: one entry per port, mixed reachability", async () => {
  const out = await collectLlm([8080, 9999], {
    fetch: async (url) => {
      if (url.startsWith("http://127.0.0.1:8080")) return mockFetchVllm()(url);
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].backend, "vllm");
  assert.equal(out[1].backend, null);
});

test("llm: empty/invalid ports → []", async () => {
  assert.deepEqual(await collectLlm([], { fetch: mockFetchVllm() }), []);
  assert.deepEqual(await collectLlm("abc", { fetch: mockFetchVllm() }), []);
  assert.deepEqual(await collectLlm(null, { fetch: mockFetchVllm() }), []);
  assert.deepEqual(await collectLlm("99999,bad", { fetch: mockFetchVllm() }), []);
});

test("llm: port list normalization dedupes + validates", async () => {
  const { normalizeLlmPorts } = await import("../llm.js");
  assert.deepEqual(normalizeLlmPorts("8080, 8080,8081"), [8080, 8081]);
  assert.deepEqual(normalizeLlmPorts([8080, "8081"]), [8080, 8081]);
});
