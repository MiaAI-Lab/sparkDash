/**
 * Detection re-runs every minute. An engine that names itself in /v1/models `owned_by` must be
 * classified from that card alone: probing LM Studio's /api/v0/models or Ollama's /api/tags on it
 * logs a 404 per minute in the engine (5,196 of them in four days on a Locals server).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function engineFetch(ownedBy, requested) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    if (path === "/v1/models") {
      const payload = { data: [{ id: "m", owned_by: ownedBy }] };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

for (const [ownedBy, backend] of [
  ["locals", "locals"],
  ["splash", "splash"],
  ["tensorfold", "tensorfold"],
]) {
  test(`owned_by ${ownedBy} is classified as ${backend} without probing LM Studio or Ollama paths`, async () => {
    const requested = [];
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
    probe._fetch = engineFetch(ownedBy, requested);
    await probe._detectServerType();
    assert.equal(probe.backendType, backend);
    assert.deepEqual(
      requested.filter((p) => p === "/api/v0/models" || p === "/api/tags"),
      []
    );
  });
}

// Ollama reports a model's namespace as owned_by, which can contain an engine's name: only an
// owned_by that is exactly an engine's name may skip the probes.
test("Ollama whose model namespace contains an engine name still classifies as ollama", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 11434);
  probe._fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const json = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    if (path === "/v1/models") return json({ data: [{ id: "splashai/m:latest", owned_by: "splashai" }] });
    if (path === "/api/tags") return json({ models: [{ name: "splashai/m:latest" }] });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "ollama");
});

// Detection asks each probe once per pass. A second identical /api/tags call is a wasted request
// every minute on every engine that is not Ollama (the 404-spam shape #282 was about).
test("an engine that names no backend probes Ollama's /api/tags once, not twice", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8030);
  probe._fetch = engineFetch("some-router", requested);
  await probe._detectServerType();
  assert.equal(probe.backendType, "vllm");
  assert.equal(requested.filter((p) => p === "/api/tags").length, 1);
});
