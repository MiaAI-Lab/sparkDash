import { useTranslation } from "react-i18next";
import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled, isWorkerSpark } from "../../api/sparkRole";
import { idToPath, llmServerId } from "../../constants";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { backendLabel } from "../../shared/llmBackends";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { TrendLine } from "../ui/TrendLine";
import { BotIcon, ServerIcon } from "../ui/icons";
import { fmtNum, fmtPct, fmtSeconds } from "./LlmServerCharts";
import "../../styles/llmServers.css";

interface Endpoint {
  spark: SparkSnapshot;
  port: number;
  llm: LlmMetrics | null;
}

function endpointsOf(sparks: SparkSnapshot[]): Endpoint[] {
  const rows: Endpoint[] = [];
  for (const spark of sparks) {
    if (!isLlmMonitoringEnabled(spark) || isWorkerSpark(spark)) continue;
    const ports = spark.llmPorts?.length ? spark.llmPorts : [spark.llmPort];
    ports.forEach((port, index) => {
      const llm =
        spark.metrics.llm?.find((entry) => entry.port === port) ??
        spark.metrics.llm?.[index] ??
        null;
      rows.push({ spark, port, llm });
    });
  }
  return rows.sort((a, b) => {
    if (a.spark.online !== b.spark.online) return a.spark.online ? -1 : 1;
    const name = a.spark.name.localeCompare(b.spark.name);
    return name !== 0 ? name : a.port - b.port;
  });
}

function LlmServerCard({
  endpoint,
  onOpen,
}: {
  endpoint: Endpoint;
  onOpen?: (sparkId: string) => void;
}) {
  const { t } = useTranslation("spark");
  const { spark, port, llm } = endpoint;
  const decodeTrend = useMetricsHistoryTail(spark.id, `llm:${port}.tps`);
  const available = llm?.available === true;
  const backend = backendLabel(llm?.backend ?? null);
  const decode = llm?.generationTps ?? null;
  const prefill = llm?.prefillTps ?? null;
  const kv = llm?.kvCacheUsage ?? null;
  const cache = llm?.prefixCacheHitRate ?? null;
  const running = llm?.slots?.running ?? llm?.requestsRunning ?? null;
  const waiting = llm?.slots?.waiting ?? llm?.requestsWaiting ?? null;
  const href = idToPath(llmServerId(spark.id));

  return (
    <a
      href={href}
      className="panel ls-card"
      aria-label={t("llmServer.openCard", { name: spark.name, port })}
      onClick={(e) => {
        if (!onOpen) return;
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen(spark.id);
      }}
    >
      <div className="ls-card__top">
        <div className="ls-card__identity">
          <span className={`ls-dot ${spark.online ? "is-on" : "is-off"}`} aria-hidden />
          <div>
            <h2 className="ls-card__name">{spark.name}</h2>
            <p className="ls-card__meta">
              <span>{backend ?? "—"}</span>
              <span>·</span>
              <span>:{port}</span>
              {llm?.modelId ? (
                <>
                  <span>·</span>
                  <span
                    className="ls-card__model"
                    title={llm.models && llm.models.length > 1 ? llm.models.join(", ") : llm.modelId}
                  >
                    {llm.modelId}
                    {llm.models && llm.models.length > 1 ? ` +${llm.models.length - 1}` : ""}
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="ls-card__tags">
          {available ? (
            <Tag tone="good">{t("llmServer.live")}</Tag>
          ) : (
            <Tag tone={spark.online ? "warn" : "bad"}>
              {spark.online ? t("llmServer.unavailable") : t("llmServer.offline")}
            </Tag>
          )}
          {llm?.via === "ssh-tunnel" ? <Tag>{t("llmServer.viaSsh")}</Tag> : null}
          {llm?.posture ? (
            <Tag
              tone={llm.posture.level === "ok" ? "good" : llm.posture.level === "warn" ? "warn" : "bad"}
              title={llm.posture.detail}
            >
              {llm.posture.label}
            </Tag>
          ) : null}
        </div>
      </div>

      <div className="sp-tiles ls-card__tiles">
        <div className="sp-tile">
          <b>{running == null && waiting == null ? "—" : `${running ?? "—"} / ${waiting ?? "—"}`}</b>
          <span>{t("llmServer.runningWaiting")}</span>
        </div>
        <div className="sp-tile">
          <b>{available ? fmtNum(decode) : "—"}</b>
          <span>{t("llmServer.decodeTps")}</span>
        </div>
        <div className="sp-tile">
          <b>{available ? fmtNum(prefill) : "—"}</b>
          <span>{t("llmServer.prefillTps")}</span>
        </div>
        <div className="sp-tile">
          <b>{kv == null ? "—" : fmtPct(kv)}</b>
          <span>{t("llmServer.kvUsage")}</span>
        </div>
        <div className="sp-tile">
          <b>{cache == null ? "—" : fmtPct(cache)}</b>
          <span>{t("llmServer.cacheHit")}</span>
        </div>
        <div className="sp-tile">
          <b>{llm?.ttftP95Seconds == null ? "—" : fmtSeconds(llm.ttftP95Seconds)}</b>
          <span>{t("llmServer.ttftP95")}</span>
        </div>
      </div>

      <div className="ls-card__trend">
        <span className="eyebrow">{t("llmServer.decodeTrend")}</span>
        <TrendLine data={decodeTrend} height={34} color="var(--color-accent)" />
      </div>
    </a>
  );
}

export function LlmServersPage({
  sparks,
  onSelectSpark,
}: {
  sparks: SparkSnapshot[];
  onSelectSpark?: (sparkId: string) => void;
}) {
  const { t } = useTranslation("spark");
  const endpoints = endpointsOf(sparks);
  const online = endpoints.filter((e) => e.llm?.available === true).length;
  const waiting = endpoints.reduce((sum, e) => sum + (e.llm?.requestsWaiting ?? 0), 0);
  const decode = endpoints.reduce((sum, e) => sum + (e.llm?.generationTps ?? 0), 0);

  const open = (sparkId: string) => onSelectSpark?.(sparkId);
  const cardOpen = onSelectSpark ? open : undefined;

  return (
    <div className="ls">
      <header className="page-head">
        <div>
          <h1>{t("llmServer.title")}</h1>
          <p className="page-head__sub">{t("llmServer.subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <Tag tone={online > 0 ? "good" : "warn"}>
            {t("llmServer.onlineCount", { online, total: endpoints.length })}
          </Tag>
        </div>
      </header>

      {endpoints.length === 0 ? (
        <Panel title={t("llmServer.title")} icon={<BotIcon />}>
          <div className="ls-empty">
            <ServerIcon className="h-6 w-6" />
            <h2>{t("llmServer.noServers")}</h2>
            <p>{t("llmServer.noServersHint")}</p>
          </div>
        </Panel>
      ) : (
        <>
          <div className="ls-summary">
            <div className="sp-tile">
              <b>{online}</b>
              <span>{t("llmServer.onlineServers")}</span>
            </div>
            <div className="sp-tile">
              <b>{fmtNum(decode)}</b>
              <span>{t("llmServer.fleetDecode")}</span>
            </div>
            <div className="sp-tile">
              <b>{fmtNum(waiting, 0)}</b>
              <span>{t("llmServer.fleetWaiting")}</span>
            </div>
          </div>
          <div className="ls-grid">
            {endpoints.map((endpoint) => (
              <LlmServerCard
                key={`${endpoint.spark.id}:${endpoint.port}`}
                endpoint={endpoint}
                onOpen={cardOpen}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
