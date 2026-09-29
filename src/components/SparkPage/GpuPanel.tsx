import type { CpuMetrics, GpuMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { DISPLAY } from "../../config/display.js";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { useShareMode } from "../../hooks/shareMode";

interface GpuPanelProps {
  gpu: GpuMetrics | null;
  /** When set and temperature > 0, show a CPU temp row (DGX Spark pages). */
  cpu?: CpuMetrics | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
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
      <div className="flex items-center gap-3">
        <span style={{ color }}>{spark}</span>
        <span className="font-tabular text-sm font-semibold text-text">{value}</span>
      </div>
    </div>
  );
}

export function GpuPanel({ gpu, cpu, sparkId, temperatureUnit, className }: GpuPanelProps) {
  const shareMode = useShareMode();
  const tempHistory = useMetricsHistoryTail(sparkId, "gpu.temp");
  const usageHistory = useMetricsHistoryTail(sparkId, "gpu.usage");
  const cpuTempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");

  const temperature = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const usage = gpu?.usage ?? 0;
  const powerDraw = gpu?.power?.draw ?? 0;
  const powerLimit = gpu?.power?.limit ?? 0;

  const vramUsed = gpu?.vram?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? 0;
  const vramPct = gpu?.vram?.percentage ?? 0;

  const cpuTemperature = cpu?.temperature ?? 0;
  const cpuDisplayTemp =
    temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(cpuTemperature) : cpuTemperature;
  const cpuTempLabel =
    temperatureUnit === "fahrenheit" ? `${cpuDisplayTemp}°F` : `${cpuDisplayTemp}°C`;

  // Sparkline colors follow §5.6: compute utilisation is never risk-coloured
  // (I-3); temperature is neutral accent with the warn band + throttle rule
  // drawn inside the sparkline (fixed domain 20–95 °C).
  const tempColor = "var(--color-accent)";
  const cpuTempColor = "var(--color-accent)";

  return (
    <Panel
      title="GPU"
      accent
      icon={<ActivityIcon />}
      className={`panel-gpu ${className ?? ""}`}
      bodyClassName="space-y-3"
    >
      <MetricRow
        label="Usage"
        color="var(--color-accent)"
        spark={
          <Sparkline
            data={usageHistory}
            domain={DISPLAY.USAGE_DOMAIN}
            color="var(--color-accent)"
            width={180}
            axisLabel="axis 0–100 %"
            summary={`GPU usage ${usage} percent over the last 5 minutes`}
          />
        }
        value={<span className="text-text-strong">{usage}%</span>}
      />
      <MetricRow
        label="Temperature"
        color={tempColor}
        spark={
          <Sparkline
            data={tempHistory}
            domain={DISPLAY.TEMP_DOMAIN_C}
            color={tempColor}
            width={180}
            warnBand={[DISPLAY.TEMP_WARN_C, DISPLAY.TEMP_DOMAIN_C[1]]}
            axisLabel={`axis 20–95 °C, warn ≥ ${DISPLAY.TEMP_WARN_C} °C`}
            summary={`GPU temperature ${temperature} degrees Celsius over the last 5 minutes`}
          />
        }
        value={<span className="text-text-strong">{tempLabel}</span>}
      />
      {cpuTemperature > 0 && (
        <MetricRow
          label="CPU"
          color={cpuTempColor}
          spark={
            <Sparkline
              data={cpuTempHistory}
              domain={DISPLAY.TEMP_DOMAIN_C}
              color={cpuTempColor}
              width={180}
              axisLabel={`axis 20–95 °C, warn ≥ ${DISPLAY.TEMP_WARN_C} °C`}
              summary={`CPU temperature ${cpuTemperature} degrees Celsius over the last 5 minutes`}
            />
          }
          value={<span className="text-text-strong">{cpuTempLabel}</span>}
        />
      )}
      <div className="flex justify-between text-sm">
        <span className="text-muted">GPU Power</span>
        <span className="font-tabular text-sm text-text">
          {powerDraw.toFixed(1)} W / {Math.round(powerLimit)} W
        </span>
      </div>

      {/* NVIDIA throttle / thermal slowdown + SM clock headroom */}
      {(() => {
        const t = gpu?.throttle;
        const reason = t?.reason ?? "ok";
        const chipLabel =
          reason === "thermal"
            ? "Thermal"
            : reason === "power"
              ? "Power"
              : reason === "hw"
                ? "HW"
                : "OK";
        const chipClass =
          reason === "thermal"
            ? "border-danger/40 bg-danger/15 text-danger"
            : reason === "power" || reason === "hw"
              ? "border-warning/40 bg-warning/15 text-warning"
              : "border-border bg-surface-elevated text-muted";
        const barColor =
          reason === "thermal"
            ? "bg-danger"
            : reason === "power" || reason === "hw"
              ? "bg-warning"
              : "bg-accent";
        const pct = t?.smClockPct;
        const clockCaption =
          t?.smClockMHz != null && t?.smClockMaxMHz != null
            ? `${t.smClockMHz} / ${t.smClockMaxMHz} MHz`
            : pct != null
              ? `${pct}%`
              : "—";
        return (
          <div className="space-y-1.5" title={t?.detail ?? undefined}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted">Throttle</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chipClass}`}
              >
                {chipLabel}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted">SM clock</span>
              <span className="font-tabular text-xs text-text">{clockCaption}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${barColor}`}
                style={{
                  width: `${pct != null ? Math.min(100, Math.max(0, pct)) : 0}%`,
                }}
              />
            </div>
          </div>
        );
      })()}

      {/* GPU-allocated memory (portion of the unified pool held by GPU compute apps) */}
      {gpu && (
        <div className="space-y-2 border-t border-border pt-3">
          {vramTotal > 0 ? (
            <>
              <MetricBar
                label="VRAM"
                value={vramUsed}
                max={vramTotal}
                caption={shareMode ? `${vramPct}%` : vramTotal > 0 ? `${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}` : "—"}
              />
              {gpu.vram.available > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted">Available</span>
                  <span className="font-tabular text-text">{shareMode ? "—" : formatMb(gpu.vram.available)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between text-xs">
              <span className="text-muted">VRAM</span>
              <span className="font-tabular text-text">
                {vramUsed > 0 ? (shareMode ? `${vramPct}%` : `${formatMb(vramUsed)} used`) : "—"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Top GPU processes by VRAM usage */}
      {gpu && gpu.processes && gpu.processes.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Processes</div>
          {gpu.processes.map((proc) => (
            <div key={proc.pid} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-text" title={`${proc.name} (PID ${proc.pid})`}>
                  {proc.name}
                </span>
                <span className="shrink-0 font-tabular text-[10px] text-muted">
                  {proc.pid}
                </span>
              </div>
              <span className="shrink-0 font-tabular text-text">
                {formatMb(proc.vramMB)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}