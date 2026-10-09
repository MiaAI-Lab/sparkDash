import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { TrendLine } from "../ui/TrendLine";
import { aggregateModelTotals } from "./FleetTokenTotals";
import { computeFleetTotals, pushRolling } from "./fleetStats";

interface Trends {
  decode: number[];
  power: number[];
  mem: number[];
}

// Survives leaving and re-entering the Overview within one browser session.
let persisted: Trends = { decode: [], power: [], mem: [] };

/** Test helper: forget the samples kept across mounts. */
export function _resetFleetKpiTrends(): void {
  persisted = { decode: [], power: [], mem: [] };
}

function Kpi({
  label,
  value,
  unit,
  right,
  trend,
  color,
  foot,
}: {
  label: string;
  value: string;
  unit: string;
  right?: ReactNode;
  trend?: readonly number[];
  color: string;
  foot?: ReactNode;
}) {
  return (
    <div className="panel ov-kpi">
      <div className="ov-kpi__row">
        <span className="eyebrow">{label}</span>
        {right}
      </div>
      <div className="big-num">
        {value}
        <small>{unit}</small>
      </div>
      {trend ? <TrendLine data={trend} height={34} color={color} min={0} /> : <div className="ov-kpi__foot">{foot}</div>}
    </div>
  );
}

/** Four fleet-wide KPI tiles computed from live snapshots. */
export function FleetKpis({
  sparks,
  snapshotKey = sparks,
}: {
  sparks: SparkSnapshot[];
  /**
   * Identity of the snapshot the sparks came from. A trend sample is added when this changes
   * (a snapshot arrived), not when `sparks` is merely re-filtered by the search box.
   */
  snapshotKey?: unknown;
}) {
  const totals = useMemo(() => computeFleetTotals(sparks), [sparks]);
  const totalsRef = useRef(totals);
  totalsRef.current = totals;
  const [trends, setTrends] = useState<Trends>(persisted);
  const [tokens, setTokens] = useState<{ completion: number; prompt: number } | null>(null);

  useEffect(() => {
    const t = totalsRef.current;
    setTrends((prev) => {
      const next = {
        decode: pushRolling(prev.decode, t.decodeTps),
        power: pushRolling(prev.power, t.powerW),
        mem: pushRolling(prev.mem, t.memUsedMb / 1024),
      };
      persisted = next;
      return next;
    });
  }, [snapshotKey]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLlmTokenTotals("today")
        .then((res) => {
          if (cancelled) return;
          const agg = aggregateModelTotals(res.series || []);
          setTokens(agg.totalCompletion + agg.totalPrompt > 0 ? { completion: agg.totalCompletion, prompt: agg.totalPrompt } : null);
        })
        .catch(() => {
          if (!cancelled) setTokens(null);
        });
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const memGb = totals.memUsedMb / 1024;
  const memPct = totals.memTotalMb > 0 ? Math.round((totals.memUsedMb / totals.memTotalMb) * 100) : null;
  const tokensCompact = tokens ? formatTokensCompact(tokens.completion).match(/^([\d.,]+)\s*(.*)$/) : null;

  return (
    <div className="ov-kpis">
      <Kpi
        label="Fleet decode"
        value={totals.decodeTps.toFixed(1)}
        unit="tok/s"
                trend={trends.decode}
        color="var(--color-accent)"
      />
      <Kpi
        label="Fleet power"
        value={totals.powerW.toFixed(0)}
        unit="W"
                trend={trends.power}
        color="var(--color-violet)"
      />
      <Kpi
        label="Memory in use"
        value={memGb.toFixed(0)}
        unit="GB"
        right={memPct != null ? <span className="ov-delta mono">{memPct}%</span> : undefined}
        trend={trends.mem}
        color="var(--color-info)"
      />
      {tokens && tokensCompact ? (
        <Kpi
          label="Tokens today"
          value={tokensCompact[1]}
          unit={tokensCompact[2] || "tok"}
          foot={`generated · ${formatTokensCompact(tokens.prompt)} prefill`}
          color="var(--color-success)"
        />
      ) : (
        <Kpi
          label="Online"
          value={String(totals.online)}
          unit={`/ ${totals.total} units`}
          foot={totals.online === totals.total ? "all units reachable" : `${totals.total - totals.online} offline`}
          color="var(--color-success)"
        />
      )}
    </div>
  );
}
