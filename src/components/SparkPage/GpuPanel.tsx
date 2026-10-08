import { useState } from "react";
import type { GpuDevice, GpuMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { Ring } from "../ui/Ring";
import { Tag, type TagTone } from "../ui/Tag";
import { ActivityIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { VramBreakdownBar } from "../ui/VramBreakdownBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { formatMb } from "../../shared/formatBytes";
import { GpuHistoryChart, GPU_CHART_WINDOWS } from "./GpuHistoryChart";
import {
  computeVramBreakdown,
  headroomTextClass,
  type VramBreakdownContext,
} from "../../shared/vramBreakdown";

interface GpuPanelProps {
  gpu: GpuMetrics | null;
  /**
   * Draw the VRAM bars as an engine / system / free breakdown judged by
   * headroom (Settings → Detailed VRAM breakdown). null: the plain bar.
   */
  vramContext?: VramBreakdownContext | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  /** GPU chip name for the title (e.g. "GB10"). */
  chip?: string | null;
  /**
   * Hide the VRAM bar and process list — set when the Unified memory panel
   * (which shows both) sits right below this one.
   */
  hideMemory?: boolean;
  className?: string;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

/** "NVIDIA GeForce RTX 5080" → "RTX 5080" for the per-card rows. */
function shortGpuName(name: string | null): string {
  if (!name) return "";
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");
}

function throttleTag(reason: string | undefined): { label: string; tone: TagTone } {
  const r = reason ?? "ok";
  if (r === "thermal") return { label: "Thermal throttle", tone: "bad" };
  if (r === "power") return { label: "Power cap", tone: "neutral" };
  if (r === "hw") return { label: "HW slowdown", tone: "warn" };
  if (r === "unknown") return { label: "Throttled", tone: "warn" };
  return { label: "No throttle", tone: "good" };
}

function tempTag(celsius: number): { label: string; tone: TagTone } {
  if (celsius > 85) return { label: "Hot", tone: "bad" };
  if (celsius > 65) return { label: "Warm", tone: "warn" };
  return { label: "Normal", tone: "good" };
}

function tempColorFor(celsius: number, idle = "var(--color-text)"): string {
  return celsius > 85 ? "var(--color-danger)" : celsius > 65 ? "var(--color-warning)" : idle;
}

/** One physical GPU on a multi-card host: name, throttle chip, usage/temp sparklines, VRAM. */
function GpuDeviceRow({
  device: d,
  vramContext,
  sparkId,
  temperatureUnit,
}: {
  device: GpuDevice;
  vramContext: VramBreakdownContext | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
}) {
  // One card's own VRAM and processes; its KV pool is not knowable per card.
  const breakdown = vramContext
    ? computeVramBreakdown(d.vram, d.processes, {
        model: "discrete",
        unified: null,
        serving: vramContext.serving,
      })
    : null;
  const usageHistory = useMetricsHistoryTail(sparkId, `gpu.${d.index}.usage`);
  const tempHistory = useMetricsHistoryTail(sparkId, `gpu.${d.index}.temp`);
  const temp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(d.temperature) : d.temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${temp}°F` : `${temp}°C`;
  const tempColor = tempColorFor(d.temperature, "var(--color-accent)");
  const chip = throttleTag(d.throttle?.reason);
  const short = shortGpuName(d.name);
  return (
    <div className="sp-device space-y-1.5" title={d.throttle?.detail ?? undefined}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-text" title={d.name ?? undefined}>
          GPU {d.index}
          {short ? ` · ${short}` : ""}
        </span>
        <Tag tone={chip.tone}>{chip.label}</Tag>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Usage</span>
        <div className="flex items-center gap-2">
          <Sparkline data={usageHistory} color="var(--color-accent)" width={84} height={16} />
          <span className="font-tabular text-text">{d.usage}%</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Temperature</span>
        <div className="flex items-center gap-2">
          <Sparkline data={tempHistory} color={tempColor} width={84} height={16} />
          <span className="font-tabular" style={{ color: tempColor }}>{tempLabel}</span>
        </div>
      </div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted">Power</span>
        <span className="font-tabular text-text">
          {d.power.draw}W / {d.power.limit}W
        </span>
      </div>
      {breakdown ? (
        <VramBreakdownBar label="VRAM" breakdown={breakdown} showLegend />
      ) : d.vram.total > 0 ? (
        <MetricBar
          label="VRAM"
          value={d.vram.used}
          max={d.vram.total}
          caption={`${formatMb(d.vram.used).replace(/ (GB|MB)$/, "")} / ${formatMb(d.vram.total)}`}
        />
      ) : (
        <div className="flex justify-between text-xs">
          <span className="text-muted">VRAM</span>
          <span className="font-tabular text-text">
            {d.vram.used > 0 ? `${formatMb(d.vram.used)} used` : "—"}
          </span>
        </div>
      )}
    </div>
  );
}

export function GpuPanel({
  gpu,
  vramContext = null,
  sparkId,
  temperatureUnit,
  chip,
  hideMemory = false,
  className,
}: GpuPanelProps) {
  const [windowId, setWindowId] = useState<(typeof GPU_CHART_WINDOWS)[number]["id"]>("30m");
  const windowMs = GPU_CHART_WINDOWS.find((w) => w.id === windowId)?.ms ?? GPU_CHART_WINDOWS[0].ms;

  const temperature = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempUnit = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const usage = gpu?.usage ?? 0;
  const powerDraw = gpu?.power?.draw ?? 0;
  const powerLimit = gpu?.power?.limit ?? 0;
  const systemDraw = gpu?.power?.systemDraw;

  const vramUsed = gpu?.vram?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? 0;
  const devices = gpu?.gpus ?? [];
  const multiGpu = devices.length > 1;
  const breakdown =
    gpu && vramContext ? computeVramBreakdown(gpu.vram, gpu.processes, vramContext) : null;

  const t = gpu?.throttle;
  const thermal = t?.reason === "thermal";
  const throttle = throttleTag(t?.reason);
  const temp = tempTag(temperature);
  const ringColor = thermal ? "var(--color-danger)" : "var(--color-accent)";
  const clock =
    t?.smClockMHz != null
      ? { value: (t.smClockMHz / 1000).toFixed(2), unit: "GHz" }
      : t?.smClockPct != null
        ? { value: String(Math.round(t.smClockPct)), unit: "%" }
        : { value: "—", unit: "" };

  return (
    <Panel
      title={chip ? `GPU · ${chip}` : "GPU"}
      icon={<ActivityIcon />}
      className={`panel-gpu ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        <div className="seg" role="group" aria-label="Chart window">
          {GPU_CHART_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              className={w.id === windowId ? "is-on" : ""}
              aria-pressed={w.id === windowId}
              onClick={() => setWindowId(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="sp-gpu-top">
        <Ring
          value={usage}
          size={140}
          strokeWidth={11}
          color={ringColor}
          label={`${usage}%`}
          caption="utilization"
          className="sp-gpu-top__ring"
        />
        <div className="sp-stat">
          <span className="eyebrow">Temperature</span>
          <div className="big-num">
            {displayTemp}
            <small>{tempUnit}</small>
          </div>
          <Tag tone={temp.tone}>{temp.label}</Tag>
        </div>
        <div className="sp-stat">
          <span className="eyebrow">{multiGpu ? "Power (all cards)" : "Power draw"}</span>
          <div className="big-num">
            {powerDraw}
            <small>{powerLimit > 0 ? `/ ${powerLimit} W` : "W"}</small>
          </div>
          {systemDraw != null && systemDraw > 0 ? (
            <span className="sp-stat__sub mono">System ≈ {systemDraw} W</span>
          ) : null}
        </div>
        <div className="sp-stat" title={t?.detail ?? undefined}>
          <span className="eyebrow">SM clock</span>
          <div className="big-num">
            {clock.value}
            <small>{clock.unit}</small>
          </div>
          <Tag tone={throttle.tone}>{throttle.label}</Tag>
        </div>
      </div>

      <GpuHistoryChart sparkId={sparkId} gpu={gpu} windowMs={windowMs} />
      <div className="legend">
        <span className="c-accent">GPU utilization %</span>
        <span className="c-violet">Power % of limit</span>
        <span className="c-info">Temperature °C</span>
      </div>

      {/* Per-card breakdown — only when the host has more than one GPU */}
      {multiGpu && (
        <div className="sp-section">
          <div className="eyebrow">{devices.length} GPUs</div>
          <div className="sp-devices">
            {devices.map((d) => (
              <GpuDeviceRow
                key={d.uuid ?? d.index}
                device={d}
                vramContext={vramContext}
                sparkId={sparkId}
                temperatureUnit={temperatureUnit}
              />
            ))}
          </div>
        </div>
      )}

      {/* GPU-allocated memory (shown here only when the Unified memory panel is not) */}
      {gpu && !hideMemory && (
        <div className="sp-section">
          {breakdown ? (
            <>
              <VramBreakdownBar
                label={
                  multiGpu
                    ? "VRAM (all cards)"
                    : breakdown.systemMB != null
                      ? "Unified memory"
                      : "VRAM"
                }
                breakdown={breakdown}
                showLegend
              />
              <div className="sp-row">
                <span className="text-muted">Available</span>
                <span className={`mono ${headroomTextClass(breakdown.tone)}`}>
                  {formatMb(breakdown.freeMB)}
                </span>
              </div>
            </>
          ) : vramTotal > 0 ? (
            <>
              <MetricBar
                label={multiGpu ? "VRAM (all cards)" : "VRAM"}
                value={vramUsed}
                max={vramTotal}
                color="bg-info"
                caption={`${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}`}
              />
              {gpu.vram.available > 0 && (
                <div className="sp-row">
                  <span className="text-muted">Available</span>
                  <span className="mono text-text">{formatMb(gpu.vram.available)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="sp-row">
              <span className="text-muted">VRAM</span>
              <span className="mono text-text">{vramUsed > 0 ? `${formatMb(vramUsed)} used` : "—"}</span>
            </div>
          )}
        </div>
      )}

      {(gpu?.nvErrNoMemory ?? 0) > 0 && (
        <div
          className="sp-row"
          title="NVRM kernel NV_ERR_NO_MEMORY lines since boot (journal). GPU memory allocation failures under pressure."
        >
          <span className="text-muted">GPU memory allocation errors since boot</span>
          <span className="mono font-semibold text-danger">{gpu?.nvErrNoMemory}</span>
        </div>
      )}

      {/* Top GPU processes by VRAM usage */}
      {gpu && !hideMemory && gpu.processes && gpu.processes.length > 0 && (
        <GpuProcessTable processes={gpu.processes} />
      )}
    </Panel>
  );
}

/** Per-process memory table (PID · process · memory). Shared with the Unified memory panel. */
export function GpuProcessTable({
  processes,
}: {
  processes: NonNullable<GpuMetrics["processes"]>;
}) {
  return (
    <table className="sp-table">
      <thead>
        <tr>
          <th>PID</th>
          <th>Process</th>
          <th className="r">Memory</th>
        </tr>
      </thead>
      <tbody>
        {processes.map((proc) => (
          <tr key={proc.pid}>
            <td className="mono">{proc.pid}</td>
            <td title={`${proc.name} (PID ${proc.pid})`}>
              <span className="sp-table__name">{proc.name}</span>
            </td>
            <td className="r mono">{formatMb(proc.vramMB)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
