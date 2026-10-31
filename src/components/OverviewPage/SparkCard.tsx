import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GpuDevice, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { usableHead } from "../../shared/sparkHead";
import { wakeSpark } from "../../api/client";
import { backendLabel } from "../../shared/llmBackends";
import { formatDiskSize, formatMb } from "../../shared/formatBytes";
import { shortProcessName } from "../../shared/processName";
import { shortGpuName } from "../../shared/gpuName";
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
type WakeMessage = "sent" | "failed" | { raw: string } | null;

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
  /** Small line under the bar, e.g. available memory; `warn` marks its label (a hot card). */
  sub?: { label: string; value: string; warn?: boolean } | null;
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
          <span className={sub.warn ? "ov-sub__warn" : undefined}>{sub.label}</span>
          <b className="mono">{sub.value}</b>
        </div>
      ) : null}
    </div>
  );
}

/** One card of a multi-GPU host: its VRAM bar ("GPU 0 VRAM"), with its load, temperature and power on the line under it. */
function GpuCardBar({ card, fmtTemp }: { card: GpuDevice; fmtTemp: (c: number) => string }) {
  const { t } = useTranslation("overview");
  const avail = card.metricAvailability;
  const vramKnown = avail?.vramUsed !== false && avail?.vramTotal !== false && card.vram.total > 0;
  const vramPct = card.vram.percentage;
  const hot = !!(card.throttle?.thermal || card.throttle?.hwSlowdown) || card.temperature >= 80;
  const load = [
    avail?.usage === false ? t("card.loadUnavailable") : t("card.load", { value: Math.round(card.usage) }),
    avail?.temperature === false ? null : fmtTemp(card.temperature),
  ]
    .filter(Boolean)
    .join(" · ");
  const power =
    avail?.powerDraw === false ? "—" : `${Math.round(card.power.draw)}${avail?.powerLimit === false ? "" : ` / ${Math.round(card.power.limit)}`} W`;
  return (
    <Bar
      label={t("card.gpuVram", { index: card.physicalIndex ?? card.index })}
      title={shortGpuName(card.name) || undefined}
      caption={vramKnown ? `${fmtStorage(card.vram.used, false)} / ${fmtStorage(card.vram.total, true)}` : "—"}
      pct={vramKnown ? vramPct : 0}
      color={vramPct >= 90 ? "var(--color-danger)" : vramPct >= 85 ? "var(--color-warning)" : "var(--color-info)"}
      sub={{ label: load, value: power, warn: hot }}
    />
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
  const { t } = useTranslation("overview");
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;
  const role = resolveSparkRole(spark);
  const llmList = Array.isArray(spark.metrics.llm) ? spark.metrics.llm : [];
  const llmIdx = llmList.findIndex((l) => l.available);
  const llm = llmIdx >= 0 ? llmList[llmIdx] : null;
  const [wakeMsg, setWakeMsg] = useState<WakeMessage>(null);
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
  // A multi-card host gets one bar per card (its VRAM, with load, temperature and power under it) in place of
  // the GPU rows: the aggregate is the busiest card's usage and the summed VRAM, which hides a model split
  // unevenly across cards (or one card sitting idle).
  const cards = gpu?.gpus && gpu.gpus.length > 1 ? gpu.gpus : null;

  const rootDisk =
    spark.metrics.storage.find((d) => d.label === "/") ?? spark.metrics.storage.find((d) => d.device === "nvme0n1p2");

  const comfy = spark.comfyMonitoring ? spark.metrics?.comfy : undefined;
  const hermes = spark.hermes;

  const roleText = role === "head" ? t("card.roleHead") : role === "worker" ? t("card.roleWorker") : t("card.roleStandalone");
  const roleTitle =
    role === "head"
      ? t("card.clusterHead")
      : role === "worker"
        ? spark.workerLabel?.trim()
          ? t("card.distributedWorkerNamed", { label: spark.workerLabel.trim() })
          : t("card.distributedWorker")
        : spark.llmMonitoring === false
          ? t("card.standaloneMonitoringOff")
          : t("card.standaloneSpark");

  async function onWake() {
    setWaking(true);
    setWakeMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setWakeMsg(res.success ? "sent" : res.error || res.message ? { raw: res.error || res.message! } : "failed");
    } catch (err) {
      setWakeMsg(err instanceof Error ? { raw: err.message } : "failed");
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
  // Why the head reports no model, without asserting that none is loaded: a head
  // that is cold-starting, switching model or simply not monitored produces the same
  // empty probe state as an idle one, so its readiness is unknown, not established.
  const headState = !headName
    ? t("card.worker")
    : !headSpark?.online
      ? t("card.headOffline")
      : headLlmList.length
        ? t("card.headApiNotReady")
        : t("card.noHeadLlmPort");
  if (role === "worker") {
    // Prefer the head's live model; fall back to the configured / mirrored worker label.
    const label = headLlm?.modelId || spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null;
    modelEyebrowRight = headLlm ? formatCtx(headLlm.contextLength) : null;
    modelText = label ?? headState;
    modelTitle = headName ? t("card.workerOf", { label: label ?? headState, head: headName }) : t("card.llmWorker", { label: label ?? t("card.distributed") });
  } else if (llm) {
    // The engine name lives in the tooltip; the row itself is just model + context.
    const engine = backendLabel(llm.backend) ?? llm.backend ?? "LLM";
    modelEyebrowRight = formatCtx(llm.contextLength);
    modelText = llm.modelId ?? t("card.unknown");
    modelTitle = llm.modelId ? `${llm.modelId} · ${engine}` : engine;
  }
  // Idle Spark (nothing serving): the launcher block fills the free space instead.
  // Memory or compute in use while nothing serves yet: a model is most likely still loading.
  // When nvidia-smi names the processes holding the GPU, say so: it may be a server sparkDash does not
  // monitor (add its port under "+ Add LLM port"), not a model that is still starting.
  const gpuHolders = (gpu?.processes ?? [])
    .filter((p) => p.vramMB > 0)
    .slice(0, 3)
    .map((p) => `${shortProcessName(p.name)} (${formatMb(p.vramMB)})`);
  const loadingHint =
    !llm && (memUsed >= 2048 || usage >= 10)
      ? gpuHolders.length > 0
        ? t("card.vramInUseWithHolders", { holders: gpuHolders.join(", "), memory: formatMb(memUsed), usage: Math.round(usage) })
        : t("card.vramInUse", { memory: formatMb(memUsed), usage: Math.round(usage) })
      : null;
  const showLauncher = role !== "worker" && !llm && !spark.llmMovedTo && spark.llmMonitoring !== false && spark.platform !== "windows";

  const showTps = role !== "worker" && !!llm;
  const isStrata = llm?.backend === "strata";
  // Engines that report requests (TensorFold, Strata, …) used to hide their parallelism behind
  // "N running": a unit set to --parallel 4 and one set to 8 read the same. Name the capacity too.
  const parallel = llm && llm.slotsTotal > 0 ? llm.slotsTotal : null;
  const llmChip = llm
    ? llm.requestsRunning != null
      ? t("card.requestStatus", { running: llm.requestsRunning, waiting: llm.requestsWaiting == null ? t("card.queueUnknown") : t("card.queued", { count: llm.requestsWaiting }), slots: parallel == null ? "" : t("card.slots", { count: parallel }) })
      : llm.slotsTotal > 0
        ? t("card.activeSlots", { active: llm.slotsActive ?? "?", total: llm.slotsTotal })
        : null
    : null;
  const llmChipTitle =
    parallel != null && llm?.requestsRunning != null ? t("card.parallelRequests", { count: parallel }) : undefined;

  const chips = (
    <div className="ov-chips">
      {online && throttle && slowed ? (
        <Tag tone="warn" title={throttle.detail || t("card.gpuClockThrottled")}>
          {throttle.thermal ? t("card.thermalThrottle") : t("card.hardwareSlowdown")}
          {throttle.smClockMHz ? ` · SM ${(throttle.smClockMHz / 1000).toFixed(1)} GHz` : ""}
        </Tag>
      ) : null}
      {online && throttle?.clockCapMHz != null ? (
        <Tag title={t("card.gpuClockLocked")}>
          {t("card.clockCap", { value: (throttle.clockCapMHz / 1000).toFixed(1) })}
        </Tag>
      ) : null}
      {online && llmChip ? <Tag tone={(llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0 ? "good" : "neutral"} title={llmChipTitle}>{llmChip}</Tag> : null}
      {comfy !== undefined || spark.comfyMonitoring ? (
        !comfy?.available ? (
          <Tag title={t("card.comfyUnavailable")}>Comfy</Tag>
        ) : (comfy.queueRunning ?? 0) > 0 ? (
          <Tag tone="info" title={comfy.activeJob?.title ? t("card.comfyRunningTitle", { title: comfy.activeJob.title }) : t("card.comfyJobRunning")}>
            <ImageIcon className="h-3.5 w-3.5" />
            {comfy.activeJob?.title ? t("card.comfyRunningTitle", { title: comfy.activeJob.title }) : t("card.comfyRunning")}
            {comfy.progress?.percent != null ? ` ${Math.round(comfy.progress.percent)}%` : ""}
          </Tag>
        ) : (comfy.queuePending ?? 0) > 0 ? (
          <Tag tone="warn" title={t("card.comfyQueue", { count: comfy.queuePending })}>Comfy {"·"} {comfy.queuePending}q</Tag>
        ) : (
          <Tag title={t("card.comfyIdle")}>Comfy {"·"} {t("card.idle")}</Tag>
        )
      ) : null}
      {hermes?.monitoring && hermes.status === "running" ? <Tag tone="info">{t("card.hermesUpdating")}</Tag> : null}
      {hermes?.monitoring && hermes.status !== "running" && hermes.updateAvailable ? (
        <Tag tone="acc" title={t("card.hermesUpdateAvailable")}>{t("card.hermesUpdateAvailable")}</Tag>
      ) : null}
      {!online ? <Tag>{t("card.offline")}</Tag> : null}
    </div>
  );

  return (
    <div className={`overview-card ov-sc ${online ? "" : "is-off"} ${hot && online ? "is-hot" : ""} ${online && worstSeverity(spark.health) ? `is-health-${worstSeverity(spark.health)}` : ""} ${onSelect ? "is-link" : ""}`}>
      <div className="ov-sc__head">
        <i className={`sdot ${!online ? "sdot--off" : hot || worstSeverity(spark.health) ? "sdot--warn" : ""}`} aria-label={online ? t("card.online") : t("card.offline")} />
        <h3 className="ov-sc__name">
          {onSelect ? (
            // Stretched link: this button's ::after covers the whole card (overview.css), so the card
            // is clickable without being a button that contains buttons.
            <AppLink href={idToPath(spark.id)} className="ov-sc__link" onNavigate={() => onSelect(spark.id)} title={t("card.openSpark", { name: spark.name })}>
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
          <span>{online ? t("card.waitingForMetrics") : t("card.hostUnreachable")}</span>
          {!online && spark.kind === "host" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={waking}
              onClick={() => void onWake()}
            >
              <PowerOnIcon className="h-3.5 w-3.5" />
              {t("card.wakeUp")}
            </button>
          ) : null}
          {wakeMsg ? <span className="ov-sc__msg">{wakeMsg === "sent" ? t("card.wakePacketSent") : wakeMsg === "failed" ? t("card.wakeFailed") : wakeMsg.raw}</span> : null}
          {chips}
        </div>
      ) : (
        <>
          <div className="ov-sc__body">
            <div className="ov-sc__stats">
              {cards ? (
                cards.map((card) => <GpuCardBar key={card.index} card={card} fmtTemp={fmtTemp} />)
              ) : breakdown ? (
                <VramBreakdownBar
                  label={breakdown.systemMB != null ? t("memory.unifiedMemory") : t("memory.vram")}
                  breakdown={breakdown}
                  showLegend
                />
              ) : (
                <Bar
                  label={gpu.vram?.total ? t("memory.vram") : t("memory.unifiedMemory")}
                  caption={vramAvailable && memTotal > 0 ? `${fmtStorage(memUsed, false)} / ${fmtStorage(memTotal, true)}` : "—"}
                  pct={vramAvailable ? memPct : 0}
                  color={memColor}
                  sub={memTotal > 0 && memAvail > 0 ? { label: t("card.available"), value: formatMb(memAvail) } : null}
                />
              )}
              {cards ? null : (
                <Bar label={t("card.gpu")} caption={gpu.metricAvailability?.usage === false ? "—" : `${Math.round(usage)}%`} pct={gpu.metricAvailability?.usage === false ? 0 : usage} color={ringColor} />
              )}
              {spark.kind === "host" && spark.metrics.ram?.total ? (
                <Bar
                  label={t("card.ram")}
                  caption={`${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`}
                  pct={(spark.metrics.ram.used / spark.metrics.ram.total) * 100}
                  color="var(--color-info)"
                />
              ) : null}
              {cards ? null : (
                <>
                  <Bar label={t("card.gpuTemp")} caption={gpu.metricAvailability?.temperature === false ? "—" : fmtTemp(tempRaw)} pct={gpu.metricAvailability?.temperature === false ? 0 : (tempVal / tempMax) * 100} color={tempColor} />
                  <Bar
                    label={t("card.gpuPower")}
                    caption={gpu.metricAvailability?.powerDraw === false ? "—" : `${power?.draw ?? 0} / ${gpu.metricAvailability?.powerLimit === false ? "—" : power?.limit ?? 0} W`}
                    pct={gpu.metricAvailability?.powerDraw === false ? 0 : powerPct}
                    color="var(--color-violet)"
                  />
                </>
              )}
              {cpuTempRaw !== null ? (
                <Bar
                  label={t("card.cpuTemp")}
                  title={cpuMetrics?.temperatureLabel ? t("card.sensor", { name: cpuMetrics.temperatureLabel }) : undefined}
                  caption={fmtTemp(cpuTempRaw)}
                  pct={(cpuTempVal / tempMax) * 100}
                  color={cpuTempColor}
                />
              ) : null}
              {cpuPower ? <Bar label={t("card.cpuPower")} caption={`${cpuPower.draw} / ${cpuPower.tdp} W`} pct={cpuPowerPct} color="var(--color-violet)" /> : null}
            </div>
          </div>
          {showLauncher ? <ModelLauncher spark={spark} onOpen={onSelect} busy={loadingHint} busyHolders={gpuHolders.length > 0} freeMb={memTotal > 0 ? memAvail : null} lowFreeMb={HEADROOM_THRESHOLDS_MB[memoryModelFor(spark.kind, spark.platform)].low} /> : null}
          {role === "worker" ? (
            <div className="ov-launch ov-launch--worker">
              <div className="eyebrow">{t("card.workerOfLabel")}</div>
              {headSpark ? (
                <AppLink
                  href={idToPath(headSpark.id)}
                  className="ov-launch__head"
                  onNavigate={() => onSelect?.(headSpark.id)}
                  title={t("card.openSpark", { name: headSpark.name })}
                >
                  <i className={`sdot ${headSpark.online ? "" : "sdot--off"}`} aria-hidden />
                  {headSpark.name}
                </AppLink>
              ) : (
                <div className="ov-launch__title">{t("card.headNotSet")}</div>
              )}
              <div className="ov-launch__hint">
                {headLlm
                  ? t("card.workerHeadThroughput", {
                      backend: backendLabel(headLlm.backend) ?? headLlm.backend ?? "LLM",
                      decode: headLlm.measurementValid === false ? "—" : headLlm.generationTps.toFixed(1),
                      perStream: headLlm.perStreamTps == null ? "" : t("card.workerHeadPerStream", { value: headLlm.perStreamTps.toFixed(1) }),
                      prefill: headLlm.perStreamPrefillTps == null ? "" : t("card.workerHeadPrefill", { value: Math.round(headLlm.perStreamPrefillTps).toLocaleString() }),
                    })
                  : headSpark
                    ? headSpark.online
                      ? headLlmList.length
                        ? t("card.headInferenceNotReady")
                        : t("card.noHeadLlmPortHint")
                      : t("card.headOfflineHint")
                    : t("card.pickHead")}
              </div>
            </div>
          ) : null}
          {role !== "worker" && spark.llmMovedTo ? (
            <div className="ov-launch ov-launch--moved" title={spark.llmMovedTo.message}>
              <div className="eyebrow">{t("card.engineOnWorker")}</div>
              <div className="ov-launch__hint">
                {t("card.workerAnswersOnPort", { name: spark.llmMovedTo.workerName, port: spark.llmMovedTo.port })}
                {spark.llmMovedTo.modelId ? ` · ${spark.llmMovedTo.modelId}` : ""} {t("card.headDoesNotAnswer")}
                {t("card.engineMayHaveMoved")}
              </div>
            </div>
          ) : null}
          {showTps && llm ? (
            <div className="ov-tps">
              <div
                title={
                  isStrata
                    ? t("card.decodeStrataHelp")
                    : undefined
                }
              >
                <div className="eyebrow">{t("card.decode")}</div>
                {llm.measurementValid === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? t("card.statsCouldNotBeRead")}>—</div>
                ) : isStrata && llm.decodeActive && llm.generationTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live">
                    <span className="ov-tps__dots" aria-hidden />
                    <small>{t("card.decoding")}</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{llm.generationTps.toFixed(1)}<small>{t("card.tokPerSecond")}</small></div>
                )}
                {isStrata && llm.generationTpsSource === "slot-mean" && <small className="text-muted">{t("card.activeSlotMean")}</small>}
                {llm.measurementValid !== false && llm.perStreamTps != null && (
                  <small
                    className="text-muted"
                    title={t("card.perStreamDecodeHelp")}
                  >
                    {t("card.tokPerSecondPerStream", { value: llm.perStreamTps.toFixed(1) })}
                  </small>
                )}
              </div>
              <div
                title={
                  isStrata
                    ? t("card.prefillStrataHelp")
                    : undefined
                }
              >
                <div className="eyebrow">{t("card.prefill")}</div>
                {llm.measurementValid === false ? (
                  <div className="big-num ov-tps__num" title={llm.measurementError ?? t("card.statsCouldNotBeRead")}>—</div>
                ) : llm.prefillActive && llm.prefillTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live" title={isStrata ? t("card.prefillProcessingStrata") : t("card.prefillProcessing")}>
                    <span className="ov-tps__dots" aria-hidden />
                    <small>{t("card.prefilling")}</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{Math.round(llm.prefillTps).toLocaleString()}<small>{t("card.tokPerSecond")}</small></div>
                )}
                {llm.measurementValid !== false && llm.perStreamPrefillTps != null && (
                  <small
                    className="text-muted"
                    title={t("card.perRequestPrefillHelp")}
                  >
                    {t("card.tokPerSecondPerRequestEffective", { value: Math.round(llm.perStreamPrefillTps).toLocaleString() })}
                  </small>
                )}
                {isStrata && llm.prefillTps > 0 && <small className="text-muted">{t("card.lastReportedMean")}</small>}
              </div>
            </div>
          ) : null}
          {chips}
          {rootDisk ? (
            <div className="ov-foot">
              <div className="ov-kv">
                <span>{t("card.storage")}</span>
                <b
                  className="mono"
                  title={t("card.storageUsed", { used: fmtStorage(rootDisk.used, true), total: fmtStorage(rootDisk.total, true), percentage: Math.round(rootDisk.percentage) })}
                >
                  {formatDiskSize(rootDisk.used)} / {formatDiskSize(rootDisk.total)}
                </b>
              </div>
              <div className="ov-kv">
                <span>{t("card.storageAvailable")}</span>
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
            <div className="ov-modelrow" key={name} title={t("card.loadedModelTitle", { name })}>
              <code>{name}</code>
              <span className="ov-modelrow__ctx">{t("card.loaded")}</span>
            </div>
          ))}
        </>
      )}

    </div>
  );
}

/** Memoised: the Overview re-renders on every keystroke in its search and on each snapshot. */
export const SparkCard = memo(SparkCardImpl);
