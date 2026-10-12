import { localizedServerText } from "../../../i18n/messages";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import type { ToolEvalLine, ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { GenericResult, GenericValue } from "./GenericResult";
import { explainErrorCode, fmtDate, fmtDuration, toolNotes } from "./format";
import { useToolEvalResult } from "./hooks";
import { hasScenarioData, isObj, normalizeToolResult } from "./normalize";
import { CopyButton, Notice, RunTerminal, Skeleton } from "./parts";
import { statusLabel, statusTone } from "./status";
import { ToolResult } from "./ToolResult";

/** Run facts: when, how long, what it ran against, the command and the (redacted) options. */
export function RunMeta({ run }: { run: ToolEvalRun }) {
  useTranslation();
  const dur = run.finishedAt ? (run.finishedAt - run.startedAt) / 1000 : null;
  const optionCount = Object.keys(run.options ?? {}).length;
  return (
    <div className="te-runmeta">
      <div className="te-runmeta__tags">
        <Tag tone={statusTone(run.status)}>{statusLabel(run.status)}</Tag>
        <span className="te-faint">{fmtDate(run.startedAt)}</span>
        {dur != null ? <span className="te-faint">{i18next.t("bench.ui.took_b1b416", "took")} {fmtDuration(dur)}</span> : null}
        {run.model ? <Tag tone="neutral">{run.model}</Tag> : null}
        <span className="te-faint mono">{run.id}</span>
      </div>
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">{i18next.t("bench.ui.command_890189", "Command")}</span>
          <CopyButton text={run.command} />
        </div>
        <pre className="te-cmd__body">{run.command}</pre>
      </div>
      {optionCount ? (
        <details className="te-disclosure">
          <summary>
            <span>{i18next.t("bench.ui.optionsCount", "Options used ({count})", { count: optionCount })}</span>
          </summary>
          <div className="te-disclosure__body">
            <GenericValue value={run.options} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

interface ResultPanelProps {
  sparkId: string;
  type: string;
  run: ToolEvalRun;
  /** Output captured while this page followed the run (only available for runs started or watched in this visit). */
  lines?: ToolEvalLine[];
  errorCode?: { code: string; message: string | null } | null;
  /** Bumped when the run settles so the result is re-read. */
  version?: number;
}

/** The result of one run: headline renderers for tool-call data, metric-first for everything else, and failure explanations. */
export function ResultPanel({ sparkId, type, run, lines, errorCode, version }: ResultPanelProps) {
  useTranslation();
  const wantsResult = run.status === "completed" || run.status === "stopped" || run.status === "failed";
  const state = useToolEvalResult(sparkId, wantsResult ? run.id : null, version);
  const tool = state.result ? normalizeToolResult(state.result) : null;
  const scenarios = state.result ? hasScenarioData(state.result) : false;
  const isToolType = type === "tool-eval" || type === "context-pressure";
  const failed = run.status === "failed" || run.status === "stopped" || run.status === "gone";
  const stripped = isObj(state.result) && scenarios ? Object.fromEntries(Object.entries(state.result).filter(([k]) => k !== "scores")) : state.result;

  return (
    <div className="te-result">
      <RunMeta run={run} />
      {failed ? (
        <Notice tone={run.status === "failed" ? "bad" : "warn"} title={run.status === "failed" ? i18next.t("bench.ui.theRunFailedV1_d84728", "The run failed{v1}", { v1: run.exitCode != null ? i18next.t("bench.ui.exitCodeV1_01f57c", " (exit code {v1})", { v1: run.exitCode }) : "" }) : run.status === "stopped" ? i18next.t("bench.ui.theRunWasStopped_366783", "The run was stopped") : i18next.t("bench.ui.theRunIsGone_89f83f", "The run is gone")}>
          {errorCode
            ? explainErrorCode(errorCode.code, errorCode.message)
            : run.status === "gone"
              ? i18next.t("bench.ui.theFilesOfThisRunNoLonger_8dfced", "The files of this run no longer exist on the Spark.")
              : i18next.t("bench.ui.theToolStoppedBeforeWritingAComplete_1bbf03", "The tool stopped before writing a complete result.")}
        </Notice>
      ) : null}
      {!failed && lines && lines.length ? (
        <>
          {toolNotes(lines).length ? (
            <Notice tone="info" title={i18next.t("bench.ui.goodToKnow_79fc37", "Good to know")}>
              {toolNotes(lines).map((n) => (
                <p key={n.key}>{n.text}</p>
              ))}
            </Notice>
          ) : null}
        </>
      ) : null}
      {failed && lines && lines.length ? (
        <details className="te-disclosure" open>
          <summary>
            <span>{i18next.t("bench.ui.outputOfTheRun_f5347d", "Output of the run")}</span>
          </summary>
          <div className="te-disclosure__body">
            <RunTerminal lines={lines} />
          </div>
        </details>
      ) : null}
      {run.status === "running" ? <Notice tone="info">{i18next.t("bench.ui.thisRunHasNotFinishedYetIts_9f04ef", "This run has not finished yet. Its result appears here when it does.")}</Notice> : null}
      {state.loading ? <Skeleton lines={5} /> : null}
      {state.error && wantsResult ? (
        <Notice tone={failed ? "info" : "bad"} title={failed ? i18next.t("bench.ui.noResultWasSaved_4bd5fd", "No result was saved") : i18next.t("bench.ui.couldNotLoadTheResult_ff8933", "Could not load the result")} actions={failed ? null : <button type="button" className="btn btn--sm" onClick={state.reload}>{i18next.t("bench.ui.retry_9f5cd8", "Retry")}</button>}>
          {localizedServerText(state.error)}
        </Notice>
      ) : null}
      {state.result != null && !state.loading ? (
        <>
          {scenarios && tool ? <ToolResult data={tool} raw={state.result} /> : null}
          {(!isToolType || !scenarios) && !(scenarios && isToolType) ? <GenericResult result={stripped} /> : null}
          {scenarios && isToolType && type === "context-pressure" ? <GenericResult result={stripped} compact /> : null}
        </>
      ) : null}
    </div>
  );
}
