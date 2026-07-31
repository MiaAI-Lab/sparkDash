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
