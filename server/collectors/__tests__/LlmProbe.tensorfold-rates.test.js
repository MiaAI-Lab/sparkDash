import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function fixture(livePrefill = 0) {
  let sample = { prompt: 1000, seconds: 1, count: 1, generated: 100 };
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.backendType = "tensorfold";
  probe._fetch = async (url) => {
    if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "test-model", owned_by: "tensorfold" }] }) };
    if (url.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ status: "ok", max_batch_size: 16, live: { connections: 3, waiting: 0, decode_tokens_per_second: 7, prefill_tokens_per_second: livePrefill } }) };
    assert.ok(url.endsWith("/metrics"), url);
    return { ok: true, status: 200, text: async () => [
      `tensorfold:prompt_tokens_total ${sample.prompt}`,
      `tensorfold:generation_tokens_total ${sample.generated}`,
      "tensorfold:generation_tokens_running 50",
      "tensorfold:requests_running 3",
      "tensorfold:requests_waiting 0",
      `tensorfold:request_prefill_seconds_sum ${sample.seconds}`,
      `tensorfold:request_prefill_seconds_count ${sample.count}`,
    ].join("\n") };
  };
  return { probe, next: (patch) => { sample = { ...sample, ...patch }; }, poll: async () => {
    probe.lastProbeTime = Date.now() - 2000;
    return probe._probeOpenAICompatible();
  } };
}

test("TensorFold live decode must not disable separately labelled completion prefill", async () => {
  const f = fixture();
  await f.poll();
  f.next({ prompt: 11000, seconds: 1.5, count: 2, generated: 1100 });
  const snap = await f.poll();
  assert.equal(snap.generationTps, 7); // Not the /metrics counter-delta spike.
  assert.equal(snap.prefillTps, 20000); // Preserve existing effective arithmetic; cache exclusion is separate.
  assert.equal(snap.prefillTpsSource, "completed-effective");
  assert.equal(snap.perStreamPrefillTps, 20000);
  assert.equal(snap.requestsRunning, 3);
  assert.equal(snap.prefillActive, false); // Do not infer a phase from mixed aggregate requests.
  assert.equal((await f.poll()).prefillTps, 20000);
  f.probe._tensorfoldPrefillMeasuredAt = Date.now() - 21000;
  const expired = await f.poll();
  assert.equal(expired.prefillTpsSource, null);
  assert.equal(expired.perStreamPrefillTps, null);
});

test("TensorFold positive live prefill stays authoritative over completion history", async () => {
  const f = fixture(1234);
  await f.poll();
  f.next({ prompt: 11000, seconds: 1.5, count: 2 });
  const snap = await f.poll();
  assert.equal(snap.prefillTps, 1234);
  assert.equal(snap.prefillTpsSource, "live");
});
