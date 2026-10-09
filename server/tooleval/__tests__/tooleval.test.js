import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildToolEvalArgs, splitExtraArgs, validateBaseUrl } from "../argv.js";
import { ARG_SPEC, publicSpec, specByName } from "../spec.js";
import { ToolEvalManager, reduceProgress, emptyProgress, summarizeResult } from "../ToolEvalManager.js";
import { ToolEvalStore, isValidRunId, newRunId } from "../ToolEvalStore.js";
import { buildRunProgram, installCommandLine, secretsPayload } from "../commands.js";
import { installFakeTool } from "./fakeTool.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("spec: every option has a flag, a group and a known kind; the public copy is JSON-safe", () => {
  const kinds = new Set(["bool", "int", "float", "string", "text", "choice", "csv", "list", "repeat", "path", "url", "json", "range", "secret"]);
  const seen = new Set();
  for (const s of ARG_SPEC) {
    assert.ok(kinds.has(s.kind), `${s.name}: kind ${s.kind}`);
    assert.equal(s.flag, `--${s.name}`);
    assert.ok(publicSpec().groups.some((g) => g.id === s.group), `${s.name}: group ${s.group}`);
    assert.ok(!seen.has(s.name), `duplicate ${s.name}`);
    seen.add(s.name);
  }
  assert.doesNotThrow(() => JSON.stringify(publicSpec()));
  for (const must of ["short", "scenarios", "categories", "perf", "spec-bench", "context-pressure", "gsm8k-only", "needle-only", "decision-only", "trials", "system-prompt"]) {
    assert.ok(specByName(must), must);
  }
});

