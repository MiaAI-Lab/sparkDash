/**
 * vLLM reports its own version at GET /version. The probe reads it once per
 * cache window into `engineVersion`, leaves it null when the answer is missing
 * or malformed, and never asks backends that do not publish it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const VLLM_METRICS = "vllm:generation_tokens_total 100\nvllm:prompt_tokens_total 50\n";

const response = (body, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function setup({
  backend = "vllm",
  versionBody = { version: "0.11.0" },
  versionStatus = 200,
  healthBody = { ok: true },
} = {}) {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.serverIsOpenAI = true;
  probe.backendType = backend;
  probe._lastDetectAt = Date.now();
  const calls = [];
  probe._fetch = async (url) => {
    calls.push(String(url));
    if (url.endsWith("/v1/models")) return response({ data: [{ id: "fixture-model", max_model_len: 8192 }] });
    if (url.endsWith("/metrics")) return response(VLLM_METRICS);
    if (url.endsWith("/health")) return response(healthBody);
    if (url.endsWith("/version")) return response(versionBody, versionStatus);
    return response({}, 404);
  };
  return { probe, calls };
}

test("a vLLM unit reports the engine version from /version", async () => {
  const { probe, calls } = setup();
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "vllm");
  assert.equal(snap.engineVersion, "0.11.0");
  assert.equal(calls.filter((u) => u.endsWith("/version")).length, 1);
});

test("the version is reused inside the cache window instead of being asked every poll", async () => {
  const { probe, calls } = setup();
  await probe.probe();
  await probe.probe();
  await probe.probe();
  assert.equal(calls.filter((u) => u.endsWith("/version")).length, 1);
});

test("an engine that does not implement /version is asked once per cache window, not every poll", async () => {
  const { probe, calls } = setup({ versionStatus: 404 });
  await probe.probe();
  await probe.probe();
  assert.equal(calls.filter((u) => u.endsWith("/version")).length, 1);
  assert.equal(probe.engineVersion, null);
});

test("a failed or malformed /version leaves the field null without failing the probe", async () => {
  for (const options of [
    { versionStatus: 500 },
    { versionStatus: 404 },
    { versionBody: { version: 42 } },
    { versionBody: {} },
  ]) {
    const { probe } = setup(options);
    const snap = await probe.probe();
    assert.equal(snap.available, true, JSON.stringify(options));
    assert.equal(snap.engineVersion, null, JSON.stringify(options));
  }
});

test("backends that do not publish /version are never asked for it", async () => {
  for (const backend of ["tensorfold", "q27", "sglang"]) {
    const { probe, calls } = setup({ backend });
    const snap = await probe.probe();
    assert.equal(calls.filter((u) => u.endsWith("/version")).length, 0, backend);
    assert.equal(snap.engineVersion, null, backend);
  }
});

test("a TensorFold unit reports the version its open /health names", async () => {
  const { probe, calls } = setup({ backend: "tensorfold", healthBody: { ok: true, version: "0.6.0" } });
  const snap = await probe.probe();
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.engineVersion, "0.6.0");
  assert.equal(calls.filter((u) => u.endsWith("/version")).length, 0);
});

test("a TensorFold build that omits or malforms the version leaves the field null", async () => {
  for (const healthBody of [
    { ok: true },
    { status: "ok" },
    { ok: true, version: 42 },
    { ok: true, version: "  " },
  ]) {
    const { probe } = setup({ backend: "tensorfold", healthBody });
    const snap = await probe.probe();
    assert.equal(snap.engineVersion, null, JSON.stringify(healthBody));
  }
});

test("redetection clears a version read from a previous backend", async () => {
  const { probe } = setup();
  await probe.probe();
  assert.equal(probe.engineVersion, "0.11.0");
  probe._resetDetection();
  assert.equal(probe.engineVersion, null);
  // A later probe of a backend that does not publish /version keeps it cleared.
  probe.backendType = "tensorfold";
  probe.serverIsOpenAI = true;
  probe._lastDetectAt = Date.now();
  const snap = await probe.probe();
  assert.equal(snap.engineVersion, null);
});

// A version is a measurement like any other: once the probe stops measuring, the chip must
// not keep presenting the last value it read, which is why `models` is cleared the same way.
test("a probe that is no longer measuring reports no version", async () => {
  const { probe } = setup();
  const live = await probe.probe();
  assert.equal(live.engineVersion, "0.11.0");
  assert.equal(live.available, true);

  // An API key added to a previously open endpoint: still vLLM, no longer readable.
  probe.authOpen = false;
  const closed = probe._getSnapshot();
  assert.equal(closed.available, false);
  assert.equal(closed.engineVersion, null, "a closed endpoint must not report a cached version");
  assert.deepEqual(closed.models, []);
  // The value is retained internally, so one readable poll restores it without a refetch.
  assert.equal(probe.engineVersion, "0.11.0");
});
