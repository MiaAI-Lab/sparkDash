/**
 * QualityBenchManager lifecycle: cancel, consecutive-error stop, timeouts, history trimming,
 * polling payload, active-slot ownership, job pruning. Fake OpenAI-compatible server only.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";
import { QualityBenchManager, isResumable, timeoutMsForItem, runQualityItem } from "../QualityBench.js";
import { timeoutMsForSize } from "../PrefillBench.js";
import { generateSuite, SCORING_VERSION, SUITE_VERSION } from "../qualitySuite.js";

function tmpManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-mgr-"));
  const active = path.join(dir, "active.json");
  return { dir, active, mgr: new QualityBenchManager(path.join(dir, "hist.json"), active) };
}

async function until(pred, ms = 8000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

/**
 * handler(req, res, body) for /v1/chat/completions; /v1/models is canned. `/v1/completions`
 * (the WP0 engine probe) answers 404 like an engine without that route, unless `completions`
 * is given a handler of its own.
 */
function server(handler, { completions = null } = {}) {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake", max_model_len: 65536 }] }));
      return;
    }
    if (req.url === "/v1/completions") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        if (completions) return completions(req, res, raw ? JSON.parse(raw) : {});
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no completions here" } }));
      });
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => handler(req, res, raw ? JSON.parse(raw) : {}));
  });
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => srv.close(r));
        },
      })
    )
  );
}

const startOpts = (port, extra = {}) => ({
  sparkId: "s1",
  lanIp: "127.0.0.1",
  port,
  modelId: "fake",
  categories: ["qa"],
  concurrency: 1,
  ...extra,
});

test("config stores suite and scoring versions", () => {
  const { mgr } = tmpManager();
  mgr.activeBySpark.clear();
  const job = mgr.start(startOpts(9));
  assert.equal(job.config.suiteVersion, SUITE_VERSION);
  assert.equal(job.config.scoringVersion, SCORING_VERSION);
  mgr.cancel("s1", job.benchId);
});

test("cancel mid-run: status cancelled, partial rows kept, slot released, job pruned", async () => {
  const { mgr } = tmpManager();
  let hits = 0;
  const srv = await server((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "42" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
    // later requests hang until aborted
  });
  try {
    const job = mgr.start(startOpts(srv.port));
    await until(() => hits >= 2);
    const cancelled = mgr.cancel("s1", job.benchId);
    assert.equal(cancelled.progress.message, "Cancelling…");
    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "cancelled");
    assert.match(done.error, /Cancelled/);
    assert.equal(done.results.items.length, 1); // the in-flight item is dropped, finished ones stay
    assert.equal(mgr.jobs.has(job.benchId), false);
    assert.equal(mgr.cancel("s1", job.benchId).status, "cancelled"); // from history
  } finally {
    await srv.close();
  }
});

test("MAX_CONSECUTIVE_ERRORS (8) stops the run as failed", async () => {
  const { mgr } = tmpManager();
  const srv = await server((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"boom"}');
  });
  try {
    const job = mgr.start(startOpts(srv.port));
    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "failed");
    assert.match(done.error, /Stopped after 8 failed requests in a row/);
    assert.equal(done.results.items.length, 8);
    assert.ok(done.results.items.every((r) => r.ok === false && r.error));
    // errors are reported, not scored
    assert.equal(done.results.categories.qa.errors, 8);
    assert.equal(done.results.categories.qa.scored, 0);
    assert.equal(done.results.categories.qa.pct, null);
  } finally {
    await srv.close();
  }
});

