import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LlmInsightsData,
  LlmMetrics,
  MetricsHistoryRange,
  SparkSnapshot,
} from "../../api/types";
import { isLlmMonitoringEnabled, isWorkerSpark } from "../../api/sparkRole";
import { backendLabel } from "../../shared/llmBackends";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { BotIcon, ServerIcon } from "../ui/icons";
import { LlmCachePanel } from "../SparkPage/LlmCachePanel";
import { LlmDailyChart } from "../SparkPage/LlmDailyChart";
import { LlmTokenTotals } from "../SparkPage/LlmTokenTotals";
import { LlmClusterPanel } from "./LlmClusterPanel";
import { LlmInsightsPanel } from "./LlmInsightsPanel";
import { LlmLiveOverview } from "./LlmLiveOverview";
import {
  LlmLineChart,
  LlmQueueChart,
  LlmQueueDecodeChart,
  LlmStateChart,
  LlmTokenFlowChart,
  fmtNum,
  fmtPct,
  fmtSeconds,
} from "./LlmServerCharts";
import { useLlmServerData } from "./useLlmServerData";
import "../../styles/llmServers.css";

const RANGES: Array<{ key: MetricsHistoryRange; label: string }> = [
  { key: "1h", label: "1h" },
  { key: "6h", label: "6h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

function liveFor(spark: SparkSnapshot, port: number): LlmMetrics | null {
  const ports = spark.llmPorts?.length ? spark.llmPorts : [spark.llmPort];
  const index = ports.indexOf(port);
  return (
    spark.metrics.llm?.find((entry) => entry.port === port) ??
    spark.metrics.llm?.[index >= 0 ? index : 0] ??
    null
  );
}

export function LlmServerDetailPage({
  sparkId,
  sparks,
  onBack,
  onSelectSpark,
}: {
  sparkId: string;
  sparks: SparkSnapshot[];
  onBack: () => void;
  onSelectSpark?: (sparkId: string) => void;
}) {
  const { t } = useTranslation("spark");
  const spark = sparks.find((s) => s.id === sparkId) ?? null;
  const ports = spark?.llmPorts?.length ? spark.llmPorts : spark ? [spark.llmPort] : [];
  const [port, setPort] = useState(ports[0] ?? 0);
  const [range, setRange] = useState<MetricsHistoryRange>("24h");
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    setPort(ports[0] ?? 0);
  }, [sparkId, ports[0]]);

  const llm = spark ? liveFor(spark, port) : null;
  useEffect(() => {
    const options = llm?.models?.length ? llm.models : llm?.modelId ? [llm.modelId] : [];
    if (options.length === 0) return;
    // Keep the operator's selection while the endpoint still serves it.
    setModel((current) => (current && options.includes(current) ? current : options[0]));
  }, [llm?.models, llm?.modelId]);

  const data = useLlmServerData(sparkId, port, range, Boolean(spark));
  const points = data.points;

  const modelOptions = useMemo(() => {
    const models = llm?.models ?? [];
    if (models.length > 0) return models;
    return llm?.modelId ? [llm.modelId] : [];
  }, [llm?.models, llm?.modelId]);

  if (!spark) {
    return (
      <div className="ls">
        <header className="page-head">
          <div>
            <h1>{t("llmServer.title")}</h1>
            <p className="page-head__sub">{t("llmServer.notFound")}</p>
          </div>
          <div className="page-head__tools">
            <button type="button" className="btn btn--sm" onClick={onBack}>
              {t("llmServer.back")}
            </button>
          </div>
        </header>
      </div>
    );
  }

  if (!isLlmMonitoringEnabled(spark) || isWorkerSpark(spark)) {
    return (
      <div className="ls">
        <header className="page-head">
          <div>
            <h1>{spark.name}</h1>
            <p className="page-head__sub">{t("llmServer.monitoringOff")}</p>
          </div>
          <div className="page-head__tools">
            <button type="button" className="btn btn--sm" onClick={onBack}>
              {t("llmServer.back")}
            </button>
          </div>
        </header>
      </div>
    );
  }

  const available = llm?.available === true;
  const measured = llm?.measurementValid !== false;
  const insights: LlmInsightsData | null =
    data.insights && data.insights.enabled === true
      ? (data.insights as LlmInsightsData)
      : null;
  const enabled = data.enabled !== false;
  const backend = backendLabel(llm?.backend ?? null);

  return (
    <div className="ls ls-detail">
      <header className="page-head ls-head">
        <div className="ls-head__identity">
          <button type="button" className="ls-back" onClick={onBack} aria-label={t("llmServer.back")}>
            <span aria-hidden>←</span>
          </button>
          <div>
            <h1>{spark.name}</h1>
            <p className="page-head__sub">
              <span>{backend ?? "—"}</span>
              <span>·</span>
              <span>:{port}</span>
              {llm?.modelId ? (
                <>
                  <span>·</span>
                  <span>{llm.modelId}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="page-head__tools ls-head__tools">
          {ports.length > 1 ? (
            <div className="seg" role="group" aria-label={t("llmServer.portAria")}>
              {ports.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={p === port ? "is-on" : undefined}
                  aria-pressed={p === port}
                  onClick={() => setPort(p)}
                >
                  :{p}
                </button>
              ))}
            </div>
          ) : null}
          {modelOptions.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label={t("llmServer.modelAria")}
              title={t("llmServer.modelHint")}
              className="sp-select ls-model"
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : null}
          <div className="seg" role="group" aria-label={t("llmServer.rangeAria")}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={r.key === range ? "is-on" : undefined}
                aria-pressed={r.key === range}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Tag tone={available ? "good" : spark.online ? "warn" : "bad"}>
            {available ? t("llmServer.live") : spark.online ? t("llmServer.unavailable") : t("llmServer.offline")}
          </Tag>
          {onSelectSpark ? (
            <button type="button" className="btn btn--sm" onClick={() => onSelectSpark(spark.id)}>
              <ServerIcon className="h-3.5 w-3.5" />
              {t("llmServer.openHost")}
            </button>
          ) : null}
        </div>
      </header>

      {!enabled ? (
        <div className="panel ls-note" role="status">
          <h2>{t("llmServer.historyOffTitle")}</h2>
          <p>{t("llmServer.historyOffHint")}</p>
        </div>
      ) : null}

      {enabled && data.loadedAt != null && points.length === 0 ? (
        <div className="panel ls-note" role="status">
          <p>{t("llmServer.noHistory")}</p>
        </div>
      ) : null}

      {data.error ? (
        <div className="panel ls-note ls-note--err" role="alert">
          <span>{t("llmServer.staleError", { error: data.error })}</span>
        </div>
      ) : null}

      <Panel
        title={t("llmServer.liveTitle")}
        icon={<BotIcon />}
        accent={available}
        className="ls-live"
        bodyClassName="sp-stack"
        actions={
          <div className="sp-actions">
            {llm?.via === "ssh-tunnel" ? <Tag>{t("llmServer.viaSsh")}</Tag> : null}
            {llm?.posture ? (
              <Tag
                tone={llm.posture.level === "ok" ? "good" : llm.posture.level === "warn" ? "warn" : "bad"}
                title={llm.posture.detail}
              >
                {llm.posture.label}
              </Tag>
            ) : null}
            {llm?.engineVersion ? <Tag tone="info">v{llm.engineVersion}</Tag> : null}
            {llm?.cluster?.parts != null && llm.cluster.parts > 1 ? (
              <Tag tone="info">{t("llmServer.nodeCount", { n: llm.cluster.parts })}</Tag>
            ) : null}
            {llm?.contextLength ? (
              <Tag tone="info">{t("llmServer.context", { size: Math.round(llm.contextLength / 1024) })}</Tag>
            ) : null}
          </div>
        }
      >
        {available ? (
          <>
            <LlmLiveOverview
              llm={llm}
              points={points}
              insights={insights}
              available={available}
              measured={measured}
              range={range}
            />
            {llm?.backend === "tensorfold" ? <LlmCachePanel llm={llm} /> : null}
            {llm?.cluster ? <LlmClusterPanel cluster={llm.cluster} /> : null}
          </>
        ) : (
          <p className="sp-muted">{t("llmServer.noLive")}</p>
        )}
      </Panel>

      {enabled && insights && insights.available ? (
        <Panel
          title={t("llmServer.windowTitle", { range })}
          icon={<ServerIcon />}
          bodyClassName="sp-stack"
        >
          <div className="sp-tiles">
            <div className="sp-tile">
              <b>{insights.requestTime ? Math.round(insights.requestTime.requests).toLocaleString() : "—"}</b>
              <span>{t("llmServer.requests")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.requestTime ? fmtSeconds(insights.requestTime.queueSecondsPerRequest) : "—"}</b>
              <span>{t("llmServer.queuePerRequest")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.requestTime ? fmtSeconds(insights.requestTime.prefillSecondsPerRequest) : "—"}</b>
              <span>{t("llmServer.prefillPerRequest")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.requestTime ? fmtSeconds(insights.requestTime.decodeSecondsPerRequest) : "—"}</b>
              <span>{t("llmServer.decodePerRequest")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.requestTime ? fmtSeconds(insights.requestTime.ttftSecondsPerRequest) : "—"}</b>
              <span>{t("llmServer.ttftPerRequest")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.cache ? fmtPct(insights.cache.hitRate) : "—"}</b>
              <span>{t("llmServer.cacheHit")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.kv ? fmtPct(insights.kv.usageMax) : "—"}</b>
              <span>{t("llmServer.kvMax")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.kv?.deviceMaxGb == null ? "—" : `${fmtNum(insights.kv.deviceMaxGb)} GiB`}</b>
              <span>{t("llmServer.deviceMax")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.kv?.preemptions == null ? "—" : Math.round(insights.kv.preemptions).toLocaleString()}</b>
              <span>{t("llmServer.preemptions")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.mtp ? fmtNum(insights.mtp.tokensPerRound, 2) : "—"}</b>
              <span>{t("llmServer.tokensPerRound")}</span>
            </div>
          </div>
          <div className="sp-tiles">
            <div className="sp-tile">
              <b>{insights.timeInState ? fmtPct(insights.timeInState.prefillFraction) : "—"}</b>
              <span>{t("llmServer.timePrefilling")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.timeInState ? fmtPct(insights.timeInState.decodeFraction) : "—"}</b>
              <span>{t("llmServer.timeDecoding")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.timeInState ? fmtPct(insights.timeInState.queuedFraction) : "—"}</b>
              <span>{t("llmServer.timeQueued")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.timeInState ? fmtPct(insights.timeInState.idleFraction) : "—"}</b>
              <span>{t("llmServer.timeIdle")}</span>
            </div>
            <div className="sp-tile">
              <b>{insights.timeInState ? fmtNum(insights.timeInState.waitingMax, 0) : "—"}</b>
              <span>{t("llmServer.maxQueue")}</span>
            </div>
          </div>
        </Panel>
      ) : null}

      {enabled && points.length > 0 ? (
        <div className="ls-chart-grid">
          <Panel
            title={t("llmServer.charts.stateTitle")}
            className="ls-chart"
            bodyClassName="sp-stack"
            actions={<span className="sp-muted">{t("llmServer.charts.stateHint")}</span>}
          >
            <LlmStateChart
              points={points}
              labels={{
                queue: t("llmServer.charts.queue"),
                prefill: t("llmServer.charts.prefill"),
                decode: t("llmServer.charts.decode"),
                overhead: t("llmServer.charts.overhead"),
                empty: t("llmServer.noHistory"),
              }}
            />
            <LlmQueueChart
              points={points}
              labels={{
                queue: t("llmServer.charts.queueDepth"),
                running: t("llmServer.charts.runningSlots"),
                decode: t("llmServer.charts.perStreamDecode"),
                empty: t("llmServer.noHistory"),
              }}
            />
          </Panel>

          <Panel
            title={t("llmServer.charts.queueDecodeTitle")}
            className="ls-chart"
            bodyClassName="sp-stack"
            actions={
              insights?.knee ? (
                <span className="sp-muted">
                  {t("llmServer.charts.kneeNote", {
                    waiting: insights.knee.waiting,
                    tps: fmtNum(insights.knee.perStreamTps),
                  })}
                </span>
              ) : null
            }
          >
            <LlmQueueDecodeChart
              bins={insights?.queueBins ?? []}
              knee={insights?.knee ?? null}
              labels={{
                tps: t("llmServer.charts.perStreamDecode"),
                ttft: t("llmServer.charts.ttft"),
                prefill: t("llmServer.charts.prefill"),
                buckets: t("llmServer.charts.buckets"),
                empty: t("llmServer.noHistory"),
                knee: t("llmServer.charts.knee"),
              }}
            />
          </Panel>

          <Panel
            title={t("llmServer.charts.prefillDecodeTitle")}
            className="ls-chart"
            bodyClassName="sp-stack"
            actions={<span className="sp-muted">{t("llmServer.charts.prefillDecodeHint")}</span>}
          >
            <LlmLineChart
              points={points}
              ariaLabel={t("llmServer.charts.prefillDecodeTitle")}
              series={[
                {
                  id: "prefill",
                  label: t("llmServer.charts.prefill"),
                  values: points.map((p) => p.prefillTps?.avg ?? null),
                  color: "var(--color-info)",
                  format: (n) => `${fmtNum(n)} tok/s`,
                },
                {
                  id: "decode",
                  label: t("llmServer.charts.decode"),
                  values: points.map((p) => p.genTps?.avg ?? null),
                  color: "var(--color-accent)",
                  format: (n) => `${fmtNum(n)} tok/s`,
                },
                {
                  id: "perStream",
                  label: t("llmServer.charts.perStreamDecode"),
                  values: points.map((p) => p.perStreamTps?.avg ?? null),
                  color: "var(--color-success)",
                  format: (n) => `${fmtNum(n)} tok/s`,
                },
              ]}
            />
            <LlmLineChart
              points={points}
              ariaLabel={t("llmServer.charts.prefillShare")}
              series={[
                {
                  id: "prefillShare",
                  label: t("llmServer.charts.prefillShare"),
                  values: points.map((p) => p.prefillShare?.avg ?? null),
                  color: "var(--color-info)",
                  max: 1,
                  format: (n) => fmtPct(n),
                },
                {
                  id: "cacheHitRate",
                  label: t("llmServer.charts.cacheHitRate"),
                  values: points.map((p) => p.cacheHitRate?.avg ?? null),
                  color: "var(--color-success)",
                  max: 1,
                  format: (n) => fmtPct(n),
                },
              ]}
              height={96}
            />
          </Panel>

          <Panel
            title={t("llmServer.charts.cacheKvTitle")}
            className="ls-chart"
            bodyClassName="sp-stack"
            actions={<span className="sp-muted">{t("llmServer.charts.cacheKvHint")}</span>}
          >
            <LlmLineChart
              points={points}
              ariaLabel={t("llmServer.charts.cacheKvTitle")}
              series={[
                {
                  id: "cache",
                  label: t("llmServer.charts.cacheHit"),
                  values: points.map((p) => p.cacheHitRate?.avg ?? null),
                  color: "var(--color-info)",
                  max: 1,
                  format: (n) => fmtPct(n),
                },
                {
                  id: "kv",
                  label: t("llmServer.charts.kvUsage"),
                  values: points.map((p) => p.kvUsage?.avg ?? null),
                  color: "var(--color-warning)",
                  max: 1,
                  format: (n) => fmtPct(n),
                },
                {
                  id: "device",
                  label: t("llmServer.charts.deviceMemory"),
                  values: points.map((p) => p.deviceMemory?.avg ?? null),
                  color: "var(--color-violet)",
                  format: (n) => `${fmtNum(n)} GiB`,
                },
              ]}
            />
            <LlmTokenFlowChart
              points={points}
              labels={{
                cached: t("llmServer.charts.cachedTokens"),
                computed: t("llmServer.charts.computedTokens"),
                empty: t("llmServer.noHistory"),
              }}
            />
          </Panel>
        </div>
      ) : null}

      {enabled && insights && insights.available ? (
        <Panel
          title={t("llmServer.insightsTitle")}
          icon={<BotIcon />}
          bodyClassName="sp-stack"
          actions={
            insights.knee?.collapse ? (
              <span className="sp-muted">
                {t("llmServer.insightsSub", {
                  waiting: insights.knee.waiting,
                  collapseWaiting: insights.knee.collapse.waiting,
                })}
              </span>
            ) : null
          }
        >
          <LlmInsightsPanel insights={insights} />
          {insights.requestTime ? (
            <div className="ls-breakdown">
              <span className="eyebrow">{t("llmServer.breakdownTitle")}</span>
              <div className="ls-breakdown__bar" role="img" aria-label={t("llmServer.breakdownTitle")}>
                <i className="ls-seg ls-seg--queue" style={{ width: `${(insights.requestTime.queueShare ?? 0) * 100}%` }} />
                <i className="ls-seg ls-seg--prefill" style={{ width: `${(insights.requestTime.prefillShare ?? 0) * 100}%` }} />
                <i className="ls-seg ls-seg--decode" style={{ width: `${(insights.requestTime.decodeShare ?? 0) * 100}%` }} />
                <i className="ls-seg ls-seg--overhead" style={{ width: `${(insights.requestTime.overheadShare ?? 0) * 100}%` }} />
              </div>
              <ul className="ls-legend">
                <li><span aria-hidden className="ls-legend__dot ls-legend__dot--queue" /><span className="ls-legend__label">{t("llmServer.charts.queue")}</span><b>{fmtPct(insights.requestTime.queueShare)}</b></li>
                <li><span aria-hidden className="ls-legend__dot ls-legend__dot--prefill" /><span className="ls-legend__label">{t("llmServer.charts.prefill")}</span><b>{fmtPct(insights.requestTime.prefillShare)}</b></li>
                <li><span aria-hidden className="ls-legend__dot ls-legend__dot--decode" /><span className="ls-legend__label">{t("llmServer.charts.decode")}</span><b>{fmtPct(insights.requestTime.decodeShare)}</b></li>
                <li><span aria-hidden className="ls-legend__dot ls-legend__dot--overhead" /><span className="ls-legend__label">{t("llmServer.charts.overhead")}</span><b>{fmtPct(insights.requestTime.overheadShare)}</b></li>
              </ul>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <div className="ls-chart-grid">
        <Panel title={t("llmServer.dailyTitle")} className="ls-chart" bodyClassName="sp-stack">
          <LlmDailyChart sparkId={spark.id} llmPort={port} />
        </Panel>
        <Panel title={t("llmServer.tokensTitle")} className="ls-chart" bodyClassName="sp-stack">
          <LlmTokenTotals sparkId={spark.id} llmPort={port} modelId={model} />
        </Panel>
      </div>
    </div>
  );
}
