import type { CpuMetrics, RamMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { CpuIcon, MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface CpuPanelProps {
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  sparkId: string;
  /** Temperature unit conversion; default celsius (Spark pages, historical behavior). */
  temperatureUnit?: "celsius" | "fahrenheit";
  /** Temp row label — GB10 machines default to "SoC temp"; gpu-less hosts pass "CPU temp". */
  tempLabel?: string;
  className?: string;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * CPU & RAM row — a full-width panel with two side-by-side boxes:
 * CPU (usage sparkline + power + temperature) on the left, RAM on the right.
 * Each box carries its own header (icon + label); the container has no heading.
 * Lives below the stock Resources grid (GPU | Storage + Network).
 */
export function CpuPanel({
  cpu,
  ram,
  unifiedMemory,
  sparkId,
  temperatureUnit = "celsius",
  tempLabel,
  className,
}: CpuPanelProps) {
  const cpuHistory = useMetricsHistoryTail(sparkId, "cpu.usage");

  const usage = cpu?.usage ?? 0;
  const temperature = cpu?.temperature ?? 0;
  const draw = cpu?.draw ?? 0;
  const tdp = cpu?.tdp ?? 0;

  const ramUsed = ram?.used ?? 0;
  const ramTotal = ram?.total ?? 0;
  const ramPct = ram?.percentage ?? 0;
  const ramBarColor = ramPct > 95 ? "bg-danger" : ramPct > 75 ? "bg-warning" : "bg-bar-ram";
  const ramAvail = ramTotal > 0 ? ramTotal - ramUsed : 0;

  return (
    <section
      className={`panel panel-accent panel-cpu-ram ${className ?? ""}`}
      style={{ padding: "var(--density-panel-pad)" }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* CPU box */}
        <div className="space-y-2">
          <div className="panel-title mb-2.5">
            <CpuIcon />
            CPU
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Usage</span>
            <div className="flex items-center gap-3">
              {cpuHistory.length > 0 && (
                <span style={{ color: "var(--color-accent)" }}>
                  <Sparkline data={cpuHistory} color="var(--color-accent)" width={180} />
                </span>
              )}
              <span className="font-tabular text-sm font-semibold text-text-strong">{usage}%</span>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Power</span>
            <span className="font-tabular text-[13px] text-text">
              {draw}W / {tdp}W
            </span>
          </div>
          {temperature > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span
                className="text-muted"
                title={
                  tempLabel
                    ? "Package/CPU sensor (coretemp / k10temp)"
                    : "Board/SoC ACPI zone (no coretemp on GB10)"
                }
              >
                {tempLabel ?? "SoC temp"}
              </span>
              <span className="font-tabular text-[13px] text-text">
                {temperatureUnit === "fahrenheit"
                  ? `${Math.round((temperature * 9) / 5 + 32)}°F`
                  : `${temperature}°C`}
              </span>
            </div>
          )}
        </div>

        {/* RAM box */}
        <div className="space-y-2 border-l border-border pl-4">
          <div className="panel-title mb-2.5">
            <MemoryIcon />
            RAM
          </div>
          <MetricBar
            label="Used"
            value={ramUsed}
            max={ramTotal}
            color={ramBarColor}
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
      </div>
    </section>
  );
}
