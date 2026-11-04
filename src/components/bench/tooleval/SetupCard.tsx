import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { fetchToolEvalInstallCommand, fetchToolEvalUpdateCheck } from "../../../api/client";
import type { SparkSnapshot, ToolEvalSpec, ToolEvalStatus, ToolEvalUpdateCheck } from "../../../api/types";
import { fmtDate } from "./format";
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
  const { t } = useTranslation("tooleval");
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
      <Notice tone="bad" title={t("ui.setup.checkInstallFailed")} actions={<button type="button" className="btn btn--sm" onClick={reload}>{t("ui.error.retry")}</button>}>
        {error ?? t("ui.setup.noServerAnswer")}
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
          <span className="eyebrow">{t("setup.command", { name: spark.name })}</span>
          {command ? <CopyButton text={command} /> : null}
        </div>
        <pre className="te-cmd__body">{command ?? "…"}</pre>
      </div>
      <p className="te-note">
        {installed && !forceReinstall ? (
          <>
            {t("setup.upgradeHelp", { name: spark.name })}
          </>
        ) : (
          <>
            {t("setup.installHelp", { name: spark.name })}
          </>
        )}{" "}
        {t("ui.setup.internetNote")}
      </p>
      {uvMissing ? (
        <Notice tone="warn" title={t("ui.setup.uvMissing")}>
          {t("setup.uvHelp")}
        </Notice>
      ) : null}
      {install.job ? (
        <div className="te-install-out">
          <div className="te-install-out__head">
            <Tag tone={install.job.status === "running" ? "acc" : install.job.status === "completed" ? "good" : "bad"}>
              {install.job.status === "running" ? t("ui.setup.installing") : install.job.status === "completed" ? t("ui.setup.installed") : t("ui.setup.installFailed")}
            </Tag>
            <CopyButton text={() => linesText(install.lines, install.partial)} label={t("ui.copyOutput")} />
          </div>
          <RunTerminal lines={install.lines} partial={install.partial} running={install.running} />
          {install.job.status === "completed" ? <p className="te-ok" role="status">{t("ui.setup.doneChecking")}</p> : null}
          {install.job.status === "failed" ? (
            <Notice tone="bad" title={t("ui.setup.installDidNotFinish")}>
              {uvProblem ? t("ui.setup.uvNotFound") : install.job.error ?? t("ui.setup.installFailureHint")}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {install.error ? <Notice tone="bad">{install.error}</Notice> : null}
      <div className="te-actions">
        {!confirm ? (
          <button type="button" className="btn btn--primary" disabled={install.running || busy} onClick={() => setConfirm(true)}>
            {installed ? t("ui.setup.upgradeNow") : t("setup.installOn", { name: spark.name })}
          </button>
        ) : (
          <>
            <span className="te-confirm-text">{t("setup.confirm", { name: spark.name })}</span>
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
              {installed ? t("setup.yesUpgrade") : t("setup.yesInstall")}
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
              {t("ui.action.cancel")}
            </button>
          </>
        )}
        {busy ? <span className="te-faint">{t("ui.setup.busy")}</span> : null}
        {installed ? (
          <label className="te-check te-check--inline">
            <input type="checkbox" checked={forceReinstall} onChange={(e) => setForceReinstall(e.target.checked)} disabled={install.running} />
            <span>{t("ui.setup.forceReinstall")}</span>
          </label>
        ) : null}
        {installed ? null : (
          <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
            {loading ? t("ui.accessToken.checking") : t("ui.setup.checkAgain")}
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
            <div className="eyebrow">{t("ui.setup.setup")}</div>
            <h2 id="te-setup-title">{t("setup.notInstalled", { name: spark.name })}</h2>
          </div>
          <Tag tone="warn">{t("ui.setup.notInstalled")}</Tag>
        </div>
        <p className="te-lead">
          {t("setup.intro")}
        </p>
        {status.error && !status.reachable ? <Notice tone="bad" title={t("ui.setup.sparkUnreachable")}>{status.error}</Notice> : null}
        {installer}
      </section>
    );
  }

  return (
    <section className="panel te-card te-status" aria-label={t("ui.setup.installStatus")}>
      <div className="te-status__line">
        <Tag tone="good">{t("ui.setup.installed")}</Tag>
        <span>
          tool-eval-bench <b className="mono">{status.version?.replace(/^tool-eval-bench\s+/i, "") ?? t("ui.setup.unknownVersion")}</b>
        </span>
        <span className="te-faint mono" title={status.path ?? ""}>{status.path}</span>
        {status.pythonVersion ? <span className="te-faint">{status.pythonVersion}</span> : null}
        <span className="te-status__spacer" />
        <button type="button" className="btn btn--sm" onClick={runCheck} disabled={check.loading}>
          {check.loading ? t("ui.setup.checkingGithub") : t("ui.setup.checkUpdates")}
        </button>
      </div>
      {check.error ? <Notice tone="bad" title={t("ui.setup.checkUpdatesFailed")}>{check.error}</Notice> : null}
      {check.data ? (
        check.data.upToDate === true ? (
          <p className="te-ok" role="status">
            {t("ui.setup.latestVersion")}{" "}
            <span className="te-faint">
              {t("ui.setup.installedCommit")} <code>{check.data.installedCommit}</code>
              {check.data.latestDate ? t("setup.latestChange", { date: fmtDate(Date.parse(check.data.latestDate)) }) : ""}
            </span>{" "}
            <button type="button" className="te-link" onClick={() => { setForceReinstall(true); openUpgrade(); }}>
              {t("ui.setup.reinstall")}
            </button>
          </p>
        ) : check.data.upToDate === false ? (
          <Notice
            tone="info"
            title={t("ui.setup.newVersion")}
            actions={
              <button type="button" className="btn btn--sm btn--primary" onClick={openUpgrade}>
                {t("ui.setup.upgradeNow")}
              </button>
            }
          >
            {t("ui.setup.latestCommit")} <code>{check.data.latestCommit?.slice(0, 9)}</code>
            {check.data.latestDate ? ` (${fmtDate(Date.parse(check.data.latestDate))})` : ""}{t("setup.installedCommit", { commit: check.data.installedCommit, name: spark.name })}
          </Notice>
        ) : (
          <Notice
            tone="warn"
            title={t("ui.setup.updateUnknown")}
            actions={
              <button type="button" className="btn btn--sm" onClick={openUpgrade}>
                {t("ui.setup.upgradeAnyway")}
              </button>
            }
          >
            {check.data.error ?? t("ui.setup.noComparableCommit")} {t("ui.setup.canUpgrade")}
          </Notice>
        )
      ) : null}
      {status.workDir ? (
        <p className="te-note">
          {t("setup.results", { directory: status.workDir, name: spark.name })}
        </p>
      ) : null}
      {done && !showInstaller ? (
        <Notice
          tone="good"
          title={done.kind === "upgrade" ? t("ui.setup.upgradeComplete") : t("ui.setup.installComplete")}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDone(null)}>
              {t("ui.progress.dismiss")}
            </button>
          }
        >
          {done.kind === "upgrade" && done.from && done.from !== status.version ? (
            <>
              {t("setup.upgraded", { name: spark.name, from: done.from.replace(/^tool-eval-bench\s+/i, ""), to: status.version?.replace(/^tool-eval-bench\s+/i, "") })}
            </>
          ) : done.kind === "upgrade" ? (
            <>
              {t("setup.reinstalled", { name: spark.name, version: status.version?.replace(/^tool-eval-bench\s+/i, "") })}
            </>
          ) : (
            <>
              {t("setup.installed", { name: spark.name, version: status.version?.replace(/^tool-eval-bench\s+/i, "") })}
            </>
          )}
        </Notice>
      ) : null}
      {showInstaller ? installer : null}
    </section>
  );
}
