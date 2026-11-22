/**
 * llama-swap (mostlygeek/llama-swap) fronts one engine at a time. The card must show the loaded
 * model with its engine's own rates, read from the engine's port: a poll through llama-swap's
 * proxy would reset the model's TTL (keeping it loaded forever) or start an unloaded model.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { LlmProbe, llamaSwapEnginePort } from "../LlmProbe.js";

const LOCAL = { id: "spark", isLocal: true, lanIp: "127.0.0.1" };

/** llama-swap's /v1/models: every configured model, loaded or not, alphabetical. */
const SWAP_MODELS = {
  object: "list",
  data: [
    { id: "A-unloaded-model", object: "model", owned_by: "llama-swap", status: { value: "unloaded" } },
    { id: "B-loaded-model", object: "model", owned_by: "llama-swap", status: { value: "loaded" } },
  ],
};

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return server.address().port;
}

function json(res, body) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** A llama-swap stand-in; `running()` returns the /running list. Records every path asked for. */
async function llamaSwap(t, running) {
  const paths = [];
  const port = await listen(t, (req, res) => {
    paths.push(req.url);
    if (req.url === "/v1/models") return json(res, SWAP_MODELS);
    if (req.url === "/running") return json(res, { running: running() });
    if (req.url === "/health") return res.end("OK");
    res.statusCode = 404;
    res.end();
  });
  return { port, paths };
}

/** A TensorFold engine stand-in, shaped like tensorfold-native serve's answers. */
async function tensorFold(t) {
  return listen(t, (req, res) => {
    if (req.url === "/v1/models") {
      return json(res, { object: "list", data: [{ id: "engine-served-name", owned_by: "tensorfold", context_length: 131072 }] });
    }
    if (req.url === "/health") {
      return json(res, {
        status: "ok",
        model: "engine-served-name",
        live: { connections: 1, waiting: 0, decode_tokens_per_second: 42.5, prefill_tokens_per_second: 1500 },
        version: "1.1.9",
      });
    }
    res.statusCode = 404;
    res.end();
  });
}

/** Stand-in for the engine probe, to watch its lifecycle without an engine. */
function fakeEngineProbe(port, log, snap = {}) {
  return {
    port,
    spark: null,
    setPort() {},
    async probe() {
      log.push(`probe:${port}`);
      return { port, available: true, backend: "tensorfold", modelId: "x", ...snap };
    },
    dispose() {
      log.push(`dispose:${port}`);
    },
  };
}

test("llamaSwapEnginePort: only a plain-http loopback proxy is this unit's engine", () => {
  assert.equal(llamaSwapEnginePort("http://localhost:25802"), 25802);
  assert.equal(llamaSwapEnginePort("http://127.0.0.1:8000/"), 8000);
  assert.equal(llamaSwapEnginePort("http://[::1]:9000"), 9000);
  assert.equal(llamaSwapEnginePort("http://192.0.2.7:8000"), null); // an engine on another machine
  assert.equal(llamaSwapEnginePort("https://localhost:8443"), null);
  assert.equal(llamaSwapEnginePort("http://localhost"), null);
  assert.equal(llamaSwapEnginePort(undefined), null);
});

test("owned_by llama-swap is classified as llama-swap and skips the /slots probe on re-detect", async () => {
  const probe = new LlmProbe(LOCAL, 18080);
  const seen = [];
  probe._fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/v1/models")) return { ok: true, status: 200, json: async () => SWAP_MODELS };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "llama-swap");
  seen.length = 0;
  await probe._detectServerType();
  assert.equal(seen.some((u) => u.endsWith("/slots")), false);
});

