import type { RamMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface RamPanelProps {
  ram: RamMetrics | null;
  sparkId: string;
  className?: string;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * System RAM panel — shown for non-Spark GPU hosts, where RAM (system memory)
 * and VRAM (discrete GPU memory) are separate things. CPU stats live in the
 * dedicated CPU panel.
 */
export function RamPanel({ ram, sparkId, className }: RamPanelProps) {
  const history = useMetricsHistoryTail(sparkId, "ram.percentage");
  const used = ram?.used ?? 0;
  const total = ram?.total ?? 0;
  const percentage = ram?.percentage ?? 0;

  return (
    <Panel
      title="RAM"
      icon={<MemoryIcon />}
      className={`panel-ram ${className ?? ""}`}
      bodyClassName="space-y-3"
    >
      {total > 0 ? (
        <>
          <MetricBar
            label="RAM"
            value={used}
            max={total}
            caption={
              total > 0
                ? `${formatMb(used).replace(/ (GB|MB)$/, "")} / ${formatMb(total)}`
                : "—"
            }
          />
          {history.length > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Usage</span>
              <div className="flex items-center gap-3">
                <Sparkline data={history} color="var(--color-accent)" width={180} />
                <span className="font-tabular text-sm font-semibold text-text">{percentage}%</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex justify-between text-xs">
          <span className="text-muted">RAM</span>
          <span className="font-tabular text-text">—</span>
        </div>
      )}
    </Panel>
  );
}
