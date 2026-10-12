import { localizedServerText } from "../../../i18n/messages";
import { useEffect, useRef, useState } from "react";
import { fetchToolEvalInstallCommand, fetchToolEvalUpdateCheck } from "../../../api/client";
import type { SparkSnapshot, ToolEvalSpec, ToolEvalStatus, ToolEvalUpdateCheck } from "../../../api/types";
import { fmtDate } from "./format";
import { Tag } from "../../ui/Tag";
import { CopyButton, Notice, RunTerminal, Skeleton, linesText } from "./parts";
import { useToolEvalInstall } from "./hooks";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const install = useToolEvalInstall(spark.id, reload);
  // The optional pip extras (perf, hf) are not offered: the plain install is all sparkDash needs.
  const extras: string[] = NO_EXTRAS;
  const [forceReinstall, setForceReinstall] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<{ loading: boolean; data: ToolEvalUpdateCheck | null; error: string | null }>({ loading: false, data: null, error: null });
  // Opens the upgrade step: the command, the force-reinstall option and the confirmation.
  const openUpgrade = () => {
    setOpen(true);
    setConfirm(true);
  };
  const runCheck = () => {
    setCheck({ loading: true, data: null, error: null });
    fetchToolEvalUpdateCheck(spark.id)
      .then((data) => setCheck({ loading: false, data, error: null }))
      .catch((e) => setCheck({ loading: false, data: null, error: e instanceof Error ? e.message : String(e) }));
  };
  const installed = Boolean(status?.installed);
  // A finished install collapses back to the compact status line (its output was just on screen);
  // a running or failed one stays open so the output and the retry are in reach.
  const justInstalled = installed && install.job?.status === "completed";
  const showInstaller = !installed || open || install.running || (install.job != null && !justInstalled);

  // A finished install closes the upgrade panel, shows the success line, and re-checks the version.
  const settledJob = useRef<string | null>(null);
  const versionBefore = useRef<string | null>(null);
  const [done, setDone] = useState<{ from: string | null; kind: "upgrade" | "install" } | null>(null);
  const jobId = install.job?.id ?? null;
  const jobDone = install.job?.status === "completed";
  useEffect(() => {
    if (!jobDone || !jobId || settledJob.current === jobId) return;
    settledJob.current = jobId;
    setDone({ from: versionBefore.current, kind: versionBefore.current ? "upgrade" : "install" });
    setOpen(false);
    setConfirm(false);
    setForceReinstall(false);
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDone, jobId]);

  useEffect(() => {
    if (!showInstaller) return;
    let off = false;
    fetchToolEvalInstallCommand(spark.id, extras, installed && !forceReinstall)
      .then((r) => !off && setCommand(r.command))
      .catch(() => !off && setCommand(null));
    return () => {
      off = true;
    };
  }, [spark.id, extras, forceReinstall, installed, showInstaller]);

  if (!status && loading) return <Skeleton lines={2} className="te-card te-card--pad" />;
  if (!status) {
    return (
      <Notice tone="bad" title={t("bench.setup.checkInstallFailed", "Could not check the Tool Eval Bench install")} actions={<button type="button" className="btn btn--sm" onClick={reload}>{t("bench.setup.retry", "Retry")}</button>}>
        {error ? localizedServerText(error) : t("bench.setup.noServerAnswer", "No answer from the server.")}
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
          <span className="eyebrow">{t("bench.setup.commandRunOn", "Command run on {name}", { name: spark.name })}</span>
          {command ? <CopyButton text={command} /> : null}
        </div>
        <pre className="te-cmd__body">{command ?? "…"}</pre>
      </div>
      <p className="te-note">
        {installed && !forceReinstall ? (
          <>
            {t("bench.setup.upgradeExplanation", "This runs uv tool upgrade on {name}: it fetches the newest tool-eval-bench from GitHub (SeraphimSerapis/tool-eval-bench) and replaces the installed copy. If uv did not install the current copy, it reinstalls from GitHub instead. Tick force reinstall to reinstall from scratch instead.", { name: spark.name })}
          </>
        ) : (
          <>
            {t("bench.setup.installExplanation", "This runs uv tool install from GitHub (SeraphimSerapis/tool-eval-bench) on {name}, as the user sparkDash connects with.", { name: spark.name })}
          </>
        )}{" "}
        {t("bench.setup.internetNote", "It downloads Python packages and needs internet access on that Spark. Nothing is installed on the machine running sparkDash.")}
      </p>
      {uvMissing ? (
        <Notice tone="warn" title={t("bench.setup.uvMissing", "uv is not installed on this Spark")}>
          {t("bench.setup.uvMissingBody", "Installation uses uv. Install it first (curl -LsSf https://astral.sh/uv/install.sh | sh on the Spark), then check again.")}
        </Notice>
      ) : null}
      {install.job ? (
        <div className="te-install-out">
          <div className="te-install-out__head">
            <Tag tone={install.job.status === "running" ? "acc" : install.job.status === "completed" ? "good" : "bad"}>
              {install.job.status === "running" ? t("bench.setup.installing", "Installing…") : install.job.status === "completed" ? t("bench.setup.installed", "Installed") : t("bench.setup.installFailed", "Install failed")}
            </Tag>
            <CopyButton text={() => linesText(install.lines, install.partial)} label={t("bench.setup.copyOutput", "Copy output")} />
          </div>
          <RunTerminal lines={install.lines} partial={install.partial} running={install.running} />
          {install.job.status === "completed" ? <p className="te-ok" role="status">{t("bench.setup.doneChecking", "Done. Checking the install…")}</p> : null}
          {install.job.status === "failed" ? (
            <Notice tone="bad" title={t("bench.setup.installDidNotFinish", "The install did not finish")}>
              {uvProblem ? t("bench.setup.uvNotFound", "uv was not found on the Spark. Install uv first, then try again.") : install.job.error ? localizedServerText(install.job.error) : t("bench.setup.installFailureHint", "See the output above for the reason (no internet, a missing Python, a full disk…).")}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {install.error ? <Notice tone="bad">{localizedServerText(install.error)}</Notice> : null}
      <div className="te-actions">
        {!confirm ? (
          <button type="button" className="btn btn--primary" disabled={install.running || busy} onClick={() => setConfirm(true)}>
            {installed ? t("bench.setup.upgradeNow", "Upgrade now") : t("bench.setup.installOn", "Install on {name}…", { name: spark.name })}
          </button>
        ) : (
          <>
            <span className="te-confirm-text">{t("bench.setup.confirmRun", "Run the command above on {name}?", { name: spark.name })}</span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={install.running}
              onClick={() => {
                setConfirm(false);
                versionBefore.current = status?.installed ? status.version : null;
                setDone(null);
                void install.start(extras, installed && !forceReinstall);
              }}
            >
              {installed ? t("bench.setup.yesUpgrade", "Yes, upgrade") : t("bench.setup.yesInstall", "Yes, install")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirm(false);
                if (installed) {
                  setOpen(false);
                  setForceReinstall(false);
                }
              }}
            >
              {t("bench.setup.cancel", "Cancel")}
            </button>
          </>
        )}
        {busy ? <span className="te-faint">{t("bench.setup.busy", "Another Tool Eval Bench job is running on this Spark.")}</span> : null}
        {installed ? (
          <label className="te-check te-check--inline">
            <input type="checkbox" checked={forceReinstall} onChange={(e) => setForceReinstall(e.target.checked)} disabled={install.running} />
            <span>{t("bench.setup.forceReinstall", "force reinstall")}</span>
          </label>
        ) : null}
        {installed ? null : (
          <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
            {loading ? t("bench.setup.checking", "Checking…") : t("bench.setup.checkAgain", "Check again")}
          </button>
        )}
      </div>
    </div>
  );

  if (!installed) {
    return (
      <section className="panel te-card te-card--setup" aria-labelledby="te-setup-title">
        <div className="te-card__head">
          <div>
            <div className="eyebrow">{t("bench.setup.setup", "Setup")}</div>
            <h2 id="te-setup-title">{t("bench.setup.notInstalledOn", "Tool Eval Bench is not installed on {name}", { name: spark.name })}</h2>
          </div>
          <Tag tone="warn">{t("bench.setup.notInstalled", "Not installed")}</Tag>
        </div>
        <p className="te-lead">
          {t("bench.setup.lead", "This page drives the external tool-eval-bench CLI, which runs on the Spark itself. Install it once and every Tool Eval Bench page becomes available. You can still configure and preview a run meanwhile; Start is disabled until it is installed.")}
        </p>
        {status.error && !status.reachable ? <Notice tone="bad" title={t("bench.setup.sparkUnreachable", "The Spark could not be reached")}>{localizedServerText(status.error)}</Notice> : null}
        {installer}
      </section>
    );
  }

  return (
    <section className="panel te-card te-status" aria-label={t("bench.setup.installStatus", "Tool Eval Bench install status")}>
      <div className="te-status__line">
        <Tag tone="good">{t("bench.setup.installed", "Installed")}</Tag>
        <span>
          tool-eval-bench <b className="mono">{status.version?.replace(/^tool-eval-bench\s+/i, "") ?? t("bench.setup.unknownVersion", "unknown version")}</b>
        </span>
        <span className="te-faint mono" title={status.path ?? ""}>{status.path}</span>
        {status.pythonVersion ? <span className="te-faint">{status.pythonVersion}</span> : null}
        <span className="te-status__spacer" />
        <button type="button" className="btn btn--sm" onClick={runCheck} disabled={check.loading}>
          {check.loading ? t("bench.setup.checkingGithub", "Checking GitHub…") : t("bench.setup.checkUpdates", "Check for updates")}
        </button>
      </div>
      {check.error ? <Notice tone="bad" title={t("bench.setup.checkUpdatesFailed", "Could not check for updates")}>{localizedServerText(check.error)}</Notice> : null}
      {check.data ? (
        check.data.upToDate === true ? (
          <p className="te-ok" role="status">
            {t("bench.setup.latestVersion", "You have the latest version.")}{" "}
            <span className="te-faint">
              {t("bench.setup.installedCommit", "Installed commit")} <code>{check.data.installedCommit}</code>
              {check.data.latestDate ? t("bench.setup.latestChange", " · latest change {date}", { date: fmtDate(Date.parse(check.data.latestDate)) }) : ""}
            </span>{" "}
            <button type="button" className="te-link" onClick={() => { setForceReinstall(true); openUpgrade(); }}>
              {t("bench.setup.reinstall", "Reinstall…")}
            </button>
          </p>
        ) : check.data.upToDate === false ? (
          <Notice
            tone="info"
            title={t("bench.setup.newVersion", "A newer version is available")}
            actions={
              <button type="button" className="btn btn--sm btn--primary" onClick={openUpgrade}>
                {t("bench.setup.upgradeNow", "Upgrade now")}
              </button>
            }
          >
            {t("bench.setup.latestCommit", "Latest commit")} <code>{check.data.latestCommit?.slice(0, 9)}</code>
            {check.data.latestDate ? ` (${fmtDate(Date.parse(check.data.latestDate))})` : ""}; {t("bench.setup.installed", "Installed").toLowerCase()} <code>{check.data.installedCommit}</code>. {t("bench.setup.upgradeRunsOn", "Upgrading runs on {name}.", { name: spark.name })}
          </Notice>
        ) : (
          <Notice
            tone="warn"
            title={t("bench.setup.updateUnknown", "Could not tell if there is an update")}
            actions={
              <button type="button" className="btn btn--sm" onClick={openUpgrade}>
                {t("bench.setup.upgradeAnyway", "Upgrade anyway")}
              </button>
            }
          >
            {check.data.error ?? t("bench.setup.noComparableCommit", "The installed version does not name a commit, so it cannot be compared with GitHub.")} {t("bench.setup.canUpgrade", "You can still upgrade anyway.")}
          </Notice>
        )
      ) : null}
      {status.workDir ? (
        <p className="te-note">
          {t("bench.setup.resultsLocation", "Where results live: each run keeps its files under {path} on {name}; sparkDash also caches finished results so history stays readable when the Spark is off.", { path: status.workDir, name: spark.name })}
        </p>
      ) : null}
      {done && !showInstaller ? (
        <Notice
          tone="good"
          title={done.kind === "upgrade" ? t("bench.setup.upgradeComplete", "Upgrade complete") : t("bench.setup.installComplete", "Installation complete")}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDone(null)}>
              {t("bench.setup.dismiss", "Dismiss")}
            </button>
          }
        >
          {done.kind === "upgrade" && done.from && done.from !== status.version ? (
            <>
              {t("bench.setup.upgradedFrom", "tool-eval-bench on {name} went from {from} to {to}. You can run a benchmark now.", { name: spark.name, from: done.from.replace(/^tool-eval-bench\s+/i, ""), to: status.version?.replace(/^tool-eval-bench\s+/i, "") })}
            </>
          ) : done.kind === "upgrade" ? (
            <>
              {t("bench.setup.reinstalled", "tool-eval-bench on {name} was reinstalled and is now {version}. You can run a benchmark now.", { name: spark.name, version: status.version?.replace(/^tool-eval-bench\s+/i, "") })}
            </>
          ) : (
            <>
              {t("bench.setup.installedSuccess", "tool-eval-bench {version} is installed on {name}. You can run a benchmark now.", { version: status.version?.replace(/^tool-eval-bench\s+/i, ""), name: spark.name })}
            </>
          )}
        </Notice>
      ) : null}
      {showInstaller ? installer : null}
    </section>
  );
}