test("a ready model is read from its engine's own port: engine backend and rates, the configured port", async (t) => {
  const enginePort = await tensorFold(t);
  const swap = await llamaSwap(t, () => [{ model: "B-loaded-model", state: "ready", proxy: `http://localhost:${enginePort}` }]);
  const probe = new LlmProbe(LOCAL, swap.port);
  t.after(() => probe.dispose());

  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.port, swap.port); // the card stays keyed to the configured port
  assert.equal(snap.backend, "tensorfold");
  assert.equal(snap.modelId, "B-loaded-model"); // llama-swap's id: not data[0] of its list, not the engine's served name
  assert.equal(snap.generationTps, 42.5);
  assert.equal(snap.engineVersion, "1.1.9");
  // Only llama-swap's own endpoints were asked: none of them loads a model or resets its TTL
  // (the model-routed GETs are /props, /v1/realtime, /v1/audio/voices, /sdapi/v1/loras; /upstream proxies).
  const ownEndpoints = new Set(["/health", "/slots", "/v1/models", "/running"]);
  assert.deepEqual(swap.paths.filter((p) => !ownEndpoints.has(p)), []);
});

test("nothing loaded: an available, idle card with no model, and no engine is probed", async (t) => {
  const swap = await llamaSwap(t, () => []);
  const probe = new LlmProbe(LOCAL, swap.port);
  const log = [];
  probe._newEngineProbe = (port) => fakeEngineProbe(port, log);

  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.backend, "llama-swap");
  assert.equal(snap.modelId, null);
  assert.equal(snap.measurementValid, true); // idle is a measured state
  assert.deepEqual(log, []);
});

test("a starting model or an engine off this unit is named, with rates marked unmeasured", async (t) => {
  for (const entry of [
    { model: "B-loaded-model", state: "starting", proxy: "http://localhost:25802" },
    { model: "B-loaded-model", state: "ready", proxy: "http://192.0.2.7:25802" },
  ]) {
    const swap = await llamaSwap(t, () => [entry]);
    const probe = new LlmProbe(LOCAL, swap.port);
    const log = [];
    probe._newEngineProbe = (port) => fakeEngineProbe(port, log);
    const snap = await probe.probe();
    assert.equal(snap.available, true, JSON.stringify(entry));
    assert.equal(snap.modelId, "B-loaded-model");
    assert.equal(snap.measurementValid, false); // not a measured 0 tok/s
    assert.deepEqual(log, []);
  }
});

test("an engine that is not answering yet keeps the card available and its probe alive for the tunnel", async (t) => {
  const swap = await llamaSwap(t, () => [{ model: "B-loaded-model", state: "ready", proxy: "http://localhost:25802" }]);
  const probe = new LlmProbe(LOCAL, swap.port);
  const log = [];
  probe._newEngineProbe = (port) => fakeEngineProbe(port, log, { available: false });

  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(snap.modelId, "B-loaded-model");
  assert.equal(snap.measurementValid, false);
  assert.deepEqual(log, ["probe:25802"]); // not disposed: its own failures open its SSH tunnel
});

test("a swap disposes the old engine's probe, and dispose() closes the current one", async (t) => {
  let running = [{ model: "B-loaded-model", state: "ready", proxy: "http://localhost:25802" }];
  const swap = await llamaSwap(t, () => running);
  const probe = new LlmProbe(LOCAL, swap.port);
  const log = [];
  probe._newEngineProbe = (port) => fakeEngineProbe(port, log);

  await probe.probe();
  running = [{ model: "C-other-model", state: "ready", proxy: "http://localhost:25803" }];
  await probe.probe();
  assert.deepEqual(log, ["probe:25802", "dispose:25802", "probe:25803"]);

  probe.dispose();
  assert.deepEqual(log.at(-1), "dispose:25803");
});

test("the engine probe follows an edited spark and reports a bench on the configured port", async (t) => {
  const swap = await llamaSwap(t, () => [{ model: "B-loaded-model", state: "ready", proxy: "http://localhost:25802" }]);
  const asked = [];
  const probe = new LlmProbe(LOCAL, swap.port, { liveDecodeTps: (port) => (asked.push(port), null) });
  const engine = probe._newEngineProbe(25802);
  t.after(() => engine.dispose());
  engine._liveDecodeTps(engine.port);
  assert.deepEqual(asked, [swap.port]);

  const log = [];
  let built = null;
  probe._newEngineProbe = (port) => (built = fakeEngineProbe(port, log));
  const edited = { ...LOCAL, name: "renamed" };
  probe.spark = edited;
  await probe.probe();
  assert.equal(built.spark, edited);
});
