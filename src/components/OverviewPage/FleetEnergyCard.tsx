import { RestartButton } from "../ui/RestartButton";
import { AppLink } from "../ui/AppLink";
import { ENERGY_ID, idToPath } from "../../constants";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy, FleetWallEnergy } from "../../api/types";

const DAY_MS = 86_400_000;

function number(value: number | null, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

// Fleet efficiency is ~0.001 Wh per token, so fixed decimals keep only one or
// two digits of it. toPrecision turns 1000 and up into exponent notation, so
// large values (a nearly idle fleet) are printed whole.
function significant(value: number | null): string {
  if (value == null) return "—";
  return Math.abs(value) >= 1000 ? value.toFixed(0) : value.toPrecision(3);
}

export function FleetEnergyCard({
  nodeCount,
  nodeNames,
  onOpenDetails,
}: {
  nodeCount: number;
  /** Display names by Spark id, used to say which nodes are missing. */
  nodeNames?: Record<string, string>;
  onOpenDetails?: () => void;
}) {
  const { t } = useTranslation("overview");
  const [data, setData] = useState<FleetEnergy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchFleetEnergy()
      .then((next) => { if (!cancelled) { setData(next); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // With power meters configured the card shows wall power (gaps filled from the estimate).
  // The share filled from the estimate is said out loud, so a meter outage is not read as measured.
  const wallLabel = (w: FleetWallEnergy) => {
    const total = w.energy24hKwh;
    const filled = w.filledEnergy24hKwh;
    if (total != null && total > 0 && filled != null && filled > 0) {
      return t("energy.wallMeteredFilled", { percent: Math.min(100, Math.round((filled / total) * 100)) });
    }
    return w.currentFilled ? t("energy.wallMeteredNowFilled") : t("energy.wallMetered");
  };
  const wall = data?.wall ?? null;
  const view = wall ?? data;
  // Fleet coverage is wall-clock time during which every node was fresh, so
  // it is capped by its measurement window — not window × nodeCount. Use the
  // server-provided window; DAY_MS is only a fallback for older servers.
  const coverageWindowMs = view?.coverage24hWindowMs ?? DAY_MS;
  const coverage = view && nodeCount > 0
    ? Math.min(100, (view.coverage24hMs / coverageWindowMs) * 100)
    : 0;
  const freshCount = wall ? nodeCount - wall.staleNodeIds.length : data?.freshNodeCount ?? 0;
  const stale = (view?.staleNodeIds ?? []).map((id) => nodeNames?.[id] ?? id);
  const partialHelp =
    data && !data.membershipChanged && freshCount < nodeCount
      ? wall
        ? t("energy.partialHelpWall", { stale: stale.length ? t("energy.noFreshReading", { nodes: stale.join(", ") }) : "" })
        : t("energy.partialHelp", { stale: stale.length ? t("energy.noFreshReading", { nodes: stale.join(", ") }) : "" })
      : null;
  const state = error
    ? t("energy.unavailable", { error })
    : data?.membershipChanged
      ? t("energy.membershipChanged")
      : !data
        ? t("energy.loading")
        : freshCount < nodeCount
          ? t("energy.partialCoverage", { fresh: freshCount, total: nodeCount })
          : view?.energy24hKwh == null
            ? t("energy.warmingUp")
            : null;

  const hourly = view?.hourlyWatts24h ?? Array(24).fill(null);
  const max = Math.max(1, ...hourly.filter((value): value is number => value != null));
  return (
    <section className="panel ov-card" aria-labelledby="fleet-energy-title">
      <div className="ov-card__head">
        <h2 id="fleet-energy-title" className="ov-card__title">{t("energy.title")}</h2>
        <div className="ov-card__tools">
          <span className="tag">{data ? t("energy.fresh", { fresh: freshCount, total: nodeCount }) : "\u2014"}</span>
          {onOpenDetails ? (
            <AppLink href={idToPath(ENERGY_ID)} className="btn btn--sm btn--ghost" onNavigate={onOpenDetails}>
              {t("energy.details")}
            </AppLink>
          ) : null}
        </div>
      </div>
      {state && (
        <p className="ov-note" role="status">
          {state}
          {partialHelp ? (
            <>
              {" "}
              <span className="ov-help" tabIndex={0} role="img" aria-label={partialHelp} title={partialHelp}>ⓘ</span>
            </>
          ) : null}
        </p>
      )}
      {data?.membershipChanged && !error ? <RestartButton /> : null}
      <div>
        <div className="big-num">{number(view?.energy24hKwh ?? null)}<small>{t("energy.kwhPer24Hours")}</small></div>
        <div className="ov-card__sub mono">
          {wall
            ? t("energy.wallCoverage", { label: wallLabel(wall), coverage: coverage.toFixed(1) })
            : t("energy.estimatedCoverage", { coverage: coverage.toFixed(1) })}
        </div>
      </div>
      <div className="ov-bars" aria-label={wall ? t("energy.hourlyWallWattsAria") : t("energy.hourlyWattsAria")}>
        {hourly.map((watts, index) => (
          <span
            key={index}
            className={index === hourly.length - 1 ? "is-now" : undefined}
            style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }}
            title={watts == null ? t("energy.noCompleteCoverage") : `${watts.toFixed(0)} W`}
          />
        ))}
      </div>
      <div className="ov-axis mono"><span>{t("energy.hoursAgo", { count: 24 })}</span><span>{t("energy.hours", { count: 12 })}</span><span>{t("energy.now")}</span></div>
      <dl className="ov-stats">
        <div><dt>{t("energy.current")}</dt><dd className="mono">{number(view?.currentWatts30s ?? null, 0)} W</dd></div>
        <div><dt>{t("energy.days", { count: 31 })}</dt><dd className="mono">{number(view?.energy31dKwh ?? null)} kWh</dd></div>
        <div><dt>{t("energy.efficiency")}</dt><dd className="mono">{significant(view?.whPerOutputToken24h ?? null)} Wh/token</dd></div>
      </dl>
    </section>
  );
}
