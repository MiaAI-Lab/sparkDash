import { useEffect, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark, resolveSparkRole } from "../../api/sparkRole";
import { shutdownAllSparks, updateAllHermes, wakeAllSparks } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { MetricBar } from "../ui/MetricBar";
import { SpeedGauge } from "../ui/SpeedGauge";
import { ServingLanes } from "../SparkPage/ServingLanes";
import { scaleForModel } from "../../config/display.js";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { FleetAlertStrip } from "./FleetAlertStrip";
import { ActivityIcon, GearIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  hideWorkers?: boolean;
  showFleetEnergy?: boolean;
  showFleetExceptions?: boolean;
  showOverviewSearch?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
  /** "gauges" renders the same cards with tok/s speedometers (Alt-overview tab). */
  variant?: "overview" | "gauges";
  /** Per-Spark manual gauge scale maxima (from server settings). */
  gaugeScales?: Record<string, { gen?: number | null; prefill?: number | null }>;
  /** Persist a Spark's manual gauge scale maxima to server settings. */
  onGaugeScalesChange?: (sparkId: string, scales: { gen: number | null; prefill: number | null }) => void;
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
  wrap = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
  /** Allow value to wrap (no ellipsis trim) — used for long model ids. */
  wrap?: boolean;
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
        className={`font-tabular text-[13px] ${
          wrap
            ? "whitespace-normal break-words leading-snug [overflow-wrap:anywhere]"
            : "truncate"
        } ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function SparkCard({
  spark,
  headSparkName,
  temperatureUnit,
  onSelect,
  tokDisplay = "stats",
  gaugeScales = null,
  onGaugeScalesChange,
}: {
  spark: SparkSnapshot;
  headSparkName?: string | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
  /** "gauges" swaps the tok/s numbers for prefill/gen speedometer dials. */
  tokDisplay?: "stats" | "gauges";
  /** This Spark's manual gauge scale maxima (tok/s); null/empty per dial =
   *  defer to the model-keyed scale (MODEL_SCALES). */
  gaugeScales?: { gen?: number | null; prefill?: number | null } | null;
  onGaugeScalesChange?: (scales: { gen: number | null; prefill: number | null }) => void;
}) {
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
      className="overview-card flex flex-col"
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
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
        {(() => {
          const role = resolveSparkRole(spark);
          const text =
            role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
          const title =
            role === "head"
              ? "Cluster head Spark"
              : role === "worker"
                ? spark.workerLabel?.trim()
                  ? `${spark.workerLabel.trim()} · distributed LLM worker`
                  : "Distributed LLM worker"
                : spark.llmMonitoring === false
                  ? "Standalone — LLM monitoring off"
                  : "Standalone Spark";
          return (
            <span
              className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
              title={title}
            >
              {text}
            </span>
          );
        })()}
        {spark.comfyMonitoring ? (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              !spark.metrics?.comfy?.available
                ? "bg-border/60 text-muted"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? "bg-accent/15 text-accent"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? "bg-warning/15 text-warning"
                    : "bg-border/60 text-muted"
            }`}
            title={
              !spark.metrics?.comfy?.available
                ? "ComfyUI monitoring on — not reachable"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? spark.metrics.comfy.activeJob?.title
                    ? `ComfyUI running: ${spark.metrics.comfy.activeJob.title}`
                    : "ComfyUI job running"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? `ComfyUI queue: ${spark.metrics.comfy.queuePending} pending`
                    : "ComfyUI idle"
            }
          >
            {!spark.metrics?.comfy?.available
              ? "Comfy"
              : (spark.metrics.comfy.queueRunning ?? 0) > 0
                ? "Comfy · run"
                : (spark.metrics.comfy.queuePending ?? 0) > 0
                  ? `Comfy · ${spark.metrics.comfy.queuePending}q`
                  : "Comfy · idle"}
          </span>
        ) : null}
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
            {spark.kind === "host" && (() => {
              // Non-Spark hosts: system RAM is separate from discrete VRAM.
              const ram = spark.metrics.ram;
              const rUsed = ram?.used ?? 0;
              const rTotal = ram?.total ?? 0;
              const rPct = rTotal > 0 ? Math.round((rUsed / rTotal) * 100) : 0;
              const ramBarColor = rPct > 85 ? "bg-danger" : rPct > 60 ? "bg-warning" : "bg-accent";
              return (
                <MetricBar
                  label="RAM"
                  value={rUsed}
                  max={rTotal}
                  color={ramBarColor}
                  caption={rTotal > 0 ? `${fmtStorage(rUsed, false)} / ${fmtStorage(rTotal, true)}` : "—"}
                />
              );
            })()}
            <MetricBar
              label={
                spark.kind === "host" || (spark.metrics.cpu?.temperature ?? 0) > 0
                  ? "GPU"
                  : "Temperature"
              }
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            {(spark.metrics.cpu?.temperature ?? 0) > 0 && (() => {
              const cpuRaw = spark.metrics.cpu?.temperature ?? 0;
              const cpuDisplay =
                temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(cpuRaw) : cpuRaw;
              const cpuLabel =
                temperatureUnit === "fahrenheit" ? `${cpuDisplay}°F` : `${cpuDisplay}°C`;
              const cpuBarColor =
                cpuRaw > 95 ? "bg-danger" : cpuRaw > 85 ? "bg-warning" : cpuRaw > 50 ? "bg-accent" : "bg-success";
              return (
                <MetricBar
                  label="CPU"
                  value={cpuDisplay}
                  max={temperatureUnit === "fahrenheit" ? 212 : 100}
                  color={cpuBarColor}
                  caption={cpuLabel}
                />
              );
            })()}
            {gpu?.throttle?.thermal && (
              <div
                className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger"
                title={gpu.throttle.detail || "GPU thermal slowdown engaged"}
              >
                Thermal throttle
              </div>
            )}
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
              const role = resolveSparkRole(spark);

              // Workers have no local LLM API — show cluster/model label instead.
              // Priority: manual workerLabel override > derived head-model
              // mirror > generic fallback. Derived never shows a stale model:
              // the backend nulls it when the head is unresolvable/offline.
              if (role === "worker") {
                const label =
                  spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || "distributed";
                const title = headSparkName
                  ? `${label} · worker of ${headSparkName}`
                  : `${label} · distributed LLM worker`;
                return (
                  <MiniStat
                    label="Worker"
                    value={label}
                    tone="accent"
                    title={title}
                    wrap
                  />
                );
              }

              // Head / Standalone: same as before — live backend + model id.
              const llmArr = spark.metrics.llm;
              const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
              if (!llm) return null;
              // Alt-overview: the model id is the section header above the dials.
              if (tokDisplay === "gauges") return null;
              return (
                <MiniStat
                  label={
                    llm.backend === "vllm"
                      ? "vLLM"
                      : llm.backend === "ds4"
                        ? "ds4"
                        : llm.backend === "sglang"
                          ? "sgLang"
                          : llm.backend === "exl3"
                            ? "EXL3"
                            : llm.backend === "q27"
                              ? "q27"
                              : llm.backend ?? "LLM"
                  }
                  value={llm.modelId ?? "unknown"}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                  wrap
                />
              );
            })()}
          </div>

          {(() => {
            const role = resolveSparkRole(spark);
            if (role === "worker") return null;
            const llmArr = spark.metrics.llm;
            const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
            if (!llm) return null;
            if (tokDisplay === "gauges") {
              // Scale precedence per dial: per-Spark manual override >
              // model-keyed MODEL_SCALES > badged FALLBACK_SCALE. Dials never
              // auto-scale to traffic.
              const modelScale = scaleForModel(llm.modelId);
              const genOverride = gaugeScales?.gen ?? null;
              const prefillOverride = gaugeScales?.prefill ?? null;
              const genScale = genOverride ?? modelScale.gen;
              const prefillScale = prefillOverride ?? modelScale.prefill;
              const backendLabel =
                llm.backend === "vllm"
                  ? "vLLM"
                  : llm.backend === "ds4"
                    ? "ds4"
                    : llm.backend === "sglang"
                      ? "sgLang"
                      : llm.backend === "exl3"
                        ? "EXL3"
                        : llm.backend === "q27"
                          ? "q27"
                          : (llm.backend ?? "LLM");
              return (
                <div className="mt-3.5 border-t border-border pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="min-w-0 truncate text-[14px] font-semibold text-text"
                      title={llm.modelId ?? undefined}
                    >
                      {backendLabel}: {llm.modelId ?? "unknown"}
                    </span>
                    <GaugeScaleButton scales={gaugeScales} onChange={onGaugeScalesChange} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <SpeedGauge label="Prefill" value={llm.prefillTps} max={prefillScale} />
                    <SpeedGauge label="Generation" value={llm.generationTps} max={genScale} />
                  </div>
                  {(genOverride == null || prefillOverride == null) && modelScale.isFallback && (
                    <div className="mt-1 text-center">
                      <span
                        className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning"
                        title="This model is not in MODEL_SCALES and has no manual override — rendering at the fallback scale. Set it with the gear above, or add a measured entry in src/config/display.js."
                      >
                        Default Scale
                      </span>
                    </div>
                  )}
                  <div className="mt-1">
                    {llm.backend === "vllm" && (
                      <ServingLanes llm={llm} maxNumSeqs={spark.maxNumSeqs ?? null} />
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.generationTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted"> tok/s</span>
                </div>
                <div className="border-l border-border text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.prefillTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted"> prefill</span>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

/** Gear popover that edits one Spark's manual gauge scale maxima (tok/s).
 *  Empty value = defer to the model-keyed scale (MODEL_SCALES). */
function GaugeScaleButton({
  scales,
  onChange,
}: {
  scales?: { gen?: number | null; prefill?: number | null } | null;
  onChange?: (scales: { gen: number | null; prefill: number | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const gen = scales?.gen ?? null;
  const prefill = scales?.prefill ?? null;

  const update = (kind: "gen" | "prefill", raw: string) => {
    const n = raw === "" ? null : Number(raw);
    const v = n != null && Number.isFinite(n) && n > 0 ? n : null;
    onChange?.({ gen: kind === "gen" ? v : gen, prefill: kind === "prefill" ? v : prefill });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Gauge scale settings"
        title="Gauge scale settings"
        className={`shrink-0 rounded p-1 transition-colors hover:bg-surface-hover ${open ? "text-accent" : "text-muted"}`}
      >
        <GearIcon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="panel absolute right-0 top-full z-20 mt-1 w-56 space-y-2.5 p-3">
          <p className="text-[11px] text-muted">
            Fixed dial scale for this machine, in tok/s. Leave empty to use the model-keyed
            scale. At or past the max the pointer pins and turns amber.
          </p>
          {(
            [
              ["Generation", "gen", gen],
              ["Prefill", "prefill", prefill],
            ] as const
          ).map(([label, kind, value]) => (
            <label key={kind} className="block text-[11px] text-muted">
              {label} max (tok/s)
              <input
                type="number"
                min={1}
                value={value ?? ""}
                placeholder="model scale"
                onChange={(e) => update(kind, e.target.value)}
                className="mt-0.5 w-full rounded-md border border-border bg-surface-elevated px-2 py-1 font-tabular text-[12px] text-text"
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function OverviewPage({
  sparks,
  hideOffline = false,
  hideWorkers = false,
  showFleetEnergy = false,
  showFleetExceptions = false,
  showOverviewSearch = false,
  temperatureUnit = "celsius",
  onSelectSpark,
  variant = "overview",
  gaugeScales = {},
  onGaugeScalesChange,
}: OverviewPageProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "issues">("all");
  const withoutWorkers = hideWorkers ? sparks.filter((s) => !isWorkerSpark(s)) : sparks;
  const visibleSparks = withoutWorkers.filter((spark) => {
    if (hideOffline && !spark.online) return false;
    if (showOverviewSearch && query && !spark.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (showOverviewSearch && statusFilter === "online" && !spark.online) return false;
    if (showOverviewSearch && statusFilter === "offline" && spark.online) return false;
    if (showOverviewSearch && statusFilter === "issues" && spark.online && !spark.metrics.storage.some((disk) => disk.percentage >= 90)) return false;
    return true;
  });
  const hiddenWorkerCount = hideWorkers ? sparks.filter(isWorkerSpark).length : 0;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  /** Spark ids we started a batch Hermes update on; drives the live progress bar. */
  const [batchRun, setBatchRun] = useState<string[] | null>(null);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;
  const hermesMonitoredCount = sparks.filter((s) => s.hermes?.monitoring).length;
  const hermesPendingUpdateCount = sparks.filter((s) => s.hermes?.updateAvailable === true).length;

  // Live batch progress — counted from WS snapshots, not from the one-shot HTTP response.
  const batchProg = (() => {
    if (!batchRun || batchRun.length === 0) return null;
    let done = 0;
    let failed = 0;
    for (const id of batchRun) {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) continue;
      if (h.status === "error") {
        done += 1;
        failed += 1;
      } else if (h.status === "success" || h.finishedAt != null) {
        done += 1;
      }
    }
    return { total: batchRun.length, done, failed };
  })();

  // Once every started update has settled (success/error), dismiss the progress bar.
  useEffect(() => {
    if (!batchRun || batchRun.length === 0) return;
    const settled = batchRun.reduce((n, id) => {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) return n;
      return n + (h.status === "success" || h.status === "error" || h.finishedAt != null ? 1 : 0);
    }, 0);
    if (settled === batchRun.length) {
      const t = setTimeout(() => setBatchRun(null), 6000);
      return () => clearTimeout(t);
    }
  }, [batchRun, sparks]);

  async function handleUpdateAllHermes() {
    if (hermesMonitoredCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await updateAllHermes();
      const started = res.results.filter((r) => r.started);
      const skipped = res.results.filter((r) => r.skipped).length;
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      const parts = [`${started.length} update${started.length === 1 ? "" : "s"} started`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      setBatchMsg({
        text: parts.join(", "),
        tone: failed === 0 ? "ok" : "err",
      });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch hermes update failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleShutdownAll() {
    if (onlineShutdownCount === 0) return;
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

  if (withoutWorkers.length === 0 || (hideOffline && withoutWorkers.every((spark) => !spark.online))) {
    const allWorkersHidden = hideWorkers && sparks.length > 0 && withoutWorkers.length === 0;
    const allOffline = hideOffline && withoutWorkers.length > 0;
    const title = allWorkersHidden
      ? "Worker nodes are hidden"
      : allOffline
        ? "All Sparks are offline"
        : "No Sparks registered";
    const detail = allWorkersHidden
      ? "Hide worker nodes is on in Settings. Turn it off to show Worker-role Sparks again."
      : allOffline
        ? "Auto-hide is enabled and no Sparks are currently online."
        : "Click the + tab to add a DGX Spark unit.";
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
        <p className="mt-1 text-xs text-muted">{detail}</p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      {showFleetEnergy ? <FleetEnergyCard nodeCount={sparks.length} /> : null}
      {showFleetExceptions ? <FleetAlertStrip sparks={sparks} onSelect={onSelectSpark} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-6">
        {variant !== "gauges" && (
          <h1
            className="font-normal leading-tight tracking-tight text-text-strong"
            style={{ fontSize: "var(--density-overview-title)" }}
          >
            Overview
          </h1>
        )}
        <div className="flex flex-wrap items-end justify-end gap-3">
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="flex flex-col items-end gap-1">
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <RotateIcon className="h-3 w-3" />
                Updating Hermes — {batchProg.done}/{batchProg.total}
                {batchProg.failed > 0 && (
                  <span className="text-danger">({batchProg.failed} failed)</span>
                )}
                <button
                  type="button"
                  onClick={() => setBatchRun(null)}
                  aria-label="Dismiss update progress"
                  title="Dismiss"
                  className="rounded p-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <span className="text-xs leading-none">✕</span>
                </button>
              </span>
              <div className="h-1 w-36 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    batchProg.failed > 0 ? "bg-danger" : "bg-accent"
                  }`}
                  style={{
                    width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title="Run `hermes update` on every Spark with Hermes Agent enabled"
                  className={`flex items-center gap-1 rounded-md border bg-surface-elevated px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                    hermesPendingUpdateCount > 0
                      ? "border-warning/40 text-warning hover:bg-warning/15"
                      : "border-border text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <RotateIcon className="h-3 w-3" />
                  Update Hermes
                  {hermesPendingUpdateCount > 0 && (
                    <span
                      className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                      title={`${hermesPendingUpdateCount} Spark${hermesPendingUpdateCount === 1 ? "" : "s"} with a Hermes update available`}
                    >
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
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
                onClick={() => setShutdownOpen(true)}
                disabled={batchLoading || onlineShutdownCount === 0}
                title="Shut down all online Sparks"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
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
          {hiddenWorkerCount > 0 && (
            <span className="text-[11px] text-muted">
              {hiddenWorkerCount} worker{hiddenWorkerCount === 1 ? "" : "s"} hidden
            </span>
          )}
        </div>
      </div>
      {showOverviewSearch ? (
      <div className="flex flex-wrap gap-2" role="search" aria-label="Filter fleet units">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search up to 12 units"
          aria-label="Search units by name"
          className="min-h-11 min-w-52 flex-1 rounded border border-border bg-surface-elevated px-3 text-sm text-text"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          aria-label="Filter units by status"
          className="min-h-11 rounded border border-border bg-surface-elevated px-3 text-sm text-text"
        >
          <option value="all">All status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="issues">Issues</option>
        </select>
      </div>
      ) : null}
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdownAll}
        title="Shutdown All"
        description={`Gracefully shut down all ${onlineShutdownCount} online Spark${onlineShutdownCount === 1 ? "" : "s"}? Offline nodes will be skipped.`}
        confirmLabel="Shut down all"
      />
      <div className="overview-page grid sm:grid-cols-2 lg:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
        {visibleSparks.length === 0 && (
          <p className="panel p-6 text-sm text-muted sm:col-span-2 lg:col-span-3">
            No units match the current search and status filters.
          </p>
        )}
        {visibleSparks.map((spark) => (
          <SparkCard
            key={spark.id}
            spark={spark}
            headSparkName={
              spark.workerHeadId
                ? sparks.find((s) => s.id === spark.workerHeadId)?.name ?? null
                : null
            }
            temperatureUnit={temperatureUnit}
            onSelect={onSelectSpark}
            tokDisplay={variant === "gauges" ? "gauges" : "stats"}
            gaugeScales={gaugeScales?.[spark.id] ?? null}
            onGaugeScalesChange={(scales) => onGaugeScalesChange?.(spark.id, scales)}
          />
        ))}
      </div>
    </div>
  );
}