test("args: builds a plain run with the Spark's own endpoint and a stable order", () => {
  const r = buildToolEvalArgs({ short: true, seed: 42, "no-think": true, categories: ["a", "K"] }, { defaultBaseUrl: "http://127.0.0.1:8888" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["--short", "--categories", "A", "K", "--no-think", "--seed", "42", "--base-url", "http://127.0.0.1:8888"]);
  assert.match(r.display, /^tool-eval-bench --short --categories A K/);
});

test("args: an explicit base URL or provider replaces the default endpoint", () => {
  assert.ok(buildToolEvalArgs({ "base-url": "http://10.0.0.5:8000" }, { defaultBaseUrl: "http://127.0.0.1:8888" }).argv.includes("http://10.0.0.5:8000"));
  const p = buildToolEvalArgs({ provider: "openai" }, { defaultBaseUrl: "http://127.0.0.1:8888" });
  assert.ok(!p.argv.includes("--base-url"));
});

test("args: rejects unknown options, bad types, ranges, choices and shell-looking values with readable messages", () => {
  const bad = (opts) => buildToolEvalArgs(opts, {});
  assert.match(bad({ nonsense: 1 }).errors[0], /Unknown option/);
  assert.match(bad({ seed: 1.5 }).errors[0], /whole number/);
  assert.match(bad({ temperature: 9 }).errors[0], /at most/);
  assert.match(bad({ backend: "hal9000" }).errors[0], /one of/);
  assert.match(bad({ "gsm8k-shots": 12 }).errors[0], /at most 8/);
  assert.match(bad({ scenarios: ["TC-01; rm -rf /"] }).errors[0], /invalid item/);
  assert.match(bad({ depth: "0,4096;x" }).errors[0], /invalid format/);
  assert.match(bad({ "backend-kwargs": "[1,2]" }).errors[0], /JSON object/);
  assert.match(bad({ "system-prompt-file": "relative/x" }).errors[0], /absolute path/);
  assert.match(bad({ "system-prompt-file": "/a/../b" }).errors[0], /\.\./);
  assert.match(bad({ "base-url": "ftp://x" }).errors[0], /http/);
  assert.match(bad({ "base-url": "http://u:p@host" }).errors[0], /credentials/);
  assert.match(bad({ "base-url": "http://169.254.169.254/" }).errors[0], /link-local/);
  assert.match(bad({ "context-pressure-sweep": "0.5-9" }).errors[0], /invalid format/);
  assert.equal(validateBaseUrl("http://localhost:8000"), null);
});

test("args: conflicting choices are caught together", () => {
  const r = buildToolEvalArgs({ "system-prompt": "x", "system-prompt-file": "/p", "context-pressure": 0.5, "context-pressure-sweep": "0.1-0.9", short: true, scenarios: ["TC-01"] }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});

test("args: secrets (API key, header values) never reach argv or the stored/displayed options", () => {
  const r = buildToolEvalArgs({ "api-key": "sk-SECRET", header: ["X-Token=hunter2", "X-Other=v"] }, { defaultBaseUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, true);
  const all = JSON.stringify([r.argv, r.display, r.redacted]);
  assert.ok(!all.includes("sk-SECRET") && !all.includes("hunter2"), all);
  assert.equal(r.env.TOOL_EVAL_API_KEY, "sk-SECRET");
  assert.equal(r.env.TOOL_EVAL_HEADERS, "X-Token=hunter2;X-Other=v");
  assert.equal(buildToolEvalArgs({ header: ["X=a;b"] }, {}).ok, false, "';' would split the env list");
  const saved = buildToolEvalArgs({}, { savedApiKey: "saved-key" });
  assert.equal(saved.env.TOOL_EVAL_API_KEY, "saved-key");
  assert.equal(saved.redacted["api-key"], "(saved key)");
});

test("args: additional arguments are flags and plain values only, and cannot override server-managed flags", () => {
  assert.deepEqual(splitExtraArgs("  --foo   bar  --baz 1 "), ["--foo", "bar", "--baz", "1"]);
  const ok = buildToolEvalArgs({ extra: ["--future-flag", "value-1"] }, {});
  assert.deepEqual(ok.argv, ["--future-flag", "value-1"]);
  for (const evil of [["--json-file", "/etc/x"], ["--spec-live"], ["$(id)"], ["a b"], ["--x;y"], ["`id`"]]) {
    assert.equal(buildToolEvalArgs({ extra: evil }, {}).ok, false, JSON.stringify(evil));
  }
});

test("progress: events fold into counts, current scenario and the final score", () => {
  let p = emptyProgress();
  const ev = [
    { event: "server_discovered", base_url: "http://x", backend: "vllm" },
    { event: "model_auto_selected", model: "m" },
    { event: "scenario_start", scenario_id: "TC-01", title: "T1", category: "A", index: 0, total: 2 },
    { event: "scenario_result", scenario_id: "TC-01", status: "pass", points: 2, index: 0, total: 2, duration_seconds: 1.5 },
    { event: "scenario_start", scenario_id: "TC-02", index: 1, total: 2 },
    { event: "scenario_result", scenario_id: "TC-02", status: "weird", points: 0, total: 2 },
    { event: "benchmark_complete", final_score: 77 },
  ];
  for (const e of ev) p = reduceProgress(p, e);
  assert.deepEqual(p.counts, { pass: 1, partial: 0, fail: 0, other: 1 });
  assert.equal(p.total, 2);
  assert.equal(p.done, 2);
  assert.equal(p.points, 2);
  assert.equal(p.finalScore, 77);
  assert.equal(p.phase, "done");
  assert.equal(p.model, "m");
  assert.equal(p.scenarios[0].title, "T1");
  assert.equal(reduceProgress(emptyProgress(), { event: "error", error: "no_server", message: "nope" }).error.code, "no_server");
});

test("summarizeResult is tolerant of missing fields", () => {
  assert.equal(summarizeResult(null), null);
  const s = summarizeResult({ final_score: 80, rating: "★★★★ Good", scores: { scenario_results: [{ status: "pass" }, { status: "fail" }] } });
  assert.equal(s.finalScore, 80);
  assert.deepEqual(s.counts, { pass: 1, partial: 0, fail: 1, other: 0 });
  assert.equal(summarizeResult({}).finalScore, null);
});

test("store: run ids, index order, result cache round trip, spark removal", () => {
  const dir = tmp("te-store-");
  const store = new ToolEvalStore({ file: path.join(dir, "runs.json"), resultsDir: path.join(dir, "res") });
  const id1 = newRunId(Date.UTC(2026, 9, 7, 10, 0, 0), () => 0.1);
  const id2 = newRunId(Date.UTC(2026, 9, 7, 11, 0, 0), () => 0.2);
  assert.ok(isValidRunId(id1) && !isValidRunId("../etc"));
  store.add({ id: id1, sparkId: "s1", type: "tool-eval", status: "completed" });
  store.add({ id: id2, sparkId: "s2", type: "throughput", status: "running" });
  assert.deepEqual(store.list().map((r) => r.id), [id2, id1]);
  assert.deepEqual(store.list({ sparkId: "s1" }).map((r) => r.id), [id1]);
  assert.deepEqual(store.list({ type: "throughput" }).map((r) => r.id), [id2]);
  store.saveResult(id1, JSON.stringify({ final_score: 9 }));
  assert.equal(JSON.parse(store.loadResult(id1)).final_score, 9);
  assert.equal(store.loadResult("../x"), null);
  assert.equal(new ToolEvalStore({ file: path.join(dir, "runs.json"), resultsDir: path.join(dir, "res") }).list().length, 2);
  store.removeSpark("s1");
  assert.equal(store.get(id1), null);
  assert.equal(store.loadResult(id1), null);
});

test("commands: secrets are delivered as base64 on stdin, never inside the program text", () => {
  const payload = secretsPayload({ TOOL_EVAL_API_KEY: "sk-SECRET", NOT_ALLOWED: "x" });
  assert.ok(payload.includes("TOOL_EVAL_API_KEY="));
  assert.ok(!payload.includes("NOT_ALLOWED") && !payload.includes("sk-SECRET"));
  const program = buildRunProgram({ runId: "te-20261007-100000-abcd", argvB64: Buffer.from("--short\0").toString("base64"), displayLine: "tool-eval-bench --short" });
  assert.ok(!program.includes("sk-SECRET"));
  assert.equal(installCommandLine({ extras: ["perf", "bogus"] }), 'uv tool install --force "tool-eval-bench[perf] @ git+https://github.com/SeraphimSerapis/tool-eval-bench.git"');
});

// ---- the whole pipeline against a fake tool, through real bash ----

function realManager(home) {
  const env = { ...process.env, HOME: home };
  const events = [];
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const mgr = new ToolEvalManager({
    store,
    spawnProcess: (_spark, cmd, opts = {}) =>
      spawn("bash", ["-c", cmd], { env, stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], detached: true }),
    onEvent: (e) => events.push(e),
  });
  return { mgr, store, events };
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

const spark = { id: "s1", name: "Spark 1" };

function startRun(mgr, store, { argv = ["--short"], env = {}, type = "tool-eval" } = {}) {
  const id = newRunId();
  const run = { id, sparkId: "s1", type, typeLabel: "Tool Eval", status: "running", startedAt: Date.now(), command: `tool-eval-bench ${argv.join(" ")}`, options: {}, summary: null };
  const started = mgr.startRun(spark, { run, env, argv: [...argv, "--json-file", `~/.cache/sparkdash/tooleval/${id}/result.json`, "--no-live"] });
  if (started.ok) store.add(run);
  return { id, started };
}

test("pipeline: a run streams progress events, finishes, and its result is cached with a summary", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr, store, events } = realManager(home);
  const { id, started } = startRun(mgr, store, { argv: ["--short", "--label", "demo"], env: { TOOL_EVAL_API_KEY: "sk-SECRET-123", TOOL_EVAL_HEADERS: "X-A=b" } });
  assert.equal(started.ok, true);
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.latestJob("s1").status, "completed");
  await until(() => store.get(id)?.summary);

  const read = mgr.readJob("s1", id, {});
  assert.deepEqual(read.progress.counts, { pass: 1, partial: 1, fail: 1, other: 0 });
  assert.equal(read.progress.total, 3);
  assert.equal(read.progress.model, "fake/model");
  assert.equal(read.progress.finalScore, 50);
  assert.equal(read.progress.phase, "done");
  const texts = read.lines.map((l) => l.text);
  assert.ok(texts.some((t) => t === "got-key:13"), texts.join("|"));
  assert.ok(texts.some((t) => t === "got-headers:X-A=b"));
  assert.ok(texts.some((t) => t.includes("a stray stderr line")), "non-JSON stderr is kept as an error line");
  assert.equal(read.lines.find((l) => l.text.includes("stray")).stream, "err");
  assert.ok(!texts.some((t) => t.includes("__TEEXIT__")));
  assert.ok(read.events.length >= 8);
  // The command line the tool saw contains no secret.
  assert.ok(!texts.some((t) => t.startsWith("args:") && t.includes("sk-SECRET")));

  const run = store.get(id);
  assert.equal(run.status, "completed");
  assert.equal(run.summary.finalScore, 50);
  assert.deepEqual(run.summary.counts, { pass: 1, partial: 1, fail: 1, other: 0 });
  assert.equal(run.resultCached, true);
  assert.equal(JSON.parse(store.loadResult(id)).config.label, "demo");
  assert.ok(events.some((e) => e.type === "tooleval.run.completed" && /score 50/.test(e.message)));
});