test("a success resets the consecutive-error counter", async () => {
  const { mgr } = tmpManager();
  let n = 0;
  const srv = await server((req, res) => {
    n += 1;
    if (n % 5 !== 0) {
      res.writeHead(500);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "1" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"] })); // 40 items
    await until(() => !mgr.activeBySpark.has("s1"), 20000);
    assert.equal(mgr.getJob(job.benchId).status, "completed");
  } finally {
    await srv.close();
  }
});

test("per-item and per-size timeouts scale with tokens and size", () => {
  assert.equal(timeoutMsForItem({ category: "qa", maxTokens: 0 }), 120_000);
  assert.equal(timeoutMsForItem({ category: "qa", maxTokens: 12288 }), 120_000 + 12288 * 150);
  const long = timeoutMsForItem({ category: "long", maxTokens: 512, size: 262144 });
  assert.equal(long, timeoutMsForSize(262144) + 120_000 + 512 * 150);
  assert.ok(long > timeoutMsForItem({ category: "long", maxTokens: 512, size: 8192 }));
  assert.equal(timeoutMsForSize(1024), 90_000);
  assert.equal(timeoutMsForSize(10_000_000), 2_700_000);
});

test("runQualityItem: parent abort yields an error row path, not a pass", async () => {
  const srv = await server(() => {
    /* hang */
  });
  try {
    const item = generateSuite({ categories: ["qa"] })[0];
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const row = await runQualityItem({ baseUrl: `http://127.0.0.1:${srv.port}`, modelId: "fake", item, abortSignal: ctrl.signal });
    assert.equal(row.ok, false);
    assert.ok(row.error);
  } finally {
    await srv.close();
  }
});

test("history is trimmed to 30 and summaries drop the item rows, filtered by port", () => {
  const { mgr } = tmpManager();
  for (let i = 0; i < 35; i++) {
    mgr._pushHistory({
      benchId: `b${i}`,
      sparkId: "s1",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      config: { port: i % 2 ? 8001 : 8000 },
      progress: {},
      results: { items: [{ id: "x", category: "qa", ok: true }], categories: {}, overallPct: 1, skippedLongSizes: [] },
      error: null,
    });
  }
  assert.equal(mgr.getHistory("s1").length, 30);
  assert.equal(mgr.getHistory("s1")[0].benchId, "b34");
  const all = mgr.getHistorySummaries("s1");
  assert.equal(all.length, 30);
  assert.ok(all.every((j) => j.results.items === undefined && j.results.itemCount === 1));
  const only8001 = mgr.getHistorySummaries("s1", 8001);
  assert.ok(only8001.length > 0 && only8001.every((j) => j.config.port === 8001));
  assert.equal(mgr.getHistorySummaries("s1", "not-a-port").length, 30);
});

test("polling a running job returns counts, not the item rows; completion returns them", async () => {
  const { mgr, active } = tmpManager();
  let release;
  const gate = new Promise((r) => (release = r));
  let served = 0;
  const srv = await server(async (req, res) => {
    served += 1;
    if (served > 3) await gate;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "1" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"] }));
    await until(() => served > 3 && mgr.getActive("s1")?.progress.done >= 3);
    const live = mgr.getActive("s1");
    assert.equal(live.status, "running");
    assert.equal(live.results.items, undefined);
    assert.ok(live.results.itemCount >= 3);
    assert.equal(mgr.getJob(job.benchId, { full: true }).results.items.length, live.results.itemCount);
    // the (throttled, async) checkpoint still carries the rows for crash recovery
    await until(() => fs.existsSync(active) && JSON.parse(fs.readFileSync(active, "utf8")).jobs?.[0]?.results?.items?.length > 0, 5000);
    release();
    await until(() => !mgr.activeBySpark.has("s1"), 15000);
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.results.items.length, 40);
    assert.deepEqual(JSON.parse(fs.readFileSync(active, "utf8")).jobs, []);
  } finally {
    release?.();
    await srv.close();
  }
});

test("finishing a job leaves another job's active slot alone", async () => {
  const { mgr } = tmpManager();
  const srv = await server((req, res) => {
    res.writeHead(500);
    res.end("{}");
  });
  try {
    const job = mgr.start(startOpts(srv.port));
    mgr.activeBySpark.set("s1", "someone-else"); // slot re-assigned while this job was winding down
    await until(() => mgr.getJob(job.benchId)?.status === "failed");
    assert.equal(mgr.activeBySpark.get("s1"), "someone-else");
  } finally {
    await srv.close();
  }
});

test("WP0: noise-floor run makes the extra passes, records the engine, keeps reasoning tokens per row", async () => {
  const { mgr } = tmpManager();
  const seen = { completions: [], chat: 0 };
  const srv = await server(
    (req, res, body) => {
      seen.chat += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer: 7" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    },
    {
      completions: (req, res, body) => {
        seen.completions.push(body.prompt_logprobs);
        const rows = [null, { 1: { logprob: -0.5, rank: 1, decoded_token: "a" }, 2: { logprob: -3, rank: 9, decoded_token: "b" } }];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ text: "x", prompt_logprobs: rows }], usage: { prompt_tokens: 2 } }));
      },
    }
  );
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"], concurrency: 2, noiseFloor: true }));
    assert.equal(job.config.noiseFloor, true);
    await until(() => !mgr.activeBySpark.has("s1"), 20000);
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    // primary + repeat at 2 + two serial passes at 1
    assert.equal(done.progress.total, 40 * 4);
    assert.equal(done.progress.done, 40 * 4);
    assert.equal(done.results.items.length, 40);
    assert.equal(done.results.passes.length, 3);
    assert.deepEqual(done.results.passes.map((p) => [p.kind, p.concurrency, p.items.length]), [["repeat", 2, 40], ["serial", 1, 40], ["serial", 1, 40]]);
    assert.equal(done.results.noise.passes.length, 3);
    assert.equal(done.results.noise.repeatFlipPct, 0);
    assert.equal(done.results.noise.batchFlipPct, 0);
    assert.equal(seen.chat, 160);
    // the engine probe ran once, with K=1, and its verdict sits on the run
    assert.deepEqual(seen.completions, [1, 128]);
    assert.equal(done.engine.capabilities.promptLogprobs, true);
    assert.equal(done.engine.capabilities.actualIncluded, true);
    assert.equal(done.engine.capabilities.cap, 128);
    assert.equal(done.engine.record.modelId, "fake");
    assert.equal(done.engine.record.contextLength, 65536);
    // reasoning as the server counted it, on every row
    assert.equal(done.results.items[0].reasoningTokens, 3);
    assert.equal(done.results.items[0].reasoningChars, 0);
    // history summaries carry the noise floor but no rows
    const summary = mgr.getHistorySummaries("s1")[0];
    assert.equal(summary.results.items, undefined);
    assert.equal(summary.results.noise.passes.length, 3);
    assert.equal(summary.engine.capabilities.cap, 128);
  } finally {
    await srv.close();
  }
});

