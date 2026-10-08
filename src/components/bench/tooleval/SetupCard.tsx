import { useEffect, useState } from "react";
import { fetchToolEvalInstallCommand } from "../../../api/client";
import type { SparkSnapshot, ToolEvalSpec, ToolEvalStatus } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { CopyButton, Notice, RunTerminal, Skeleton, linesText } from "./parts";
import { useToolEvalInstall } from "./hooks";

interface SetupProps {
  spark: SparkSnapshot;
  spec: ToolEvalSpec | null;
  status: ToolEvalStatus | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Another job holds the Spark; installs would be refused. */
  busy: boolean;
}

const NO_EXTRAS: string[] = [];

/** Install / upgrade of tool-eval-bench on the Spark, and the installed-state status line. */
export function SetupCard({ spark, spec, status, loading, error, reload, busy }: SetupProps) {
  const install = useToolEvalInstall(spark.id, reload);
  // The optional pip extras (perf, hf) are not offered: the plain install is all sparkDash needs.
  const extras: string[] = NO_EXTRAS;
  const [upgrade, setUpgrade] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const installed = Boolean(status?.installed);
  // A finished install collapses back to the compact status line (its output was just on screen);
  // a running or failed one stays open so the output and the retry are in reach.
  const justInstalled = installed && install.job?.status === "completed";
  const showInstaller = !installed || open || install.running || (install.job != null && !justInstalled);

  useEffect(() => {
    if (!showInstaller) return;
    let off = false;
    fetchToolEvalInstallCommand(spark.id, extras, upgrade || installed)
      .then((r) => !off && setCommand(r.command))
      .catch(() => !off && setCommand(null));
    return () => {
      off = true;
    };
  }, [spark.id, extras, upgrade, installed, showInstaller]);

  if (!status && loading) return <Skeleton lines={2} className="te-card te-card--pad" />;
  if (!status) {
    return (
      <Notice tone="bad" title="Could not check the Tool Eval Bench install" actions={<button type="button" className="btn btn--sm" onClick={reload}>Retry</button>}>
        {error ?? "No answer from the server."}
      </Notice>
    );
  }
  const uvMissing = !status.uv;
  const failedText = install.lines.map((l) => l.text).join("\n");
  const uvProblem = install.job?.status === "failed" && /uv: (command )?not found|uv is not installed|No such file/i.test(failedText);

  const installer = (
    <div className="te-installer">
      <div className="te-cmd">
        <div className="te-cmd__head">
          <span className="eyebrow">Command run on {spark.name}</span>
          {command ? <CopyButton text={command} /> : null}
        </div>
        <pre className="te-cmd__body">{command ?? "…"}</pre>
      </div>
      <p className="te-note">
        This runs <code>uv tool install</code> from GitHub (SeraphimSerapis/tool-eval-bench) <b>on {spark.name}</b>, as the user sparkDash connects with. It downloads Python packages and needs internet access on that Spark. Nothing is installed on the machine running sparkDash.
      </p>
      {uvMissing ? (
        <Notice tone="warn" title="uv is not installed on this Spark">
          Installation uses <code>uv</code>. Install it first (<code>curl -LsSf https://astral.sh/uv/install.sh | sh</code> on the Spark), then check again.
        </Notice>
      ) : null}
      {install.job ? (
        <div className="te-install-out">
          <div className="te-install-out__head">
            <Tag tone={install.job.status === "running" ? "acc" : install.job.status === "completed" ? "good" : "bad"}>
              {install.job.status === "running" ? "Installing…" : install.job.status === "completed" ? "Installed" : "Install failed"}
            </Tag>
            <CopyButton text={() => linesText(install.lines, install.partial)} label="Copy output" />
          </div>
          <RunTerminal lines={install.lines} partial={install.partial} running={install.running} />
          {install.job.status === "completed" ? <p className="te-ok" role="status">Done. Checking the install…</p> : null}
          {install.job.status === "failed" ? (
            <Notice tone="bad" title="The install did not finish">
              {uvProblem ? "uv was not found on the Spark. Install uv first, then try again." : install.job.error ?? "See the output above for the reason (no internet, a missing Python, a full disk…)."}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {install.error ? <Notice tone="bad">{install.error}</Notice> : null}
      <div className="te-actions">
        {!confirm ? (
          <button type="button" className="btn btn--primary" disabled={install.running || busy} onClick={() => setConfirm(true)}>
            {installed ? "Upgrade…" : `Install on ${spark.name}…`}
          </button>
        ) : (
          <>
            <span className="te-confirm-text">Run the command above on {spark.name}?</span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={install.running}
              onClick={() => {
                setConfirm(false);
                void install.start(extras, upgrade || installed);
              }}
            >
              Yes, {installed ? "upgrade" : "install"}
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </>
        )}
        {busy ? <span className="te-faint">Another Tool Eval job is running on this Spark.</span> : null}
        {installed ? (
          <label className="te-check te-check--inline">
            <input type="checkbox" checked={upgrade} onChange={(e) => setUpgrade(e.target.checked)} disabled={install.running} />
            <span>force reinstall</span>
          </label>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
          {loading ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  );

  if (!installed) {
    return (
      <section className="panel te-card te-card--setup" aria-labelledby="te-setup-title">
        <div className="te-card__head">
          <div>
            <div className="eyebrow">Setup</div>
            <h2 id="te-setup-title">Tool Eval Bench is not installed on {spark.name}</h2>
          </div>
          <Tag tone="warn">Not installed</Tag>
        </div>
        <p className="te-lead">
          This page drives the external <b>tool-eval-bench</b> CLI, which runs on the Spark itself. Install it once and every Tool Eval page becomes available. You can still configure and preview a run meanwhile; Start is disabled until it is installed.
        </p>
        {status.error && !status.reachable ? <Notice tone="bad" title="The Spark could not be reached">{status.error}</Notice> : null}
        {installer}
      </section>
    );
  }

  return (
    <section className="panel te-card te-status" aria-label="Tool Eval Bench install status">
      <div className="te-status__line">
        <Tag tone="good">Installed</Tag>
        <span>
          tool-eval-bench <b className="mono">{status.version?.replace(/^tool-eval-bench\s+/i, "") ?? "unknown version"}</b>
        </span>
        <span className="te-faint mono" title={status.path ?? ""}>{status.path}</span>
        {status.pythonVersion ? <span className="te-faint">{status.pythonVersion}</span> : null}
        <span className="te-status__spacer" />
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen((o) => !o)} aria-expanded={showInstaller}>
          {showInstaller ? "Hide update options" : "Check for updates / Upgrade"}
        </button>
      </div>
      {status.workDir ? (
        <p className="te-note">
          Where results live: each run keeps its files under <code>{status.workDir}</code> on {spark.name}; sparkDash also caches finished results so history stays readable when the Spark is off.
        </p>
      ) : null}
      {justInstalled && !showInstaller ? (
        <p className="te-ok" role="status">
          Installed on {spark.name}. You can run a benchmark now.
        </p>
      ) : null}
      {showInstaller ? installer : null}
    </section>
  );
}
