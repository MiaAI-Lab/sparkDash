import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import { localizedServerText } from "../../i18n/messages";
import type { SparkSnapshot } from "../../api/types";
import { shutdownSpark, wakeSpark } from "../../api/client";
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
export function shutdownWarnings(spark: SparkSnapshot): string[] {
  const out: string[] = [];
  const ports = spark.llmPorts ?? [];
  (spark.metrics.llm ?? []).forEach((l, i) => {
    if (!l?.available) return;
    const running = Math.round(l.requestsRunning ?? 0);
    const waiting = Math.round(l.requestsWaiting ?? 0);
    const busy = running + waiting > 0 ? running + waiting : l.slotsActive > 0 ? l.slotsActive : 0;
    if (busy > 0) {
      const port = ports[i];
      out.push(
        port != null
          ? i18next.t(
              "spark.warn.llmBusyPort",
              "{count, plural, one {# in-flight LLM request} other {# in-flight LLM requests}} on :{port}",
              { count: busy, port }
            )
          : i18next.t(
              "spark.warn.llmBusy",
              "{count, plural, one {# in-flight LLM request} other {# in-flight LLM requests}}",
              { count: busy }
            )
      );
    }
  });
  const job = spark.metrics.comfy?.activeJob;
  if (job)
    out.push(
      job.title
        ? i18next.t("spark.warn.comfyJobNamed", "Running ComfyUI job: {title}", { title: job.title })
        : i18next.t("spark.warn.comfyJob", "Running ComfyUI job")
    );
  if (spark.hermes?.status === "running")
    out.push(i18next.t("spark.warn.hermesUpdate", "A Hermes update is in progress"));
  return out;
}

/**
 * Update Hermes / Edit / Power action cluster.
 * Rendered twice: inline in the SparkHeader (desktop) and as a standalone row
 * just above "Resources" on mobile. Owning the shutdown dialog + transient
 * power message here keeps the two placements in sync.
 */
export function SparkActions({ spark, onEdit, className }: SparkActionsProps) {
  const { t } = useTranslation();
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text?: string; tone: "ok" | "err"; action: "shutdown" | "wake" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);

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
      setPowerMsg({
        text: res.message,
        tone: "ok",
        action: "shutdown",
      });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : undefined,
        tone: "err",
        action: "shutdown",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({
        text: res.message,
        tone: "ok",
        action: "wake",
      });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : undefined,
        tone: "err",
        action: "wake",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`sp-flash ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text ? localizedServerText(powerMsg.text) : powerMsg.action === "shutdown"
              ? powerMsg.tone === "ok" ? t("spark.action.shutdownInitiated", "Shutdown initiated") : t("spark.action.shutdownFailed", "Shutdown failed")
              : powerMsg.tone === "ok" ? t("spark.action.wakeSent", "Wake packet sent") : t("spark.action.wakeFailed", "Wake failed")}
          </span>
        )}
        {hermesRunning && (
          <span
            className="sp-flash text-warning"
            title={t(
              "spark.action.hermesRunningTitle",
              "Running `hermes update` on this machine via SSH — this can take a few minutes."
            )}
          >
            <RotateIcon className="h-3.5 w-3.5 animate-spin" />
            {t("spark.action.hermesUpdating", "Hermes updating…")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="sp-flash max-w-[16rem] truncate text-danger"
            title={hermes.error ? localizedServerText(hermes.error) : t("spark.action.hermesFailed", "Hermes update failed")}
          >
            {t("spark.action.hermesFailed", "Hermes update failed")}
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? hermes.behindCommits
                  ? t(
                      "spark.action.updateTitleBehind",
                      'Run "hermes update" on this machine via SSH ({count, plural, one {# commit behind} other {# commits behind}})',
                      { count: hermes.behindCommits }
                    )
                  : t("spark.action.updateTitle", 'Run "hermes update" on this machine via SSH')
                : t(
                    "spark.action.updateTitleIdle",
                    "Open Hermes Agent update status and run updates on this machine via SSH"
                  )
            }
            className={`btn ${hermes.updateAvailable === true ? "btn--warn" : ""}`}
          >
            <RotateIcon className="h-3.5 w-3.5" />
            {t("spark.action.update", "Update Hermes")}
            {hermes.version && <span className="sp-btn-sub mono">v{hermes.version.replace(/^v/i, "")}</span>}
            {hermes.updateAvailable === true && (
              <span
                className="sp-badge"
                title={
                  hermes.behindCommits != null
                    ? t(
                        "spark.action.behind",
                        "{count, plural, one {# commit behind} other {# commits behind}}",
                        { count: hermes.behindCommits }
                      )
                    : t("spark.action.updateAvailable", "Update available")
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
            {t("common.action.edit", "Edit")}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => setShutdownOpen(true)}
            disabled={powerLoading}
            title={t(
              "spark.action.shutdownTitle",
              "Graceful shutdown (requires /usr/local/bin/spark-shutdown on the host)"
            )}
            className="btn btn--danger"
          >
            <PowerOffIcon className="h-3.5 w-3.5" />
            {t("common.action.shutDown", "Shut down")}
          </button>
        ) : spark.kind === "host" ? (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title={t("spark.action.wakeTitle", "Wake-on-LAN (set MAC address in Edit Spark)")}
            className="btn"
          >
            <PowerOnIcon className="h-3.5 w-3.5" />
            {t("spark.action.wake", "Wake")}
          </button>
        ) : (
          <span
            className="sp-muted"
            title={t(
              "spark.action.noWolTitle",
              "DGX Spark does not wake from a magic packet. The onboard NIC has no Wake-on-LAN."
            )}
          >
            {t("spark.action.noWol", "No Wake-on-LAN")}
          </span>
        )}
      </div>

      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={t("spark.action.confirmShutdownTitle", "Shut down {name}", { name: spark.name })}
        description={t(
          "spark.action.confirmShutdownDesc",
          "Gracefully shut down {name}? This will stop all containers and power off the node.",
          { name: spark.name }
        )}
        confirmLabel={t("common.action.shutDown", "Shut down")}
        warnings={shutdownWarnings(spark)}
      />
    </>
  );
}