test("WP0: a failed reasoning row keeps the reasoning tail, a passed one does not", async () => {
  const { mgr } = tmpManager();
  let n = 0;
  const srv = await server((req, res) => {
    n += 1;
    const content = n === 1 ? "Answer: 999999" : "Answer: 7";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "let me think " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"] }));
    await until(() => !mgr.activeBySpark.has("s1"), 20000);
    const rows = mgr.getJob(job.benchId).results.items;
    const failed = rows.filter((r) => !r.ok);
    assert.ok(failed.length >= 1);
    for (const r of failed) assert.equal(r.reasoning, "let me think ");
    for (const r of rows) assert.equal(r.reasoningChars, 13);
    const passed = rows.find((r) => r.ok);
    if (passed) assert.equal(passed.reasoning, undefined);
  } finally {
    await srv.close();
  }
});

test("WP2: a fidelity run scores the corpus, writes its side file and compares with itself at ΔNLL 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-mgr-fid-"));
  const mgr = new QualityBenchManager(path.join(dir, "hist.json"), path.join(dir, "active.json"), path.join(dir, "fid"));
  const srv = await server(
    () => {
      throw new Error("no chat expected");
    },
    {
      completions: (req, res, body) => {
        // Deterministic ids and logprobs from the prompt length: the actual token is always there.
        const n = Math.max(2, Math.min(40, Math.floor(body.prompt.length / 500)));
        const rows = [null];
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(1000 + i);
        for (let i = 1; i < n; i++) {
          const row = { 5: { logprob: -0.1, rank: 1, decoded_token: "a" }, 6: { logprob: -3, rank: 2, decoded_token: "b" } };
          row[String(ids[i])] = { logprob: -1.5, rank: 9, decoded_token: "x" };
          rows.push(row);
        }
        if (body.prompt_logprobs === 1) {
          // the WP0 probe (K=1): keep the shape, two entries prove the actual token comes back
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ text: "a", prompt_logprobs: rows }], usage: { prompt_tokens: n } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ text: "a", prompt_logprobs: rows, prompt_token_ids: ids }], usage: { prompt_tokens: n } }));
      },
    }
  );
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["fidelity"] }));
    assert.equal(job.config.profile, "fidelity");
    await until(() => !mgr.activeBySpark.has("s1"), 30000);
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.results.items.length, 9);
    assert.ok(done.results.items.every((r) => r.ok && r.category === "fidelity"));
    assert.equal(done.results.overallPct, null);
    const f = done.results.categories.fidelity;
    assert.equal(f.pct, null);
    assert.equal(f.fidelity.docs, 9);
    assert.equal(f.fidelity.nll, 1.5);
    assert.equal(done.results.fidelity.k, 20);
    assert.equal(done.results.fidelity.sideFile, true);
    assert.equal(done.results.fidelity.corpusVersion, 1);
    assert.ok(fs.existsSync(path.join(dir, "fid", `${job.benchId}.json.gz`)));
    const side = mgr.getFidelitySide(job.benchId);
    assert.equal(Object.keys(side.docs).length, 9);
    const cmp = mgr.compareFidelityRuns("s1", job.benchId, job.benchId);
    assert.equal(cmp.comparable, true);
    assert.equal(cmp.dNll, 0);
    assert.equal(cmp.top1AgreementPct, 100);
    assert.equal(cmp.matchedDocs, 9);
    assert.equal(mgr.compareFidelityRuns("s1", job.benchId, "nope"), null);
    // deleting the run drops the side file
    mgr.deleteRun("s1", job.benchId);
    assert.equal(fs.existsSync(path.join(dir, "fid", `${job.benchId}.json.gz`)), false);
  } finally {
    await srv.close();
  }
});

