import { buildToolEvalArgs, mayUseSavedKey, splitExtraArgs, validateBaseUrl } from "./argv.js";
import { ALLOWED_EXTRAS, installCommandLine, runDirRef } from "./commands.js";
import { isValidRunId, newRunId } from "./ToolEvalStore.js";
import { publicSpec } from "./spec.js";

/** Benchmark pages served by the tool-eval-bench engine. */
export const TOOL_EVAL_TYPES = {
  "tool-eval": "Tool Eval",
  throughput: "Throughput benchmark",
  "spec-decode": "Speculative decoding benchmark",
  "context-pressure": "Context pressure",
  accuracy: "Accuracy suites",
  needle: "Needle in a haystack",
  decision: "Decision model benchmark",
};

const argvB64 = (argv) => Buffer.from(argv.join("\0") + "\0", "utf8").toString("base64");

function portOf(spark, body) {
  const wanted = Number(body?.port);
  const ports = Array.isArray(spark.llmPorts) ? spark.llmPorts : [];
  if (Number.isInteger(wanted) && ports.includes(wanted)) return wanted;
  return ports[0] ?? spark.llmPort ?? 8888;
}

/**
 * HTTP surface for Tool Eval (tool-eval-bench on a Spark):
 *   GET  /api/tool-eval/spec                              option spec for the form
 *   GET  /api/sparks/:id/tool-eval/status                 installed? version? uv?
 *   POST /api/sparks/:id/tool-eval/install                install / upgrade (streamed job)
 *   POST /api/sparks/:id/tool-eval/preview                validate + show the command (+ optional --dry-run)
 *   POST /api/sparks/:id/tool-eval/probe                  is the endpoint reachable (--probe)
 *   GET/POST /api/sparks/:id/tool-eval/runs               list / start a run
 *   GET  …/runs/:rid, …/stream, …/result                  one run, its live output, its full result
 *   POST …/runs/:rid/(attach|stop|refresh), DELETE …/runs/:rid, DELETE …/watch
 */