test("pipeline: stopping a long run ends it as 'stopped'", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr, store } = realManager(home);
  const { id } = startRun(mgr, store, { argv: ["--seed", "999"] });
  await until(() => mgr.readJob("s1", id, {}).progress.current);
  const res = await mgr.stopRun(spark, id);
  assert.match(res.output, /stopped|killed/);
  await until(() => mgr.latestJob("s1").status !== "running");
  await until(() => store.get(id).status !== "running");
  assert.equal(store.get(id).status, "stopped");
});

test("pipeline: closing the watcher leaves the run going; refresh then settles it", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr, store } = realManager(home);
  const { id } = startRun(mgr, store, { argv: ["--seed", "999"] });
  await until(() => mgr.readJob("s1", id, {}).progress.current);
  mgr.cancelWatch("s1");
  await until(() => mgr.latestJob("s1").status === "cancelled");
  assert.equal((await mgr.checkRun(spark, id)).state, "running");
  const attach = mgr.attachRun(spark, store.get(id));
  assert.equal(attach.ok, true);
  await until(() => mgr.readJob("s1", id, {}).progress.current);
  mgr.cancelWatch("s1");
  await mgr.stopRun(spark, id);
  await until(async () => (await mgr.checkRun(spark, id)).state === "finished");
  assert.notEqual(store.get(id).status, "running");
});