test("WP2: an engine without prompt logprobs skips fidelity with a reason instead of failing the run", async () => {
  const { mgr } = tmpManager();
  const srv = await server((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer: 7" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow", "fidelity"] }));
    await until(() => !mgr.activeBySpark.has("s1"), 30000);
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.results.items.length, 40);
    assert.match(done.results.fidelityUnsupported, /HTTP 404/);
    assert.equal(done.results.categories.fidelity, undefined);
    assert.equal(done.progress.total, 40);
  } finally {
    await srv.close();
  }
});

test("WP3: a divergence run stores full replies and structural rates, out of the overall", async () => {
  const { mgr } = tmpManager();
  let n = 0;
  const srv = await server((req, res, body) => {
    n += 1;
    assert.equal(body.stream, false);
    const user = body.messages[body.messages.length - 1].content;
    let message;
    if (Array.isArray(body.tools)) message = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: body.tools[0].function.name, arguments: "{}" } }] };
    else if (/JSON object/.test(user)) message = { role: "assistant", content: '{"name":"Mo","age":40,"tags":["a","b","c","d"],"active":true}' };
    else message = { role: "assistant", content: `Reply ${n} to: ${user.slice(0, 20)}` };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 9 } }));
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["divergence"], concurrency: 4 }));
    assert.equal(job.config.profile, "fidelity");
    await until(() => !mgr.activeBySpark.has("s1"), 60000);
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.results.items.length, 120);
    assert.equal(done.results.overallPct, null);
    const d = done.results.categories.divergence;
    assert.equal(d.pct, null);
    assert.equal(d.divergence.rows, 120);
    assert.equal(d.divergence.terminatedPct, 100);
    assert.equal(d.divergence.loops, 0);
    assert.ok(done.results.items.every((r) => typeof r.reply === "string" || r.toolCalls));
    const tool = done.results.items.filter((r) => r.kind === "tool");
    assert.equal(tool.length, 10);
    assert.ok(tool.every((r) => r.tool.called && r.tool.nameOk && !r.tool.argsOk)); // name right, empty args
    const summary = mgr.getHistorySummaries("s1")[0];
    assert.equal(summary.results.items, undefined);
    assert.equal(summary.results.categories.divergence.divergence.rows, 120);
  } finally {
    await srv.close();
  }
});

