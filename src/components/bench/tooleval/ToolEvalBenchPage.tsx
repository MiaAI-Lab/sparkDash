import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SparkSnapshot, ToolEvalRun, ToolEvalRunRequest } from "../../../api/types";
import "../../../styles/dialogs.css";
import "../../../styles/tooleval.css";
import { ConfigForm } from "./ConfigForm";
import { History } from "./History";
import { useToolEvalPreview, useToolEvalRunner, useToolEvalSpec, useToolEvalStatus } from "./hooks";
import { LiveRun } from "./LiveRun";
import { apiKeyFor, buildRequest, loadState, mapServerErrors, saveState, stateFromRun, validateState, type FormState } from "./options";
import { Notice, Skeleton } from "./parts";
import { ResultPanel } from "./ResultPanel";
import { RunCard } from "./RunCard";
import { SetupCard } from "./SetupCard";
import { SimpleConfig, defaultSimpleState } from "./SimpleConfig";
import { Tabs, panelId, tabId } from "./Tabs";
import { benchTypeById } from "../benchCatalog";
import { benchId, idToPath } from "../../../constants";
import { fmtNum } from "./format";

type Tab = "run" | "results" | "history";
type ConfigView = "simple" | "advanced";

const VIEW_KEY = "sparkdash.toolEval.view";
function readView(): ConfigView {
  try {
    return localStorage.getItem(VIEW_KEY) === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

/** Types that run tool-call scenarios (and so have a per-scenario list and score). */
const SCENARIO_TYPES = new Set(["tool-eval", "context-pressure"]);

/** One component serves all seven Tool Eval page types: setup, configure, run, results and history. */
export function ToolEvalBenchPage({ type, spark }: { type: string; spark: SparkSnapshot | null }) {
  if (!spark) return <p className="te-empty te-empty--big">Add a Spark to run Tool Eval Bench.</p>;
  return <ToolEvalBench key={`${spark.id}:${type}`} type={type} spark={spark} />;
}

function ToolEvalBench({ type, spark }: { type: string; spark: SparkSnapshot }) {
  const { spec, error: specError, retry: retrySpec } = useToolEvalSpec();
  const status = useToolEvalStatus(spark.id);
  const [state, setState] = useState<FormState>(() => loadState(type) ?? defaultSimpleState(type));
  const [view, setViewState] = useState<ConfigView>(readView);
  const setView = (v: ConfigView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const [apiKey, setApiKey] = useState("");
  // Simple view: test a custom URL instead of this Spark's model. Lives here, next to the key, so the two cannot disagree.
  const [useUrl, setUseUrl] = useState(() => String(state.values["base-url"] ?? "").trim() !== "");
  const [tab, setTab] = useState<Tab>("run");
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [settledRun, setSettledRun] = useState<ToolEvalRun | null>(null);
  const [starting, setStarting] = useState(false);
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const onSettled = useCallback((run: ToolEvalRun) => {
    setSettledRun(run);
    setViewedId(run.id);
    setVersion((v) => v + 1);
    // Only leave the Run tab; someone reading History or Results is not yanked away.
    if (run.status === "completed") setTab((t) => (t === "run" ? "results" : t));
  }, []);
  const runner = useToolEvalRunner(spark.id, type, onSettled);
  const { followed } = runner;

  // Remember the last-used options per page type (never the API key or header values).
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveState(type, spec, state);
  }, [type, spec, state]);

  const ports = spark.llmPorts && spark.llmPorts.length ? spark.llmPorts : spark.llmPort ? [spark.llmPort] : [8888];
  const port = state.port != null && ports.includes(state.port) ? state.port : ports[0];

  // A typed key only ever goes with a custom base URL, never to the local server.
  const sendKey = apiKeyFor(state, apiKey);
  const built = useMemo(() => (spec ? buildRequest(spec, type, state, "") : null), [spec, type, state]);
  const client = useMemo(() => (spec ? validateState(spec, type, state) : { fields: {}, form: [] }), [spec, type, state]);
  const clientOk = Object.keys(client.fields).length === 0 && client.form.length === 0;
  const previewReq: ToolEvalRunRequest | null = built && clientOk ? { type, options: built.options, extraArgs: built.extraArgs, port: built.port, useSavedKey: sendKey ? false : undefined } : null;
  const preview = useToolEvalPreview(spark.id, previewReq);
  const server = useMemo(() => (spec ? mapServerErrors(spec, preview.errors) : { fields: {}, form: [] }), [spec, preview.errors]);
  const fieldErrors = { ...server.fields, ...client.fields };
  const formErrors = [...client.form, ...server.form];

  // A run just started has no job for ~150 ms (until the first poll): it is already busy.
  const followedStarting = followed?.run.status === "running" && !followed.job && runner.polling;
  const followedRunning = (followed?.run.status === "running" && followed.job?.status === "running") || followedStarting;
  const busyReason = followedRunning ? "A run is already in progress on this Spark." : runner.active && runner.active.status === "running" && !followed ? "Another Tool Eval Bench job is running on this Spark." : runner.busy ? "Another Tool Eval Bench job is running on this Spark." : null;
  const baseUrl = typeof built?.options["base-url"] === "string" ? (built.options["base-url"] as string) : `http://127.0.0.1:${port}`;

  const start = async () => {
    if (!spec) return;
    const req = buildRequest(spec, type, state, sendKey);
    setStarting(true);
    const ok = await runner.start({ type, options: req.options, extraArgs: req.extraArgs, port: req.port, useSavedKey: sendKey ? false : undefined });
    setStarting(false);
    if (ok) {
      setSettledRun(null);
      setTab("run");
    }
  };

  const selectedRun = useMemo(() => {
    const id = viewedId ?? runner.runs?.find((r) => r.status === "completed")?.id ?? null;
    if (!id) return null;
    return runner.runs?.find((r) => r.id === id) ?? (followed?.run.id === id ? followed.run : null);
  }, [viewedId, runner.runs, followed]);

  const openRun = (run: ToolEvalRun) => {
    setViewedId(run.id);
    setTab("results");
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const rerun = (run: ToolEvalRun) => {
    if (!spec) return;
    const next = stateFromRun(spec, type, run);
    setState(next);
    setApiKey("");
    setUseUrl(Boolean(String(next.values["base-url"] ?? "").trim()));
    setTab("run");
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const installed = Boolean(status.status?.installed);
  const scenarioMode = SCENARIO_TYPES.has(type);
  const showStrip = followedRunning && tab !== "run";
  const progress = followed?.progress;
  const resultLines = followed && selectedRun && followed.run.id === selectedRun.id ? followed.lines : undefined;
  const resultError = followed && selectedRun && followed.run.id === selectedRun.id ? followed.progress?.error ?? null : null;

  return (
    <div className="te" ref={rootRef}>
      {!spark.online ? <Notice tone="warn" title={`${spark.name} is offline`}>The tool runs on the Spark, so runs and checks need it online. You can still configure and review history.</Notice> : null}
      {runner.elsewhere ? (
        <Notice tone="info" title="Another Tool Eval Bench run is in progress on this Spark">
          It belongs to the {benchTypeById(runner.elsewhere.type)?.label ?? runner.elsewhere.type ?? "other"} page, so it is not shown here.{" "}
          <a href={idToPath(benchId(benchTypeById(runner.elsewhere.type)?.id ?? "tool-eval"))}>Open that page</a>
        </Notice>
      ) : null}
      <SetupCard spark={spark} spec={spec} status={status.status} loading={status.loading} error={status.error} reload={status.reload} busy={followedRunning} />

      <div className="te-tabs">
        <Tabs
          prefix={uid}
          label="Tool Eval Bench sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: "run", label: "Configure and run" },
            { id: "results", label: "Results" },
            { id: "history", label: `History${runner.runs ? ` (${runner.runs.length})` : ""}` },
          ]}
        />
        {showStrip ? (
          <button type="button" className="te-strip" onClick={() => setTab("run")} aria-label="Run in progress, show progress">
            <span className="te-strip__dot" aria-hidden />
            <span>
              Run in progress{progress?.total ? ` · ${progress.done}/${progress.total}` : ""}
              {progress?.finalScore != null ? ` · ${fmtNum(progress.finalScore, 1)}` : ""}
            </span>
          </button>
        ) : null}
      </div>

      {tab === "run" ? (
        <div role="tabpanel" id={panelId(uid, "run")} aria-labelledby={tabId(uid, "run")} className="te-run-tab">
          {followed ? (
            <LiveRun
              followed={followed}
              polling={runner.polling}
              pollError={runner.pollError}
              actionError={runner.actionError}
              scenarioMode={scenarioMode}
              onStop={() => void runner.stop(followed.run)}
              onStopWatching={() => void runner.stopWatching()}
              onAttach={(r) => void runner.attach(r)}
              onRefresh={(r) =>
                void runner.refreshRun(r).then((fresh) => {
                  if (fresh && fresh.status !== "running") onSettled(fresh);
                })
              }
              onDismiss={runner.unfollow}
              onViewResult={openRun}
            />
          ) : null}
          {runner.listError && !runner.runs ? (
            <Notice tone="warn" title="Could not read this Spark's runs" actions={<button type="button" className="btn btn--sm" onClick={() => void runner.reloadRuns()}>Retry</button>}>
              {runner.listError}
            </Notice>
          ) : null}
          {specError ? (
            <Notice tone="bad" title="Could not load the option list" actions={<button type="button" className="btn btn--sm" onClick={retrySpec}>Retry</button>}>
              {specError}
            </Notice>
          ) : !spec ? (
            <Skeleton lines={8} className="te-card te-card--pad" />
          ) : (
            <div className={view === "simple" ? "te-layout te-layout--even" : "te-layout"}>
              <section className="panel te-card te-card--form" aria-label="Configuration">
                <div className="te-viewbar">
                  <Tabs
                    prefix={`${uid}-view`}
                    label="Configuration view"
                    value={view}
                    onChange={setView}
                    items={[
                      { id: "simple", label: "Simple" },
                      { id: "advanced", label: "Advanced" },
                    ]}
                  />
                  <p>{view === "simple" ? "Pick a ready-made run." : "Every option the tool offers."}</p>
                </div>
                <div role="tabpanel" id={panelId(`${uid}-view`, view)} aria-labelledby={tabId(`${uid}-view`, view)}>
                {view === "simple" ? (
                  <SimpleConfig type={type} spark={spark} state={state} onChange={setState} ports={ports} port={port} onAdvanced={() => setView("advanced")} apiKey={apiKey} onApiKey={setApiKey} useUrl={useUrl} onUseUrl={setUseUrl} />
                ) : (
                  <ConfigForm
                    spec={spec}
                    type={type}
                    spark={spark}
                    state={state}
                    onChange={setState}
                    apiKey={apiKey}
                    onApiKey={setApiKey}
                    fieldErrors={fieldErrors}
                    formErrors={formErrors}
                  />
                )}
                </div>
              </section>
              <RunCard
                spark={spark}
                type={type}
                request={{ type, options: built?.options ?? {}, extraArgs: built?.extraArgs, port: built?.port }}
                preview={preview}
                problems={[...Object.values(client.fields), ...client.form]}
                installed={installed}
                busyReason={busyReason}
                starting={starting}
                onStart={() => void start()}
                baseUrl={baseUrl}
                probeOptions={typeof built?.options["base-url"] === "string" ? { "base-url": built.options["base-url"] } : {}}
                port={built?.port}
                hasScenarios={scenarioMode}
                startError={runner.actionError && !followed ? runner.actionError : runner.busy ? runner.actionError : null}
              />
            </div>
          )}
        </div>
      ) : null}

      {tab === "results" ? (
        <div role="tabpanel" id={panelId(uid, "results")} aria-labelledby={tabId(uid, "results")}>
          {selectedRun ? (
            <section className="panel te-card te-card--result">
              <ResultPanel sparkId={spark.id} type={type} run={selectedRun} lines={resultLines} errorCode={resultError} version={version + (settledRun?.id === selectedRun.id ? 1 : 0)} />
            </section>
          ) : (
            <div className="te-empty te-empty--big">
              <b>No result to show yet</b>
              <p>Finish a run, or open one from the history.</p>
              <button type="button" className="btn" onClick={() => setTab("run")}>
                Configure a run
              </button>
            </div>
          )}
        </div>
      ) : null}

      {tab === "history" ? (
        <div role="tabpanel" id={panelId(uid, "history")} aria-labelledby={tabId(uid, "history")}>
          <History
            sparkId={spark.id}
            sparkName={spark.name}
            runs={runner.runs}
            error={runner.listError}
            followedId={followed?.run.id ?? null}
            viewedId={selectedRun?.id ?? null}
            onReload={() => void runner.reloadRuns()}
            onOpen={openRun}
            onRerun={rerun}
            onDelete={runner.remove}
            onRefresh={runner.refresh}
            onAttach={(r) => {
              void runner.attach(r);
              setTab("run");
            }}
          />
        </div>
      ) : null}

      <footer className="te-credit">
        Powered by{" "}
        <a href="https://github.com/SeraphimSerapis/tool-eval-bench/" target="_blank" rel="noopener noreferrer">
          tool-eval-bench
        </a>{" "}
        by SeraphimSerapis. sparkDash adds the interface; the benchmarks are the tool's own.
      </footer>
    </div>
  );
}
