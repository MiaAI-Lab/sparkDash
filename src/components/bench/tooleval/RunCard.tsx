import { localizedServerText } from "../../../i18n/messages";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import { useState } from "react";
import { previewToolEval, probeToolEval } from "../../../api/client";
import type { SparkSnapshot, ToolEvalProbeResponse, ToolEvalRunRequest } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import type { PreviewState } from "./hooks";
import { CopyButton, Notice } from "./parts";

interface RunCardProps {
  spark: SparkSnapshot;
  type: string;
  request: ToolEvalRunRequest;
  preview: PreviewState;
  /** Client-side + server validation messages for the whole form (shown as a list). */
  problems: string[];
  installed: boolean;
  busyReason: string | null;
  starting: boolean;
  onStart: () => void;
  baseUrl: string;
  /** Option values for the probe (base URL). */
  probeOptions: Record<string, unknown>;
  port?: number;
  hasScenarios: boolean;
  startError: string | null;
}

/** Live command line, validation summary, connection check, scenario preview and the Start button. */
export function RunCard({ spark, type, request, preview, problems, installed, busyReason, starting, onStart, baseUrl, probeOptions, port, hasScenarios, startError }: RunCardProps) {
  useTranslation();
  const [probe, setProbe] = useState<{ loading: boolean; res: ToolEvalProbeResponse | null; error: string | null }>({ loading: false, res: null, error: null });
  const [dry, setDry] = useState<{ loading: boolean; output: string | null; error: string | null }>({ loading: false, output: null, error: null });

  const runProbe = async () => {
    setProbe({ loading: true, res: null, error: null });
    try {
      setProbe({ loading: false, res: await probeToolEval(spark.id, probeOptions, port), error: null });
    } catch (e) {
      setProbe({ loading: false, res: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const runDry = async () => {
    setDry({ loading: true, output: null, error: null });
    try {
      const r = await previewToolEval(spark.id, { ...request, dryRun: true });
      setDry({ loading: false, output: r.dryRun ? r.dryRun.output || (r.dryRun.error ?? i18next.t("bench.ui.noOutput", "No output.")) : i18next.t("bench.ui.noOutput", "No output."), error: r.dryRun && !r.dryRun.ok ? r.dryRun.error ?? i18next.t("bench.ui.exitedCode", "Exited with code {code}", { code: r.dryRun.exitCode }) : null });
    } catch (e) {
      setDry({ loading: false, output: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const invalid = problems.length > 0 || preview.status === "invalid";
  const reason = !installed ? i18next.t("bench.ui.installFirst", "Install Tool Eval Bench on this Spark first.") : invalid ? i18next.t("bench.ui.fixOptions", "Fix the highlighted options first.") : busyReason;
  const disabled = Boolean(reason) || starting || preview.status === "error";
  const probeOutput = probe.res?.output?.trim() ?? "";

  return (
    <aside className="panel te-card te-runcard" aria-label={i18next.t("bench.ui.commandAndStart_5a778d", "Command and start")}>
      <div className="te-card__head">
        <h2>{i18next.t("bench.ui.command_890189", "Command")}</h2>
        {preview.status === "loading" ? <span className="te-faint" aria-live="polite">{i18next.t("bench.ui.updating_4070a5", "updating…")}</span> : null}
        {preview.status === "ok" ? <Tag tone="good">{i18next.t("bench.ui.valid_bec262", "valid")}</Tag> : null}
        {invalid ? <Tag tone="bad">{i18next.t("bench.ui.needsAttention_3ad98d", "needs attention")}</Tag> : null}
      </div>
      <p className="te-target">{i18next.t("bench.ui.runsOn_570332", "Runs on")} <b>{spark.name}</b> {i18next.t("bench.ui.against_b51c31", "against")} <span className="mono">{baseUrl}</span>
      </p>
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">{i18next.t("bench.ui.commandLine_f6fe35", "Command line")}</span>
          {preview.command ? <CopyButton text={preview.command} /> : null}
        </div>
        <pre className="te-cmd__body" aria-live="polite">
          {preview.command ?? (invalid ? i18next.t("bench.ui.fixTheErrorsToSeeTheCommand_4a4087", "(fix the errors to see the command)") : preview.status === "error" ? i18next.t("bench.ui.previewUnavailable_50369b", "(preview unavailable)") : "…")}
        </pre>
        <p className="te-faint te-cmd__foot">
          {preview.usesSavedKey ? i18next.t("bench.ui.usesTheApiKeySavedForThis_7b8a98", "Uses the API key saved for this Spark's port (passed by environment). ") : ""}{i18next.t("bench.ui.theApiKeyAndHeaderValuesNever_6b883a", "The API key and header values never appear here. The result file path is added when the run starts.")}</p>
      </div>
      {preview.status === "error" ? <Notice tone="bad" title={i18next.t("bench.ui.previewFailed_d7f276", "Preview failed")}>{localizedServerText(preview.error)}</Notice> : null}
      {preview.errors.length || problems.length ? (
        <ul className="te-form-errors" role="alert">
          {[...new Set([...problems, ...preview.errors])].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {startError ? <Notice tone="bad" title={i18next.t("bench.ui.couldNotStart_925149", "Could not start")}>{localizedServerText(startError)}</Notice> : null}

      <div className="te-actions te-actions--stack">
        <button type="button" className="btn btn--primary te-start" disabled={disabled} onClick={onStart} aria-describedby={reason ? "te-start-reason" : undefined}>
          {starting ? i18next.t("bench.ui.starting_e5f580", "Starting…") : i18next.t("bench.ui.startV1_f99684", "Start {v1}", { v1: type === "tool-eval" ? i18next.t("bench.ui.evaluation_90f0f8", "evaluation") : i18next.t("bench.ui.benchmark_fc38e4", "benchmark") })}
        </button>
        {reason ? (
          <p className="te-faint" id="te-start-reason">
            {reason}
          </p>
        ) : null}
        <div className="te-actions">
          <button type="button" className="btn btn--sm" onClick={runProbe} disabled={probe.loading || !installed}>
            {probe.loading ? i18next.t("bench.ui.checking_820d60", "Checking…") : i18next.t("bench.ui.checkConnection_14caef", "Check connection")}
          </button>
          {hasScenarios ? (
            <button type="button" className="btn btn--sm" onClick={runDry} disabled={dry.loading || !installed || invalid}>
              {dry.loading ? i18next.t("bench.ui.loading_33ce41", "Loading…") : i18next.t("bench.ui.previewScenarios_919a58", "Preview scenarios")}
            </button>
          ) : null}
        </div>
      </div>

      {probe.res || probe.error ? (
        <div className="te-probe" role="status">
          <Tag tone={probe.res?.ok ? "good" : "bad"}>{probe.res?.ok ? i18next.t("bench.ui.reachable_fa887b", "Reachable") : i18next.t("bench.ui.notReachable_4e2ee0", "Not reachable")}</Tag>
          <span className="te-faint mono">{probe.res?.target}</span>
          {probeOutput || probe.res?.error || probe.error ? <pre>{probeOutput || localizedServerText(probe.res?.error || probe.error)}</pre> : null}
        </div>
      ) : null}
      {dry.output != null || dry.error ? (
        <div className="te-probe" role="status">
          <div className="te-probe__head">
            <b>{i18next.t("bench.ui.scenariosThatWouldRun_0ae50c", "Scenarios that would run")}</b>
            {dry.output ? <CopyButton text={dry.output} /> : null}
          </div>
          {dry.error ? <p className="te-bad">{localizedServerText(dry.error)}</p> : null}
          {dry.output ? <pre>{dry.output}</pre> : null}
        </div>
      ) : null}
    </aside>
  );
}