test("pipeline: a second run is refused while one is running; status, probe and dry-run work", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr, store } = realManager(home);
  const first = startRun(mgr, store, { argv: ["--seed", "999"] });
  const second = startRun(mgr, store, {});
  assert.equal(second.started.ok, false);
  assert.equal(second.started.reason, "busy");
  await mgr.stopRun(spark, first.id);
  await until(() => mgr.latestJob("s1").status !== "running");

  const st = await mgr.status(spark);
  assert.equal(st.installed, true);
  assert.match(st.version, /9\.9\.9/);
  const b64 = (a) => Buffer.from(a.join("\0") + "\0").toString("base64");
  const probe = await mgr.once(spark, { argvB64: b64(["--probe", "--json"]), secrets: null });
  assert.equal(probe.ok, true);
  assert.match(probe.output, /ready/);
  const dry = await mgr.once(spark, { argvB64: b64(["--short", "--dry-run"]), secrets: null });
  assert.match(dry.output, /TC-01/);
  assert.match(dry.output, /--short/);
});

test("pipeline: without the tool installed a run fails clearly, and install without uv explains why", async () => {
  const home = tmp("te-home-");
  const { mgr, store } = realManager(home);
  const env = { PATH: "/usr/bin:/bin" };
  mgr.spawnProcess = (_s, cmd, opts = {}) =>
    spawn("bash", ["-c", cmd], { env: { ...env, HOME: home }, stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
  const { id } = startRun(mgr, store, {});
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.latestJob("s1").status, "failed");
  assert.equal(mgr.latestJob("s1").exitCode, 127);
  assert.ok(mgr.readJob("s1", id, {}).lines.some((l) => /not installed/.test(l.text)));
  const st = await mgr.status(spark);
  assert.equal(st.installed, false);
  const inst = mgr.install(spark, {});
  assert.equal(inst.ok, true);
  await until(() => mgr.latestJob("s1").status !== "running");
  assert.equal(mgr.latestJob("s1").status, "failed");
  assert.ok(mgr.readJob("s1", mgr.latestJob("s1").id, {}).lines.some((l) => /uv is not installed/.test(l.text)));
});

test("the key saved for a Spark's port is only used against that Spark's own server", async () => {
  const { mayUseSavedKey } = await import("../argv.js");
  for (const url of [undefined, "", "  ", "http://127.0.0.1:8888", "http://localhost:8000/v1", "127.0.0.1:8888"]) {
    assert.equal(mayUseSavedKey(url), true, String(url));
  }
  for (const url of ["https://api.example.com/v1", "http://192.168.1.50:8000", "llm.internal:8000", "http://127.0.0.1.evil.example/v1", "not a url"]) {
    assert.equal(mayUseSavedKey(url), false, url);
  }
});

test("a run whose process cannot even be spawned is settled as failed, not left 'running'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "te-spawnfail-"));
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const mgr = new ToolEvalManager({
    store,
    spawnProcess: () => {
      throw new Error("SSH config missing for spark3");
    },
  });
  const spark = { id: "spark3", name: "Spark 3" };
  const run = { id: "te-20260101-000000-abcd", sparkId: "spark3", type: "tool-eval", status: "running", startedAt: Date.now(), options: {}, command: "x" };
  // The route stores the record first, then starts the job (this is the order that lets the failure settle it).
  store.add(run);
  const started = mgr.startRun(spark, { run, argv: ["--short"], env: {} });
  assert.equal(started.ok, true);
  for (let i = 0; i < 50 && store.get(run.id).status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(store.get(run.id).status, "running");
});

test("raw output keeps the tool's progress JSON lines, and progress is still tracked from them", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "te-raw-"));
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const mgr = new ToolEvalManager({ store, spawnProcess: () => ({ stdout: null, stderr: null, on() {}, kill() {} }) });
  const job = mgr._newJob({ id: "s1" }, { id: "te-20260101-000000-abcd", kind: "run", type: "tool-eval" });
  mgr._line(job, "==> /x/events.jsonl <==");
  mgr._line(job, '{"event":"scenario_done","id":"TC-01","status":"pass"}');
  mgr._line(job, "Endpoint rejected tool_choice=required with HTTP 400; treating as unsupported");
  mgr._line(job, "==> /x/stdout.log <==");
  mgr._line(job, "[sparkdash] tool-eval-bench --short");
  assert.deepEqual(
    job.lines.map((l) => [l.stream, l.text.slice(0, 12)]),
    [["err", '{"event":"sc'], ["err", "Endpoint rej"], ["out", "[sparkdash] "]]
  );
  assert.ok(job.events.length >= 1, "the event still feeds the progress model");
});

