import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { updateAllHermes, wakeAllSparks } from "../../api/client";
import { ShutdownAll } from "../ShutdownAll";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { FleetAlertStrip } from "./FleetAlertStrip";
import { FleetTokenTotals } from "./FleetTokenTotals";
import { InferenceTrafficCard } from "./InferenceTrafficCard";
import { FleetKpis, type KpiVisibility } from "./FleetKpis";
import { ACTIVITY_ID, ENERGY_ID, TOKENS_ID } from "../../constants";
import { SparkCard } from "./SparkCard";
import { ActivityFeed } from "./ActivityFeed";
import { ActivityIcon, PowerOnIcon, RotateIcon } from "../ui/icons";
import { formatMb } from "../../shared/formatBytes";
import { vramContextFor } from "../../shared/vramBreakdown";
import { makeHeadResolver } from "../../shared/sparkHead";
import "../../styles/overview.css";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  hideWorkers?: boolean;
  showFleetEnergy?: boolean;
  /** Opt-in server capability; absent sources add no card or polling. */
  showInferenceActivity?: boolean;
  showFleetExceptions?: boolean;
  /** Alert notifications on: the exceptions strip lists `serverAlerts` instead of deriving its own. */
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
  showOverviewSearch?: boolean;
  /** Overview LLM token totals card (cumulative tokens per model). */
  showLlmTokenTotals?: boolean;
  /** Recent activity card. On by default. */
  showActivityFeed?: boolean;
  /** Which KPI tiles are shown; a missing key means shown. */
  kpis?: KpiVisibility;
  /** VRAM bar split by engine / system / free, judged by headroom. On by default. */
  showVramBreakdown?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
  /** Open a dedicated page (Token totals, Fleet energy, Activity). */
  onNavigate?: (id: string) => void;
}

