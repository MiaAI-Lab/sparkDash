import type { GpuMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface GpuPanelProps {
  gpu: GpuMetrics | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
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

export function GpuPanel({ gpu, sparkId, temperatureUnit }: GpuPanelProps) {
  const tempHistory = useMetricsHistoryTail(sparkId, "gpu.temp");
  const usageHistory = useMetricsHistoryTail(sparkId, "gpu.usage");

  const temperature = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const usage = gpu?.usage ?? 0;
  const powerDraw = gpu?.power?.draw ?? 0;
  const powerLimit = gpu?.power?.limit ?? 0;

  const vramUsed = gpu?.vram?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? 0;
  const vramPct = gpu?.vram?.percentage ?? 0;

  const tempColor =
    temperature > 85
      ? "var(--color-danger)"
      : temperature > 65
        ? "var(--color-warning)"
        : "var(--color-accent)";

  return (
    <Panel
      title="GPU"
      accent
      icon={<ActivityIcon />}
      className="panel-gpu"
      bodyClassName="space-y-3"
    >
      <MetricRow
        label="Usage"
        color="var(--color-accent)"
        spark={<Sparkline data={usageHistory} color="var(--color-accent)" width={180} />}
        value={<span className="text-text-strong">{usage}%</span>}
      />
      <MetricRow
        label="Temperature"
        color={tempColor}
        spark={<Sparkline data={tempHistory} color={tempColor} width={180} />}
        value={<span className="text-text-strong">{tempLabel}</span>}
      />
      <div className="flex justify-between text-sm">
        <span className="text-muted">GPU Power</span>
        <span className="font-tabular text-sm text-text">
          {powerDraw}W / {powerLimit}W
        </span>
      </div>

      {/* GPU-allocated memory (portion of the unified pool held by GPU compute apps) */}
      {gpu && (
        <div className="space-y-2 border-t border-border pt-3">
          {vramTotal > 0 ? (
            <>
              <MetricBar
                label="VRAM"
                value={vramUsed}
                max={vramTotal}
                caption={vramTotal > 0 ? `${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}` : "—"}
              />
              {gpu.vram.available > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted">Available</span>
                  <span className="font-tabular text-text">{formatMb(gpu.vram.available)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between text-xs">
              <span className="text-muted">VRAM</span>
              <span className="font-tabular text-text">
                {vramUsed > 0 ? `${formatMb(vramUsed)} used` : "—"}
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
            <div key={proc.pid} className="flex items-center justify-between text-xs">
              <div className="min-w-0 flex-1">
                <span className="truncate text-text" title={`${proc.name} (PID ${proc.pid})`}>
                  {proc.name}
                </span>
                <span className="ml-1.5 font-tabular text-[10px] text-muted">
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