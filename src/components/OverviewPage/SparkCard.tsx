import { useState, type KeyboardEvent } from "react";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { wakeSpark } from "../../api/client";
import { backendLabel } from "../../shared/llmBackends";
import { formatMb } from "../../shared/formatBytes";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { Tag } from "../ui/Tag";
import { TrendLine } from "../ui/TrendLine";
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

export function SparkCard({
  spark,
  headSpark,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  /** The head this worker serves for (workers only). */
  headSpark?: SparkSnapshot | null;
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
  const portKey = spark.llmPorts?.[llmIdx] != null ? spark.llmPorts[llmIdx] : Math.max(0, llmIdx);
  const decodeTrend = useMetricsHistoryTail(spark.id, `llm:${portKey}.tps`);
  const prefillTrend = useMetricsHistoryTail(spark.id, `llm:${portKey}.prefill`);
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

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.(spark.id);
    }
  }

  // Model box content: workers show their label, others the live backend + model.
  let modelEyebrowRight: string | null = null;
  let modelText: string | null = null;
  let modelTitle: string | undefined;
  const headName = headSpark?.name ?? null;
  const headLlmList = Array.isArray(headSpark?.metrics.llm) ? headSpark.metrics.llm : [];
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
  const loadingHint =
    !llm && (memUsed >= 2048 || usage >= 10)
      ? `${formatMb(memUsed)} VRAM in use · GPU ${Math.round(usage)}%`
      : null;
  const showLauncher = role !== "worker" && !llm && spark.llmMonitoring !== false;

  const showTps = role !== "worker" && !!llm;
  const llmChip = llm
    ? llm.requestsRunning != null
      ? `${llm.requestsRunning} running · ${llm.requestsWaiting ?? 0} queued`
      : llm.slotsTotal > 0
        ? `${llm.slotsActive}/${llm.slotsTotal} slots`
        : null
    : null;

  const chips = (
    <div className="ov-chips">
      {online && throttle && slowed ? (
        <Tag tone="warn" title={throttle.detail || "GPU clock throttled"}>
          {throttle.thermal ? "Thermal throttle" : "HW slowdown"}
          {throttle.smClockMHz ? ` · SM ${(throttle.smClockMHz / 1000).toFixed(1)} GHz` : ""}
        </Tag>
      ) : null}
      {online && llmChip ? <Tag tone={(llm?.requestsRunning ?? llm?.slotsActive ?? 0) > 0 ? "good" : "neutral"}>{llmChip}</Tag> : null}
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
    <div
      className={`overview-card ov-sc ${online ? "" : "is-off"} ${hot && online ? "is-hot" : ""} ${onSelect ? "is-link" : ""}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `Open ${spark.name}` : undefined}
      onClick={onSelect ? () => onSelect(spark.id) : undefined}
      onKeyDown={onSelect ? onKey : undefined}
    >
      <div className="ov-sc__head">
        <i className={`sdot ${!online ? "sdot--off" : hot ? "sdot--warn" : ""}`} aria-label={online ? "online" : "offline"} />
        <h3 className="ov-sc__name">{spark.name}</h3>
        <Tag tone={role === "head" ? "acc" : "neutral"} title={roleTitle}>{roleText}</Tag>
        {spark.lanIp ? <span className="ov-sc__ip mono">{spark.lanIp}</span> : null}
      </div>

      {!online || !gpu ? (
        <div className="ov-sc__off">
          <span>{online ? "Waiting for metrics…" : "Host unreachable"}</span>
          {!online && spark.kind === "host" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={waking}
              onClick={(e) => {
                e.stopPropagation();
                void onWake();
              }}
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
              <Bar
                label={gpu.vram?.total ? "VRAM" : "Unified memory"}
                caption={memTotal > 0 ? `${fmtStorage(memUsed, false)} / ${fmtStorage(memTotal, true)}` : "—"}
                pct={memPct}
                color={memColor}
                sub={memTotal > 0 && memAvail > 0 ? { label: "Available", value: formatMb(memAvail) } : null}
              />
              <Bar label="GPU" caption={`${Math.round(usage)}%`} pct={usage} color={ringColor} />
              {spark.kind === "host" && spark.metrics.ram?.total ? (
                <Bar
                  label="RAM"
                  caption={`${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`}
                  pct={(spark.metrics.ram.used / spark.metrics.ram.total) * 100}
                  color="var(--color-info)"
                />
              ) : null}
              <Bar label="GPU temp" caption={fmtTemp(tempRaw)} pct={(tempVal / tempMax) * 100} color={tempColor} />
              <Bar
                label="GPU power"
                caption={`${power?.draw ?? 0} / ${power?.limit ?? 0} W`}
                pct={powerPct}
                color="var(--color-violet)"
              />
            </div>
          </div>
          {showLauncher ? <ModelLauncher spark={spark} onOpen={onSelect} busy={loadingHint} /> : null}
          {role === "worker" ? (
            <div className="ov-launch ov-launch--worker">
              <div className="eyebrow">Worker of</div>
              {headSpark ? (
                <button
                  type="button"
                  className="ov-launch__head"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect?.(headSpark.id);
                  }}
                  title={`Open ${headSpark.name}`}
                >
                  <i className={`sdot ${headSpark.online ? "" : "sdot--off"}`} aria-hidden />
                  {headSpark.name}
                </button>
              ) : (
                <div className="ov-launch__title">Head not set</div>
              )}
              <div className="ov-launch__hint">
                {headLlm
                  ? `${backendLabel(headLlm.backend) ?? headLlm.backend ?? "LLM"} · ${headLlm.generationTps.toFixed(1)} tok/s decode`
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
              <div>
                <div className="eyebrow">Decode</div>
                <div className="big-num ov-tps__num">{llm.generationTps.toFixed(1)}<small>tok/s</small></div>
                <TrendLine data={decodeTrend} height={30} color={hot ? "var(--color-warning)" : "var(--color-accent)"} min={0} className="ov-tps__trend" />
              </div>
              <div>
                <div className="eyebrow">Prefill</div>
                <div className="big-num ov-tps__num">{Math.round(llm.prefillTps).toLocaleString()}<small>tok/s</small></div>
                <TrendLine data={prefillTrend} height={30} color="var(--color-info)" min={0} className="ov-tps__trend" />
              </div>
            </div>
          ) : null}
          {chips}
          {rootDisk ? (
            <div className="ov-foot">
              <div className="ov-kv">
                <span>Storage</span>
                <b className="mono">
                  {fmtStorage(rootDisk.used, false)} / {fmtStorage(rootDisk.total, true)}
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
        </>
      )}

    </div>
  );
}
