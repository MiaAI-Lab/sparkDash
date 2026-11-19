import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { fetchShutdownHelperPolicy, installShutdownHelper, shutdownSpark, wakeSpark } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { openHermesUpdateDialog } from "../../hooks/useHermesUpdateDialog";
import { EditIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface SparkActionsProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
  /** Classes for the button-cluster wrapper (controls responsive visibility). */
  className?: string;
}

/**
 * Work a shutdown would interrupt, from signals already in the snapshot:
 * in-flight LLM requests, a running ComfyUI job, a Hermes update.
 */
export function shutdownWarnings(spark: SparkSnapshot, t: TFunction): string[] {
  const out: string[] = [];
  const ports = spark.llmPorts ?? [];
  (spark.metrics.llm ?? []).forEach((l, i) => {
    if (!l?.available) return;
    const running = Math.round(l.requestsRunning ?? 0);
    const waiting = Math.round(l.requestsWaiting ?? 0);
    const busy = running + waiting > 0 ? running + waiting : (l.slotsActive ?? 0) > 0 ? (l.slotsActive ?? 0) : 0;
    if (busy > 0) {
      const port = ports[i];
      out.push(t("actions.requests", { count: busy, port: port != null ? t("actions.onPort", { port }) : "" }));
    }
  });
  const job = spark.metrics.comfy?.activeJob;
  if (job) out.push(t("actions.comfyJob", { name: job.title ? `: ${job.title}` : "" }));
  if (spark.hermes?.status === "running") out.push(t("actions.hermesRunningWarning"));
  return out;
}

/** True when a shutdown failed because the unit lacks the spark-shutdown
 * helper or passwordless sudo for it — the in-UI installer can fix both. */
export function isHelperInstallError(message: string): boolean {
  return /spark-shutdown|passwordless sudo/i.test(message || "");
}

/**
 * Update Hermes / Edit / Power action cluster.
 * Rendered twice: inline in the SparkHeader (desktop) and as a standalone row
 * just above "Resources" on mobile. Owning the shutdown dialog + transient
 * power message here keeps the two placements in sync.
 */
