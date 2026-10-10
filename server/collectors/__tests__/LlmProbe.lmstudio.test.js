import { test } from "node:test";
import { strict as assert } from "node:assert";

const { LlmProbe } = await import("../LlmProbe.js");

const response = (body, status = 200, text = null) => ({
  ok: status === 200,
  status,
  json: async () => body,
  text: async () => text ?? JSON.stringify(body),
});

function spark() {
  return { id: "test-win", kind: "host", platform: "windows", lanIp: "100.10.10.10" };
}

/** Stub _fetch with a per-path fixture map; returns the probe. */
function probeWith(paths) {
  const probe = new LlmProbe(spark());
  probe._fetch = async (url) => {
    for (const [suffix, res] of Object.entries(paths)) {
      if (url.endsWith(suffix)) return typeof res === "function" ? res(url) : res;
    }
    return response({}, 404);
  };
  return probe;
}

const LMSTUDIO_MODELS = {
  data: [
    { id: "ornith-1.5-35b-a3b", object: "model", type: "vlm", publisher: "ornith-ai", state: "loaded", quantization: "Q4_K_M", max_context_length: 262144 },
    { id: "qwen3.8-27b", object: "model", type: "vlm", publisher: "unsloth", state: "loaded" },
  ],
};

test("LM Studio is classified positively via /api/v0/models, not sglang's /server_info", async () => {
  // LM Studio answers 200 + JSON on EVERY path (the real-world bug: it was
  // misclassified as sglang because /server_info returned an object).
  const paths = {
    "/v1/models": response({ data: [{ id: "ornith-1.5-35b-a3b", owned_by: "organization_owner" }] }),
    "/server_info": response({ error: "Unexpected endpoint or method." }),
    "/get_server_info": response({ error: "Unexpected endpoint or method." }),
    "/api/v0/models": response(LMSTUDIO_MODELS),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("organization_owner"), "lmstudio");
});

test("a plain vLLM server without /api/v0/models still classifies as vllm", async () => {
  const paths = {
    "/v1/models": response({ data: [{ id: "m", owned_by: "organization_owner" }] }),
    "/api/v0/models": response({}, 404),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("organization_owner"), "vllm");
});

test("sglang is still detected when /server_info carries sglang-shaped fields", async () => {
  const paths = {
    "/v1/models": response({ data: [{ id: "m", owned_by: "organization_owner" }] }),
    "/api/v0/models": response({}, 404),
    "/server_info": response({ model_path: "/models/x", context_length: 65536, max_running_requests: 32 }),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("organization_owner"), "sglang");
});

test("an error-object /server_info no longer misclassifies as sglang", async () => {
  const paths = {
    "/v1/models": response({ data: [{ id: "m", owned_by: "organization_owner" }] }),
    "/api/v0/models": response({}, 404),
    "/server_info": response({ error: "Unexpected endpoint or method." }),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("organization_owner"), "vllm");
});

test("LM Studio is not downgraded to vllm by its catch-all 200 /metrics body", async () => {
  // Real-world bug: _probeOpenAICompatible fetched /metrics; LM Studio answers
  // 200 on every path, the body isn't Prometheus text → backendType was
  // unconditionally reset to "vllm", clobbering the lmstudio classification.
  const probe = new LlmProbe(spark(), 1234);
  probe.backendType = "lmstudio";
  probe.serverIsOpenAI = true;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/metrics")) return response({ error: "Unexpected endpoint or method." });
    if (u.endsWith("/v1/models")) return response({ data: [{ id: "ornith-1.5-35b-a3b" }] });
    return response({}, 404);
  };
  const snap = await probe._probeOpenAICompatible();
  assert.equal(probe.backendType, "lmstudio");
  assert.equal(snap.backend, "lmstudio");
});

test("a classified LM Studio server is never probed on /metrics (no log spam)", async () => {
  const fetched = [];
  const probe = new LlmProbe(spark(), 1234);
  probe.backendType = "lmstudio";
  probe.serverIsOpenAI = true;
  probe._fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith("/v1/models")) {
      return response({ data: [{ id: "ornith-1.5-35b-a3b", owned_by: "organization_owner" }] });
    }
    return response({}, 404);
  };
  await probe._probeOpenAICompatible();
  assert.ok(!fetched.some((u) => u.endsWith("/metrics")), `probed /metrics: ${fetched.join(", ")}`);
  assert.ok(!fetched.some((u) => u.endsWith("/server_info")), `probed /server_info: ${fetched.join(", ")}`);
});

test("Ollama is classified via its native /api/tags contract", async () => {
  const paths = {
    "/v1/models": response({ object: "list", data: [{ id: "qwen3:27b", object: "model", owned_by: "library" }] }),
    "/api/tags": response({ models: [{ name: "qwen3:27b", model: "qwen3:27b", size: 17179869184, details: { family: "qwen3" } }] }),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("library"), "ollama");
});

test("Ollama with zero installed models still classifies as ollama", async () => {
  const paths = {
    "/v1/models": response({ object: "list", data: [] }),
    "/api/tags": response({ models: [] }),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend(null), "ollama");
});

test("a server without /api/tags is not classified as ollama", async () => {
  const paths = {
    "/v1/models": response({ data: [{ id: "m", owned_by: "organization_owner" }] }),
    "/api/tags": response({}, 404),
  };
  const probe = probeWith(paths);
  assert.equal(await probe._classifyOpenAIBackend("organization_owner"), "vllm");
});

test("a classified Ollama server is not probed on /metrics or /slots", async () => {
  const fetched = [];
  const probe = new LlmProbe(spark(), 11434);
  probe.backendType = "ollama";
  probe.serverIsOpenAI = true;
  probe._fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith("/v1/models")) {
      return response({ object: "list", data: [{ id: "qwen3:27b", owned_by: "library" }] });
    }
    if (String(url).endsWith("/api/tags")) {
      return response({ models: [{ name: "qwen3:27b", model: "qwen3:27b", size: 17179869184 }] });
    }
    return response({}, 404);
  };
  await probe._probeOpenAICompatible();
  assert.ok(!fetched.some((u) => u.endsWith("/metrics")), `probed /metrics: ${fetched.join(", ")}`);
  await probe._detectServerType();
  assert.ok(!fetched.some((u) => u.endsWith("/slots")), `probed /slots: ${fetched.join(", ")}`);
  assert.equal(probe.backendType, "ollama");
});
