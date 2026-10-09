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
  const { hardware } = spark;
  const online = spark.online;
  const hermes = spark.hermes;
  const role = resolveSparkRole(spark);
  const roleText = role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
  const roleTitle =
    role === "head"
      ? "Cluster head — local LLM API"
      : role === "worker"
        ? "Distributed LLM worker — no local model; LLM card is hidden"
        : spark.llmMonitoring === false
          ? "Standalone — LLM monitoring off"
          : "Standalone — local LLM API";
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
            title={online ? "Online" : spark.offlineReason ? `Offline — ${spark.offlineReason}` : "Offline"}
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
            {spark.isLocal && <Tag title="This dashboard runs on this machine">local</Tag>}
            {online && backend && <Tag tone="info">{backend}</Tag>}
            {!online && spark.offlineReason && (
              <Tag tone="bad" className="sp-tag-clip" title={`Offline — ${spark.offlineReason}`}>
                {spark.offlineReason}
              </Tag>
            )}
            {online && spark.uptime != null && (
              <Tag title={`Uptime: ${formatUptime(spark.uptime)}`}>up {formatUptime(spark.uptime)}</Tag>
            )}
            {hermes?.monitoring && hermes.installed && hermes.version && (
              <Tag tone="acc" title={`Hermes Agent ${hermes.version} installed on this machine`}>
                Hermes
              </Tag>
            )}
            {hermes?.monitoring && hermes.installed === false && hermes.checkedAt != null && (
              <Tag
                tone="bad"
                title="The `hermes` binary was not found on this machine (check the install path or Edit Spark)."
              >
                Hermes not found
              </Tag>
            )}
            {hermes?.monitoring && hermes.error && hermes.status === "idle" && (
              <Tag
                tone="bad"
                className="sp-tag-clip"
                title={`Update check failed — it will retry automatically: ${hermes.error}`}
              >
                Update check failed
              </Tag>
            )}
          </div>
        </div>
        <p className="sp-header__meta">
          {spark.lanIp && <span className="mono">{spark.lanIp}</span>}
          {tailscaleIp && (
            <>
              {spark.lanIp && <span className="sp-sep">·</span>}
              <span className="mono">{tailscaleIp}</span> <span>(tailscale)</span>
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
