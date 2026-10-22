import { memo, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { usableHead } from "../../shared/sparkHead";
import { wakeSpark } from "../../api/client";
import { backendLabel } from "../../shared/llmBackends";
import { formatDiskSize, formatMb } from "../../shared/formatBytes";
import { Tag } from "../ui/Tag";
import { HealthChips, worstSeverity } from "../ui/HealthFindings";
import { AppLink } from "../ui/AppLink";
import { idToPath } from "../../constants";
import { VramBreakdownBar } from "../ui/VramBreakdownBar";
import { HEADROOM_THRESHOLDS_MB, computeVramBreakdown, memoryModelFor, type VramBreakdownContext } from "../../shared/vramBreakdown";
import { ImageIcon, PowerOnIcon } from "../ui/icons";
import { formatCtx } from "./fleetStats";
import { ModelLauncher } from "./ModelLauncher";

type Unit = "celsius" | "fahrenheit";

function toF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function Bar({
  label,
  caption,
  pct,
  color,
  title,
  sub,
}: {
  label: string;
  caption: string;
  pct: number;
  color: string;
  title?: string;
  /** Small line under the bar, e.g. available memory. */
  sub?: { label: string; value: string } | null;
}) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div>
      <div className="ov-lbl">
        <span title={title}>{label}</span>
        <b className="mono">{caption}</b>
      </div>
      <div className="ov-bar" role="progressbar" aria-label={label} aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${p}%`, background: color }} />
      </div>
      {sub ? (
        <div className="ov-sub">
          <span>{sub.label}</span>
          <b className="mono">{sub.value}</b>
        </div>
      ) : null}
    </div>
  );
}

function SparkCardImpl({
  spark,
  headSpark,
  vramContext = null,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  /** The head this worker serves for (workers only). */
  headSpark?: SparkSnapshot | null;
  /** Breakdown inputs (see `vramContextFor`); null keeps the plain VRAM bar. */
  vramContext?: VramBreakdownContext | null;
  temperatureUnit: Unit;
  onSelect?: (id: string) => void;
}) {
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;
  const role = resolveSparkRole(spark);
  const llmList = Array.isArray(spark.metrics.llm) ? spark.metrics.llm : [];
  const llmIdx = llmList.findIndex((l) => l.available);
  const llm = llmIdx >= 0 ? llmList[llmIdx] : null;
  const [wakeMsg, setWakeMsg] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const unitSuffix = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const fmtTemp = (c: number) => `${temperatureUnit === "fahrenheit" ? toF(c) : Math.round(c)}${unitSuffix}`;
  const tempMax = temperatureUnit === "fahrenheit" ? 212 : 100;
  const tempVal = temperatureUnit === "fahrenheit" ? toF(tempRaw) : tempRaw;
  const memPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const memUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const memTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const memAvail = gpu?.vram?.available ?? um?.available ?? 0;
  const vramAvailable = gpu?.metricAvailability?.vramUsed !== false && gpu?.metricAvailability?.vramTotal !== false;
  const breakdown = gpu && vramAvailable && vramContext ? computeVramBreakdown(gpu.vram, gpu.processes, vramContext) : null;
  const throttle = gpu?.throttle;
  const slowed = !!(throttle?.thermal || throttle?.hwSlowdown);
  const hot = slowed || tempRaw >= 80;

  const ringColor = hot ? "var(--color-warning)" : "var(--color-accent)";
  const memColor = memPct >= 90 ? "var(--color-danger)" : memPct >= 85 ? "var(--color-warning)" : "var(--color-info)";
  const tempColor = tempRaw > 80 ? "var(--color-danger)" : tempRaw >= 75 ? "var(--color-warning)" : "var(--color-success)";
  // A Spark's CPU runs much hotter than its GPU under the same load — on the GB10 the CPU
  // is the number that hits high temps first, so it belongs next to the GPU bars at a glance
  // instead of hiding behind a per-unit page visit.
  const cpuMetrics = spark.metrics.cpu ?? null;
  const cpuTempRaw = cpuMetrics && Number.isFinite(cpuMetrics.temperature) && cpuMetrics.temperature > 0 ? cpuMetrics.temperature : null;
  const cpuTempVal = cpuTempRaw === null ? 0 : temperatureUnit === "fahrenheit" ? toF(cpuTempRaw) : cpuTempRaw;
  const cpuTempColor = cpuTempRaw !== null && cpuTempRaw > 80 ? "var(--color-danger)" : cpuTempRaw !== null && cpuTempRaw >= 75 ? "var(--color-warning)" : "var(--color-success)";
  const cpuPower = cpuMetrics && (cpuMetrics.draw > 0 || cpuMetrics.tdp > 0) ? { draw: cpuMetrics.draw, tdp: cpuMetrics.tdp } : null;
  const cpuPowerPct = cpuPower && cpuPower.tdp > 0 ? (cpuPower.draw / cpuPower.tdp) * 100 : 0;
  const power = gpu?.power;
  const powerPct = power && power.limit > 0 ? (power.draw / power.limit) * 100 : 0;

  const rootDisk =
    spark.metrics.storage.find((d) => d.label === "/") ?? spark.metrics.storage.find((d) => d.device === "nvme0n1p2");

  const comfy = spark.comfyMonitoring ? spark.metrics?.comfy : undefined;
  const hermes = spark.hermes;

  const roleText = role === "head" ? "head" : role === "worker" ? "worker" : "standalone";
  const roleTitle =
    role === "head"
      ? "Cluster head Spark"
      : role === "worker"
        ? spark.workerLabel?.trim()
          ? `${spark.workerLabel.trim()} · distributed LLM worker`
          : "Distributed LLM worker"
        : spark.llmMonitoring === false
          ? "Standalone — LLM monitoring off"
          : "Standalone Spark";

  async function onWake() {
    setWaking(true);
    setWakeMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setWakeMsg(res.success ? "Wake packet sent" : res.error || res.message || "Wake failed");
    } catch (err) {
      setWakeMsg(err instanceof Error ? err.message : "Wake failed");
    } finally {
      setWaking(false);
    }
  }

  // Model box content: workers show their label, others the live backend + model.
  let modelEyebrowRight: string | null = null;
  let modelText: string | null = null;
  let modelTitle: string | undefined;
  const headName = headSpark?.name ?? null;
  // An offline head's last LLM reading is stale: do not present it as the worker's live model.
  const liveHead = usableHead(headSpark);
  const headLlmList = Array.isArray(liveHead?.metrics.llm) ? liveHead.metrics.llm : [];
  const headLlm = headLlmList.find((l) => l.available) ?? null;
  if (role === "worker") {
    // Prefer the head's live model; fall back to the configured / mirrored worker label.
    const label = headLlm?.modelId || spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null;
    modelEyebrowRight = headLlm ? formatCtx(headLlm.contextLength) : null;
    modelText = label ?? (headName ? "No model on head" : "Worker");
    modelTitle = headName ? `${label ?? "No model"} · worker of ${headName}` : `${label ?? "Distributed"} · LLM worker`;
  } else if (llm) {
    // The engine name lives in the tooltip; the row itself is just model + context.
    const engine = backendLabel(llm.backend) ?? llm.backend ?? "LLM";
    modelEyebrowRight = formatCtx(llm.contextLength);
    modelText = llm.modelId ?? "unknown";
    modelTitle = llm.modelId ? `${llm.modelId} · ${engine}` : engine;
  }
  // Idle Spark (nothing serving): the launcher block fills the free space instead.
  // Memory or compute in use while nothing serves yet: a model is most likely still loading.
  // When nvidia-smi names the processes holding the GPU, say so: it may be a server sparkDash does not
  // monitor (add its port under "+ Add LLM port"), not a model that is still starting.
  const gpuHolders = (gpu?.processes ?? [])
    .filter((p) => p.vramMB > 0)
    .slice(0, 3)
    .map((p) => `${p.name} (${formatMb(p.vramMB)})`);
  const loadingHint =
    !llm && (memUsed >= 2048 || usage >= 10)
      ? `${gpuHolders.length > 0 ? `In use by ${gpuHolders.join(", ")} · ` : ""}${formatMb(memUsed)} VRAM in use · GPU ${Math.round(usage)}%`
      : null;
  const showLauncher = role !== "worker" && !llm && spark.llmMonitoring !== false && spark.platform !== "windows";

  const showTps = role !== "worker" && !!llm;
  const isStrata = llm?.backend === "strata";
  // Engines that report requests (TensorFold, Strata, …) used to hide their parallelism behind
  // "N running": a unit set to --parallel 4 and one set to 8 read the same. Name the capacity too.
  const parallel = llm && llm.slotsTotal > 0 ? llm.slotsTotal : null;
  const llmChip = llm
    ? llm.requestsRunning != null
      ? `${llm.requestsRunning} running · ${llm.requestsWaiting == null ? "queue unknown" : `${llm.requestsWaiting} queued`}${
          parallel != null ? ` · ${parallel} slots` : ""
        }`
      : llm.slotsTotal > 0
        ? `${llm.slotsActive ?? "?"}/${llm.slotsTotal} slots`
        : null
    : null;
  const llmChipTitle =
    parallel != null && llm?.requestsRunning != null ? `${parallel} requests decode in parallel on this engine` : undefined;

  const chips = (
    <div className="ov-chips">
      {online && throttle && slowed ? (
        <Tag tone="warn" title={throttle.detail || "GPU clock throttled"}>
          {throttle.thermal ? "Thermal throttle" : "HW slowdown"}
          {throttle.smClockMHz ? ` · SM ${(throttle.smClockMHz / 1000).toFixed(1)} GHz` : ""}
        </Tag>
      ) : null}
      {online && throttle?.clockCapMHz != null ? (
        <Tag title="GPU clock locked with nvidia-smi -lgc">
          Cap {(throttle.clockCapMHz / 1000).toFixed(1)} GHz
        </Tag>
      ) : null}
      {online && llmChip ? <Tag tone={(llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0 ? "good" : "neutral"} title={llmChipTitle}>{llmChip}</Tag> : null}
      {comfy !== undefined || spark.comfyMonitoring ? (
        !comfy?.available ? (
          <Tag title="ComfyUI monitoring on — not reachable">Comfy</Tag>
        ) : (comfy.queueRunning ?? 0) > 0 ? (
          <Tag tone="info" title={comfy.activeJob?.title ? `ComfyUI running: ${comfy.activeJob.title}` : "ComfyUI job running"}>
            <ImageIcon className="h-3.5 w-3.5" />
            {comfy.activeJob?.title ? `ComfyUI · ${comfy.activeJob.title}` : "ComfyUI · running"}
            {comfy.progress?.percent != null ? ` ${Math.round(comfy.progress.percent)}%` : ""}
          </Tag>
        ) : (comfy.queuePending ?? 0) > 0 ? (
          <Tag tone="warn" title={`ComfyUI queue: ${comfy.queuePending} pending`}>Comfy {"·"} {comfy.queuePending}q</Tag>
        ) : (
          <Tag title="ComfyUI idle">Comfy {"·"} idle</Tag>
        )
      ) : null}
      {hermes?.monitoring && hermes.status === "running" ? <Tag tone="info">Hermes updating</Tag> : null}
      {hermes?.monitoring && hermes.status !== "running" && hermes.updateAvailable ? (
        <Tag tone="acc" title="A Hermes update is available">Hermes update available</Tag>
      ) : null}
      {!online ? <Tag>Offline</Tag> : null}
    </div>
  );

  return (
    <div className={`overview-card ov-sc ${online ? "" : "is-off"} ${hot && online ? "is-hot" : ""} ${online && worstSeverity(spark.health) ? `is-health-${worstSeverity(spark.health)}` : ""} ${onSelect ? "is-link" : ""}`}>
      <div className="ov-sc__head">
        <i className={`sdot ${!online ? "sdot--off" : hot || worstSeverity(spark.health) ? "sdot--warn" : ""}`} aria-label={online ? "online" : "offline"} />
        <h3 className="ov-sc__name">
          {onSelect ? (
            // Stretched link: this button's ::after covers the whole card (overview.css), so the card
            // is clickable without being a button that contains buttons.
            <AppLink href={idToPath(spark.id)} className="ov-sc__link" onNavigate={() => onSelect(spark.id)} title={`Open ${spark.name}`}>
              {spark.name}
            </AppLink>
          ) : (
            spark.name
          )}
        </h3>
        <Tag className="tag--role" tone={role === "head" ? "acc" : "neutral"} title={roleTitle}>{roleText}</Tag>
        {spark.lanIp ? <span className="ov-sc__ip mono">{spark.lanIp}</span> : null}
      </div>

      {online ? <HealthChips findings={spark.health} /> : null}

      {!online || !gpu ? (
        <div className="ov-sc__off">
          <span>{online ? "Waiting for metrics…" : "Host unreachable"}</span>
          {!online && spark.kind === "host" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={waking}
              onClick={() => void onWake()}
            >
              <PowerOnIcon className="h-3.5 w-3.5" />
              Wake up
            </button>
          ) : null}
          {wakeMsg ? <span className="ov-sc__msg">{wakeMsg}</span> : null}
          {chips}
        </div>
      ) : (
        <>
          <div className="ov-sc__body">
            <div className="ov-sc__stats">
              {breakdown ? (
                <VramBreakdownBar
                  label={breakdown.systemMB != null ? "Unified memory" : "VRAM"}
                  breakdown={breakdown}
                  showLegend
                />
              ) : (
                <Bar
                  label={gpu.vram?.total ? "VRAM" : "Unified memory"}
                  caption={vramAvailable && memTotal > 0 ? `${fmtStorage(memUsed, false)} / ${fmtStorage(memTotal, true)}` : "—"}
                  pct={vramAvailable ? memPct : 0}
                  color={memColor}
                  sub={memTotal > 0 && memAvail > 0 ? { label: "Available", value: formatMb(memAvail) } : null}
                />
              )}
              <Bar label="GPU" caption={gpu.metricAvailability?.usage === false ? "—" : `${Math.round(usage)}%`} pct={gpu.metricAvailability?.usage === false ? 0 : usage} color={ringColor} />
              {spark.kind === "host" && spark.metrics.ram?.total ? (
                <Bar
                  label="RAM"
                  caption={`${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`}
                  pct={(spark.metrics.ram.used / spark.metrics.ram.total) * 100}
                  color="var(--color-info)"
                />
              ) : null}
              <Bar label="GPU temp" caption={gpu.metricAvailability?.temperature === false ? "—" : fmtTemp(tempRaw)} pct={gpu.metricAvailability?.temperature === false ? 0 : (tempVal / tempMax) * 100} color={tempColor} />
              <Bar
                label="GPU power"
                caption={gpu.metricAvailability?.powerDraw === false ? "—" : `${power?.draw ?? 0} / ${gpu.metricAvailability?.powerLimit === false ? "—" : power?.limit ?? 0} W`}
                pct={gpu.metricAvailability?.powerDraw === false ? 0 : powerPct}
                color="var(--color-violet)"
              />
              {cpuTempRaw !== null ? (
                <Bar
                  label="CPU temp"
                  title={cpuMetrics?.temperatureLabel ? `Sensor: ${cpuMetrics.temperatureLabel}` : undefined}
                  caption={fmtTemp(cpuTempRaw)}
                  pct={(cpuTempVal / tempMax) * 100}
                  color={cpuTempColor}
                />
              ) : null}
              {cpuPower ? <Bar label="CPU power" caption={`${cpuPower.draw} / ${cpuPower.tdp} W`} pct={cpuPowerPct} color="var(--color-violet)" /> : null}
            </div>
          </div>
          {showLauncher ? <ModelLauncher spark={spark} onOpen={onSelect} busy={loadingHint} busyHolders={gpuHolders.length > 0} freeMb={memTotal > 0 ? memAvail : null} lowFreeMb={HEADROOM_THRESHOLDS_MB[memoryModelFor(spark.kind)].low} /> : null}
          {role === "worker" ? (
            <div className="ov-launch ov-launch--worker">
              <div className="eyebrow">Worker of</div>
              {headSpark ? (
                <AppLink
                  href={idToPath(headSpark.id)}
                  className="ov-launch__head"
                  onNavigate={() => onSelect?.(headSpark.id)}
                  title={`Open ${headSpark.name}`}
                >
                  <i className={`sdot ${headSpark.online ? "" : "sdot--off"}`} aria-hidden />
                  {headSpark.name}
                </AppLink>
              ) : (
                <div className="ov-launch__title">Head not set</div>
              )}
              <div className="ov-launch__hint">
                {headLlm
                  ? `${backendLabel(headLlm.backend) ?? headLlm.backend ?? "LLM"} · ${headLlm.measurementValid === false ? "—" : headLlm.generationTps.toFixed(1)} tok/s decode${headLlm.perStreamTps != null ? ` · ${headLlm.perStreamTps.toFixed(1)} per stream` : ""}${headLlm.perStreamPrefillTps != null ? ` · ${Math.round(headLlm.perStreamPrefillTps).toLocaleString()} prefill per request (effective, incl. cached)` : ""}`
                  : headSpark
                    ? headSpark.online
                      ? "No model loaded on the head"
                      : "Head is offline"
                    : "Pick its head in Edit Spark to see the model here"}
              </div>
            </div>
          ) : null}
          {showTps && llm ? (
            <div className="ov-tps">
              <div
                title={
                  isStrata
                    ? "Live sliding-window decode rate. When that window is unavailable, the active-slot mean sums each active slot’s generated tokens divided by its elapsed time since first token; it excludes prefill time."
                    : undefined
                }
              >
                <div className="eyebrow">Decode</div>
                {llm.measurementValid === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? "Stats could not be read"}>—</div>
                ) : isStrata && llm.decodeActive && llm.generationTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live">
                    <span className="ov-tps__dots" aria-hidden />
                    <small>decoding</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{llm.generationTps.toFixed(1)}<small>tok/s</small></div>
                )}
                {isStrata && llm.generationTpsSource === "slot-mean" && <small className="text-muted">active-slot mean</small>}
                {llm.measurementValid !== false && llm.perStreamTps != null && (
                  <small
                    className="text-muted"
                    title="Average decode throughput of one running stream (1 / mean seconds per output token). Only engines that publish a per-token latency histogram report it."
                  >
                    {llm.perStreamTps.toFixed(1)} tok/s per stream
                  </small>
                )}
              </div>
              <div
                title={
                  isStrata
                    ? "Engine-reported mean for computed/new prompt tokens. It may be from an earlier prefill and is not an aggregate across slots."
                    : undefined
                }
              >
                <div className="eyebrow">Prefill</div>
                {llm.measurementValid === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? "Stats could not be read"}>—</div>
                ) : llm.prefillActive && llm.prefillTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live" title={isStrata ? "A prompt is being processed; no current prefill rate is available." : "A prompt is being processed. The engine reports its speed only when the request finishes."}>
                    <span className="ov-tps__dots" aria-hidden />
                    <small>prefilling</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{Math.round(llm.prefillTps).toLocaleString()}<small>tok/s</small></div>
                )}
                {llm.measurementValid !== false && llm.perStreamPrefillTps != null && (
                  <small
                    className="text-muted"
                    title="Effective prefill rate of one request (prompt tokens ÷ prefill seconds over finished requests). The prompt counter includes prefix-cache tokens, so this is an effective speed, not raw GPU speed; it is held between completions."
                  >
                    {Math.round(llm.perStreamPrefillTps).toLocaleString()} tok/s per request — effective (incl. cached tokens)
                  </small>
                )}
                {isStrata && llm.prefillTps > 0 && <small className="text-muted">last reported mean</small>}
              </div>
            </div>
          ) : null}
          {chips}
          {rootDisk ? (
            <div className="ov-foot">
              <div className="ov-kv">
                <span>Storage</span>
                <b
                  className="mono"
                  title={`${fmtStorage(rootDisk.used, true)} of ${fmtStorage(rootDisk.total, true)} used (${Math.round(rootDisk.percentage)}%)`}
                >
                  {formatDiskSize(rootDisk.used)} / {formatDiskSize(rootDisk.total)}
                </b>
              </div>
              <div className="ov-kv">
                <span>Storage available</span>
                <b className="mono">{fmtStorage(rootDisk.available ?? Math.max(0, rootDisk.total - rootDisk.used), true)}</b>
              </div>
            </div>
          ) : null}
          {modelText ? (
            <div className="ov-modelrow" title={modelTitle}>
              <code>{modelText}</code>
              {modelEyebrowRight ? <span className="ov-modelrow__ctx">{modelEyebrowRight}</span> : null}
            </div>
          ) : (
            // Nothing to show, but keep the row's height so Storage lines up across the cards.
            <div className="ov-modelrow ov-modelrow--empty" aria-hidden="true">
              <code>{"\u00a0"}</code>
            </div>
          )}
          {online && role !== "worker" && [...new Set([
            ...llmList.filter((entry) => entry.available).flatMap((entry) => entry.models?.length ? entry.models : entry.modelId ? [entry.modelId] : []),
            ...(spark.metrics.residentModels ?? []).map((entry) => entry.modelId),
          ])].filter((name) => name !== modelText).map((name) => (
            <div className="ov-modelrow" key={name} title={`${name} · loaded model; throughput shown for the monitored endpoint above`}>
              <code>{name}</code>
              <span className="ov-modelrow__ctx">Loaded</span>
            </div>
          ))}
        </>
      )}

    </div>
  );
}

/** Memoised: the Overview re-renders on every keystroke in its search and on each snapshot. */
export const SparkCard = memo(SparkCardImpl);
