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
import { QualityBenchManager, timeoutMsForItem, runQualityItem } from "../QualityBench.js";
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

/** handler(req, res, body) for /v1/chat/completions; /v1/models is canned. */
function server(handler) {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake", max_model_len: 65536 }] }));
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
