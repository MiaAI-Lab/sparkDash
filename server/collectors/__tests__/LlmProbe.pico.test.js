/**
 * Pico support: an OpenAI-compatible engine that names only its model namespace
 * (`owned_by: "dsgb10"`, DeepSeek on GB10) and publishes no telemetry at all —
 * no /metrics, no /slots, no stats endpoint. Classification must come from the
 * card alone (no 404-spamming probes), the poll must ask for nothing but the
 * model card, and the live rates must stay 0 rather than being invented.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

// Body captured from a live Pico serving DeepSeek V4.1 Flash on a DGX Spark.
const PICO_MODELS = {
  object: "list",
  data: [
    {
      id: "deepseek-v4.1-flash-1017",
      object: "model",
      created: 0,
      owned_by: "dsgb10",
      root: "deepseek-v4.1-flash-1017",
      max_model_len: 1048576,
    },
  ],
};

/** Tracks every path the probe asks for; everything but /v1/models answers 404 (Pico's real surface). */
function picoFetch(requested) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    if (path === "/v1/models") {
      return { ok: true, status: 200, json: async () => PICO_MODELS, text: async () => JSON.stringify(PICO_MODELS) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

test("owned_by dsgb10 classifies as pico without probing LM Studio or Ollama paths", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = picoFetch(requested);
  await probe._detectServerType();
  assert.equal(probe.backendType, "pico");
  // Detection re-runs every minute: the engine must not see a 404 per probe
  // for LM Studio's or Ollama's native paths (the shape #282 was about).
  assert.deepEqual(
    requested.filter((p) => p === "/api/v0/models" || p === "/api/tags"),
    []
  );
});

test("a poll asks Pico for nothing but the model card and invents no rates", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = picoFetch(requested);
  await probe._detectServerType();
  requested.length = 0; // only the poll pass is under test here
  const snap = await probe._probeOpenAICompatible();
  assert.equal(probe.backendType, "pico");
  assert.equal(snap.modelId, "deepseek-v4.1-flash-1017");
  assert.equal(snap.contextLength, 1048576);
  // No /metrics (there is none), no /version (not vLLM), no /slots, no /health re-probe.
  assert.deepEqual(requested, ["/v1/models"]);
  // Pico publishes no counters: the panel shows 0 with no active states, never a guessed rate.
  assert.equal(snap.generationTps, 0);
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.decodeActive, false);
  assert.equal(snap.prefillActive, false);
  assert.equal(snap.totalOutputTokens, 0);
});

test("a poll self-heals an earlier vLLM label from the Pico card", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = picoFetch(requested);
  probe.backendType = "vllm";
  await probe._probeOpenAICompatible();
  assert.equal(probe.backendType, "pico");
  assert.deepEqual(requested, ["/v1/models"]);
});

// "dsgb10" is a namespace tag, so the match must be exact: another engine's
// namespace that merely contains it must not read as Pico.
test("an owned_by that only contains dsgb10 is not Pico", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requested.push(path);
    if (path === "/v1/models") {
      const payload = { data: [{ id: "m", owned_by: "xdsgb10-router" }] };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "vllm");
});

// ─── Stream-sample (opt-in) ─────────────────────────────
const encoder = new TextEncoder();