test("WP4: fleet summaries carry the unit, references pin per model family and survive a reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-mgr-ref-"));
  const refs = path.join(dir, "refs.json");
  const mk = () => new QualityBenchManager(path.join(dir, "hist.json"), path.join(dir, "active.json"), path.join(dir, "fid"), refs);
  const mgr = mk();
  const srv = await server((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer: 7" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  try {
    const a = mgr.start(startOpts(srv.port, { categories: ["follow"], modelId: "GLM-5.3-Flash-FP8", unit: { id: "s1", name: "Spark one" }, cost: { decodeTps: 42, weightsGb: 60 } }));
    assert.deepEqual(a.unit, { id: "s1", name: "Spark one" });
    assert.deepEqual(a.cost, { decodeTps: 42, weightsGb: 60 });
    await until(() => !mgr.activeBySpark.has("s1"), 20000);
    const b = mgr.start({ ...startOpts(srv.port, { categories: ["follow"], modelId: "glm-5.3-flash-exl3-4bit" }), sparkId: "s2" });
    assert.deepEqual(b.unit, { id: "s2", name: "s2" }); // no unit given: the spark id stands in
    await until(() => !mgr.activeBySpark.has("s2"), 20000);

    const fleet = mgr.getFleetSummaries();
    assert.equal(fleet.length, 2);
    assert.ok(fleet.every((j) => j.results.items === undefined && j.unit && j.sparkId));
    assert.equal(fleet[0].sparkId, "s2"); // newest first

    assert.deepEqual(mgr.setReference("s1", "nope"), { ok: false, reason: "missing" });
    const pinned = mgr.setReference("s1", a.benchId);
    assert.deepEqual(pinned, { ok: true, key: "glm-5.3-flash" });
    // the quantised build on the other unit resolves to the same family
    assert.equal(mgr.referenceFor("glm-5.3-flash-exl3-4bit").benchId, a.benchId);
    assert.equal(mgr.referenceFor("Qwen3-8B"), null);
    assert.equal(mk().referenceFor("GLM-5.3-Flash").benchId, a.benchId); // persisted
    assert.deepEqual(mgr.clearReference("glm-5.3-flash"), { ok: true });
    assert.deepEqual(mgr.clearReference("glm-5.3-flash"), { ok: false, reason: "missing" });

    // cross-unit fidelity compare resolves each run on its own unit (no side files here → not comparable, not null)
    const cmp = mgr.compareFidelityRuns("s2", b.benchId, a.benchId, "s1");
    assert.equal(cmp.comparable, false);
    assert.equal(mgr.compareFidelityRuns("s2", b.benchId, a.benchId), null); // wrong unit for B
  } finally {
    await srv.close();
  }
});

