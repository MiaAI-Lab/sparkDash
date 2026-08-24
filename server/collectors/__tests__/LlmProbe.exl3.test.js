/**
 * Unit tests for EXL3 tools/serve_openai.py detection and /health tok/s.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notFound() {
  return {
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "",
  };
}

test("_healthLooksLikeExl3: backend field or ok+busy", () => {
  assert.equal(LlmProbe._healthLooksLikeExl3({ backend: "exl3" }), true);
  assert.equal(LlmProbe._healthLooksLikeExl3({ ok: true, busy: false }), true);
  assert.equal(LlmProbe._healthLooksLikeExl3({ status: "ok" }), false);
  assert.equal(LlmProbe._healthLooksLikeExl3(null), false);
});

test("_detectServerType: owned_by exl3 → exl3", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        data: [{ id: "qwen3.8-27b-exl3-3.5bpw-wm", owned_by: "exl3" }],
      });
    }
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.serverIsOpenAI, true);
  assert.equal(probe.backendType, "exl3");
});

test("_detectServerType: OpenAI models + /health ok+busy → exl3 (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        data: [{ id: "qwen3.8-27b-exl3-3.5bpw-wm", owned_by: "local" }],
      });
    }
    if (u.endsWith("/metrics")) return notFound();
    if (u.endsWith("/get_server_info") || u.endsWith("/server_info")) return notFound();
    if (u.endsWith("/health")) {
      return jsonRes({
        ok: true,
        busy: true,
        backend: "exl3",
        prompt_tokens_total: 10,
        completion_tokens_total: 20,
      });
    }
    return notFound();
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "exl3");
});

test("_applyExl3Health: counter diffs → tok/s; idle → 0", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._applyExl3Health(
    {
      ok: true,
      busy: true,
      backend: "exl3",
      prompt_tokens_total: 100,
      completion_tokens_total: 50,
      context_length: 65536,
    },
    2
  );
  assert.equal(probe.totalOutputTokens, 50);
  assert.equal(probe.contextLength, 65536);
  assert.equal(probe.slotsActive, 1);

  probe._applyExl3Health(
    {
      ok: true,
      busy: false,
      backend: "exl3",
      prompt_tokens_total: 100,
      completion_tokens_total: 50,
      context_length: 65536,
    },
    2
  );
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.slotsActive, 0);

  probe._applyExl3Health(
    {
      ok: true,
      busy: true,
      backend: "exl3",
      prompt_tokens_total: 180,
      completion_tokens_total: 90,
      context_length: 65536,
    },
    2
  );
  assert.equal(probe.generationTps, 20);
  assert.equal(probe.prefillTps, 40);
});

test("probe: exl3 path does not mislabel as vllm", async (t) => {
  const now = 10_000;
  t.mock.method(Date, "now", () => now);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = "exl3";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  probe.lastProbeTime = now - 2000;
  probe.lastTokenCounts = { input: 100, output: 50 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        data: [
          {
            id: "qwen3.8-27b-exl3-3.5bpw-wm",
            owned_by: "exl3",
            max_model_len: 65536,
          },
        ],
      });
    }
    if (u.endsWith("/health")) {
      return jsonRes({
        ok: true,
        busy: true,
        backend: "exl3",
        prompt_tokens_total: 140,
        completion_tokens_total: 90,
        context_length: 65536,
      });
    }
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.backend, "exl3");
  assert.equal(snap.generationTps, 20);
  assert.equal(snap.prefillTps, 20);
  assert.equal(snap.available, true);
});
