import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { backendLabel } from "../../shared/llmBackends.js";
import { Tag } from "../ui/Tag";
import { SparkActions } from "./SparkActions";

interface SparkHeaderProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return "<1m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

export function SparkHeader({ spark, onEdit }: SparkHeaderProps) {
  const { t } = useTranslation();
  const { hardware } = spark;
  const online = spark.online;
  const hermes = spark.hermes;
  const role = resolveSparkRole(spark);
  const roleText =
    role === "head"
      ? t("spark.role.head", "Head")
      : role === "worker"
        ? t("spark.role.worker", "Worker")
        : t("spark.role.standalone", "Standalone");
  const roleTitle =
    role === "head"
      ? t("spark.roleTitle.head", "Cluster head — local LLM API")
      : role === "worker"
        ? t(
            "spark.roleTitle.worker",
            "Distributed LLM worker — no local model; LLM card is hidden"
          )
        : spark.llmMonitoring === false
          ? t("spark.roleTitle.standaloneOff", "Standalone — LLM monitoring off")
          : t("spark.roleTitle.standaloneOn", "Standalone — local LLM API");
  // Manual override first, then derived head-model mirror.
  const workerLabel =
    role === "worker" ? spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null : null;
  const backend = backendLabel(spark.metrics.llm?.find((l) => l.available)?.backend ?? null);
  const tailscaleIp = spark.metrics.tailscale?.tailscaleIp ?? null;
  const hw = [
    hardware.gpuChip ? `${hardware.device} · ${hardware.gpuChip}` : hardware.device,
    hardware.totalMemoryGB != null ? `${Math.round(hardware.totalMemoryGB)} GB` : null,
  ].filter(Boolean);

  return (
    <header className={`sp-header ${online ? "" : "is-offline"}`}>
      <div className="sp-header__id">
        <div className="sp-header__title">
          <span
            className={`sdot ${online ? "" : "sdot--bad"}`}
            title={
              online
                ? t("spark.header.online", "Online")
                : spark.offlineReason
                  ? t("spark.header.offlineWithReason", "Offline — {reason}", {
                      reason: spark.offlineReason,
                    })
                  : t("spark.header.offline", "Offline")
            }
          />
          <h2>{spark.name}</h2>
          <div className="sp-tags">
            <Tag className="tag--role" tone="acc" title={roleTitle}>
              {roleText}
            </Tag>
            {workerLabel && (
              <Tag tone="acc" title={workerLabel} className="sp-tag-clip">
                {workerLabel}
              </Tag>
            )}
            {spark.isLocal && (
              <Tag title={t("spark.header.localTitle", "This dashboard runs on this machine")}>
                {t("spark.header.localTag", "local")}
              </Tag>
            )}
            {online && backend && <Tag tone="info">{backend}</Tag>}
            {!online && spark.offlineReason && (
              <Tag
                tone="bad"
                className="sp-tag-clip"
                title={t("spark.header.offlineWithReason", "Offline — {reason}", {
                  reason: spark.offlineReason,
                })}
              >
                {spark.offlineReason}
              </Tag>
            )}
            {online && spark.uptime != null && (
              <Tag
                title={t("spark.header.uptimeTitle", "Uptime: {value}", {
                  value: formatUptime(spark.uptime),
                })}
              >
                {t("spark.header.uptimeLabel", "up {value}", {
                  value: formatUptime(spark.uptime),
                })}
              </Tag>
            )}
            {hermes?.monitoring && hermes.installed && hermes.version && (
              <Tag
                tone="acc"
                title={t(
                  "spark.header.hermesInstalled",
                  "Hermes Agent {version} installed on this machine",
                  { version: hermes.version }
                )}
              >
                Hermes
              </Tag>
            )}
            {hermes?.monitoring && hermes.installed === false && hermes.checkedAt != null && (
              <Tag
                tone="bad"
                title={t(
                  "spark.header.hermesNotFoundTitle",
                  "The `hermes` binary was not found on this machine (check the install path or Edit Spark)."
                )}
              >
                {t("spark.header.hermesNotFound", "Hermes not found")}
              </Tag>
            )}
            {hermes?.monitoring && hermes.error && hermes.status === "idle" && (
              <Tag
                tone="bad"
                className="sp-tag-clip"
                title={t(
                  "spark.header.updateCheckFailedTitle",
                  "Update check failed — it will retry automatically: {error}",
                  { error: hermes.error }
                )}
              >
                {t("spark.header.updateCheckFailed", "Update check failed")}
              </Tag>
            )}
          </div>
        </div>
        <p className="sp-header__meta">
          {spark.lanIp && <span className="mono">{spark.lanIp}</span>}
          {tailscaleIp && (
            <>
              {spark.lanIp && <span className="sp-sep">·</span>}
              <span className="mono">{tailscaleIp}</span>{" "}
              <span>{t("spark.header.tailscale", "(tailscale)")}</span>
            </>
          )}
          {(spark.lanIp || tailscaleIp) && hw.length > 0 && <span className="sp-sep">·</span>}
          <span>{hw.join(", ")}</span>
        </p>
      </div>

      {/* Desktop action cluster (hidden on mobile; mobile renders its own row below the header) */}
      <SparkActions
        spark={spark}
        onEdit={onEdit}
        className="sp-header__actions hidden sm:flex"
      />
    </header>
  );
}
