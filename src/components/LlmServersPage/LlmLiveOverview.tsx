import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  HistoryLlmPoint,
  LlmInsightsData,
  LlmMetrics,
  MetricsHistoryRange,
} from "../../api/types";
import { formatSince } from "../../shared/formatSince";
import { TrendLine } from "../ui/TrendLine";
import { fmtNum, fmtPct, fmtSeconds } from "./LlmServerCharts";

type LiveState = "idle" | "queued" | "prefilling" | "decoding" | "serving" | "unknown";
type ChipTone = "good" | "warn" | "info" | "neutral";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function series(points: HistoryLlmPoint[], key: keyof HistoryLlmPoint, limit = 60): number[] {
  return points
    .map((point) => {
      const stat = point[key];
      if (!stat || typeof stat !== "object") return null;
      return num((stat as { avg?: number }).avg);
    })
    .filter((v): v is number => v != null)
    .slice(-limit);
}

/** Per-bucket mean of a cumulative pair. */
function ratioSeries(
  points: HistoryLlmPoint[],
  numerator: keyof HistoryLlmPoint,
  denominator: keyof HistoryLlmPoint,
  limit = 60,
): number[] {
  const total = (point: HistoryLlmPoint, key: keyof HistoryLlmPoint): number | null => {
    const stat = point[key];
    if (!stat || typeof stat !== "object") return null;
    const a = num((stat as { avg?: number }).avg);
    const n = num((stat as { n?: number }).n);
    return a == null || n == null || n <= 0 ? null : a * n;
  };
  return points
    .map((point) => {
      const top = total(point, numerator);
      const bottom = total(point, denominator);
      return top != null && bottom != null && bottom > 0 ? top / bottom : null;
    })
    .filter((v): v is number => v != null)
    .slice(-limit);
}

