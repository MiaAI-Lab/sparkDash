import type { CpuMetrics, RamMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { CpuIcon, MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface CpuPanelProps {
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  sparkId: string;
  unifiedMemory: UnifiedMemoryMetrics | null;
  temperatureUnit: "celsius" | "fahrenheit";
}

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function MetricRow({
  label,
  spark,
  value,
  color = "var(--color-accent)",
}: {
  label: string;
  spark: React.ReactNode;
  value: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-2.5">
        <span style={{ color }}>{spark}</span>
        <span className="font-tabular text-[13px] font-semibold text-text">{value}</span>
      </div>
    </div>
  );
}

export function CpuPanel({ cpu, ram, sparkId, unifiedMemory, temperatureUnit }: CpuPanelProps) {
  const usageHistory = useMetricsHistoryTail(sparkId, "cpu.usage");
  const tempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");

  const usage = cpu?.usage ?? 0;
  const draw = cpu?.draw ?? 0;
  const tdp = cpu?.tdp ?? 0;

  // 0 means no sensor was readable on this host (see SystemCollector._parseSensorTemp).
  const temperature = cpu?.temperature ?? 0;
  const displayTemp =
    temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  // GB10 CPU thresholds follow DGX_SPARK.THERMAL_THRESHOLDS.junction (warn 85, crit 95).
  // The GPU panel's 65°C warning would sit amber permanently here under normal load.
  const tempColor =
    temperature > 95
      ? "var(--color-danger)"
      : temperature > 85
        ? "var(--color-warning)"
        : "var(--color-accent)";

  const ramUsed = ram?.used ?? 0;
  const ramTotal = ram?.total ?? 0;
  const ramPct = ram?.percentage ?? 0;
  const ramAvail = ramTotal > 0 ? ramTotal - ramUsed : 0;

  return (
    <Panel title="CPU" icon={<CpuIcon />} className="panel-cpu" bodyClassName="space-y-3" accent>
      <MetricRow
        label="Usage"
        color="var(--color-accent)"
        spark={<Sparkline data={usageHistory} color="var(--color-accent)" width={180} />}
        value={<span className="text-text-strong">{usage}%</span>}
      />
      {temperature > 0 && (
        <MetricRow
          label="Temperature"
          color={tempColor}
          spark={<Sparkline data={tempHistory} color={tempColor} width={180} />}
          value={<span className="text-text-strong">{tempLabel}</span>}
        />
      )}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Power</span>
        <span className="font-tabular text-[13px] text-text">
          {draw}W / {tdp}W
        </span>
      </div>

      {(ramTotal > 0 || ram) && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="panel-title mb-2.5">
            <MemoryIcon />
            RAM
          </div>
          <MetricBar
            label="Used"
            value={ramUsed}
            max={ramTotal}
            caption={ramTotal > 0 ? `${formatMb(ramUsed)} / ${formatMb(ramTotal)} · ${ramPct}%` : "—"}
          />
          {ramAvail > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-muted">Available</span>
              <span className="font-tabular text-text">{formatMb(ramAvail)}</span>
            </div>
          )}
          {unifiedMemory?.oomRisk && unifiedMemory.oomRisk !== "low" && (
            <div className="flex justify-between text-xs">
              <span className="text-muted">OOM Risk</span>
              <span
                className={`font-tabular ${
                  unifiedMemory.oomRisk === "high" ? "text-danger" : "text-warning"
                }`}
              >
                {unifiedMemory.oomRisk}
              </span>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}