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
      setDry({ loading: false, output: r.dryRun ? r.dryRun.output || (r.dryRun.error ?? "No output.") : "No output.", error: r.dryRun && !r.dryRun.ok ? r.dryRun.error ?? `Exited with code ${r.dryRun.exitCode}` : null });
    } catch (e) {
      setDry({ loading: false, output: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const invalid = problems.length > 0 || preview.status === "invalid";
  const reason = !installed ? "Install Tool Eval Bench on this Spark first." : invalid ? "Fix the highlighted options first." : busyReason;
  const disabled = Boolean(reason) || starting || preview.status === "error";
  const probeOutput = probe.res?.output?.trim() ?? "";

  return (
    <aside className="panel te-card te-runcard" aria-label="Command and start">
      <div className="te-card__head">
        <h2>Command</h2>
        {preview.status === "loading" ? <span className="te-faint" aria-live="polite">updating…</span> : null}
        {preview.status === "ok" ? <Tag tone="good">valid</Tag> : null}
        {invalid ? <Tag tone="bad">needs attention</Tag> : null}
      </div>
      <p className="te-target">
        Runs on <b>{spark.name}</b> against <span className="mono">{baseUrl}</span>
      </p>
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">Command line</span>
          {preview.command ? <CopyButton text={preview.command} /> : null}
        </div>
        <pre className="te-cmd__body" aria-live="polite">
          {preview.command ?? (invalid ? "(fix the errors to see the command)" : preview.status === "error" ? "(preview unavailable)" : "…")}
        </pre>
        <p className="te-faint te-cmd__foot">
          {preview.usesSavedKey ? "Uses the API key saved for this Spark's port (passed by environment). " : ""}
          The API key and header values never appear here. The result file path is added when the run starts.
        </p>
      </div>
      {preview.status === "error" ? <Notice tone="bad" title="Preview failed">{preview.error}</Notice> : null}
      {preview.errors.length || problems.length ? (
        <ul className="te-form-errors" role="alert">
          {[...new Set([...problems, ...preview.errors])].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {startError ? <Notice tone="bad" title="Could not start">{startError}</Notice> : null}

      <div className="te-actions te-actions--stack">
        <button type="button" className="btn btn--primary te-start" disabled={disabled} onClick={onStart} aria-describedby={reason ? "te-start-reason" : undefined}>
          {starting ? "Starting…" : `Start ${type === "tool-eval" ? "evaluation" : "benchmark"}`}
        </button>
        {reason ? (
          <p className="te-faint" id="te-start-reason">
            {reason}
          </p>
        ) : null}
        <div className="te-actions">
          <button type="button" className="btn btn--sm" onClick={runProbe} disabled={probe.loading || !installed}>
            {probe.loading ? "Checking…" : "Check connection"}
          </button>
          {hasScenarios ? (
            <button type="button" className="btn btn--sm" onClick={runDry} disabled={dry.loading || !installed || invalid}>
              {dry.loading ? "Loading…" : "Preview scenarios"}
            </button>
          ) : null}
        </div>
      </div>

      {probe.res || probe.error ? (
        <div className="te-probe" role="status">
          <Tag tone={probe.res?.ok ? "good" : "bad"}>{probe.res?.ok ? "Reachable" : "Not reachable"}</Tag>
          <span className="te-faint mono">{probe.res?.target}</span>
          {probeOutput || probe.res?.error || probe.error ? <pre>{probeOutput || probe.res?.error || probe.error}</pre> : null}
        </div>
      ) : null}
      {dry.output != null || dry.error ? (
        <div className="te-probe" role="status">
          <div className="te-probe__head">
            <b>Scenarios that would run</b>
            {dry.output ? <CopyButton text={dry.output} /> : null}
          </div>
          {dry.error ? <p className="te-bad">{dry.error}</p> : null}
          {dry.output ? <pre>{dry.output}</pre> : null}
        </div>
      ) : null}
    </aside>
  );
}