test("pause closes the gate between items, keeps the slot, stops the clock; resume carries on; cancel while paused ends the run", async () => {
  const { mgr } = tmpManager();
  let hits = 0;
  const srv = await server((req, res) => {
    hits += 1;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    }, 20);
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"], concurrency: 2 })); // 40 items
    await until(() => mgr.getJob(job.benchId).progress.done >= 2);
    const paused = mgr.pause("s1", job.benchId);
    assert.equal(paused.paused, true);
    assert.equal(paused.status, "running");
    assert.match(paused.progress.message, /^Pausing|^Paused$/);
    // In-flight replies finish, then nothing new is sent.
    await until(() => mgr.getJob(job.benchId).progress.message === "Paused");
    const doneAtPause = mgr.getJob(job.benchId).progress.done;
    const hitsAtPause = hits;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(mgr.getJob(job.benchId).progress.done, doneAtPause);
    assert.equal(hits, hitsAtPause);
    assert.equal(mgr.activeBySpark.get("s1"), job.benchId); // the unit slot stays taken
    const snap = mgr.getJob(job.benchId);
    assert.ok(snap.pausedMs >= 100, `pausedMs ${snap.pausedMs}`);
    assert.ok(snap.durationMs < Date.now() - snap.startedAt - 100, "the clock excludes the pause");
    assert.equal(mgr.pause("s1", job.benchId).paused, true); // idempotent
    // The active file carries the paused flag for the dialog after a reload.
    const active = JSON.parse(fs.readFileSync(mgr.activePath, "utf8"));
    assert.equal(active.jobs[0].paused, true);

    const resumed = mgr.resume("s1", job.benchId);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pausedAt, null);
    assert.ok(resumed.pausedMs >= 100);
    assert.match(resumed.progress.message, /Instruction following/);
    await until(() => mgr.getJob(job.benchId).progress.done > doneAtPause);
    assert.equal(mgr.resume("s1", job.benchId).paused, false); // idempotent

    // Pause again, then cancel: parked workers wake up and the run ends as cancelled, not paused.
    mgr.pause("s1", job.benchId);
    await until(() => mgr.getJob(job.benchId).progress.message === "Paused");
    mgr.cancel("s1", job.benchId);
    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "cancelled");
    assert.equal(done.paused, false);
    assert.ok(done.pausedMs >= 100);
    assert.equal(done.durationMs, done.completedAt - done.startedAt - done.pausedMs);
    assert.ok(done.results.items.length >= doneAtPause);
    assert.equal(mgr.pause("s1", job.benchId), null); // pruned from jobs: unknown
  } finally {
    await srv.close();
  }
});

test("a run that finishes while paused settles the pause into its history record", async () => {
  const { mgr } = tmpManager();
  const srv = await server((req, res) => {
    // Slow enough that the run is still going when the pause lands.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    }, 15);
  });
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"], concurrency: 4 }));
    await until(() => mgr.getJob(job.benchId).progress.done >= 1);
    mgr.pause("s1", job.benchId);
    await new Promise((r) => setTimeout(r, 30));
    mgr.resume("s1", job.benchId);
    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getHistory("s1").find((j) => j.benchId === job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.paused, false);
    assert.ok(done.pausedMs >= 25);
  } finally {
    await srv.close();
  }
});

