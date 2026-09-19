import type { CpuMetrics, RamMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { DISPLAY } from "../../config/display.js";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { useShareMode } from "../../hooks/shareMode";

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
 * here for hosts; Spark pages show it on the GPU panel.
 */
export function RamPanel({ ram, cpu, sparkId, temperatureUnit, className }: RamPanelProps) {
  const shareMode = useShareMode();
  const history = useMetricsHistoryTail(sparkId, "ram.percentage");
  const tempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");
  const used = ram?.used ?? 0;
  const total = ram?.total ?? 0;
  const percentage = ram?.percentage ?? 0;

  const temperature = cpu?.temperature ?? 0;
  const displayTemp =
    temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  // RAM usage % and CPU temperature are utilisation/trend metrics: neutral
  // accent only, fixed domains (I-1/I-3) — never risk-coloured.
  const tempColor = "var(--color-accent)";

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
              shareMode
                ? `${percentage}%`
                : total > 0
                  ? `${formatMb(used).replace(/ (GB|MB)$/, "")} / ${formatMb(total)}`
                  : "—"
            }
          />
          {history.length > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Usage</span>
              <div className="flex items-center gap-3">
                <Sparkline data={history} domain={[0, 100]} color="var(--color-accent)" width={180} axisLabel="axis 0–100 %" summary={`RAM usage ${percentage} percent over the last 5 minutes`} />
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
              <Sparkline data={tempHistory} domain={DISPLAY.TEMP_DOMAIN_C} color={tempColor} width={180} axisLabel="axis 20–95 °C" summary={`CPU temperature ${temperature} degrees Celsius over the last 5 minutes`} />
            </span>
            <span className="font-tabular text-sm font-semibold text-text">{tempLabel}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}
