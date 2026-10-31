import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LauncherAction, LauncherJob, LauncherRunState, LlmLauncher, SparkSnapshot } from "../../api/types";
import { removeLauncher, runLauncher } from "../../api/client";
import { fetchLaunchersCached, invalidateLaunchers, patchCachedStatus } from "../../hooks/launcherCache";
import { useLauncherJob } from "../../hooks/useLauncherJob";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { LiveTerminal, terminalText } from "../ui/LiveTerminal";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { BotIcon, EditIcon, ExpandIcon, PlusIcon, XIcon } from "../ui/icons";
import { LlmLauncherDialog } from "./LlmLauncherDialog";

const AUTOSHOW_KEY = "sparkdash.llm.autoShowOutput";
const STATUS_REFRESH_MS = 20_000;

function readAutoShow(): boolean {
  try {
    return localStorage.getItem(AUTOSHOW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function jobHeadline(job: LauncherJob, t: TFunction): string {
  // A start job follows a script that may keep running for days, so it is not "starting" forever.
  if (job.status === "running") {
    if (job.action === "stop") return t("models.stoppingName", { name: job.launcherName });
    return job.action === "start" ? t("models.startingName", { name: job.launcherName }) : t("models.outputName", { name: job.launcherName });
  }
  if (job.action === "attach") return t("models.outputName", { name: job.launcherName });
  const noun = job.action === "start" ? t("models.startScript") : t("models.stopScript");
  if (job.status === "completed") return t("models.finishedName", { name: job.launcherName, script: noun });
  if (job.status === "cancelled") return t("models.cancelledName", { name: job.launcherName });
  if (job.status === "detached") return t("models.detachedName", { name: job.launcherName });
  return t("models.failedName", { name: job.launcherName, script: noun, exit: job.exitCode != null ? t("models.exit", { code: job.exitCode }) : "" });
}

export function jobTone(job: LauncherJob): TagTone {
  if (job.status === "running") return "info";
  if (job.status === "completed") return "good";
  if (job.status === "failed") return "bad";
  return "neutral";
}

function statusLabels(t: TFunction): Record<LauncherJob["status"], string> { return {
  running: t("models.running"),
  completed: t("models.finished"),
  failed: t("models.failed"),
  cancelled: t("models.stoppedWatching"),
  detached: t("models.stoppedWatching"),
}; }

function Elapsed({ job }: { job: LauncherJob }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (job.status !== "running") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [job.status]);
  const end = job.finishedAt ?? now;
  return <span className="mono">{formatElapsed(end - job.startedAt)}</span>;
}

function TerminalModal({
  open,
  title,
  lines,
  partial,
  running,
  onClose,
}: {
  open: boolean;
  title: string;
  lines: { seq: number; text: string }[];
  partial: string;
  running: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("hardware");
  const { mounted, visible } = useModalPresence(open);
  const overlayClose = useOverlayClose(onClose);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      {...overlayClose}
    >
      <div className="modal-sheet term-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title">{title}</h2>
          <button type="button" className="icon-circle ml-auto" onClick={onClose} aria-label={t("models.closeOutput")}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="modal-sheet__body term-modal__body">
          <LiveTerminal lines={lines} partial={partial} running={running} maxVisible={5000} className="live-term--tall" />
        </div>
      </div>
    </div>,
    document.body
  );
}

type Confirm =
  | { kind: "stop"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "switch"; id: string; otherId: string };

/**
 * Models you can start and stop from the dashboard: each is a folder on the Spark
 * with a start.sh and a stop.sh. The scripts run there and their output streams
 * into the terminal below the list.
 */
export function LlmModelsPanel(props: { spark: SparkSnapshot; className?: string }) {
  // Keyed by Spark: the page is reused when switching Sparks, and none of this state belongs to the next one.
  return <LlmModelsPanelFor key={props.spark.id} {...props} />;
}

function LlmModelsPanelFor({ spark, className }: { spark: SparkSnapshot; className?: string }) {
  const { t } = useTranslation("hardware");
  const sparkId = spark.id;
  const [launchers, setLaunchers] = useState<LlmLauncher[]>([]);
  const [statuses, setStatuses] = useState<Record<string, LauncherRunState>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopFailed, setStopFailed] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; launcher: LlmLauncher | null }>({ open: false, launcher: null });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [autoShow, setAutoShow] = useState(readAutoShow);
  const [queuedStart, setQueuedStart] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { job, lines, partial, truncated, error: jobError, follow, cancel } = useLauncherJob(sparkId);
  const adoptedRef = useRef(false);

  // Only a stop script is exclusive. A start job is a watcher; a new action simply detaches it.
  const busy = job?.status === "running" && job.action === "stop";
  const online = spark.online;

  const refresh = useCallback(
    async (force = false) => {
      try {
        // Shared with the Overview cards: at most one SSH-backed request per Spark per few seconds.
        const res = await fetchLaunchersCached(sparkId, { force });
        setLaunchers(res.launchers);
        if (res.statuses) setStatuses(res.statuses);
        setLoadError(null);
        setLoaded(true);
        return res;
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
        return null;
      }
    },
    [sparkId]
  );

  // First load: also adopt a job the server is still running (e.g. after a page reload).
  useEffect(() => {
    adoptedRef.current = false;
    void refresh(true).then((res) => {
      if (res?.job && !adoptedRef.current) {
        adoptedRef.current = true;
        follow(res.job);
        if (res.job.status === "running") setTermOpen(true);
      }
    });
  }, [sparkId, refresh, follow]);

  // Keep running/stopped fresh while the page is open.
  useEffect(() => {
    if (!online) return;
    const t = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, STATUS_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [online, refresh]);

  // A finished job changes what is running: re-check, and run a queued start after its stop.
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const key = job ? `${job.id}:${job.status}` : null;
    if (key === lastStatusRef.current) return;
    lastStatusRef.current = key;
    if (!job || job.status === "running") return;
    void refresh(true);
    if (queuedStart && job.action === "stop") {
      const next = queuedStart;
      setQueuedStart(null);
      if (job.status === "completed") void run(next, "start");
      else setStopFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, queuedStart, refresh]);

  async function run(launcherId: string, action: LauncherAction) {
    setActionError(null);
    setStopFailed(false);
    setConfirm(null);
    try {
      const res = await runLauncher(sparkId, launcherId, action);
      follow(res.job);
      if (action === "start" || action === "attach") {
        patchCachedStatus(sparkId, launcherId, "running");
        setStatuses((s) => ({ ...s, [launcherId]: "running" }));
      }
      if (action === "attach" || autoShow) setTermOpen(true);
    } catch (e) {
      setQueuedStart(null);
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  function requestStart(l: LlmLauncher) {
    const other = launchers.find((x) => x.id !== l.id && statuses[x.id] === "running");
    if (other) setConfirm({ kind: "switch", id: l.id, otherId: other.id });
    else void run(l.id, "start");
  }

  async function switchTo(l: LlmLauncher, otherId: string) {
    setQueuedStart(l.id);
    await run(otherId, "stop");
  }

  async function doRemove(id: string) {
    setConfirm(null);
    try {
      await removeLauncher(sparkId, id);
      invalidateLaunchers(sparkId);
      setLaunchers((ls) => ls.filter((x) => x.id !== id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleAutoShow(v: boolean) {
    setAutoShow(v);
    try {
      localStorage.setItem(AUTOSHOW_KEY, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  }

  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(terminalText(lines, partial));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  }

  const byId = useMemo(() => new Map(launchers.map((l) => [l.id, l])), [launchers]);
  const showTerminal = Boolean(job) && termOpen;

  const rows = launchers.map((l) => {
    const state = statuses[l.id] ?? "unknown";
    const portIdx = l.port != null ? (spark.llmPorts ?? []).indexOf(l.port) : -1;
    const live = portIdx >= 0 ? spark.metrics.llm?.[portIdx] : null;
    const serving = Boolean(live?.available);
    const mine = job?.launcherId === l.id;
    const pending = confirm?.id === l.id ? confirm : null;
    const other = pending?.kind === "switch" ? byId.get(pending.otherId) : null;
    return (
      <li key={l.id} className="sp-launch" data-state={state}>
        <div className="sp-launch__main">
          <div className="sp-launch__title">
            <b>{l.name}</b>
            {mine && job?.status === "running" && job.action === "stop" ? (
              <Tag tone="info">{t("models.stopping")}</Tag>
            ) : serving ? (
              <Tag tone="good" title={live?.modelId ?? undefined}>
                {t("models.serving", { port: l.port })}
              </Tag>
            ) : state === "running" ? (
              <Tag tone="info" title={t("models.scriptRunning")}>
                {t("models.running")}
              </Tag>
            ) : state === "stopped" ? (
              <Tag>{t("models.stopped")}</Tag>
            ) : null}
          </div>
          <div className="sp-launch__dir mono" title={`${l.dir}/${l.startScript} · ${l.dir}/${l.stopScript}`}>
            {l.dir}
          </div>
          {l.notes ? <div className="sp-launch__notes">{l.notes}</div> : null}
          {serving && live?.modelId ? <div className="sp-launch__notes mono">{live.modelId}</div> : null}
        </div>
        <div className="sp-launch__actions">
          {pending?.kind === "stop" ? (
            <>
              <span className="sp-launch__ask">{t("models.runAsk", { script: l.stopScript })}</span>
              <button type="button" className="btn btn--sm btn--danger" onClick={() => void run(l.id, "stop")}>
                {t("models.stop")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                {t("models.cancel")}
              </button>
            </>
          ) : pending?.kind === "switch" ? (
            <>
              <span className="sp-launch__ask">{t("models.switchAsk", { name: other?.name ?? t("models.another") })}</span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void switchTo(l, pending.otherId)}>
                {t("models.stopThenStart")}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                title={t("models.runBothHelp")}
                onClick={() => void run(l.id, "start")}
              >
                {t("models.runBoth")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                {t("models.cancel")}
              </button>
            </>
          ) : pending?.kind === "remove" ? (
            <>
              <span className="sp-launch__ask">{t("models.removeAsk")}</span>
              <button type="button" className="btn btn--sm btn--danger" onClick={() => void doRemove(l.id)}>
                {t("models.remove")}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                {t("models.cancel")}
              </button>
            </>
          ) : (
            <>
              {state === "running" ? (
                <>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void run(l.id, "attach")}
                    title={t("models.showHelp")}
                  >
                    {t("models.output")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy || !online}
                    onClick={() => setConfirm({ kind: "stop", id: l.id })}
                  >
                    {t("models.stop")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy || !online}
                    onClick={() => setConfirm({ kind: "stop", id: l.id })}
                    title={t("models.stopHelp", { script: l.stopScript })}
                  >
                    {t("models.stop")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy || !online}
                    onClick={() => requestStart(l)}
                  >
                    {t("models.start")}
                  </button>
                </>
              )}
              <button
                type="button"
                className="sp-iconbtn"
                aria-label={t("models.editName", { name: l.name })}
                title={t("models.edit")}
                disabled={busy && mine}
                onClick={() => setDialog({ open: true, launcher: l })}
              >
                <EditIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="sp-iconbtn"
                aria-label={t("models.removeName", { name: l.name })}
                title={t("models.removeTitle")}
                disabled={busy && mine}
                onClick={() => setConfirm({ kind: "remove", id: l.id })}
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </li>
    );
  });

  return (
    <Panel
      title={t("models.models")}
      icon={<BotIcon className="h-4 w-4" />}
      className={className}
      actions={
        <button type="button" className="btn btn--sm" onClick={() => setDialog({ open: true, launcher: null })}>
          <PlusIcon className="h-3.5 w-3.5" />
          {t("models.add")}
        </button>
      }
    >
      <div className="sp-models">
        {loadError ? (
          <p className="sp-models__error" role="alert">
            {t("models.loadFailed", { error: loadError })}
          </p>
        ) : null}
        {loaded && !loadError && launchers.length === 0 ? (
          <div className="sp-models__empty">
            <p>
              {t("models.empty", { name: spark.name })}
            </p>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setDialog({ open: true, launcher: null })}>
              <PlusIcon className="h-3.5 w-3.5" />
              {t("models.first")}
            </button>
          </div>
        ) : null}
        {launchers.length > 0 ? <ul className="sp-models__list">{rows}</ul> : null}
        {!online && launchers.length > 0 ? <p className="sp-models__hint">{t("models.offline", { name: spark.name })}</p> : null}
        {actionError || stopFailed ? (
          <p className="sp-models__error" role="alert">
            {stopFailed ? t("models.stopFailed") : actionError}
          </p>
        ) : null}

        {job ? (
          <div className="sp-job">
            <div className="sp-job__bar">
              <div className="sp-job__title">
                <Tag tone={jobTone(job)}>{statusLabels(t)[job.status]}</Tag>
                <span className="sp-job__name">{jobHeadline(job, t)}</span>
                <Elapsed job={job} />
              </div>
              <div className="sp-job__tools">
                {job.status === "running" ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => void cancel()}
                    title={job.action === "stop" ? t("models.cancelStop") : t("models.stopWatchingHelp")}
                  >
                    {job.action === "stop" ? t("models.cancel") : t("models.stopWatching")}
                  </button>
                ) : null}
                {showTerminal ? (
                  <>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => void copyOutput()}>
                      {copied ? t("models.copied") : t("models.copy")}
                    </button>
                    <button type="button" className="sp-iconbtn" aria-label={t("models.expandOutput")} title={t("models.expand")} onClick={() => setExpanded(true)}>
                      <ExpandIcon className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTermOpen(false)}>
                      {t("models.hideOutput")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTermOpen(true)}>
                    {t("models.showOutput")}
                  </button>
                )}
              </div>
            </div>
            {job.error ? <p className="sp-models__error">{job.error}</p> : null}
            {jobError ? <p className="sp-models__hint">{t("models.lost", { error: jobError })}</p> : null}
            {showTerminal ? (
              <>
                <LiveTerminal lines={lines} partial={partial} running={job.status === "running"} />
                {truncated ? <p className="sp-models__hint">{t("models.truncated")}</p> : null}
              </>
            ) : null}
          </div>
        ) : null}

        <label className="sp-models__pref">
          <input type="checkbox" checked={autoShow} onChange={(e) => toggleAutoShow(e.target.checked)} />
          <span>{t("models.autoShow")}</span>
        </label>
      </div>

      <LlmLauncherDialog
        open={dialog.open}
        sparkId={sparkId}
        sparkName={spark.name}
        launcher={dialog.launcher}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={() => {
          invalidateLaunchers(sparkId);
          void refresh(true);
        }}
      />
      <TerminalModal
        open={expanded && Boolean(job)}
        title={job ? jobHeadline(job, t) : t("models.output")}
        lines={lines}
        partial={partial}
        running={job?.status === "running"}
        onClose={() => setExpanded(false)}
      />
    </Panel>
  );
}
