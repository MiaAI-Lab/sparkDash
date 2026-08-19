import type { CpuMetrics, RamMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface RamPanelProps {
  ram: RamMetrics | null;
  cpu: CpuMetrics | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/**
 * System RAM panel — shown for non-Spark GPU hosts, where RAM (system memory)
 * and VRAM (discrete GPU memory) are separate things. CPU temperature lives
 * here because Sparks do not show a CPU panel.
 */
export function RamPanel({ ram, cpu, sparkId, temperatureUnit, className }: RamPanelProps) {
  const history = useMetricsHistoryTail(sparkId, "ram.percentage");
  const tempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");
  const used = ram?.used ?? 0;
  const total = ram?.total ?? 0;
  const percentage = ram?.percentage ?? 0;

  const temperature = cpu?.temperature ?? 0;
  const displayTemp =
    temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  // Generic CPU junction-style bands (not GB10 GPU 65/85 — idle x86 often sits ~50–70).
  const tempColor =
    temperature > 95
      ? "var(--color-danger)"
      : temperature > 85
        ? "var(--color-warning)"
        : "var(--color-accent)";

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
      {temperature > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">CPU</span>
          <div className="flex items-center gap-3">
            <span style={{ color: tempColor }}>
              <Sparkline data={tempHistory} color={tempColor} width={180} />
            </span>
            <span className="font-tabular text-sm font-semibold text-text">{tempLabel}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}