function sseBody(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

const deltaChunk = (text) =>
  `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] })}\n\n`;

const usageTail =
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } })}\n\n` +
  "data: [DONE]\n\n";

/** Models card plus an opt-in sample endpoint; every request is recorded with its parsed body. */
function picoFetchWithSample(requested, { sampleStatus = 200, stream } = {}) {
  return async (url, _timeoutMs, init) => {
    const path = new URL(String(url)).pathname;
    requested.push({ path, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (path === "/v1/models") {
      return { ok: true, status: 200, json: async () => PICO_MODELS, text: async () => JSON.stringify(PICO_MODELS) };
    }
    if (path === "/v1/chat/completions") {
      if (sampleStatus !== 200) return { ok: false, status: sampleStatus, body: null };
      return { ok: true, status: 200, body: stream() };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

/** Deterministic clock: 100 ms per call, so 6 visible tokens span a 500 ms window → 10 tok/s. */
function fakeClock() {
  let ticks = 0;
  return () => 1_000_000 + (ticks += 1) * 100;
}

const SAMPLE_STREAM = () => sseBody([deltaChunk("ready"), deltaChunk(" "), deltaChunk("for"), deltaChunk(" you"), deltaChunk(" now"), deltaChunk("."), usageTail]);

function sampleOptions(overrides = {}) {
  return {
    streamSampleEnabled: () => true,
    streamSampleMinIntervalMs: 15_000,
    now: fakeClock(),
    ...overrides,
  };
}

test("with sampling off (default) a poll sends no sample request", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  await probe.probe();
  assert.equal(probe.backendType, "pico");
  assert.deepEqual(requested.filter((r) => r.path === "/v1/chat/completions"), []);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.generationTpsSource, null);
});

test("the stream sample measures decode tok/s from the token window and labels it probe-sample", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions());
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  const snap = await probe.probe();
  assert.equal(probe.backendType, "pico");
  assert.equal(probe.generationTps, 10);
  assert.equal(probe.generationTpsSource, "probe-sample");
  assert.equal(snap.generationTps, 10);
  assert.equal(snap.generationTpsSource, "probe-sample");
  // The sample request is a tiny, greedy, non-thinking streamed completion.
  const sample = requested.find((r) => r.path === "/v1/chat/completions");
  assert.equal(sample.method, "POST");
  assert.equal(sample.body.max_tokens, 128);
  assert.equal(sample.body.temperature, 0);
  assert.equal(sample.body.stream, true);
  assert.equal(sample.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(sample.body.messages[0].content, "Count from 1 to 60, with each number separated by a single space. Output only the numbers.");
});

test("samples respect the minimum interval: back-to-back polls sample once", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions());
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  await probe.probe();
  await probe.probe();
  assert.equal(requested.filter((r) => r.path === "/v1/chat/completions").length, 1);
  // An idle poll must not replay the previous completion as current throughput.
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.generationTpsSource, "probe-sample");
});

test("sampling pauses while a bench, showcase or launch owns the unit", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({ streamSampleBlocked: () => true }));
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  await probe.probe();
  assert.deepEqual(requested.filter((r) => r.path === "/v1/chat/completions"), []);
});

test("a failed sample does not replay the previous rate or fail the poll", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({ streamSampleMinIntervalMs: 0 }));
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  await probe.probe();
  assert.equal(probe.generationTps, 10);
  // The endpoint stops answering samples; the poll itself still succeeds.
  probe._fetch = picoFetchWithSample([], { sampleStatus: 503 });
  const snap = await probe.probe();
  assert.equal(snap.available, true);
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.measurementValid, false);
});

test("a degenerate sample window does not replay the previous rate", async () => {
  const requested = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({ streamSampleMinIntervalMs: 0 }));
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  await probe.probe();
  assert.equal(probe.generationTps, 10);
  const single = () => sseBody([deltaChunk("ok"), `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 1 } })}\n\n`, "data: [DONE]\n\n"]);
  probe._fetch = picoFetchWithSample([], { stream: single });
  await probe.probe();
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.measurementValid, false);
});

test("disabling or blocking sampling clears the last decode rate", async () => {
  for (const mode of ["disabled", "blocked"]) {
    let enabled = true;
    let blocked = false;
    const requested = [];
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({
      streamSampleEnabled: () => enabled,
      streamSampleBlocked: () => blocked,
    }));
    probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
    await probe.probe();
    assert.equal(probe.generationTps, 10);
    enabled = mode !== "disabled";
    blocked = mode === "blocked";
    const snap = await probe.probe();
    assert.equal(snap.generationTps, 0);
    assert.equal(snap.decodeActive, false);
    assert.equal(requested.filter((r) => r.path === "/v1/chat/completions").length, 1);
  }
});

test("Pico uses its port's dashboard stream rate while synthetic sampling is blocked", async () => {
  for (const enabled of [true, false]) {
    const requested = [];
    let liveRate = 75;
    const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({
      streamSampleEnabled: () => enabled,
      streamSampleBlocked: () => true,
      liveDecodeTps: (port) => { assert.equal(port, 8888); return liveRate; },
    }));
    probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
    const active = await probe.probe();
    assert.equal(active.generationTps, 75);
    assert.equal(active.generationTpsSource, "dashboard-stream");
    assert.equal(active.decodeActive, true);
    liveRate = null;
    const idle = await probe.probe();
    assert.equal(idle.generationTps, 0);
    assert.equal(idle.decodeActive, false);
    assert.ok(idle.generationTpsSource);
    assert.equal(requested.filter((r) => r.path === "/v1/chat/completions").length, 0);
  }
});

// ─── The engine front end's own request log ─────────────
/** Stands in for PicoFrontLog: what the log follower reports on each poll. */
function fakeLog(answers) {
  const calls = { polls: 0, resets: 0 };
  return {
    calls,
    poll: async () => { calls.polls += 1; const next = answers.shift(); if (next instanceof Error) throw next; return next ?? null; },
    reset: () => { calls.resets += 1; },
  };
}
const logged = (generationTps, output = 0) => ({
  generationTps, totalOutputTokens: output, totalPromptTokens: output * 40, totalCachedTokens: output * 30,
});

test("Pico's decode comes from the engine log when it can be followed, with its token totals", async () => {
  const requested = [];
  const log = fakeLog([logged(131.5, 1421), logged(0, 1421), null]);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { picoLog: (port) => { assert.equal(port, 8888); return log; } });
  probe._fetch = picoFetch(requested);
  const active = await probe.probe();
  assert.equal(active.backend, "pico");
  assert.equal(active.generationTps, 131.5);
  assert.equal(active.generationTpsSource, "engine-log");
  assert.equal(active.decodeActive, true);
  assert.equal(active.totalOutputTokens, 1421);
  assert.equal(active.totalPromptTokens, 56840);
  assert.equal(active.totalCachedTokens, 42630);
  // Idle by the log: a measured zero, still attributed to the log.
  const idle = await probe.probe();
  assert.equal(idle.generationTps, 0);
  assert.equal(idle.generationTpsSource, "engine-log");
  assert.equal(idle.decodeActive, false);
  assert.equal(idle.totalOutputTokens, 1421);
  // The log cannot be followed: no figure and no source, and the totals do not step back.
  const lost = await probe.probe();
  assert.equal(lost.generationTps, 0);
  assert.equal(lost.generationTpsSource, null);
  assert.equal(lost.totalOutputTokens, 1421);
  // The figures came from the log: the engine was asked for no counters and sent no completion.
  assert.deepEqual(requested.filter((p) => p === "/metrics" || p === "/v1/chat/completions"), []);
});

test("the dashboard's own live stream outranks the log; the log outranks a synthetic sample", async () => {
  const requested = [];
  let liveRate = 75;
  const log = fakeLog([logged(140, 100), logged(140, 200), logged(0, 200)]);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, sampleOptions({
    liveDecodeTps: () => liveRate,
    picoLog: log,
  }));
  probe._fetch = picoFetchWithSample(requested, { stream: SAMPLE_STREAM });
  const bench = await probe.probe();
  assert.equal(bench.generationTps, 75);
  assert.equal(bench.generationTpsSource, "dashboard-stream");
  assert.equal(bench.totalOutputTokens, 100); // the log still counts what finished
  liveRate = null;
  const traffic = await probe.probe();
  assert.equal(traffic.generationTps, 140);
  assert.equal(traffic.generationTpsSource, "engine-log");
  // Real traffic was measured, so no synthetic completion was sent on top of it.
  assert.equal(requested.filter((r) => r.path === "/v1/chat/completions").length, 0);
  // Idle by the log with sampling on: the opt-in sample behaves as it did before.
  const idle = await probe.probe();
  assert.equal(idle.generationTpsSource, "probe-sample");
  assert.equal(requested.filter((r) => r.path === "/v1/chat/completions").length, 1);
});

test("a failing log follower never fails the probe, and is reset with the detection state", async () => {
  const requested = [];
  const log = fakeLog([new Error("ssh down"), logged(50, 10)]);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { picoLog: log });
  probe._fetch = picoFetch(requested);
  const failed = await probe.probe();
  assert.equal(failed.available, true);
  assert.equal(failed.generationTps, 0);
  assert.equal(failed.generationTpsSource, null);
  assert.equal((await probe.probe()).totalOutputTokens, 10);
  probe._resetDetection();
  assert.equal(log.calls.resets, 1);
  assert.equal(probe.totalOutputTokens, 0);
});

test("the log follower is polled for Pico only", async () => {
  const log = fakeLog([logged(99, 99)]);
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { picoLog: log });
  probe._fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/models") {
      const payload = { data: [{ id: "m", owned_by: "vllm" }] };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const snap = await probe.probe();
  assert.notEqual(snap.backend, "pico");
  assert.equal(log.calls.polls, 0);
  assert.notEqual(snap.generationTpsSource, "engine-log");
});