export function registerToolEvalRoutes(app, { registry, manager, store, allowRun, principalKey, rejectLimited }) {
  const base = "/api/sparks/:id/tool-eval";

  const sparkOr404 = (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) res.status(404).json({ error: "Spark not found" });
    return spark || null;
  };
  const runOr404 = (req, res, spark) => {
    const rid = req.params.rid;
    const run = isValidRunId(rid) ? store.get(rid) : null;
    if (!run || run.sparkId !== spark.id) {
      res.status(404).json({ error: "Run not found" });
      return null;
    }
    return run;
  };

  /** Validate a request body into { type, built, port } or send a 400. */
  const prepare = (req, res, spark, { forPreview = false } = {}) => {
    const body = req.body || {};
    const type = typeof body.type === "string" ? body.type : "tool-eval";
    if (!(type in TOOL_EVAL_TYPES)) {
      res.status(400).json({ error: `Unknown benchmark type "${String(body.type).slice(0, 40)}"` });
      return null;
    }
    const port = portOf(spark, body);
    const options = { ...(body.options && typeof body.options === "object" ? body.options : {}) };
    if (typeof body.extraArgs === "string" && body.extraArgs.trim()) options.extra = splitExtraArgs(body.extraArgs);
    else if (Array.isArray(body.extra)) options.extra = body.extra;
    // The saved key belongs to this Spark's own server: never to a custom URL or a named provider.
    const providerSet = typeof options.provider === "string" && options.provider.trim() !== "";
    const savedApiKey = body.useSavedKey === false || providerSet || !mayUseSavedKey(options["base-url"]) ? null : registry.getLlmApiKey?.(spark.id, port) ?? null;
    const built = buildToolEvalArgs(options, {
      defaultBaseUrl: `http://127.0.0.1:${port}`,
      savedApiKey,
      forPreview,
    });
    if (!built.ok) {
      res.status(400).json({ error: built.errors[0], errors: built.errors });
      return null;
    }
    return { type, built, port, label: typeof options.label === "string" ? options.label : "", usedSavedKey: savedApiKey != null && !!built.env.TOOL_EVAL_API_KEY };
  };

  app.get("/api/tool-eval/spec", (_req, res) => {
    res.json({
      ...publicSpec(),
      types: TOOL_EVAL_TYPES,
      install: { extras: ALLOWED_EXTRAS, source: "github.com/SeraphimSerapis/tool-eval-bench" },
    });
  });

  app.get(`${base}/status`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    res.json(await manager.status(spark));
  });

  app.get(`${base}/install-command`, (req, res) => {
    const extras = String(req.query.extras ?? "").split(",").filter((e) => ALLOWED_EXTRAS.includes(e));
    res.json({ command: installCommandLine({ extras, upgrade: req.query.upgrade === "1" }) });
  });

  app.post(`${base}/install`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
    const extras = Array.isArray(req.body?.extras) ? req.body.extras.filter((e) => ALLOWED_EXTRAS.includes(e)) : [];
    const result = manager.install(spark, { extras, upgrade: req.body?.upgrade === true });
    if (!result.ok) return res.status(409).json({ error: "Another Tool Eval job is running on this Spark", active: result.active });
    res.status(202).json({ job: manager.summary(result.job), command: installCommandLine({ extras, upgrade: req.body?.upgrade === true }) });
  });

  app.get(`${base}/install/stream`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const job = manager.latestJob(spark.id);
    if (!job || job.kind !== "install") return res.status(404).json({ error: "No install is in progress" });
    const read = manager.readJob(spark.id, job.id, { lineSince: Number(req.query.lineSince) || 0 });
    res.json(read);
  });

  app.post(`${base}/preview`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const prepared = prepare(req, res, spark, { forPreview: true });
    if (!prepared) return;
    const out = { ok: true, command: prepared.built.display, port: prepared.port, usesSavedKey: prepared.usedSavedKey };
    if (req.body?.dryRun === true) {
      if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
      const argv = [...prepared.built.argv, "--dry-run", "--no-live"];
      const result = await manager.once(spark, { argvB64: argvB64(argv), secrets: null });
      out.dryRun = { ok: result.ok, exitCode: result.code, output: result.output.slice(0, 20000), error: result.error };
    }
    res.json(out);
  });

  app.post(`${base}/probe`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
    const port = portOf(spark, req.body);
    const options = req.body?.options && typeof req.body.options === "object" ? req.body.options : {};
    const target = typeof options["base-url"] === "string" && options["base-url"] ? options["base-url"] : `http://127.0.0.1:${port}`;
    const bad = validateBaseUrl(target, "Base URL");
    if (bad) return res.status(400).json({ error: bad });
    const result = await manager.once(spark, { argvB64: argvB64(["--probe", "--json", "--base-url", target]), secrets: null });
    res.json({ ok: result.ok, exitCode: result.code, output: result.output.slice(0, 8000), error: result.error, target });
  });

  app.get(`${base}/runs`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const type = typeof req.query.type === "string" && req.query.type in TOOL_EVAL_TYPES ? req.query.type : undefined;
    const active = manager.activeJob(spark.id);
    res.json({
      runs: store.list({ sparkId: spark.id, type }),
      active: active ? manager.summary(active) : null,
    });
  });

  app.post(`${base}/runs`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
    const prepared = prepare(req, res, spark);
    if (!prepared) return;
    const id = newRunId();
    const resultRef = `${runDirRef(id)}/result.json`;
    const argv = [...prepared.built.argv, "--json-file", resultRef, "--no-live"];
    const typeLabel = TOOL_EVAL_TYPES[prepared.type];
    const opts = prepared.built.redacted;
    const run = {
      id,
      sparkId: spark.id,
      type: prepared.type,
      typeLabel,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      label: prepared.label.slice(0, 120),
      port: prepared.port,
      model: typeof opts.model === "string" ? opts.model : null,
      baseUrl: typeof opts["base-url"] === "string" ? opts["base-url"] : `http://127.0.0.1:${prepared.port}`,
      command: prepared.built.display,
      options: opts,
      summary: null,
      resultCached: false,
    };
    // Stored before the job starts: a job that fails at once (e.g. an incomplete SSH config) settles
    // this record itself, and it must already exist for that to happen.
    store.add(run);
    const started = manager.startRun(spark, { run, argv, env: prepared.built.env });
    if (!started.ok) {
      store.remove(run.id);
      return res.status(409).json({ error: "Another Tool Eval job is running on this Spark. Wait for it or stop it first.", active: started.active });
    }
    res.status(202).json({ run: store.get(run.id) ?? run, job: manager.summary(started.job) });
  });

  app.get(`${base}/runs/:rid`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    const job = manager.latestJob(spark.id);
    res.json({ run, job: job && job.id === run.id ? manager.summary(job) : null });
  });

  app.get(`${base}/runs/:rid/stream`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    const read = manager.readJob(spark.id, run.id, {
      lineSince: Number.parseInt(String(req.query.lineSince ?? "0"), 10) || 0,
      eventSince: Number.parseInt(String(req.query.eventSince ?? "0"), 10) || 0,
    });
    // No live job in memory (finished long ago or the server restarted): the client falls back to the stored run.
    res.json({ run: store.get(run.id), live: read });
  });

  app.post(`${base}/runs/:rid/attach`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    const result = manager.attachRun(spark, run);
    if (!result.ok) return res.status(409).json({ error: "Another Tool Eval job is running on this Spark", active: result.active });
    res.status(202).json({ job: manager.summary(result.job) });
  });

  app.post(`${base}/runs/:rid/stop`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
    const result = await manager.stopRun(spark, run.id);
    res.json({ success: result.ok, output: result.output });
  });

  app.post(`${base}/runs/:rid/refresh`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
    const state = await manager.checkRun(spark, run.id);
    res.json({ state, run: store.get(run.id) });
  });

  app.get(`${base}/runs/:rid/result`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    let text = store.loadResult(run.id);
    if (!text) {
      if (!allowRun(principalKey(req))) return rejectLimited(res, "Too many requests; try again shortly");
      const captured = await manager.captureResult(spark, run.id);
      if (!captured.ok) {
        const why = captured.reason === "too-big" ? "The result file is too large to load here." : "No result file exists for this run (yet).";
        return res.status(404).json({ error: why, reason: captured.reason });
      }
      text = store.loadResult(run.id);
    }
    let result = null;
    try {
      result = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "The stored result could not be read" });
    }
    res.json({ run: store.get(run.id), result });
  });

  app.delete(`${base}/runs/:rid`, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    const run = runOr404(req, res, spark);
    if (!run) return;
    const live = manager.activeJob(spark.id);
    if (run.status === "running" || (live && live.id === run.id && live.kind === "run")) {
      return res.status(409).json({ error: "Stop the run before deleting it." });
    }
    await manager.deleteRun(spark.online ? spark : null, run.id);
    res.json({ success: true });
  });

  app.delete(`${base}/watch`, (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    res.json({ success: manager.cancelWatch(spark.id) });
  });
}
