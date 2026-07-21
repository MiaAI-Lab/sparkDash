import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { shutdownAllSparks, wakeAllSparks } from "../../api/client";
import { MetricBar } from "../ui/MetricBar";
import { ActivityIcon, PowerOffIcon, PowerOnIcon } from "../ui/icons";
import { getOverviewLlmStat } from "./overviewLlmStat";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Format a storage value in MB, stripping trailing ".0" and optionally omitting the unit. */
function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function MiniStat({
  label,
  value,
  tone = "default",
  bold = true,
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted">{label}</span>
      <span
        className={`font-tabular text-[13px] truncate ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title}
      >{value}</span>
    </div>
  );
}

function SparkCard({ spark, temperatureUnit, onSelect }: { spark: SparkSnapshot; temperatureUnit: "celsius" | "fahrenheit"; onSelect?: (id: string) => void }) {
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const vramPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const vramUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const vramAvail = gpu?.vram?.available ?? um?.available ?? 0;

  // Temperature bar: cool → success, warm → warning, hot → danger
  const tempBarColor =
    tempRaw > 85 ? "bg-danger" : tempRaw > 65 ? "bg-warning" : tempRaw > 40 ? "bg-accent" : "bg-success";
  // Usage bar: accent for moderate, warning high, danger critical
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  // VRAM allocation: accent normal → warning/danger as it fills
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  return (
    <div
      className="overview-card flex flex-col gap-3 p-[22px]"
      style={online ? undefined : { opacity: 0.6 }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong">
          {onSelect ? (
            <button
              type="button"
              onClick={() => onSelect(spark.id)}
              className="text-left font-inherit text-inherit hover:underline"
            >
              {spark.name}
            </button>
          ) : (
            spark.name
          )}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {online ? "online" : "offline"}
        </span>
      </div>

      {!online || !gpu ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {online ? "Waiting for metrics…" : "Host unreachable"}
          </span>
        </div>
      ) : (
        <>
          {/* Three headline bars: GPU alloc, Temp, Usage */}
          <div className="flex flex-col gap-3.5">
            <MetricBar
              label="VRAM"
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}` : "—"}
            />
            <MetricBar
              label="Temperature"
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            <MetricBar
              label="Usage"
              value={usage}
              max={100}
              color={usageBarColor}
              caption={`${usage}%`}
            />
          </div>

          {/* Secondary stats */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5">
            <MiniStat
              label="GPU Power"
              value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`}
            />
            {vramAvail > 0 && (
              <MiniStat
                label="Available"
                value={formatMb(vramAvail)}
                tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"}
              />
            )}
            {(() => {
              // Find the root disk by label "/" (the collector maps the host
              // root mount to that label). Fall back to the GB10 partition name
              // so the overview keeps working where labels aren't populated.
              const rootDisk =
                spark.metrics.storage.find((d) => d.label === "/") ??
                spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) {
                return (
                  <MiniStat
                    label="Storage"
                    value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`}
                    tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"}
                    bold={false}
                  />
                );
              }
              return null;
            })()}
            {(() => {
              const stat = getOverviewLlmStat(spark);
              if (!stat) return null;
              return (
                <MiniStat
                  label={stat.label}
                  value={stat.value}
                  tone="accent"
                  title={stat.title}
                />
              );
            })()}
          </div>

          {(() => {
            const llmArr = spark.metrics.llm;
            const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
            if (!llm) return null;
            return (
              <div className="mt-3.5 border-t border-border pt-3 text-center">
                <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                  {llm.generationTps.toFixed(0)}
                </span>
                <span className="text-sm font-normal text-muted"> tok/s</span>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

export function OverviewPage({ sparks, hideOffline = false, temperatureUnit = "celsius", onSelectSpark }: OverviewPageProps) {
  const visibleSparks = hideOffline ? sparks.filter((s) => s.online) : sparks;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  async function handleShutdownAll() {
    const onlineCount = sparks.filter((s) => s.online).length;
    if (onlineCount === 0) return;
    if (!confirm(`Gracefully shut down all ${onlineCount} online Spark(s)? Offline nodes will be skipped.`)) {
      return;
    }
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [`${ok} shut down`];
      if (fail) parts.push(`${fail} failed`);
      if (skipped) parts.push(`${skipped} skipped`);
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch shutdown failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? `${ok} wake packet(s) sent` : `${ok} sent, ${fail} failed`,
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch wake failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (visibleSparks.length === 0) {
    const allOffline = hideOffline && sparks.length > 0;
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">
          {allOffline ? "All Sparks are offline" : "No Sparks registered"}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {allOffline
            ? "Auto-hide is enabled and no Sparks are currently online."
            : "Click the + tab to add a DGX Spark unit."}
        </p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1 className="text-[32px] font-normal leading-tight tracking-tight text-text-strong">
          Overview
        </h1>
        <div className="flex items-center gap-3">
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {sparks.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title="Wake all Sparks that have a MAC configured (WoL)"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
              >
                <PowerOnIcon className="h-3 w-3" />
                Wake All
              </button>
              <button
                type="button"
                onClick={() => void handleShutdownAll()}
                disabled={batchLoading || !sparks.some((s) => s.online)}
                title="Shut down all online Sparks"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-danger/20 hover:text-danger transition-colors disabled:opacity-50"
              >
                <PowerOffIcon className="h-3 w-3" />
                Shutdown All
              </button>
            </div>
          )}
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{visibleSparks.length} online
          </span>
        </div>
      </div>
      <div className="overview-page grid gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
        {visibleSparks.map((spark) => (
          <SparkCard key={spark.id} spark={spark} temperatureUnit={temperatureUnit} onSelect={onSelectSpark} />
        ))}
      </div>
    </div>
  );
}