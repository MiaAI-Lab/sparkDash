import test from "node:test";
import assert from "node:assert/strict";
import { responseI18n, responseI18nResults, jobTextI18n, jobErrorI18n, eventI18n } from "./messages.js";
import { applicationTextI18n } from "../../src/shared/applicationText.js";
import { HealthEvaluator } from "../health/HealthEvaluator.js";
import { ARG_SPEC } from "../tooleval/spec.js";
import { buildToolEvalArgs } from "../tooleval/argv.js";
import fs from "node:fs";
import { applicationTextRequiredParams } from "../../src/shared/applicationText.js";

test("response boundary preserves English fields and adds a static descriptor", () => {
  const body = responseI18n({ error: "Spark not found" });
  assert.equal(body.error, "Spark not found");
  assert.deepEqual(body.i18n, { error: { key: "server.error.sparkNotFound" } });
});

test("browser parameter requirements stay synchronized with literal templates", () => {
  const source = fs.readFileSync(new URL("../../src/i18n/messages.ts", import.meta.url), "utf8");
  for (const match of source.matchAll(/t\("((?:server|health)\.[^"]+)", ("(?:\\.|[^"\\])*")/g)) {
    const required = [...new Set([...JSON.parse(match[2]).matchAll(/\{(\w+)[},]/g)].map(m => m[1]))];
    assert.deepEqual(applicationTextRequiredParams(match[1]), required, match[1]);
  }
});

test("every Tool Eval field validation has a recognized application descriptor", () => {
  for (const spec of ARG_SPEC) {
    const output = buildToolEvalArgs({ [spec.name]: { invalid: true } });
    for (const error of output.errors) assert.ok(applicationTextI18n(error), `${spec.name}: ${error}`);
  }
  for (const options of [{ "system-prompt": "test", "system-prompt-file": "/a" }, { "context-pressure": "0.1", "context-pressure-sweep": "0.2,0.3" }, { extra: ["--api-key", "sk-test"] }]) {
    for (const error of buildToolEvalArgs(options).errors) assert.ok(applicationTextI18n(error), error);
  }
});

test("response boundary leaves arbitrary result payloads and their references alone", () => {
  const original = { results: [{ id: "a", error: "Spark not found" }, { id: "b", message: "Shutdown initiated" }, { id: "c", error: "ssh timed out\nlast diagnostic line\n" }] };
  const output = responseI18n(original);
  assert.equal(output, original);
  assert.equal(output.results, original.results);
  assert.equal(original.results[0].i18n, undefined);
});

test("response boundary does not read a results getter", () => {
  const body = { ok: true };
  Object.defineProperty(body, "results", { get: () => { throw new Error("must not traverse results"); } });
  assert.equal(responseI18n(body), body);
});

test("explicit batch error boundary keeps raw fields and decorates known result rows", () => {
  const original = [{ id: "a", error: "Spark not found" }, { id: "b", message: "Shutdown initiated" }, { id: "c", error: "ssh timed out\nlast diagnostic line\n" }];
  const output = responseI18nResults(original);
  assert.equal(output[0].error, original[0].error);
  assert.equal(output[0].i18n.error.key, "server.error.sparkNotFound");
  assert.equal(output[1].i18n.message.key, "server.message.shutdownInitiated");
  assert.equal(output[2].i18n.error.params.detail, original[2].error);
  assert.equal(original[0].i18n, undefined);
});

test("authored progress and dynamic errors use the same recognizer as stored browser errors", () => {
  for (const text of ["Running concurrency 8…", "Prefilling 32k (run 2/3)…", "Long-context recall 16k…", "Opening SSH tunnel to 127.0.0.1:8000…", "Reading /v1/models…"]) {
    assert.deepEqual(jobTextI18n(text), applicationTextI18n(text));
    assert.notEqual(jobTextI18n(text).key, "server.progress.running");
  }
  for (const error of ["Invalid URL", "Invalid LLM port", "Spark abc not found", "maxTokens must be between 10 and 512"]) {
    assert.deepEqual(responseI18n({ error }).i18n.error, applicationTextI18n(error));
    assert.deepEqual(jobErrorI18n(error), applicationTextI18n(error));
  }
  assert.equal(applicationTextI18n("Installed (0.8.2)").params.version, "0.8.2");
  assert.equal(applicationTextI18n("Installed (0.8.2)\n"), undefined, "never partially match trailing output");
});

test("actual emitted event aliases and all benchmark and launcher phases have metadata", () => {
  const types = ["spark.online", "spark.offline", "spark.added", "spark.removed", "power.shutdown", "power.wake", "gpu.throttle.thermal", "gpu.throttle.cleared", "hermes.update.available", "hermes.update.success", "hermes.update.error", "health.thermal", "health.cleared"];
  for (const kind of ["decode", "prefill", "quality"]) for (const stage of ["finished", "failed", "cancelled"]) types.push(`bench.${kind}.${stage}`);
  for (const action of ["start", "stop", "attach"]) for (const stage of ["requested", "completed", "failed", "cancelled", "detached"]) types.push(`llm.${action}.${stage}`);
  for (const type of types) assert.ok(eventI18n({ type, sparkName: "Spark 1", message: "original" })?.message, type);
  assert.equal(eventI18n({ type: "external.command", message: "raw" }), undefined);
});

test("health descriptors retain exact thresholds, latest Xid and RoCE physical state", () => {
  const evaluator = new HealthEvaluator({ now: () => 10_000 });
  const thermal = evaluator.evaluate({ gpu: { temperature: 86 } })[0];
  assert.deepEqual(thermal.i18n.detail.params, { temperature: 86, warn: 85, critical: 90 });
  evaluator.evaluate({ gpu: { kernelErrors: { xid: 1, oomKills: 0 } } });
  const xid = evaluator.evaluate({ gpu: { kernelErrors: { xid: 2, oomKills: 0, lastXid: "Xid 79" } } })[0];
  assert.equal(xid.i18n.detail.params.last, "Xid 79");
  assert.equal(evaluator.pendingEvents[0].data.last, "Xid 79");
  const roce = evaluator.evaluate({ roce: { devices: [{ name: "mlx5_0", netdev: "eth0", everActive: true, active: false, state: "DOWN", physState: "Disabled" }] } }).find(f => f.id === "roce-link");
  assert.equal(roce.i18n.detail.params.links, "eth0: DOWN (Disabled)");
  assert.equal(roce.i18n.title.params.count, 1);
});

test("unknown diagnostics keep their raw detail behind a localized summary", () => {
  const body = responseI18n({ error: "ssh: connect to host 10.0.0.2: timed out" });
  assert.equal(body.error, "ssh: connect to host 10.0.0.2: timed out");
  assert.deepEqual(body.i18n, { error: { key: "server.error.unexpected", params: { detail: body.error } } });
});
