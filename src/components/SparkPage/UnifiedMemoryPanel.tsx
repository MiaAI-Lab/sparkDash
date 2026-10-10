import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GpuMetrics, LlmMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { MemoryIcon } from "../ui/icons";
import { formatMb } from "../../shared/formatBytes";
import { memoryBreakdown } from "./chartMath";
import { GpuProcessTable } from "./GpuPanel";

interface UnifiedMemoryPanelProps {
  um: UnifiedMemoryMetrics | null;
  gpu: GpuMetrics | null;
  llm: readonly LlmMetrics[] | undefined;
  className?: string;
}

/**
 * GB10 unified pool: one stacked bar (model weights / KV cache / system / free)
 * and the per-process table. The KV slice comes from the engines' allocated
 * pool (vLLM `cache_config_info`); without it the GPU slice stays whole.
 */
export function UnifiedMemoryPanel({ um, gpu, llm, className }: UnifiedMemoryPanelProps) {
  const { t, i18n } = useTranslation();
  const total = um?.total ?? 0;
  const segments = useMemo(() => {
    if (!um || um.total <= 0) return [];
    const engines = (llm ?? []).filter((l) => l.available);
    const kvBytes = engines.reduce((sum, l) => sum + (l.kvCacheMemoryBytes ?? 0), 0);
    return memoryBreakdown({
      totalMb: um.total,
      gpuUsedMb: um.gpuUsed,
      cpuUsedMb: um.cpuUsed,
      kvBytes,
      hasModel: engines.length > 0 && um.gpuUsed > 0,
    });
  }, [um, llm, i18n.language]);

  const used = um?.used ?? 0;
  const pct = um?.percentage ?? 0;
  const processes = gpu?.processes ?? [];

  return (
    <Panel
      title={t("spark.unifiedMemory.title", "Unified memory")}
      icon={<MemoryIcon />}
      className={`panel-memory ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        total > 0 ? (
          <span className="mono sp-muted">
            {t("spark.unifiedMemory.ofTotal", "{used} of {total} · {pct}%", {
              used: formatMb(used),
              total: formatMb(total),
              pct,
            })}
          </span>
        ) : undefined
      }
    >
      {total > 0 ? (
        <>
          <div
            className="seg-bar sp-seg-bar"
            role="img"
            aria-label={t("spark.unifiedMemory.ariaUsed", "Unified memory {pct}% used", { pct })}
          >
            {segments
              .filter((s) => s.mb > 0)
              .map((s) => (
                <i
                  key={s.key}
                  className={`sp-seg sp-seg--${s.key}`}
                  style={{ width: `${(s.mb / total) * 100}%` }}
                  title={`${s.label} ${formatMb(s.mb)}`}
                />
              ))}
          </div>
          <div className="legend">
            {segments.map((s) => (
              <span key={s.key} className={`sp-key sp-key--${s.key}`}>
                {s.label} {formatMb(s.mb)}
              </span>
            ))}
          </div>
          <div className="sp-chips">
            {um && um.oomRisk !== "low" && (
              <Tag tone={um.oomRisk === "high" ? "bad" : "warn"}>
                {um.oomRisk === "high"
                  ? t("spark.unifiedMemory.oomHigh", "OOM risk: high")
                  : t("spark.unifiedMemory.pressure", "Memory pressure")}
              </Tag>
            )}
            {um && um.bandwidth.current > 0 && (
              <Tag title={t("spark.unifiedMemory.bandwidthTitle", "GPU memory bandwidth (nvidia-smi dmon)")}>
                {um.bandwidth.current.toFixed(1)} / {um.bandwidth.peak} GB/s
              </Tag>
            )}
          </div>
        </>
      ) : (
        <p className="sp-muted">{t("spark.unifiedMemory.waiting", "Waiting for memory reading…")}</p>
      )}
      {processes.length > 0 && <GpuProcessTable processes={processes} />}
    </Panel>
  );
}