/** A chat server that answers the first `answerFirst` requests at once and hangs the rest until `release()`. */
function gatedServer(answerFirst) {
  let hits = 0;
  let open = false;
  const waiting = [];
  const reply = (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  const srvP = server((req, res) => {
    hits += 1;
    if (open || hits <= answerFirst) reply(res);
    else waiting.push(res);
  });
  return srvP.then((srv) => ({
    ...srv,
    hits: () => hits,
    release: () => {
      open = true;
      for (const res of waiting.splice(0)) reply(res);
    },
  }));
}

test("resumeRun: an interrupted run relaunches from its rows under the same id, skips what it scored, counts downtime as paused", async () => {
  const { mgr } = tmpManager();
  const srv = await gatedServer(6);
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"], concurrency: 2 })); // 40 items
    await until(() => mgr.getJob(job.benchId).progress.done >= 6);
    mgr.interruptAll("Interrupted — server restarted while the benchmark was running");
    const record = mgr.getJob(job.benchId);
    assert.equal(record.status, "failed");
    assert.equal(record.resumable, true);
    assert.equal(mgr.getHistorySummaries("s1")[0].resumable, true);
    assert.equal(mgr.getLast("s1").resumable, true);
    const scored = record.results.items.length;
    assert.ok(scored >= 6 && scored < 40, `scored ${scored}`);
    assert.equal(mgr.activeBySpark.has("s1"), false);

    await new Promise((r) => setTimeout(r, 60));
    srv.release();
    const hitsBefore = srv.hits();
    const resumed = mgr.resumeRun("s1", job.benchId, { lanIp: "127.0.0.1", unit: { id: "s1", name: "Spark one" } });
    assert.equal(resumed.benchId, job.benchId);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.resumes, 1);
    assert.equal(resumed.resumedFrom, scored);
    assert.equal(resumed.progress.done, scored);
    assert.ok(resumed.pausedMs >= 60, `downtime ${resumed.pausedMs}`);
    assert.equal(resumed.startedAt, record.startedAt);
    assert.equal(mgr.getHistory("s1").some((j) => j.benchId === job.benchId), false); // out of the history while live
    assert.throws(() => mgr.resumeRun("s1", job.benchId, { lanIp: "127.0.0.1" }), /not found/i);

    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.resumable, false);
    assert.equal(done.results.items.length, 40);
    assert.equal(new Set(done.results.items.map((r) => r.id)).size, 40); // no item twice
    assert.equal(srv.hits() - hitsBefore, 40 - scored); // only the rest was sent
    assert.equal(done.progress.done, 40);
    assert.equal(done.unit.name, "Spark one");
    assert.ok(done.pausedMs >= 60);
    assert.equal(done.durationMs, done.completedAt - done.startedAt - done.pausedMs);
    assert.equal(mgr.getHistory("s1").filter((j) => j.benchId === job.benchId).length, 1); // one record, replaced
    assert.throws(() => mgr.resumeRun("s1", job.benchId, { lanIp: "127.0.0.1" }), /finished/);
  } finally {
    await srv.close();
  }
});

test("resumeRun: a noise-floor run interrupted in its second pass keeps the first pass whole and finishes the second", async () => {
  const { mgr } = tmpManager();
  const srv = await gatedServer(40 + 5);
  try {
    const job = mgr.start(startOpts(srv.port, { categories: ["follow"], concurrency: 1, noiseFloor: true })); // 2 passes of 40
    await until(() => mgr.getJob(job.benchId).progress.done >= 45);
    mgr.interruptAll("Interrupted — server restarted while the benchmark was running");
    const record = mgr.getJob(job.benchId);
    assert.equal(record.results.items.length, 40);
    const secondBefore = record.results.passes[0].items.length;
    assert.ok(secondBefore >= 5 && secondBefore < 40);
    srv.release();
    const hitsBefore = srv.hits();
    mgr.resumeRun("s1", job.benchId, { lanIp: "127.0.0.1" });
    await until(() => !mgr.activeBySpark.has("s1"));
    const done = mgr.getJob(job.benchId);
    assert.equal(done.status, "completed");
    assert.equal(done.results.items.length, 40);
    assert.equal(done.results.passes[0].items.length, 40);
    assert.equal(srv.hits() - hitsBefore, 40 - secondBefore);
    assert.ok(done.results.noise, "the noise floor is summarised from both passes");
  } finally {
    await srv.close();
  }
});

test("isResumable: not a completed run, not one from another suite or scoring version, not one without rows", () => {
  const base = { status: "failed", config: { suiteVersion: SUITE_VERSION, scoringVersion: SCORING_VERSION }, progress: { done: 3, total: 10 }, results: { items: [{}, {}, {}] } };
  assert.equal(isResumable(base), true);
  assert.equal(isResumable({ ...base, status: "cancelled" }), true);
  assert.equal(isResumable({ ...base, status: "completed" }), false);
  assert.equal(isResumable({ ...base, status: "running" }), false);
  assert.equal(isResumable({ ...base, config: { suiteVersion: 1, scoringVersion: SCORING_VERSION } }), false);
  assert.equal(isResumable({ ...base, config: { suiteVersion: SUITE_VERSION, scoringVersion: 3 } }), false);
  assert.equal(isResumable({ ...base, progress: { done: 0, total: 10 } }), false);
  assert.equal(isResumable({ ...base, progress: { done: 10, total: 10 } }), false);
});
