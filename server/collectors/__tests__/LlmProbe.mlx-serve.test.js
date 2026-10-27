/**
 * mlx-serve exports vLLM counters that move only at request completion; live
 * tok/s must come from its mlx_serve:*_live series instead.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const metrics = ({ prompt, gen, prefillDone, prefillLive, genLive, running }) => `vllm:prompt_tokens_total ${prompt}
vllm:generation_tokens_total ${gen}
vllm:num_requests_running ${running}
vllm:num_requests_waiting 0
mlx_serve:prefill_tokens_total ${prefillDone}
mlx_serve:prefill_tokens_live ${prefillLive}
mlx_serve:generation_tokens_live ${genLive}
`;

function mlxServeProbe(t) {
  const now = 10_000;
  t.mock.method(Date, "now", () => now);
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8010);
  probe.serverIsOpenAI = true;
  probe.backendType = "vllm";
  probe.authOpen = true;
  probe._lastDetectAt = now;
  let body = "";
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "DeepSeek-V4.1-Flash-iQ3-3.0bpw", max_model_len: 1048576 }] }) };
    }
    if (u.endsWith("/metrics")) return { ok: true, status: 200, text: async () => body };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return async (sample) => {
    body = metrics(sample);
    probe.lastProbeTime = now - 2000;
    return probe.probe();
  };
}

test("mlx-serve: prefill, decode, and completion read live series without a completion spike", async (t) => {
  const poll = mlxServeProbe(t);
  const base = { prompt: 8280, gen: 3, prefillDone: 8280, genLive: 3, running: 1 };

  await poll({ ...base, prefillLive: 70000 });
  let snap = await poll({ ...base, prefillLive: 72000 });
  assert.equal(snap.prefillTps, 1000);
  assert.ok(!snap.generationTps, `generationTps ${snap.generationTps}`);

  snap = await poll({ ...base, prefillLive: 0, prefillDone: 8280 + 74000, genLive: 63 });
  assert.equal(snap.prefillTps, 1000);
  assert.equal(snap.generationTps, 30);

  // Completion: vLLM counters jump by the whole request; rates must not spike.
  snap = await poll({ prompt: 82280, gen: 103, prefillDone: 82280, prefillLive: 0, genLive: 103, running: 0 });
  assert.ok(!snap.prefillTps, `prefillTps ${snap.prefillTps}`);
  assert.equal(snap.generationTps, 20);

  snap = await poll({ prompt: 82280, gen: 103, prefillDone: 82280, prefillLive: 0, genLive: 103, running: 0 });
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.generationTps, 0);
});

test("mlx-serve: a server restart (counters drop) reads 0, not negative", async (t) => {
  const poll = mlxServeProbe(t);
  await poll({ prompt: 5000, gen: 500, prefillDone: 5000, prefillLive: 0, genLive: 500, running: 0 });
  const snap = await poll({ prompt: 0, gen: 0, prefillDone: 0, prefillLive: 100, genLive: 0, running: 1 });
  assert.ok(snap.prefillTps >= 0 && snap.generationTps >= 0);
});

test("an mlx-serve endpoint that also answers Ollama's /api/tags is read as vLLM, not Ollama", async () => {
  // A model switch fronts mlx-serve and answers /api/tags for Ollama clients;
  // the explicit owned_by must win, or the engine shows as Ollama with no rates.
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8010);
  probe._fetch = async (url) => {
    if (String(url).endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "DeepSeek-V4.1-Flash-iQ3-3.0bpw:latest" }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  assert.equal(await probe._classifyOpenAIBackend("mlx-serve"), "vllm");
});

test("mlx-serve live rates re-seed after unreadable metrics and long gaps", () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" });
  const sample = (n) => metrics({ prompt: n, gen: n, prefillDone: n, prefillLive: 0, genLive: n, running: 1 });
  probe._applyMlxServeLiveRates(sample(100), 2);
  probe._applyMlxServeLiveRates(sample(200), 2);
  assert.equal(probe.generationTps, 50);
  probe._markUnmeasured("metrics read failed");
  probe._applyMlxServeLiveRates(sample(2000), 2);
  assert.equal(probe.generationTps, 0);
  probe._applyMlxServeLiveRates(sample(4000), 30);
  assert.equal(probe.generationTps, 0);
  probe._applyMlxServeLiveRates(sample(4100), 2);
  assert.equal(probe.generationTps, 50);
});

test("mlx-serve live series are gated by the metrics helper", () => {
  assert.equal(
    LlmProbe._metricsLookLikeMlxServe(metrics({ prompt: 1, gen: 1, prefillDone: 0, prefillLive: 0, genLive: 0, running: 0 })),
    true
  );
  assert.equal(
    LlmProbe._metricsLookLikeMlxServe("vllm:prompt_tokens_total 1\nvllm:generation_tokens_total 1\n"),
    false
  );
});
