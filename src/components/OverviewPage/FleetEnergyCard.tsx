import { RestartButton } from "../ui/RestartButton";
import { AppLink } from "../ui/AppLink";
import { useTranslation } from "react-i18next";
import { ENERGY_ID, idToPath } from "../../constants";
import { useEffect, useState } from "react";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy } from "../../api/types";

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
  const { t } = useTranslation();
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

  // Fleet coverage is wall-clock time during which every node was fresh, so
  // it is capped by its measurement window — not window × nodeCount. Use the
  // server-provided window; DAY_MS is only a fallback for older servers.
  const coverageWindowMs = data?.coverage24hWindowMs ?? DAY_MS;
  const coverage = data && nodeCount > 0
    ? Math.min(100, (data.coverage24hMs / coverageWindowMs) * 100)
    : 0;
  const stale = (data?.staleNodeIds ?? []).map((id) => nodeNames?.[id] ?? id);
  const staleText = stale.length ? t("overview.energy.partialHelpStale", "No fresh reading from: {list}. ", { list: stale.join(", ") }) : "";
  const partialHelp =
    data && !data.membershipChanged && data.freshNodeCount < nodeCount
      ? t("overview.energy.partialHelpBase", "Energy is estimated from each node's live GPU and CPU readings. {stalePart}A node that is offline, unreachable or not reporting power stops the fleet total from being measured for that time, so 24h coverage drops. It recovers by itself once the node reports again.", { stalePart: staleText })
      : null;
  const state = error
    ? t("overview.energy.unavailable", "Energy telemetry unavailable: {error}", { error })
    : data?.membershipChanged
      ? t("overview.energy.membershipChanged", "Fleet membership changed. Restart sparkDash to establish a truthful new accounting scope.")
      : !data
        ? t("overview.energy.loading", "Loading fleet energy…")
        : data.freshNodeCount < nodeCount
          ? t("overview.energy.partialCoverage", "Partial coverage: {fresh}/{total} nodes currently fresh.", { fresh: data.freshNodeCount, total: nodeCount })
          : data.energy24hKwh == null
            ? t("overview.energy.warmingUp", "Warming up — no complete energy interval recorded yet.")
            : null;

  const hourly = data?.hourlyWatts24h ?? Array(24).fill(null);
  const max = Math.max(1, ...hourly.filter((value): value is number => value != null));
  return (
    <section className="panel ov-card" aria-labelledby="fleet-energy-title">
      <div className="ov-card__head">
        <h2 id="fleet-energy-title" className="ov-card__title">{t("overview.energy.title", "Fleet energy")}</h2>
        <div className="ov-card__tools">
          <span className="tag">{data ? t("overview.energy.fresh", "{fresh}/{total} fresh", { fresh: data.freshNodeCount, total: nodeCount }) : "\u2014"}</span>
          {onOpenDetails ? (
            <AppLink href={idToPath(ENERGY_ID)} className="btn btn--sm btn--ghost" onNavigate={onOpenDetails}>
              {t("overview.energy.details", "Details")}
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
        <div className="big-num">{number(data?.energy24hKwh ?? null)}<small>{t("overview.energy.kwh24", "kWh / 24 h")}</small></div>
        <div className="ov-card__sub mono">{t("overview.energy.estimated", "Estimated, not wall-metered · 24h coverage {coverage}%", { coverage: coverage.toFixed(1) })}</div>
      </div>
      <div className="ov-bars" aria-label={t("overview.energy.barsAria", "Hourly estimated watts for the last 24 hours, with gaps shown empty")}>
        {hourly.map((watts, index) => (
          <span
            key={index}
            className={index === hourly.length - 1 ? "is-now" : undefined}
            style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }}
            title={watts == null ? t("overview.energy.noCoverage", "No complete coverage") : `${watts.toFixed(0)} W`}
          />
        ))}
      </div>
      <div className="ov-axis mono"><span>{t("overview.energy.axis24h", "24h ago")}</span><span>{t("overview.energy.axis12h", "12h")}</span><span>{t("overview.energy.axisNow", "now")}</span></div>
      <dl className="ov-stats">
        <div><dt>{t("overview.energy.current", "Current")}</dt><dd className="mono">{number(data?.currentWatts30s ?? null, 0)} W</dd></div>
        <div><dt>{t("overview.energy.d31", "31 days")}</dt><dd className="mono">{number(data?.energy31dKwh ?? null)} kWh</dd></div>
        <div><dt>{t("overview.energy.efficiency", "Efficiency")}</dt><dd className="mono">{significant(data?.whPerOutputToken24h ?? null)} Wh/token</dd></div>
      </dl>
    </section>
  );
}