function gib(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function sum(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

function liveState(llm: LlmMetrics | null, available: boolean, measured: boolean): LiveState {
  if (!available) return "unknown";
  const slots = llm?.slots;
  const running = slots?.running ?? llm?.requestsRunning ?? null;
  const waiting = slots?.waiting ?? llm?.requestsWaiting ?? null;
  if (slots?.idle === true || (running === 0 && waiting === 0)) return "idle";
  if (waiting != null && waiting > 0) return "queued";
  if (slots?.prefilling === true || llm?.prefillActive === true) return "prefilling";
  if (
    slots?.decoding === true ||
    llm?.decodeActive === true ||
    (measured && (llm?.generationTps ?? 0) > 0)
  ) {
    return "decoding";
  }
  if (running != null && running > 0) return "serving";
  return "unknown";
}

function HeroCard({
  label,
  value,
  sub,
  spark,
  color,
  meter,
  meterTone = "info",
  hint,
  children,
}: {
  label: string;
  value: string;
  sub?: string | null;
  spark?: number[];
  color?: string;
  meter?: number | null;
  meterTone?: "info" | "warn" | "good" | "accent";
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="ls-live-card" title={hint}>
      <span className="eyebrow">{label}</span>
      <div className="ls-live-card__value">{value}</div>
      {meter != null && Number.isFinite(meter) ? (
        <div className="ls-meter" role="img" aria-label={`${label} ${fmtPct(meter)}`}>
          <i
            className={`ls-meter__fill ls-meter__fill--${meterTone}`}
            style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }}
          />
        </div>
      ) : null}
      {sub ? <span className="ls-live-card__sub">{sub}</span> : null}
      {children}
      {spark && spark.length >= 2 ? (
        <TrendLine data={spark} height={34} color={color} className="ls-live-card__trend" />
      ) : (
        <div className="ls-live-card__trend-empty" />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  meter,
  meterTone = "info",
  hint,
}: {
  label: string;
  value: string;
  meter?: number | null;
  meterTone?: "info" | "warn" | "good" | "accent";
  hint?: string;
}) {
  return (
    <div className="ls-metric" title={hint}>
      <span className="ls-metric__label">{label}</span>
      <b className="ls-metric__value">{value}</b>
      {meter != null && Number.isFinite(meter) ? (
        <div className="ls-meter ls-meter--slim" role="img" aria-label={`${label} ${fmtPct(meter)}`}>
          <i
            className={`ls-meter__fill ls-meter__fill--${meterTone}`}
            style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function MetricGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ls-live-group">
      <h4>{title}</h4>
      <div className="ls-live-metrics">{children}</div>
    </section>
  );
}

export function LlmLiveOverview({
  llm,
  points,
  insights,
  available,
  measured,
  range,
}: {
  llm: LlmMetrics | null;
  points: HistoryLlmPoint[];
  insights: LlmInsightsData | null;
  available: boolean;
  measured: boolean;
  range: MetricsHistoryRange;
}) {
  const { t } = useTranslation("spark");
  const state = liveState(llm, available, measured);
  const slots = llm?.slots;
  const running = slots?.running ?? llm?.requestsRunning ?? null;
  const waiting = slots?.waiting ?? llm?.requestsWaiting ?? null;
  const totalSlots = slots?.total ?? (llm?.slotsTotal && llm.slotsTotal > 0 ? llm.slotsTotal : null);
  const used = (running ?? 0) + (waiting ?? 0);
  const free = totalSlots != null ? Math.max(0, totalSlots - used) : null;
  const since = formatSince(llm?.lastActiveAt);
  const cacheHit = llm?.prefixCacheHitRate ?? null;
  const kv = llm?.kvCacheUsage ?? null;
  const cluster = llm?.cluster ?? null;
  const clusterKv = cluster?.partStats.length
    ? (() => {
        let used = 0;
        let total = 0;
        for (const part of cluster.partStats) {
          const rows =
            cluster.partRows ??
            sum(part.freeRows, part.liveRows, part.keptRows, part.twinRows, part.holdRows);
          if (rows == null || rows <= 0 || part.freeRows == null) continue;
          total += rows;
          used += Math.max(0, rows - part.freeRows);
        }
        return total > 0 ? used / total : null;
      })()
    : null;
  const kvValue = clusterKv ?? kv;
  const deviceMemory = llm?.deviceMemoryBytes ?? null;
  const devicePeak = llm?.deviceMemoryPeakBytes ?? null;
  const devicePressure =
    deviceMemory != null && devicePeak != null && devicePeak > 0 ? deviceMemory / devicePeak : null;
  const mtp = llm?.mtpAcceptanceRate ?? null;
  const decodeEfficiency = series(points, "decodeEfficiency", 1)[0] ?? null;

  const stateLabel =
    state === "idle"
      ? t("llmServer.state.idle")
      : state === "queued"
        ? t("llmServer.state.queued")
        : state === "prefilling"
          ? t("llmServer.state.prefilling")
          : state === "decoding"
            ? t("llmServer.state.decoding")
            : state === "serving"
              ? t("llmServer.state.serving")
              : t("llmServer.state.unknown");

  const stateHint =
    state === "idle"
      ? t("llmServer.stateHint.idle")
      : state === "queued"
        ? t("llmServer.stateHint.queued", {
            waiting: waiting == null ? "—" : fmtNum(waiting, 0),
            running: running == null ? "—" : fmtNum(running, 0),
          })
        : state === "prefilling"
          ? t("llmServer.stateHint.prefilling")
          : state === "decoding"
            ? t("llmServer.stateHint.decoding", {
                running: running == null ? "—" : fmtNum(running, 0),
              })
            : state === "serving"
              ? t("llmServer.stateHint.serving")
              : t("llmServer.stateHint.unknown");

  const chips: Array<{ key: string; label: string; tone: ChipTone }> = [];
  if (!available) {
    chips.push({ key: "unavailable", label: t("llmServer.diagnosis.unavailable"), tone: "warn" });
  } else if (state === "idle") {
    chips.push({ key: "idle", label: t("llmServer.diagnosis.idle"), tone: "neutral" });
  } else {
    if (waiting != null && waiting > 0) {
      chips.push({
        key: "queuePressure",
        label: t("llmServer.diagnosis.queuePressure"),
        tone: waiting >= 3 ? "warn" : "info",
      });
    }
    const prefillShare = insights?.requestTime?.prefillShare ?? null;
    if (
      (prefillShare != null && prefillShare >= 0.4) ||
      llm?.prefillActive === true ||
      slots?.prefilling === true
    ) {
      chips.push({ key: "prefillHeavy", label: t("llmServer.diagnosis.prefillHeavy"), tone: "info" });
    }
    if (cacheHit != null && cacheHit < 0.2) {
      chips.push({ key: "cacheCold", label: t("llmServer.diagnosis.cacheCold"), tone: "warn" });
    }
    if (kv != null && kv >= 0.85) {
      chips.push({ key: "kvPressure", label: t("llmServer.diagnosis.kvPressure"), tone: "warn" });
    }
    if (decodeEfficiency != null && decodeEfficiency < 0.7) {
      chips.push({
        key: "decodeContention",
        label: t("llmServer.diagnosis.decodeContention"),
        tone: "warn",
      });
    }
    if (chips.length === 0) {
      chips.push({ key: "healthy", label: t("llmServer.diagnosis.healthy"), tone: "good" });
    }
  }

  const decodeSpark = series(points, "genTps");
  const queueSpark = series(points, "requestsWaiting");
  const ttftSpark = ratioSeries(points, "ttftTime", "ttftCount");
  const cacheSpark = series(points, "cacheHitRate");
  const kvSpark = series(points, "kvUsage");
  const prefillSpark = series(points, "prefillTps");
  const mtpSpark = series(points, "mtpAcceptance");

  const queueValue =
    running == null && waiting == null
      ? "—"
      : `${running == null ? "—" : fmtNum(running, 0)} / ${waiting == null ? "—" : fmtNum(waiting, 0)}`;
  const queueSub =
    totalSlots != null
      ? t("llmServer.slotsOf", { used: fmtNum(used, 0), total: fmtNum(totalSlots, 0) })
      : t("llmServer.queueSub", {
          running: running == null ? "—" : fmtNum(running, 0),
          waiting: waiting == null ? "—" : fmtNum(waiting, 0),
        });

  const slotCap = totalSlots != null ? Math.max(totalSlots, used) : Math.max(used, 1);
  const runningPct = running == null ? 0 : (Math.min(running, slotCap) / slotCap) * 100;
  const waitingPct = waiting == null ? 0 : (Math.min(waiting, slotCap) / slotCap) * 100;
  const freePct = Math.max(0, 100 - runningPct - waitingPct);

  return (
    <>
      <div className="ls-live-hero">
        <div className="ls-live-card ls-live-card--state">
          <span className="eyebrow">{t("llmServer.liveNow")}</span>
          <span className={`ls-state-pill ls-state-pill--${state}`}>{stateLabel}</span>
          <p className="ls-live-card__hint">{stateHint}</p>
          {state === "idle" && since ? (
            <span className="ls-live-card__since">{t("llmServer.lastServed", { since })}</span>
          ) : null}
          {llm?.measurementError ? (
            <span className="ls-live-card__warn">
              {t("llmServer.notMeasured", { error: llm.measurementError })}
            </span>
          ) : null}
          <div className="ls-chips">
            {chips.map((chip) => (
              <span key={chip.key} className={`ls-chip ls-chip--${chip.tone}`}>
                {chip.label}
              </span>
            ))}
          </div>
        </div>

        <HeroCard
          label={t("llmServer.decodeTps")}
          value={measured ? fmtNum(llm?.generationTps) : "—"}
          sub={t("llmServer.perStreamSub", {
            tps: measured ? fmtNum(llm?.perStreamTps) : "—",
          })}
          spark={decodeSpark}
          color="var(--color-accent)"
          hint={t("llmServer.decodeHint")}
        />

        <HeroCard
          label={t("llmServer.runningWaiting")}
          value={queueValue}
          sub={queueSub}
          spark={queueSpark}
          color="var(--color-warning)"
          hint={t("llmServer.queueHint")}
        >
          <div
            className="ls-slotbar"
            role="img"
            aria-label={t("llmServer.slotbarAria", {
              running: running == null ? "—" : fmtNum(running, 0),
              waiting: waiting == null ? "—" : fmtNum(waiting, 0),
              free: free == null ? "—" : fmtNum(free, 0),
            })}
          >
            <i className="ls-slotbar__seg ls-slotbar__seg--running" style={{ width: `${runningPct}%` }} />
            <i className="ls-slotbar__seg ls-slotbar__seg--waiting" style={{ width: `${waitingPct}%` }} />
            {free != null ? (
              <i className="ls-slotbar__seg ls-slotbar__seg--free" style={{ width: `${freePct}%` }} />
            ) : null}
          </div>
        </HeroCard>

        <HeroCard
          label={t("llmServer.ttftP95")}
          value={llm?.ttftP95Seconds == null ? "—" : fmtSeconds(llm.ttftP95Seconds)}
          sub={t("llmServer.ttftMeanSub", {
            seconds: llm?.ttftSeconds == null ? "—" : fmtSeconds(llm.ttftSeconds),
          })}
          spark={ttftSpark}
          color="var(--color-info)"
          hint={t("llmServer.ttftHint")}
        />

        <HeroCard
          label={t("llmServer.cacheHit")}
          value={fmtPct(cacheHit)}
          sub={t("llmServer.cacheHitHint")}
          meter={cacheHit}
          meterTone={cacheHit != null && cacheHit < 0.2 ? "warn" : "good"}
          spark={cacheSpark}
          color="var(--color-success)"
          hint={t("llmServer.cacheHint")}
        />

        <HeroCard
          label={t("llmServer.kvUsage")}
          value={fmtPct(kvValue)}
          sub={
            clusterKv != null
              ? t("llmServer.kvClusterSub", {
                  nodes: cluster?.parts ?? cluster?.partStats.length ?? 0,
                })
              : t("llmServer.engineHolds", { memory: gib(deviceMemory) })
          }
          meter={kvValue}
          meterTone={kvValue != null && kvValue >= 0.85 ? "warn" : "info"}
          spark={kvSpark}
          color="var(--color-violet)"
          hint={t("llmServer.kvHint")}
        />
      </div>

      <div className="ls-live-groups">
        <MetricGroup title={t("llmServer.groups.throughput")}>
          <Metric
            label={t("llmServer.prefillTps")}
            value={measured ? fmtNum(llm?.prefillTps) : "—"}
            hint={t("llmServer.prefillHint")}
          />
          {llm?.perStreamPrefillTps != null ? (
            <Metric label={t("llmServer.perStreamPrefill")} value={fmtNum(llm.perStreamPrefillTps)} />
          ) : null}
          {llm?.cachedPrefillTps != null ? (
            <Metric label={t("llmServer.cachedPrefill")} value={fmtNum(llm.cachedPrefillTps)} />
          ) : null}
          {llm?.uncachedPrefillTps != null ? (
            <Metric label={t("llmServer.uncachedPrefill")} value={fmtNum(llm.uncachedPrefillTps)} />
          ) : null}
          {mtp != null ? (
            <Metric
              label={t("llmServer.mtpAcceptance")}
              value={fmtPct(mtp)}
              meter={mtp}
              meterTone={mtp < 0.5 ? "warn" : "good"}
              hint={t("llmServer.mtpHint")}
            />
          ) : null}
        </MetricGroup>

        <MetricGroup title={t("llmServer.groups.latency")}>
          {llm?.ttftSeconds != null ? (
            <Metric label={t("llmServer.ttftMean")} value={fmtSeconds(llm.ttftSeconds)} />
          ) : null}
          {llm?.itlP95Seconds != null ? (
            <Metric label={t("llmServer.itlP95")} value={fmtSeconds(llm.itlP95Seconds)} />
          ) : null}
          {llm?.e2eP95Seconds != null ? (
            <Metric label={t("llmServer.e2eP95")} value={fmtSeconds(llm.e2eP95Seconds)} />
          ) : null}
          {llm?.requestLatencySeconds != null ? (
            <Metric label={t("llmServer.latencyMean")} value={fmtSeconds(llm.requestLatencySeconds)} />
          ) : null}
          {llm?.prefillP95Seconds != null ? (
            <Metric label={t("llmServer.prefillP95")} value={fmtSeconds(llm.prefillP95Seconds)} />
          ) : null}
          {llm?.decodeP95Seconds != null ? (
            <Metric label={t("llmServer.decodeP95")} value={fmtSeconds(llm.decodeP95Seconds)} />
          ) : null}
        </MetricGroup>

        <MetricGroup title={t("llmServer.groups.memory")}>
          <Metric label={t("llmServer.deviceMemory")} value={gib(deviceMemory)} />
          <Metric label={t("llmServer.enginePeak")} value={gib(devicePeak)} />
          {devicePressure != null ? (
            <Metric
              label={t("llmServer.enginePressure")}
              value={fmtPct(devicePressure)}
              meter={devicePressure}
              meterTone={devicePressure >= 0.9 ? "warn" : "info"}
            />
          ) : null}
          <Metric
            label={t("llmServer.preemptions")}
            value={llm?.preemptionsTotal == null ? "—" : Math.round(llm.preemptionsTotal).toLocaleString()}
            hint={t("llmServer.preemptionsHint")}
          />
          <Metric
            label={t("llmServer.clientDisconnects")}
            value={
              llm?.clientDisconnectionsTotal == null
                ? "—"
                : Math.round(llm.clientDisconnectionsTotal).toLocaleString()
            }
            hint={t("llmServer.clientDisconnectsHint")}
          />
        </MetricGroup>
      </div>

      {prefillSpark.length >= 2 || mtpSpark.length >= 2 ? (
        <div className="ls-live-trends">
          {prefillSpark.length >= 2 ? (
            <div className="ls-live-trend">
              <span className="eyebrow">{t("llmServer.prefillTrend")}</span>
              <TrendLine data={prefillSpark} height={32} color="var(--color-info)" />
            </div>
          ) : null}
          {mtpSpark.length >= 2 ? (
            <div className="ls-live-trend">
              <span className="eyebrow">{t("llmServer.mtpTrend")}</span>
              <TrendLine data={mtpSpark} height={32} color="var(--color-success)" />
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="ls-live-range-hint">{t("llmServer.sparklineHint", { range })}</p>
    </>
  );
}
