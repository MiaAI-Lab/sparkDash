import { localizedServerText } from "../../../i18n/messages";
import { localizeBenchText } from "./benchText";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { estimateRemaining, explainErrorCode, fmtDuration, toolNotes } from "./format";
import type { Followed } from "./hooks";
import { CopyButton, Notice, RunTerminal, linesText } from "./parts";
import { statusLabel, statusTone } from "./status";

interface LiveRunProps {
  followed: Followed;
  polling: boolean;
  pollError: string | null;
  actionError: string | null;
  /** Show per-scenario tracking (tool-call scenarios) rather than a phase view. */
  scenarioMode: boolean;
  onStop: () => void;
  onStopWatching: () => void;
  onAttach: (run: ToolEvalRun) => void;
  onRefresh: (run: ToolEvalRun) => void;
  onDismiss: () => void;
  onViewResult: (run: ToolEvalRun) => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

const CHIP: Record<string, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };

/** Progress of the run being followed: counters, current scenario, per-scenario list, raw output, and the stop controls. */
export function LiveRun({ followed, polling, pollError, actionError, scenarioMode, onStop, onStopWatching, onAttach, onRefresh, onDismiss, onViewResult }: LiveRunProps) {
  const { i18n } = useTranslation();
  const { run, job, progress, lines, events, partial, noLive } = followed;
  const jobRunning = job?.status === "running";
  const running = run.status === "running" && (jobRunning || (polling && !job));
  const now = useNow(running);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showTerm, setShowTerm] = useState(false);
  const end = run.finishedAt ?? (running ? now : (job?.finishedAt ?? now));
  const elapsed = Math.max(0, (end - run.startedAt) / 1000);
  const p = progress;
  const total = p?.total ?? null;
  const done = p?.done ?? 0;
  const pct = total ? Math.min(100, (done / total) * 100) : null;
  const eta = running ? estimateRemaining(elapsed, done, total) : null;
  const finished = run.status !== "running";
  const lostWatch = !running && !finished; // run is still going on the Spark, but nobody is reading it
  const err = p?.error ?? null;
  const live = running && !stopping;
  const notes = useMemo(() => toolNotes(lines), [lines, i18n.language]);
  const errLines = lines.filter((l) => l.stream === "err" && !l.text.startsWith("{")).slice(-3);

  // Keep the newest scenario in view while the list grows, unless the reader scrolled up to look back.
  const listRef = useRef<HTMLUListElement | null>(null);
  const pinnedRef = useRef(true);
  const scenarioCount = p?.scenarios.length ?? 0;
  // A new run starts pinned to the newest scenario again, whatever the last one's scroll position was.
  useEffect(() => {
    pinnedRef.current = true;
  }, [run.id]);
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [scenarioCount]);

  useEffect(() => {
    if (!running) {
      setConfirmStop(false);
      setStopping(false);
    }
  }, [running]);

  const phaseText = (() => {
    if (!p) return i18next.t("bench.ui.starting_e5f580", "Starting…");
    switch (p.phase) {
      case "starting":
        return i18next.t("bench.ui.startingTheToolOnTheSpark_2ba2bd", "Starting the tool on the Spark…");
      case "connecting":
        return i18next.t("bench.ui.connectedToV1V2_f5c263", "Connected to {v1}{v2}…", { v1: p.server?.baseUrl ?? i18next.t("bench.ui.theServer_cae77b", "the server"), v2: p.server?.backend ? ` (${p.server.backend})` : "" });
      case "running":
        return scenarioMode ? i18next.t("bench.ui.runningScenarios_293803", "Running scenarios") : i18next.t("bench.ui.measuring_13a40d", "Measuring");
      case "done":
        return i18next.t("bench.ui.finished_355bcc", "Finished");
      case "error":
        return i18next.t("bench.ui.error_7f2f6a", "Error");
      default:
        return p.phase;
    }
  })();

  return (
    <section className="panel te-card te-live" aria-label={i18next.t("bench.ui.runProgress_c961f3", "Run progress")}>
      <div className="te-card__head">
        <div>
          <div className="eyebrow">{finished ? i18next.t("bench.ui.lastRun_333c63", "Last run") : i18next.t("bench.ui.runInProgress_3a1231", "Run in progress")}</div>
          <h2>
            {localizeBenchText(run.typeLabel)}
            {run.label ? <span className="te-faint"> · {run.label}</span> : null}
          </h2>
        </div>
        <div className="te-live__tags">
          <Tag tone={statusTone(run.status)}>{statusLabel(run.status, jobRunning)}</Tag>
          {p?.model || run.model ? <Tag tone="neutral" title={i18next.t("bench.ui.model_68c2cc", "Model")}>{p?.model ?? run.model}</Tag> : null}
        </div>
      </div>

      <div className="te-progress" role="group" aria-label={i18next.t("bench.ui.progress_1b9027", "Progress")}>
        <div
          className={`te-bar ${pct == null && running ? "is-indeterminate" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={pct == null ? undefined : done}
          aria-valuetext={total ? `${done} of ${total} scenarios` : phaseText}
        >
          <i className={err || run.status === "failed" ? "is-bad" : undefined} style={pct != null ? { width: `${pct}%` } : finished ? { width: "100%" } : undefined} />
        </div>
        <div className="te-progress__meta" aria-live="polite">
          <span>{total ? <><b className="mono">{done}</b> / {total} {i18next.t("bench.ui.scenarios_c254d1", "scenarios")}</> : phaseText}</span>
          <span className="te-faint">
            {fmtDuration(elapsed)} {i18next.t("bench.ui.elapsed_0a6837", "elapsed")}{eta != null ? i18next.t("bench.ui.aboutV1Left_b3ccd1", " · about {v1} left", { v1: fmtDuration(eta) }) : ""}
          </span>
        </div>
      </div>

      {scenarioMode && p ? (
        <div className="te-counters">
          <span className="te-counter-chip is-pass"><b>{p.counts.pass}</b> {i18next.t("bench.ui.pass_9d4e1e", "pass")}</span>
          <span className="te-counter-chip is-partial"><b>{p.counts.partial}</b> {i18next.t("bench.ui.partial_355705", "partial")}</span>
          <span className="te-counter-chip is-fail"><b>{p.counts.fail}</b> {i18next.t("bench.ui.fail_a602e2", "fail")}</span>
          {p.counts.other ? <span className="te-counter-chip"><b>{p.counts.other}</b> {i18next.t("bench.ui.other_d0941e", "other")}</span> : null}
          <span className="te-faint te-counters__pts">{p.points} {i18next.t("bench.ui.points_819f41", "points")}</span>
        </div>
      ) : null}

      {live ? (
        <p className="te-current" aria-live="polite">
          {scenarioMode && p?.current?.id ? (
            <>{i18next.t("bench.ui.now_a61d4e", "Now:")} <b className="mono">{p.current.id}</b>
              {p.current.title ? ` ${p.current.title}` : ""}
              {p.current.category ? <Tag tone="neutral">{p.current.category}</Tag> : null}
            </>
          ) : (
            phaseText
          )}
        </p>
      ) : null}

      {notes.length ? (
        <Notice tone="info" title={i18next.t("bench.ui.goodToKnow_79fc37", "Good to know")}>
          {notes.map((n) => (
            <p key={n.key}>{n.text}</p>
          ))}
        </Notice>
      ) : null}

      {err || run.status === "failed" ? (
        <Notice tone="bad" title={err ? i18next.t("bench.ui.theToolReportedAnError_e9c97f", "The tool reported an error") : i18next.t("bench.ui.theRunFailedV1_d84728", "The run failed{v1}", { v1: run.exitCode != null ? i18next.t("bench.ui.exitCodeV1_01f57c", " (exit code {v1})", { v1: run.exitCode }) : "" })}>
          {err ? explainErrorCode(err.code, err.message) : errLines.length ? errLines.map((l) => l.text).join(" / ") : i18next.t("bench.ui.openTheRawOutputBelowForDetails_21630c", "Open the raw output below for details.")}
        </Notice>
      ) : null}
      {run.status === "stopped" ? <Notice tone="warn" title={i18next.t("bench.ui.theRunWasStopped_366783", "The run was stopped")}>{i18next.t("bench.ui.itStoppedBeforeFinishingSoThereMay_689bbe", "It stopped before finishing, so there may be no result.")}</Notice> : null}
      {job?.status === "detached" || (lostWatch && job) ? (
        <Notice
          tone="warn"
          title={i18next.t("bench.ui.lostTheLiveView_22b04a", "Lost the live view")}
          actions={
            <>
              <button type="button" className="btn btn--sm" onClick={() => onAttach(run)}>{i18next.t("bench.ui.reAttach_fcc3e9", "Re-attach")}</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRefresh(run)}>{i18next.t("bench.ui.checkStatus_07adf9", "Check status")}</button>
            </>
          }
        >
          {job?.error ? localizedServerText(job.error) : i18next.t("bench.ui.theRunMayStillBeGoingOn_7baa5e", "The run may still be going on the Spark.")}
        </Notice>
      ) : null}
      {lostWatch && !job ? (
        <Notice
          tone="info"
          title={noLive ? i18next.t("bench.ui.notWatchingThisRun_285d85", "Not watching this run") : i18next.t("bench.ui.runIsDetached_a7d527", "Run is detached")}
          actions={
            <>
              <button type="button" className="btn btn--sm" onClick={() => onAttach(run)}>{i18next.t("bench.ui.watchAgain_0587c1", "Watch again")}</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRefresh(run)}>{i18next.t("bench.ui.checkStatus_07adf9", "Check status")}</button>
            </>
          }
        >{i18next.t("bench.ui.theRunContinuesOnTheSparkWatch_2a8718", "The run continues on the Spark. Watch it again to see its progress, or check whether it has finished.")}</Notice>
      ) : null}
      {pollError ? <Notice tone="warn" title={i18next.t("bench.ui.connectionToSparkdashLostRetrying_a30cf1", "Connection to sparkDash lost, retrying…")}>{localizedServerText(pollError)}</Notice> : null}
      {actionError ? <Notice tone="bad">{localizedServerText(actionError)}</Notice> : null}

      {scenarioMode && p && p.scenarios.length ? (
        <ul
          ref={(el) => {
            if (el && listRef.current !== el) pinnedRef.current = true; // a freshly mounted list starts pinned
            listRef.current = el;
          }}
          className={`te-scn-list${running ? " is-live" : ""}`}
          aria-label={i18next.t("bench.ui.scenariosSoFar_e9847f", "Scenarios so far")}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {p.scenarios.map((s, i) => (
            <li key={`${s.id}-${i}`} className={`is-${CHIP[s.status] ?? "neutral"}`} title={`${s.title ?? ""} ${s.points != null ? i18next.t("bench.ui.v1Pts_1d1eb4", "· {v1} pts", { v1: s.points }) : ""}`}>
              <Tag tone={CHIP[s.status] ?? "neutral"}>{localizeBenchText(s.status)}</Tag>
              <span className="mono">{s.id}</span>
              <span className="te-scn-list__title">{s.title ?? ""}</span>
              {s.durationSeconds != null ? <span className="te-faint">{s.durationSeconds.toFixed(1)}s</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!scenarioMode && events.length ? (
        <ul className="te-events" aria-label={i18next.t("bench.ui.recentActivity_72d561", "Recent activity")}>
          {events.slice(-6).map((e) => (
            <li key={e.seq}>
              <span className="mono">{e.event}</span>
              <span className="te-faint">{eventBrief(e)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="te-actions">
        {running ? (
          confirmStop ? (
            <>
              <span className="te-confirm-text">{i18next.t("bench.ui.stopThisRunOnTheSparkPartial_7d7247", "Stop this run on the Spark? Partial results are lost.")}</span>
              <button
                type="button"
                className="btn btn--danger"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  onStop();
                }}
              >
                {stopping ? i18next.t("bench.ui.stopping_827c97", "Stopping…") : i18next.t("bench.ui.yesStopIt_2ed0f6", "Yes, stop it")}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmStop(false)}>{i18next.t("bench.ui.keepRunning_fecf69", "Keep running")}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--danger" onClick={() => setConfirmStop(true)}>{i18next.t("bench.ui.stopRun_3fa97b", "Stop run")}</button>
              <button type="button" className="btn btn--ghost" onClick={onStopWatching} title={i18next.t("bench.ui.theRunKeepsGoingOnTheSpark_2ce681", "The run keeps going on the Spark; you can watch it again from the history.")}>{i18next.t("bench.ui.stopWatching_9e521d", "Stop watching")}</button>
            </>
          )
        ) : null}
        {finished && run.status === "completed" ? <button type="button" className="btn btn--primary" onClick={() => onViewResult(run)}>{i18next.t("bench.ui.viewResult_a4a3e2", "View result")}</button> : null}
        {finished ? <button type="button" className="btn btn--ghost" onClick={onDismiss}>{i18next.t("bench.ui.dismiss_70afe9", "Dismiss")}</button> : null}
        <button type="button" className="btn btn--ghost te-actions__end" aria-expanded={showTerm} onClick={() => setShowTerm((s) => !s)}>
          {showTerm ? i18next.t("bench.ui.hideRawOutput_dc3d32", "Hide raw output") : i18next.t("bench.ui.rawOutputV1_bbe433", "Raw output ({v1})", { v1: lines.length })}
        </button>
      </div>
      {running ? <p className="te-faint">{i18next.t("bench.ui.stopWatchingLeavesTheRunGoingOn_47fcc1", "Stop watching leaves the run going on the Spark; it will show up under History and can be re-attached.")}</p> : null}
      {showTerm ? (
        <div className="te-live__term">
          <div className="te-json__bar">
            <span className="te-faint">{i18next.t("bench.ui.stderrLinesAreDimmedMessagesAboutFeatures_856ed6", "stderr lines are dimmed. Messages about features the server lacks (an HTTP 400, “rejected”) are the tool probing it, not a failure.")}</span>
            <CopyButton text={() => linesText(lines, partial)} label={i18next.t("bench.ui.copyOutput_944a2c", "Copy output")} />
          </div>
          <RunTerminal lines={lines} partial={partial} running={running} />
        </div>
      ) : null}
    </section>
  );
}

function eventBrief(e: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === "seq" || k === "event") continue;
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${String(v).slice(0, 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" ");
}