// ---- security hardening ----

test("saved key: non-string URLs never get it, and url options reject non-strings", async () => {
  const { mayUseSavedKey } = await import("../argv.js");
  assert.equal(mayUseSavedKey(["http://evil.example"]), false);
  assert.equal(mayUseSavedKey({ toString: () => "http://127.0.0.1" }), false);
  assert.equal(buildToolEvalArgs({ "base-url": ["http://evil.example"] }, {}).ok, false);
  assert.equal(buildToolEvalArgs({ "metrics-url": 5 }, {}).ok === false || specByName("metrics-url") == null, true);
  assert.match(validateBaseUrl(["http://x"]), /text/);
});

test("saved key: every URL in the final argv must be local, including ones from additional arguments", () => {
  const ctx = { savedApiKey: "sk-saved", defaultBaseUrl: "http://127.0.0.1:8888" };
  assert.equal(buildToolEvalArgs({ extra: ["--future-flag", "https://evil.example/v1"] }, ctx).ok, false);
  assert.equal(buildToolEvalArgs({ extra: ["--future-flag", "evil.example:8000"] }, ctx).ok, false);
  const ok = buildToolEvalArgs({ extra: ["--future-flag", "http://127.0.0.1:9/x"] }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.env.TOOL_EVAL_API_KEY, "sk-saved");
});