export function OverviewPage({
  sparks,
  hideOffline = false,
  hideWorkers = false,
  showFleetEnergy = true,
  showInferenceActivity = false,
  showFleetExceptions = false,
  alertsEnabled = false,
  serverAlerts = null,
  showOverviewSearch = false,
  showLlmTokenTotals = true,
  showActivityFeed = true,
  kpis,
  showVramBreakdown = true,
  temperatureUnit = "celsius",
  onSelectSpark,
  onNavigate,
}: OverviewPageProps) {
  const { t } = useTranslation("overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "issues">("all");
  const withoutWorkers = useMemo(
    () => (hideWorkers ? sparks.filter((s) => !isWorkerSpark(s)) : sparks),
    [sparks, hideWorkers]
  );
  // Stable between renders that change nothing it depends on (a keystroke elsewhere, a dialog).
  const visibleSparks = useMemo(
    () =>
      withoutWorkers.filter((spark) => {
        if (hideOffline && !spark.online) return false;
        if (showOverviewSearch && query && !spark.name.toLowerCase().includes(query.toLowerCase())) return false;
        if (showOverviewSearch && statusFilter === "online" && !spark.online) return false;
        if (showOverviewSearch && statusFilter === "offline" && spark.online) return false;
        if (showOverviewSearch && statusFilter === "issues" && spark.online && !spark.metrics.storage.some((disk) => disk.percentage >= 90)) return false;
        return true;
      }),
    [withoutWorkers, hideOffline, showOverviewSearch, query, statusFilter]
  );
  // Head lookup and VRAM contexts for the whole fleet in one pass (not one scan per card).
  const cardContext = useMemo(() => {
    const resolveHead = makeHeadResolver(sparks);
    const byId = new Map<string, { head: SparkSnapshot | null; vram: ReturnType<typeof vramContextFor> | null }>();
    for (const spark of sparks) {
      byId.set(spark.id, {
        head: resolveHead(spark),
        vram: showVramBreakdown ? vramContextFor(spark, sparks, resolveHead) : null,
      });
    }
    return byId;
  }, [sparks, showVramBreakdown]);
  const hiddenWorkerCount = hideWorkers ? sparks.filter(isWorkerSpark).length : 0;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<
    | { kind: "hermes"; started: number; skipped: number; failed: number }
    | { kind: "wake"; sent: number; failed: number }
    | { kind: "error"; reason: "hermesFailed" | "wakeFailed"; rawMessage?: string }
    | null
  >(null);
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
      setBatchMsg({ kind: "hermes", started: started.length, skipped, failed });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        kind: "error",
        reason: "hermesFailed",
        rawMessage: err instanceof Error ? err.message : undefined,
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
      setBatchMsg({ kind: "wake", sent: ok, failed: fail });
    } catch (err: unknown) {
      setBatchMsg({
        kind: "error",
        reason: "wakeFailed",
        rawMessage: err instanceof Error ? err.message : undefined,
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
      ? t("page.empty.workersHiddenTitle")
      : allOffline
        ? t("page.empty.allOfflineTitle")
        : t("page.empty.noSparksTitle");
    const detail = allWorkersHidden
      ? t("page.empty.workersHiddenDetail")
      : allOffline
        ? t("page.empty.allOfflineDetail")
        : t("page.empty.noSparksDetail");
    return (
      <div className="panel ov mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
        <p className="mt-1 text-xs text-muted">{detail}</p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;
  const memTotalMb = sparks.reduce((n, s) => n + (s.metrics.gpu?.vram?.total || s.metrics.unifiedMemory?.total || 0), 0);

  return (
    <div className="ov">
      <div className="ov-title">
        <div>
          <h1>{t("page.title")}</h1>
          <div className="ov-meta">
            {t("page.sparkCount", { count: sparks.length })}
            <span className="tag tag--good">{t("page.onlineCount", { online: onlineCount, total: visibleSparks.length })}</span>
            {memTotalMb > 0 ? <span>{t("page.unifiedMemory", { memory: formatMb(memTotalMb) })}</span> : null}
            {hiddenWorkerCount > 0 ? <span>{t("page.hiddenWorkers", { count: hiddenWorkerCount })}</span> : null}
          </div>
        </div>
        <div className="ov-btns">
          {batchMsg && (
            <span className={`ov-batchmsg ${batchMsg.kind !== "error" && batchMsg.failed === 0 ? "is-ok" : "is-err"}`} role="status">
              {batchMsg.kind === "error"
                ? batchMsg.rawMessage ?? (batchMsg.reason === "hermesFailed" ? t("batch.hermesFailed") : t("batch.wakeFailed"))
                : batchMsg.kind === "hermes"
                  ? [
                      t("batch.hermesStarted", { count: batchMsg.started }),
                      ...(batchMsg.skipped ? [t("batch.skipped", { count: batchMsg.skipped })] : []),
                      ...(batchMsg.failed ? [t("batch.failed", { count: batchMsg.failed })] : []),
                    ].join(", ")
                  : batchMsg.failed === 0
                    ? t("batch.wakeSent", { count: batchMsg.sent })
                    : t("batch.wakeResult", { sent: batchMsg.sent, failed: batchMsg.failed })}
            </span>
          )}
          {batchProg && (
            <div className="ov-prog">
              <span className="ov-prog__label">
                <RotateIcon className="h-3 w-3" />
                {t("batch.hermesProgress", { done: batchProg.done, total: batchProg.total })}
                {batchProg.failed > 0 && <span className="text-danger">({t("batch.failed", { count: batchProg.failed })})</span>}
                <button type="button" onClick={() => setBatchRun(null)} aria-label={t("batch.dismissProgress")} title={t("batch.dismiss")} className="ov-prog__x">
                  {"\u2715"}
                </button>
              </span>
              <div className="ov-prog__track">
                <div
                  className={`ov-prog__fill ${batchProg.failed > 0 ? "is-err" : ""}`}
                  style={{ width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <>
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title={t("batch.updateHermesTitle")}
                  className={`btn ${hermesPendingUpdateCount > 0 ? "ov-btn--pending" : ""}`}
                >
                  <RotateIcon className="h-3.5 w-3.5" />
                  {t("batch.updateHermes")}
                  {hermesPendingUpdateCount > 0 && (
                    <span
                      className="ov-badge"
                      title={t("batch.hermesUpdateAvailable", { count: hermesPendingUpdateCount })}
                    >
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
              {sparks.some((spark) => spark.kind === "host") && (
                <button
                  type="button"
                  onClick={() => void handleWakeAll()}
                  disabled={batchLoading}
                  title={t("batch.wakeAllTitle")}
                  className="btn"
                >
                  <PowerOnIcon className="h-3.5 w-3.5" />
                  {t("batch.wakeAll")}
                </button>
              )}
              <ShutdownAll sparks={sparks} className="ov-shutdown" />
            </>
          )}
        </div>
      </div>

      <FleetAlertStrip
        sparks={sparks}
        onSelect={onSelectSpark}
        showExceptions={showFleetExceptions}
        temperatureUnit={temperatureUnit}
        alertsEnabled={alertsEnabled}
        serverAlerts={serverAlerts}
      />

      {showOverviewSearch ? (
        <div className="ov-search" role="search" aria-label={t("page.filters.aria")}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("page.filters.searchPlaceholder")}
            aria-label={t("page.filters.searchAria")}
            className="ov-input"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            aria-label={t("page.filters.statusAria")}
            className="ov-input ov-input--select"
          >
            <option value="all">{t("page.filters.all")}</option>
            <option value="online">{t("page.filters.online")}</option>
            <option value="offline">{t("page.filters.offline")}</option>
            <option value="issues">{t("page.filters.issues")}</option>
          </select>
        </div>
      ) : null}

      <div className="ov-grid">
        <div className="ov-sparks" data-count={visibleSparks.length}>
          {visibleSparks.length === 0 && (
            <p className="panel ov-empty">{t("page.noMatches")}</p>
          )}
          {visibleSparks.map((spark) => {
            const ctx = cardContext.get(spark.id);
            return (
              <SparkCard
                key={spark.id}
                spark={spark}
                headSpark={ctx?.head ?? null}
                vramContext={ctx?.vram ?? null}
                temperatureUnit={temperatureUnit}
                onSelect={onSelectSpark}
              />
            );
          })}
        </div>
        <FleetKpis sparks={sparks} snapshotKey={sparks} show={kpis} />
        {showFleetEnergy || showLlmTokenTotals || showActivityFeed || showInferenceActivity ? (
        <div className="ov-side">
          {showInferenceActivity ? <InferenceTrafficCard /> : null}
          {showFleetEnergy ? <FleetEnergyCard nodeCount={sparks.length} nodeNames={Object.fromEntries(sparks.map((s) => [s.id, s.name]))} onOpenDetails={onNavigate ? () => onNavigate(ENERGY_ID) : undefined} /> : null}
          {showLlmTokenTotals ? <FleetTokenTotals onOpenDetails={onNavigate ? () => onNavigate(TOKENS_ID) : undefined} /> : null}
          {showActivityFeed ? (
            <section className="panel ov-card" aria-label={t("activity.title")}>
              <ActivityFeed limit={6} onSelectSpark={onSelectSpark} onViewAll={onNavigate ? () => onNavigate(ACTIVITY_ID) : undefined} />
            </section>
          ) : null}
        </div>
        ) : null}
      </div>
    </div>
  );
}
