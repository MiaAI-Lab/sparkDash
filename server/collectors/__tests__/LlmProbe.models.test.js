import { test } from "node:test";
import { strict as assert } from "node:assert";

const { LlmProbe } = await import(process.env.PICKER_PROBE_MODULE || "../LlmProbe.js");
const response = (body, status = 200) => ({
  ok: status === 200, status, json: async () => body, text: async () => "",
});

function setup(records, backend = "vllm") {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" });
  probe.serverIsOpenAI = true;
  probe.backendType = backend;
  probe._lastDetectAt = Date.now();
  const state = { records, status: 200 };
  probe._fetch = async (url) => {
    if (url.endsWith("/v1/models")) return response({ data: state.records }, state.status);
    if (url.endsWith("/server_info")) return response({ model_path: "/native/model", context_length: 65536 });
    if (url.endsWith("/model_info")) return response({ model_path: "/native/enriched", context_length: 131072 });
    return response({}, 404);
  };
  return { probe, state };
}

test("routers publish real ordered IDs and no shared context after native enrichment", async () => {
  const { probe } = setup([
    { id: "alpha", owned_by: "sglang", max_model_len: 4096 },
    { id: "beta" }, { id: "gamma" },
  ], "sglang");
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.modelId, "alpha");
  assert.deepEqual(snap.models, ["alpha", "beta", "gamma"]);
  assert.equal(snap.contextLength, null);
  assert.equal(snap.modelPath, "/native/enriched");
});

test("plain routers have no invented path and preserve exact request values", async () => {
  const raw = "/root/models--org--name/snapshots/abc";
  const { probe } = setup([{ id: raw }, { id: " beta " }]);
  const snap = await probe.probe();
  assert.equal(snap.modelId, raw);
  assert.equal(snap.modelPath, null);
  assert.deepEqual(snap.models, [raw, " beta "]);
});

test("single model keeps upstream display normalization and context metadata", async () => {
  const raw = "/root/models--org--name/snapshots/abc";
  const { probe } = setup([{ id: raw, max_model_len: 8192 }]);
  const snap = await probe.probe();
  assert.equal(snap.modelId, "org/name");
  assert.deepEqual(snap.models, [raw]);
  assert.equal(snap.contextLength, 8192);
  assert.equal(snap.modelPath, null);
});

test("ignores malformed IDs, deduplicates in order and keeps first valid metadata", async () => {
  const { probe } = setup([
    null, { id: 123 }, { id: "" }, { id: "  " }, {},
    { id: "alpha", max_model_len: 8192 },
    { id: "alpha", max_model_len: 999 },
  ]);
  const snap = await probe.probe();
  assert.deepEqual(snap.models, ["alpha"]);
  assert.equal(snap.modelId, "alpha");
  assert.equal(snap.contextLength, 8192);
});

test("empty and malformed lists clear previously served IDs", async () => {
  const { probe, state } = setup([{ id: "alpha", context_length: 4096 }]);
  await probe.probe();
  for (const records of [[], null, {}, [{ id: false }]]) {
    state.records = records;
    const snap = await probe.probe();
    assert.deepEqual(snap.models, []);
    assert.equal(snap.modelId, null);
    assert.equal(snap.contextLength, null);
  }
});

test("failed and auth-denied discovery never publishes stale selections", async () => {
  for (const status of [401, 403, 500]) {
    const { probe, state } = setup([{ id: "alpha" }, { id: "beta" }]);
    await probe.probe();
    state.status = status;
    const snap = await probe.probe();
    assert.equal(snap.available, false);
    assert.deepEqual(snap.models, []);
    assert.deepEqual(probe.models, []);
  }
});

test("constructor, detection reset and target switch own an empty served list", async () => {
  const { probe } = setup([{ id: "alpha" }, { id: "beta" }]);
  assert.deepEqual(probe.models, []);
  assert.deepEqual(probe._defaultLlm().models, []);
  await probe.probe();
  probe._resetDetection();
  assert.deepEqual(probe.models, []);
  probe.serverIsOpenAI = true;
  await probe.probe();
  probe.setPort(9000);
  assert.deepEqual(probe.models, []);
  assert.equal(probe.modelId, null);
});