test("extra: managed or known flags are refused even as argparse prefix abbreviations; secrets never ride in extra", () => {
  for (const flag of ["--dry", "--dry-run", "--json-f", "--hist", "--leader", "--export", "--no-l", "--redact", "--skip-c", "--base", "--base-url", "--metrics", "--prov", "--api-key", "--api", "--header", "--auth-token", "--my-secret"]) {
    assert.equal(buildToolEvalArgs({ extra: [flag] }, {}).ok, false, flag);
  }
  for (const tok of ["-k", "-h", "sk-abcdef123456", "--x=1"]) {
    assert.equal(buildToolEvalArgs({ extra: ["--future-flag", tok] }, {}).ok, false, tok);
  }
  assert.equal(buildToolEvalArgs({ extra: ["--future-flag", "-1"] }, {}).ok, true);
});

test("link-local filter also catches IPv4-mapped IPv6", () => {
  for (const u of ["http://[::ffff:169.254.169.254]/", "http://169.254.1.1/", "http://[fe80::1]/", "http://[::ffff:a9fe:a9fe]/"]) {
    assert.match(validateBaseUrl(u) ?? "", /link-local/, u);
  }
  assert.equal(validateBaseUrl("http://[::ffff:127.0.0.1]/"), null);
});

test("long free text is stored as a fingerprint, not in full", () => {
  const big = "x".repeat(5000);
  const r = buildToolEvalArgs({ "system-prompt": big, label: "ok" }, {});
  assert.equal(r.ok, true);
  assert.match(r.redacted["system-prompt"], /^\(omitted: 5000 chars, sha256 [0-9a-f]{16}\)$/);
  assert.ok(r.argv.includes(big));
});

test("commands: ~/ is expanded only after path flags, not in free text", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr } = realManager(home);
  const argv = ["--dry-run", "--system-prompt", "~/not-a-path", "--output-dir", "~/out"];
  const res = await mgr.once({ id: "s1" }, { argvB64: Buffer.from(argv.join("\0") + "\0").toString("base64"), secrets: null });
  assert.match(res.output, /--system-prompt ~\/not-a-path/);
  assert.ok(res.output.includes(`--output-dir ${home}/out`));
});

test("exit marker: only the wrapper's nonce marker counts; a forged one in the output is ignored", async () => {
  const home = tmp("te-home-");
  const { mgr } = realManager(home);
  const job = mgr._newJob({ id: "s1" }, { id: "te-20260101-000000-abcd", kind: "run", type: "tool-eval" });
  mgr._line(job, "__TEEXIT__0");
  mgr._line(job, "__TEEXIT__:0");
  assert.equal(job.markerExit, null);
  mgr._line(job, `__TEEXIT__${job.nonce}:3`);
  assert.equal(job.markerExit, 3);
  // runOnce: forged marker earlier in the output, real one last
  const nonce = "abc123";
  const r = await mgr.runOnce({ id: "s1" }, `echo '__TEEXIT__abc123:0'; echo body; echo '__TEEXIT__abc123:7'`, { nonce });
  assert.equal(r.code, 7);
  assert.ok(r.output.includes("body"));
});