export function SparkActions({ spark, onEdit, className }: SparkActionsProps) {
  const { t } = useTranslation("hardware");
  const powerLabels = { shutdownOk: t("actions.shutdownOk"), shutdownError: t("actions.shutdownError"), wakeOk: t("actions.wakeOk"), wakeError: t("actions.wakeError") };
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; kind: "shutdownOk" | "shutdownError" | "wakeOk" | "wakeError"; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [helper, setHelper] = useState<{ passwordAllowed: boolean | null; pw: string; busy: boolean; result: { ok: boolean; message: string } | null } | null>(null);
  const powerMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show a transient power message; replaces any pending auto-clear so a
   * quick install→retry sequence cannot have its message cleared early. */
  function flashPowerMsg(msg: { text: string; kind: "shutdownOk" | "shutdownError" | "wakeOk" | "wakeError"; tone: "ok" | "err" }) {
    if (powerMsgTimer.current) clearTimeout(powerMsgTimer.current);
    setPowerMsg(msg);
    powerMsgTimer.current = setTimeout(() => setPowerMsg(null), 5000);
  }

  /** Offer the in-UI helper install after a helper/sudo shutdown failure. */
  function openHelperInstall() {
    setHelper((h) => h ?? { passwordAllowed: null, pw: "", busy: false, result: null });
    fetchShutdownHelperPolicy(spark.id)
      .then((policy) => setHelper((h) => (h ? { ...h, passwordAllowed: policy.passwordAllowed } : h)))
      .catch(() => {}); // the installer itself reports a blocked password
  }

  const hermes = spark.hermes;
  const hermesRunning = hermes?.status === "running";

  function handleHermesUpdate() {
    openHermesUpdateDialog({
      sparkId: spark.id,
      sparkName: spark.name,
      currentVersion: hermes?.version ?? null,
    });
  }

  async function handleShutdown() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await shutdownSpark(spark.id);
      flashPowerMsg({ text: res.message || "", kind: "shutdownOk", tone: "ok" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      flashPowerMsg({ text: message, kind: "shutdownError", tone: "err" });
      if (isHelperInstallError(message)) openHelperInstall();
    } finally {
      setPowerLoading(false);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      flashPowerMsg({ text: res.message || "", kind: "wakeOk", tone: "ok" });
    } catch (err: unknown) {
      flashPowerMsg({
        text: err instanceof Error ? err.message : "", kind: "wakeError",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
    }
  }

  /** Install the shutdown helper on this unit (one sudo password, used once),
   * then finish the shutdown the user originally asked for. */
  async function handleHelperInstall() {
    if (!helper || helper.busy) return;
    if (!window.confirm(t("actions.helperInstallConfirm", { name: spark.name }))) return;
    setHelper({ ...helper, busy: true, result: null });
    try {
      await installShutdownHelper(spark.id, helper.pw || undefined);
      setHelper(null);
      flashPowerMsg({ text: t("actions.helperInstallSuccess", { name: spark.name }), kind: "shutdownOk", tone: "ok" });
      window.setTimeout(() => { void handleShutdown(); }, 1200);
    } catch (err: unknown) {
      setHelper((h) => (h ? { ...h, busy: false, result: { ok: false, message: err instanceof Error ? err.message : t("actions.shutdownError") } } : h));
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`sp-flash ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text || powerLabels[powerMsg.kind]}
          </span>
        )}
        {hermesRunning && (
          <span
            className="sp-flash text-warning"
            title={t("actions.hermesHelp")}
          >
            <RotateIcon className="h-3.5 w-3.5 animate-spin" />
            {t("actions.updating")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="sp-flash max-w-[16rem] truncate text-danger"
            title={hermes.error || t("actions.hermesFailed")}
          >
            {t("actions.hermesFailed")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? t("actions.hermesRun", { behind: hermes.behindCommits ? ` (${t("actions.behind", { count: hermes.behindCommits })})` : "" })
                : t("actions.hermesOpen")
            }
            className={`btn ${hermes.updateAvailable === true ? "btn--warn" : ""}`}
          >
            <RotateIcon className="h-3.5 w-3.5" />
            {t("actions.update")}
            {hermes.version && <span className="sp-btn-sub mono">v{hermes.version.replace(/^v/i, "")}</span>}
            {hermes.updateAvailable === true && (
              <span
                className="sp-badge"
                title={
                  hermes.behindCommits != null
                    ? t("actions.behind", { count: hermes.behindCommits })
                    : t("actions.available")
                }
              >
                {hermes.behindCommits != null ? hermes.behindCommits : "!"}
              </span>
            )}
          </button>
        )}
        {onEdit && (
          <button type="button" onClick={onEdit} className="btn">
            <EditIcon className="h-3.5 w-3.5" />
            {t("actions.edit")}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => setShutdownOpen(true)}
            disabled={powerLoading}
            title={t("actions.shutdownHelp")}
            className="btn btn--danger"
          >
            <PowerOffIcon className="h-3.5 w-3.5" />
            {t("actions.shutdown")}
          </button>
        ) : spark.kind === "host" ? (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title={t("actions.wakeHelp")}
            className="btn"
          >
            <PowerOnIcon className="h-3.5 w-3.5" />
            {t("actions.wake")}
          </button>
        ) : (
          <span
            className="sp-muted"
            title={t("actions.noWakeHelp")}
          >
            {t("actions.noWake")}
          </span>
        )}
        {helper && (
          <div className="flex w-full basis-full flex-col gap-1.5">
            <p className="field-hint">{t("actions.helperInstallHint", { name: spark.name })}</p>
            {helper.passwordAllowed !== false && (
              <>
                <label className="field-label" htmlFor="shutdown-helper-sudo-password">{t("actions.helperSudoPassword", { name: spark.name })}</label>
                <input
                  id="shutdown-helper-sudo-password"
                  className="field-input"
                  type="password"
                  autoComplete="off"
                  value={helper.pw}
                  onChange={(e) => setHelper((h) => (h ? { ...h, pw: e.target.value } : h))}
                  disabled={helper.busy}
                />
              </>
            )}
            {helper.passwordAllowed === false && <p className="field-hint">{t("actions.helperPasswordNotPermitted")}</p>}
            <button type="button" className="btn" disabled={helper.busy} onClick={() => void handleHelperInstall()}>
              {helper.busy ? t("actions.helperInstalling") : t("actions.helperInstall")}
            </button>
            {helper.result && (
              <div className={helper.result.ok ? "modal-sheet__success" : "modal-sheet__error"} role={helper.result.ok ? "status" : "alert"}>
                {helper.result.message}
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={t("actions.shutdownTitle", { name: spark.name })}
        description={t("actions.shutdownConfirm", { name: spark.name })}
        confirmLabel={t("actions.shutdown")}
        warnings={shutdownWarnings(spark, t)}
      />
    </>
  );
}