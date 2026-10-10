import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LlmProbe } from "../LlmProbe.js";

async function fixture(t) {
  const state = { models: [], status: 200, slotsReads: 0, versionStatus: 200, versionBody: { version: "0.6.5" }, ownedBy: "library" };
  const server = http.createServer((req, res) => {
    let body;
    if (req.url === "/v1/models") body = { data: [{ id: "installed:8b", owned_by: state.ownedBy }] };
    else if (req.url === "/api/version") { res.statusCode = state.versionStatus; body = state.versionBody; }
    else if (req.url === "/api/ps") { res.statusCode = state.status; body = { models: state.models }; }
    else { res.statusCode = 404; body = {}; if (req.url === "/slots") state.slotsReads++; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const probe = new LlmProbe({ isLocal: true }, server.address().port);
  return { probe, state };
}

test("Ollama reports the loaded model instead of the first installed model", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:27b", context_length: 32768, size_vram: 1234 }];
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.equal(snap.available, true);
  assert.equal(snap.endpointReachable, true);
  assert.equal(snap.modelId, "loaded:27b");
  assert.deepEqual(snap.models, ["loaded:27b"]);
  assert.equal(snap.contextLength, 32768);
  assert.equal(snap.totalOutputTokens, null);
  assert.equal(snap.requestsRunning, null);
});

test("Ollama unload clears residency without losing backend detection", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ model: "loaded:8b", context_length: 4096 }];
  await probe.probe();
  state.models = [];
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.equal(snap.available, false);
  assert.equal(snap.endpointReachable, true);
  assert.equal(snap.modelId, null);
  assert.equal(snap.contextLength, null);
  assert.deepEqual(snap.models, []);
  probe._lastDetectAt = 0;
  await probe.probe();
  assert.equal(state.slotsReads, 1);
});

test("Ollama auth failure and malformed residency never keep stale models", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:8b" }];
  await probe.probe();
  state.status = 401;
  let snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.deepEqual(snap.models, []);
  assert.equal(snap.endpointReachable, false);
  assert.equal(snap.liveRatesAvailable, false);
  assert.equal(snap.totalOutputTokens, null);
  state.status = 200;
  state.models = {};
  snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.deepEqual(snap.models, []);
  assert.equal(snap.endpointReachable, false);
  assert.equal(snap.liveRatesAvailable, false);
  assert.equal(snap.totalOutputTokens, null);
});

test("Ollama periodic redetection retains native residency through failed or malformed version probes", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:27b" }];
  assert.equal((await probe.probe()).backend, "ollama");
  for (const version of [{ status: 503, body: {} }, { status: 200, body: { version: false } }]) {
    state.versionStatus = version.status;
    state.versionBody = version.body;
    probe._lastDetectAt = 0;
    const snap = await probe.probe();
    assert.equal(snap.backend, "ollama");
    assert.deepEqual(snap.models, ["loaded:27b"]);
    assert.equal(snap.liveRatesAvailable, false);
    assert.equal(snap.endpointReachable, true);
  }
});

test("a known Ollama endpoint can switch on positive identification of another backend", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:27b" }];
  assert.equal((await probe.probe()).backend, "ollama");
  state.ownedBy = "vllm";
  state.versionStatus = 404;
  probe._lastDetectAt = 0;
  const snap = await probe.probe();
  assert.equal(snap.backend, "vllm");
  assert.deepEqual(snap.models, ["installed:8b"]);
  assert.equal(snap.liveRatesAvailable, true);
});

test("Ollama periodic redetection retains native residency when the version request times out", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:27b" }];
  assert.equal((await probe.probe()).backend, "ollama");
  const fetch = probe._fetch.bind(probe);
  probe._fetch = (url) => {
    if (url.endsWith("/api/version")) throw new DOMException("Timed out", "TimeoutError");
    return fetch(url);
  };
  probe._lastDetectAt = 0;
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.deepEqual(snap.models, ["loaded:27b"]);
  assert.equal(snap.liveRatesAvailable, false);
});

test("Ollama unavailable residency keeps capability metadata without stale measurements", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "loaded:8b" }];
  await probe.probe();
  state.status = 503;
  const snap = await probe.probe();
  assert.equal(snap.backend, "ollama");
  assert.equal(snap.available, false);
  assert.equal(snap.endpointReachable, false);
  assert.equal(snap.liveRatesAvailable, false);
  assert.equal(snap.totalOutputTokens, null);
  assert.deepEqual(snap.models, []);
});

test("Ollama exposes all loaded IDs but no shared context for several models", async (t) => {
  const { probe, state } = await fixture(t);
  state.models = [{ name: "a:8b", context_length: 4096 }, { model: "b:8b", context_length: 8192 }];
  const snap = await probe.probe();
  assert.deepEqual(snap.models, ["a:8b", "b:8b"]);
  assert.equal(snap.contextLength, null);
});