test("runOnce keeps multibyte characters whole and can ignore stderr", async () => {
  const home = tmp("te-home-");
  const { mgr } = realManager(home);
  const r = await mgr.runOnce({ id: "s1" }, `head -c 100000 /dev/zero | tr '\\0' 'x'; printf 'é€😀'; echo noise >&2`, { stdoutOnly: true });
  assert.ok(r.output.endsWith("é€😀"));
  assert.ok(!r.output.includes("noise") && !r.output.includes("�"));
});

test("a run whose ssh connection fails before any output is failed, not left running", async () => {
  const home = tmp("te-sshfail-");
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const mgr = new ToolEvalManager({
    store,
    spawnProcess: () => spawn("bash", ["-c", "echo 'ssh: connect to host x port 22: Connection refused' >&2; exit 255"], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  const run = { id: "te-20260101-000000-abcd", sparkId: "s9", type: "tool-eval", status: "running", startedAt: Date.now(), options: {}, command: "x" };
  store.add(run);
  assert.equal(mgr.startRun({ id: "s9" }, { run, argv: ["--short"], env: {} }).ok, true);
  await until(() => store.get(run.id).status !== "running");
  assert.equal(store.get(run.id).status, "failed");
});

test("startRun refuses while the store still has a running run for that Spark", () => {
  const home = tmp("te-orphan-");
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  const mgr = new ToolEvalManager({ store, spawnProcess: () => { throw new Error("must not spawn"); } });
  store.add({ id: "te-20260101-000000-aaaa", sparkId: "s1", type: "tool-eval", status: "running", options: {} });
  const run = { id: "te-20260101-000001-bbbb", sparkId: "s1", type: "tool-eval", status: "running", options: {}, command: "x" };
  const started = mgr.startRun({ id: "s1" }, { run, argv: [], env: {} });
  assert.equal(started.ok, false);
  assert.equal(started.reason, "busy");
  store.update("te-20260101-000000-aaaa", { status: "gone" });
  assert.equal(mgr.startRun({ id: "s1" }, { run, argv: [], env: {} }).ok, true);
});

test("store: results are only written for runs that still exist; eviction is reported", () => {
  const home = tmp("te-store-");
  const store = new ToolEvalStore({ file: path.join(home, "runs.json"), resultsDir: path.join(home, "results") });
  assert.equal(store.saveResult("te-20260101-000000-aaaa", "{}"), false);
  store.add({ id: "te-20260101-000000-aaaa", sparkId: "s1", options: {} });
  assert.equal(store.saveResult("te-20260101-000000-aaaa", "{}"), true);
  store.remove("te-20260101-000000-aaaa");
  assert.equal(store.saveResult("te-20260101-000000-aaaa", "{}"), false);
  assert.equal(store.loadResult("te-20260101-000000-aaaa"), null);
});

test("stale pid: an existing exit file means the run is not alive, and the wrapper removes the pid file", async () => {
  const home = tmp("te-home-");
  installFakeTool(home);
  const { mgr, store } = realManager(home);
  const { id } = startRun(mgr, store, { argv: ["--short"] });
  await until(() => store.get(id)?.summary);
  const dir = path.join(home, ".cache/sparkdash/tooleval", id);
  assert.ok(fs.existsSync(path.join(dir, "exit")));
  assert.ok(!fs.existsSync(path.join(dir, "pid")));
  // a pid file pointing at a live, unrelated process (this test) must not be treated as the run
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  const check = await mgr.checkRun(spark, id);
  assert.equal(check.state, "finished");
  const stop = await mgr.stopRun(spark, id);
  assert.match(stop.output, /not running/);
});
