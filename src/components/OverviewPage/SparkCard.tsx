import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { computeVramBreakdown, type VramBreakdownContext } from "../../shared/vramBreakdown";
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
  const { t } = useTranslation();
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
  const breakdown = gpu && vramContext ? computeVramBreakdown(gpu.vram, gpu.processes, vramContext) : null;
  const throttle = gpu?.throttle;
  const slowed = !!(throttle?.thermal || throttle?.hwSlowdown);
  const hot = slowed || tempRaw >= 80;

  const ringColor = hot ? "var(--color-warning)" : "var(--color-accent)";
  const memColor = memPct >= 90 ? "var(--color-danger)" : memPct >= 85 ? "var(--color-warning)" : "var(--color-info)";
  const tempColor = tempRaw > 80 ? "var(--color-danger)" : tempRaw >= 75 ? "var(--color-warning)" : "var(--color-success)";
  const power = gpu?.power;
  const powerPct = power && power.limit > 0 ? (power.draw / power.limit) * 100 : 0;

  const rootDisk =
    spark.metrics.storage.find((d) => d.label === "/") ?? spark.metrics.storage.find((d) => d.device === "nvme0n1p2");

  const comfy = spark.comfyMonitoring ? spark.metrics?.comfy : undefined;
  const hermes = spark.hermes;

  const roleText =
    role === "head"
      ? t("overview.card.roleHead", "head")
      : role === "worker"
        ? t("overview.card.roleWorker", "worker")
        : t("overview.card.roleStandalone", "standalone");
  const roleTitle =
    role === "head"
      ? t("overview.card.roleHeadTitle", "Cluster head Spark")
      : role === "worker"
        ? spark.workerLabel?.trim()
          ? t("overview.card.roleWorkerLabeled", "{label} · distributed LLM worker", { label: spark.workerLabel.trim() })
          : t("overview.card.roleWorkerTitle", "Distributed LLM worker")
        : spark.llmMonitoring === false
          ? t("overview.card.roleStandaloneNoLlm", "Standalone — LLM monitoring off")
          : t("overview.card.roleStandaloneTitle", "Standalone Spark");

  async function onWake() {
    setWaking(true);
    setWakeMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setWakeMsg(res.success ? t("overview.card.wakeSent", "Wake packet sent") : res.error || res.message || t("overview.card.wakeFailed", "Wake failed"));
    } catch (err) {
      setWakeMsg(err instanceof Error ? err.message : t("overview.card.wakeFailed", "Wake failed"));
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
    modelText = label ?? (headName ? t("overview.card.noModelOnHead", "No model on head") : t("overview.card.worker", "Worker"));
    modelTitle = headName
      ? t("overview.card.workerTitle", "{label} · worker of {head}", { label: label ?? t("overview.card.noModel", "No model"), head: headName })
      : t("overview.card.workerTitleStandalone", "{label} · LLM worker", { label: label ?? t("overview.card.distributed", "Distributed") });
  } else if (llm) {
    // The engine name lives in the tooltip; the row itself is just model + context.
    const engine = backendLabel(llm.backend) ?? llm.backend ?? "LLM";
    modelEyebrowRight = formatCtx(llm.contextLength);
    modelText = llm.modelId ?? t("overview.card.unknown", "unknown");
    modelTitle = llm.modelId
      ? t("overview.card.modelTitle", "{model} · {engine}", { model: llm.modelId, engine })
      : engine;
  }
  // Idle Spark (nothing serving): the launcher block fills the free space instead.
  // Memory or compute in use while nothing serves yet: a model is most likely still loading.
  const loadingHint =
    !llm && (memUsed >= 2048 || usage >= 10)
      ? t("overview.card.loadingHint", "{size} VRAM in use · GPU {pct}%", { size: formatMb(memUsed), pct: Math.round(usage) })
      : null;
  const showLauncher = role !== "worker" && !llm && spark.llmMonitoring !== false;

  const showTps = role !== "worker" && !!llm;
  const llmChip = llm
    ? llm.requestsRunning != null
      ? t("overview.card.runningQueued", "{running} running · {queued} queued", { running: llm.requestsRunning, queued: llm.requestsWaiting ?? 0 })
      : llm.slotsTotal > 0
        ? t("overview.card.slots", "{active}/{total} slots", { active: llm.slotsActive, total: llm.slotsTotal })
        : null
    : null;

  const chips = (
    <div className="ov-chips">
      {online && throttle && slowed ? (
        <Tag tone="warn" title={throttle.detail || t("overview.card.throttleTitle", "GPU clock throttled")}>
          {throttle.thermal ? t("overview.card.throttleThermal", "Thermal throttle") : t("overview.card.hwSlowdown", "HW slowdown")}
          {throttle.smClockMHz ? t("overview.card.smClock", " · SM {ghz} GHz", { ghz: (throttle.smClockMHz / 1000).toFixed(1) }) : ""}
        </Tag>
      ) : null}
      {online && llmChip ? <Tag tone={(llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0 ? "good" : "neutral"}>{llmChip}</Tag> : null}
      {comfy !== undefined || spark.comfyMonitoring ? (
        !comfy?.available ? (
          <Tag title={t("overview.card.comfyNotReachable", "ComfyUI monitoring on — not reachable")}>Comfy</Tag>
        ) : (comfy.queueRunning ?? 0) > 0 ? (
          <Tag tone="info" title={comfy.activeJob?.title ? t("overview.card.comfyRunningNamed", "ComfyUI running: {title}", { title: comfy.activeJob.title }) : t("overview.card.comfyRunningTitle", "ComfyUI job running")}>
            <ImageIcon className="h-3.5 w-3.5" />
            {comfy.activeJob?.title ? t("overview.card.comfyRunningNamed", "ComfyUI running: {title}", { title: comfy.activeJob.title }) : t("overview.card.comfyRunning", "ComfyUI · running")}
            {comfy.progress?.percent != null ? ` ${Math.round(comfy.progress.percent)}%` : ""}
          </Tag>
        ) : (comfy.queuePending ?? 0) > 0 ? (
          <Tag tone="warn" title={t("overview.card.comfyQueuedTitle", "ComfyUI queue: {pending} pending", { pending: comfy.queuePending })}>
            {t("overview.card.comfyQueued", "Comfy · {pending}q", { pending: comfy.queuePending })}
          </Tag>
        ) : (
          <Tag title={t("overview.card.comfyIdleTitle", "ComfyUI idle")}>{t("overview.card.comfyIdle", "Comfy · idle")}</Tag>
        )
      ) : null}
      {hermes?.monitoring && hermes.status === "running" ? <Tag tone="info">{t("overview.card.hermesUpdating", "Hermes updating")}</Tag> : null}
      {hermes?.monitoring && hermes.status !== "running" && hermes.updateAvailable ? (
        <Tag tone="acc" title={t("overview.card.hermesAvailableTitle", "A Hermes update is available")}>{t("overview.card.hermesAvailable", "Hermes update available")}</Tag>
      ) : null}
      {!online ? <Tag>{t("overview.card.offline", "Offline")}</Tag> : null}
    </div>
  );

  return (
    <div className={`overview-card ov-sc ${online ? "" : "is-off"} ${hot && online ? "is-hot" : ""} ${online && worstSeverity(spark.health) ? `is-health-${worstSeverity(spark.health)}` : ""} ${onSelect ? "is-link" : ""}`}>
      <div className="ov-sc__head">
        <i className={`sdot ${!online ? "sdot--off" : hot || worstSeverity(spark.health) ? "sdot--warn" : ""}`} aria-label={online ? t("overview.card.onlineAria", "online") : t("overview.card.offlineAria", "offline")} />
        <h3 className="ov-sc__name">
          {onSelect ? (
            // Stretched link: this button's ::after covers the whole card (overview.css), so the card
            // is clickable without being a button that contains buttons.
            <AppLink href={idToPath(spark.id)} className="ov-sc__link" onNavigate={() => onSelect(spark.id)} title={t("overview.card.openTitle", "Open {name}", { name: spark.name })}>
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
          <span>{online ? t("overview.card.waitingMetrics", "Waiting for metrics…") : t("overview.card.hostUnreachable", "Host unreachable")}</span>
          {!online && spark.kind === "host" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={waking}
              onClick={() => void onWake()}
            >
              <PowerOnIcon className="h-3.5 w-3.5" />
              {t("overview.card.wakeUp", "Wake up")}
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
                  label={breakdown.systemMB != null ? t("overview.card.unifiedMemory", "Unified memory") : t("overview.card.vram", "VRAM")}
                  breakdown={breakdown}
                  showLegend
                />
              ) : (
                <Bar
                  label={gpu.vram?.total ? t("overview.card.vram", "VRAM") : t("overview.card.unifiedMemory", "Unified memory")}
                  caption={memTotal > 0 ? `${fmtStorage(memUsed, false)} / ${fmtStorage(memTotal, true)}` : "—"}
                  pct={memPct}
                  color={memColor}
                  sub={memTotal > 0 && memAvail > 0 ? { label: t("overview.card.available", "Available"), value: formatMb(memAvail) } : null}
                />
              )}
              <Bar label={t("overview.card.gpu", "GPU")} caption={`${Math.round(usage)}%`} pct={usage} color={ringColor} />
              {spark.kind === "host" && spark.metrics.ram?.total ? (
                <Bar
                  label={t("overview.card.ram", "RAM")}
                  caption={`${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`}
                  pct={(spark.metrics.ram.used / spark.metrics.ram.total) * 100}
                  color="var(--color-info)"
                />
              ) : null}
              <Bar label={t("overview.card.gpuTemp", "GPU temp")} caption={fmtTemp(tempRaw)} pct={(tempVal / tempMax) * 100} color={tempColor} />
              <Bar
                label={t("overview.card.gpuPower", "GPU power")}
                caption={`${power?.draw ?? 0} / ${power?.limit ?? 0} W`}
                pct={powerPct}
                color="var(--color-violet)"
              />
            </div>
          </div>
          {showLauncher ? <ModelLauncher spark={spark} onOpen={onSelect} busy={loadingHint} /> : null}
          {role === "worker" ? (
            <div className="ov-launch ov-launch--worker">
              <div className="eyebrow">{t("overview.card.workerOf", "Worker of")}</div>
              {headSpark ? (
                <AppLink
                  href={idToPath(headSpark.id)}
                  className="ov-launch__head"
                  onNavigate={() => onSelect?.(headSpark.id)}
                  title={t("overview.card.openTitle", "Open {name}", { name: headSpark.name })}
                >
                  <i className={`sdot ${headSpark.online ? "" : "sdot--off"}`} aria-hidden />
                  {headSpark.name}
                </AppLink>
              ) : (
                <div className="ov-launch__title">{t("overview.card.headNotSet", "Head not set")}</div>
              )}
              <div className="ov-launch__hint">
                {headLlm
                  ? `${backendLabel(headLlm.backend) ?? headLlm.backend ?? "LLM"} · ${headLlm.generationTps.toFixed(1)} tok/s decode`
                  : headSpark
                    ? headSpark.online
                      ? t("overview.card.headNoModel", "No model loaded on the head")
                      : t("overview.card.headOffline", "Head is offline")
                    : t("overview.card.pickHead", "Pick its head in Edit Spark to see the model here")}
              </div>
            </div>
          ) : null}
          {showTps && llm ? (
            <div className="ov-tps">
              <div>
                <div className="eyebrow">{t("overview.card.decode", "Decode")}</div>
                <div className="big-num ov-tps__num">{llm.generationTps.toFixed(1)}<small>{t("overview.card.tps", "tok/s")}</small></div>
              </div>
              <div>
                <div className="eyebrow">{t("overview.card.prefill", "Prefill")}</div>
                {llm.prefillActive && llm.prefillTps <= 0 ? (
                  <div className="big-num ov-tps__num ov-tps__num--live" title={t("overview.card.prefillTitle", "A prompt is being processed. The engine reports its speed only when the request finishes.")}>
                    <span className="ov-tps__dots" aria-hidden />
                    <small>{t("overview.card.prefilling", "prefilling")}</small>
                  </div>
                ) : (
                  <div className="big-num ov-tps__num">{Math.round(llm.prefillTps).toLocaleString()}<small>{t("overview.card.tps", "tok/s")}</small></div>
                )}
              </div>
            </div>
          ) : null}
          {chips}
          {rootDisk ? (
            <div className="ov-foot">
              <div className="ov-kv">
                <span>{t("overview.card.storage", "Storage")}</span>
                <b
                  className="mono"
                  title={t("overview.card.storageTitle", "{used} of {total} used ({pct}%)", {
                    used: fmtStorage(rootDisk.used, true),
                    total: fmtStorage(rootDisk.total, true),
                    pct: Math.round(rootDisk.percentage),
                  })}
                >
                  {formatDiskSize(rootDisk.used)} / {formatDiskSize(rootDisk.total)}
                </b>
              </div>
              <div className="ov-kv">
                <span>{t("overview.card.storageAvailable", "Storage available")}</span>
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
        </>
      )}

    </div>
  );
}

/** Memoised: the Overview re-renders on every keystroke in its search and on each snapshot. */
export const SparkCard = memo(SparkCardImpl);
