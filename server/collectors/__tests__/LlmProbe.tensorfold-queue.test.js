/**
 * Regression: a TensorFold /health with token totals but no live block (the Python
 * engine, e.g. GLM on two Sparks) keeps its queue gauge in /metrics alone — the
 * poll must read /metrics there too (queue-only), or the queue tile renders
 * "queue unknown" while the queue is in fact measurable.
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

function textRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
}

const GLM_MODELS = {
  object: "list",
  data: [{ id: "GLM-5.3-Flash-EXL3", object: "model", owned_by: "tensorfold" }],
};

// Shape captured from the Python engine's /health (GLM): token totals, streams,
// no `live` block, no waiting count.
const GLM_HEALTH = {
  ok: true,
  backend: "tensorfold",
  busy: true,
  requests_running: 3,
  requests_total: 30,
  completion_tokens_total: 2923,
  prompt_tokens_total: 1030863,
  prefill_seconds_total: 150.1,
  decode_seconds_total: 55.1,
  cached_tokens_total: 768768,
  rounds_total: 1132,
  drafted_total: 2866,
  accepted_total: 1761,
  streams: { decoding: 2, prefilling: 1, max: 6, filling: 0, paused: 0 },
  pool_tokens: 2416640,
  pool_free_tokens: 2152448,
  kept_prompts: 6,
  iteration_s: 0.0,
  context_length: 1048576,
};

// The Python engine's /metrics: the queue gauge exists only here. The other
// values deliberately differ from /health to prove the queue-only contract.
const GLM_METRICS = [
  "# HELP tensorfold:requests_running Requests in prefill or decode.",
  "# TYPE tensorfold:requests_running gauge",
  "tensorfold:requests_running 9",
  "# HELP tensorfold:requests_waiting Requests queued or held until a lane is free.",
  "# TYPE tensorfold:requests_waiting gauge",
  "tensorfold:requests_waiting 2",
  "# HELP tensorfold:generation_tokens_total Generated tokens of finished requests.",
  "# TYPE tensorfold:generation_tokens_total counter",
  "tensorfold:generation_tokens_total 999",
  "# HELP tensorfold:prompt_tokens_total Prompt tokens of finished requests.",
  "# TYPE tensorfold:prompt_tokens_total counter",
  "tensorfold:prompt_tokens_total 9999",
  "# HELP tensorfold:mtp_drafted_total Draft tokens.",
  "# TYPE tensorfold:mtp_drafted_total counter",
  "tensorfold:mtp_drafted_total 99",
  "# HELP tensorfold:mtp_accepted_total Accepted draft tokens.",
  "# TYPE tensorfold:mtp_accepted_total counter",
  "tensorfold:mtp_accepted_total 98",
  "",
].join("\n");

function glmProbe(withMetrics = true) {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) return jsonRes(GLM_MODELS);
    if (u.endsWith("/health")) return jsonRes(GLM_HEALTH);
    if (withMetrics && u.endsWith("/metrics")) return textRes(GLM_METRICS);
    return notFound();
  };
  return probe;
}

test("rich /health without a live block reads the queue from /metrics, queue-only", async () => {
  const probe = glmProbe();
  const snap = await probe.probe();
  // before the fix the rich /health gated /metrics off and the queue stayed unknown
  assert.equal(snap.requestsWaiting, 2); // the queue's only source is /metrics
  assert.equal(snap.requestsRunning, 3); // running stays /health's (9 in /metrics not applied)
  assert.equal(snap.totalOutputTokens, 2923); // totals stay /health's (999 not applied)
});

test("rich /health queue stays unknown when /metrics is unreachable", async () => {
  const probe = glmProbe(false);
  const snap = await probe.probe();
  assert.equal(snap.requestsWaiting, null);
});
