import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("tooleval");
  const [probe, setProbe] = useState<{ loading: boolean; res: ToolEvalProbeResponse | null; error: string | null }>({ loading: false, res: null, error: null });
  const [dry, setDry] = useState<{ loading: boolean; output: string | null; error: string | null; exitCode?: number | null }>({ loading: false, output: null, error: null });

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
      setDry({ loading: false, output: r.dryRun?.output || r.dryRun?.error || "", error: r.dryRun && !r.dryRun.ok ? r.dryRun.error : null, exitCode: r.dryRun && !r.dryRun.ok ? r.dryRun.exitCode : undefined });
    } catch (e) {
      setDry({ loading: false, output: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const invalid = problems.length > 0 || preview.status === "invalid";
  const reason = !installed ? t("ui.installFirst") : invalid ? t("ui.fixOptions") : busyReason;
  const disabled = Boolean(reason) || starting || preview.status === "error";
  const probeOutput = probe.res?.output?.trim() ?? "";

  return (
    <aside className="panel te-card te-runcard" aria-label={t("ui.commandAndStart")}>
      <div className="te-card__head">
        <h2>{t("ui.command")}</h2>
        {preview.status === "loading" ? <span className="te-faint" aria-live="polite">{t("ui.updating")}</span> : null}
        {preview.status === "ok" ? <Tag tone="good">{t("ui.valid")}</Tag> : null}
        {invalid ? <Tag tone="bad">{t("ui.needsAttention")}</Tag> : null}
      </div>
      <p className="te-target">
        {t("ui.runsOn")} <b>{spark.name}</b> {t("ui.against")} <span className="mono">{baseUrl}</span>
      </p>
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">{t("ui.commandLine")}</span>
          {preview.command ? <CopyButton text={preview.command} /> : null}
        </div>
        <pre className="te-cmd__body" aria-live="polite">
          {preview.command ?? (invalid ? t("ui.fixTheErrorsToSeeTheCommand") : preview.status === "error" ? t("ui.previewUnavailable") : "…")}
        </pre>
        <p className="te-faint te-cmd__foot">
          {preview.usesSavedKey ? t("run.savedKey") : ""}
          {t("ui.theApiKeyAndHeaderValuesNever")}
        </p>
      </div>
      {preview.status === "error" ? <Notice tone="bad" title={t("ui.previewFailed")}>{preview.error}</Notice> : null}
      {preview.errors.length || problems.length ? (
        <ul className="te-form-errors" role="alert">
          {[...new Set([...problems, ...preview.errors])].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {startError ? <Notice tone="bad" title={t("ui.couldNotStart")}>{startError}</Notice> : null}

      <div className="te-actions te-actions--stack">
        <button type="button" className="btn btn--primary te-start" disabled={disabled} onClick={onStart} aria-describedby={reason ? "te-start-reason" : undefined}>
          {starting ? t("ui.launcher.starting") : type === "tool-eval" ? t("run.startEvaluation") : t("run.startBenchmark")}
        </button>
        {reason ? (
          <p className="te-faint" id="te-start-reason">
            {reason}
          </p>
        ) : null}
        <div className="te-actions">
          <button type="button" className="btn btn--sm" onClick={runProbe} disabled={probe.loading || !installed}>
            {probe.loading ? t("ui.accessToken.checking") : t("ui.checkConnection")}
          </button>
          {hasScenarios ? (
            <button type="button" className="btn btn--sm" onClick={runDry} disabled={dry.loading || !installed || invalid}>
              {dry.loading ? t("ui.action.loading") : t("ui.previewScenarios")}
            </button>
          ) : null}
        </div>
      </div>

      {probe.res || probe.error ? (
        <div className="te-probe" role="status">
          <Tag tone={probe.res?.ok ? "good" : "bad"}>{probe.res?.ok ? t("ui.reachable") : t("ui.comfy.notReachable")}</Tag>
          <span className="te-faint mono">{probe.res?.target}</span>
          {probeOutput || probe.res?.error || probe.error ? <pre>{probeOutput || probe.res?.error || probe.error}</pre> : null}
        </div>
      ) : null}
      {dry.output != null || dry.error ? (
        <div className="te-probe" role="status">
          <div className="te-probe__head">
            <b>{t("ui.scenariosThatWouldRun")}</b>
            {dry.output ? <CopyButton text={dry.output} /> : null}
          </div>
          {dry.error || dry.exitCode !== undefined ? <p className="te-bad">{dry.error ?? t("run.exitCode", { code: dry.exitCode })}</p> : null}
          {dry.output != null ? <pre>{dry.output || t("ui.noOutput")}</pre> : null}
        </div>
      ) : null}
    </aside>
  );
}
