import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { updateAllHermes, wakeAllSparks } from "../../api/client";
import { ShutdownAll } from "../ShutdownAll";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { FleetAlertStrip } from "./FleetAlertStrip";
import { FleetTokenTotals } from "./FleetTokenTotals";
import { FleetKpis } from "./FleetKpis";
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
  showFleetExceptions?: boolean;
  showOverviewSearch?: boolean;
  /** Overview LLM token totals card (cumulative tokens per model). */
  showLlmTokenTotals?: boolean;
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
  showFleetExceptions = false,
  showOverviewSearch = false,
  showLlmTokenTotals = true,
  showVramBreakdown = true,
  temperatureUnit = "celsius",
  onSelectSpark,
  onNavigate,
}: OverviewPageProps) {
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
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
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
          <h1>Overview</h1>
          <div className="ov-meta">
            {sparks.length} Spark{sparks.length === 1 ? "" : "s"}
            <span className="tag tag--good">{onlineCount}/{visibleSparks.length} online</span>
            {memTotalMb > 0 ? <span>{formatMb(memTotalMb)} unified memory</span> : null}
            {hiddenWorkerCount > 0 ? <span>{hiddenWorkerCount} worker{hiddenWorkerCount === 1 ? "" : "s"} hidden</span> : null}
          </div>
        </div>
        <div className="ov-btns">
          {batchMsg && (
            <span className={`ov-batchmsg ${batchMsg.tone === "ok" ? "is-ok" : "is-err"}`} role="status">
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="ov-prog">
              <span className="ov-prog__label">
                <RotateIcon className="h-3 w-3" />
                Updating Hermes {"\u2014"} {batchProg.done}/{batchProg.total}
                {batchProg.failed > 0 && <span className="text-danger">({batchProg.failed} failed)</span>}
                <button type="button" onClick={() => setBatchRun(null)} aria-label="Dismiss update progress" title="Dismiss" className="ov-prog__x">
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
                  title="Run `hermes update` on every Spark with Hermes Agent enabled"
                  className={`btn ${hermesPendingUpdateCount > 0 ? "ov-btn--pending" : ""}`}
                >
                  <RotateIcon className="h-3.5 w-3.5" />
                  Update Hermes
                  {hermesPendingUpdateCount > 0 && (
                    <span
                      className="ov-badge"
                      title={`${hermesPendingUpdateCount} Spark${hermesPendingUpdateCount === 1 ? "" : "s"} with a Hermes update available`}
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
                  title="Wake dedicated GPU hosts that have a MAC configured. DGX Spark has no Wake-on-LAN."
                  className="btn"
                >
                  <PowerOnIcon className="h-3.5 w-3.5" />
                  Wake all
                </button>
              )}
              <ShutdownAll sparks={sparks} className="ov-shutdown" />
            </>
          )}
        </div>
      </div>

      <FleetAlertStrip sparks={sparks} onSelect={onSelectSpark} showExceptions={showFleetExceptions} temperatureUnit={temperatureUnit} />

      {showOverviewSearch ? (
        <div className="ov-search" role="search" aria-label="Filter fleet units">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search up to 12 units"
            aria-label="Search units by name"
            className="ov-input"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            aria-label="Filter units by status"
            className="ov-input ov-input--select"
          >
            <option value="all">All status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="issues">Issues</option>
          </select>
        </div>
      ) : null}

      <div className="ov-grid">
        <div className="ov-sparks">
          {visibleSparks.length === 0 && (
            <p className="panel ov-empty">No units match the current search and status filters.</p>
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
        <FleetKpis sparks={visibleSparks} snapshotKey={sparks} />
        <div className="ov-side">
          {showFleetEnergy ? <FleetEnergyCard nodeCount={sparks.length} onOpenDetails={onNavigate ? () => onNavigate(ENERGY_ID) : undefined} /> : null}
          {showLlmTokenTotals ? <FleetTokenTotals onOpenDetails={onNavigate ? () => onNavigate(TOKENS_ID) : undefined} /> : null}
          <section className="panel ov-card" aria-label="Recent activity">
            <ActivityFeed limit={6} onSelectSpark={onSelectSpark} onViewAll={onNavigate ? () => onNavigate(ACTIVITY_ID) : undefined} />
          </section>
        </div>
      </div>
    </div>
  );
}
