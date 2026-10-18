import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getGpuHistory, type GpuHistoryResponse } from "../../api/client";
import type { SparkSnapshot } from "../../api/types";
import { seriesSegments, type Pt } from "../SparkPage/chartMath";
import {
  TEMPS_RANGES,
  parseTempsRange,
  tempSeriesOf,
  tempsAxisLabels,
  toPoints,
  type TempsRange,
  type TempSeries,
} from "./tempsStats";
import "../../styles/temps.css";

const POLL_MS = 60_000;
const HEIGHT = 170;
const PAD = { l: 30, r: 8, t: 8, b: 22 };
const MAX_POINTS = 240;

/** Line colours in card order: the fleet uses the accent, cards of one host use the palette. */
const FLEET_COLORS = ["var(--color-accent)", "var(--color-info)", "var(--color-violet)", "var(--color-success)", "var(--color-warning)"];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPref(): string | null {
  try {
    return localStorage.getItem("sparkdash.temps.range");
  } catch {
    return null;
  }
}

function writePref(value: TempsRange) {
  try {
    localStorage.setItem("sparkdash.temps.range", value);
  } catch {
    /* a preference is a convenience */
  }
}

export function TempsPage({ sparks, onSelectSpark }: { sparks: SparkSnapshot[]; onSelectSpark?: (id: string) => void }) {
  const [range, setRange] = useState<TempsRange>(() => parseTempsRange(readPref()));
  const [data, setData] = useState<Record<string, GpuHistoryResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const rangeDef = TEMPS_RANGES.find((r) => r.id === range)!;
  const rangeMs = rangeDef.ms;
  // The id list only changes when the fleet does, so the poll refetches then (and on range change).
  const sparkIds = useMemo(() => sparks.map((s) => s.id).join(","), [sparks]);

  const load = useCallback(() => {
    const ids = sparkIds ? sparkIds.split(",") : [];
    return Promise.all(ids.map((id) => getGpuHistory(id, rangeMs).then((r) => [id, r] as const)))
      .then((pairs) => {
        setData(Object.fromEntries(pairs));
        setError(null);
        setLoaded(true);
      })
      .catch((err) => setError(errMsg(err)));
  }, [sparkIds, rangeMs]);

  useEffect(() => {
    let last = 0;
    const run = () => {
      last = Date.now();
      void load();
    };
    run();
    const timer = window.setInterval(() => {
      if (!document.hidden) run();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= POLL_MS) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const pickRange = (id: TempsRange) => {
    setRange(id);
    writePref(id);
  };

  const withData = sparks.filter((s) => data[s.id]?.t.length);

  return (
    <div className="tp">
      <div className="page-head">
        <div>
          <h1>Temps</h1>
          <p className="page-head__sub">
            GPU temperature across the fleet over the last {rangeDef.long}. Minute-resolution history is kept for a week on
            the server, so the graphs survive a refresh.
          </p>
        </div>
        <div className="page-head__tools">
          <div className="seg" role="group" aria-label="Time range">
            {TEMPS_RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={range === r.id} className={range === r.id ? "is-on" : ""} onClick={() => pickRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && !loaded ? (
        <section className="panel tp-state" role="alert">
          <h2>Could not load GPU history</h2>
          <p>{error}</p>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void load()}>Retry</button>
        </section>
      ) : !loaded ? (
        <section className="panel tp-state" role="status" aria-live="polite">
          <h2>Loading temperature history…</h2>
        </section>
      ) : withData.length === 0 ? (
        <section className="panel tp-state" role="status">
          <h2>Warming up</h2>
          <p>No GPU temperature was recorded in this range yet. Graphs appear as sparks report telemetry and fill in backwards over time.</p>
        </section>
      ) : (
        <div className="tp-grid">
          {withData.map((s, i) => (
            <TempCard key={s.id} spark={s} resp={data[s.id]} rangeMs={rangeMs} color={FLEET_COLORS[i % FLEET_COLORS.length]} onSelectSpark={onSelectSpark} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Line {
  label: string;
  color: string;
  segs: Pt[][];
}

function TempCard({
  spark,
  resp,
  rangeMs,
  color,
  onSelectSpark,
}: {
  spark: SparkSnapshot;
  resp: GpuHistoryResponse | undefined;
  rangeMs: number;
  color: string;
  onSelectSpark?: (id: string) => void;
}) {
  const endAt = resp?.t.length ? resp.t[resp.t.length - 1] : 0;
  const series: TempSeries[] = resp ? tempSeriesOf(resp) : [];
  const multi = series.length > 1;

  const lines = useMemo<Line[]>(() => {
    if (!resp || !endAt) return [];
    return series.map((s, i) => ({
      label: s.label,
      color: multi ? FLEET_COLORS[i % FLEET_COLORS.length] : color,
      segs: seriesSegments(toPoints(resp.t, s.c), rangeMs, endAt, MAX_POINTS),
    }));
  }, [resp, series, multi, endAt, rangeMs, color]);

  const [axA, axB] = tempsAxisLabels(rangeMs);
  const now = spark.online ? spark.metrics?.gpu?.temperature : null;

  return (
    <section className="panel tp-card">
      <div className="tp-card__head">
        <button type="button" className="tp-card__name" onClick={() => onSelectSpark?.(spark.id)}>
          {spark.name}
        </button>
        <span className={`tp-card__now${spark.online ? "" : " is-offline"}`}>
          {now != null && Number.isFinite(now) ? `now ${Math.round(now)}°C` : spark.online ? "" : "offline"}
        </span>
      </div>
      {lines.some((l) => l.segs.some((seg) => seg.length > 1)) ? (
        <TempSvg lines={lines} endAt={endAt} rangeMs={rangeMs} axis={[axA, axB]} />
      ) : (
        <p className="tp-card__empty">No temperature samples in this range.</p>
      )}
      {multi && (
        <div className="legend">
          {lines.map((l) => (
            <span key={l.label} style={{ "--c": l.color } as React.CSSProperties}>
              {l.label}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Fixed-width SVG plot on a 0–100 °C axis; the card is wide enough that one width is fine. */
function TempSvg({ lines, endAt, rangeMs, axis }: { lines: Line[]; endAt: number; rangeMs: number; axis: [string, string] }) {
  const width = 640;
  const iw = width - PAD.l - PAD.r;
  const ih = HEIGHT - PAD.t - PAD.b;
  const clipId = `${useId()}-plot`;
  const startAt = endAt - rangeMs;
  const xOf = (at: number) => PAD.l + ((at - startAt) / rangeMs) * iw;
  const yOf = (v: number) => PAD.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const d = (seg: Pt[]) => seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.at).toFixed(1)} ${yOf(p.value).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="tp-plot" role="img" aria-label="GPU temperature history">
      {[0, 25, 50, 75, 100].map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={width - PAD.r} y1={yOf(t)} y2={yOf(t)} stroke="var(--color-border)" strokeDasharray={t ? "2 4" : undefined} />
          <text x={PAD.l - 6} y={yOf(t) + 3.5} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <text x={PAD.l} y={HEIGHT - 4} textAnchor="start">
        {axis[0]}
      </text>
      <text x={PAD.l + iw / 2} y={HEIGHT - 4} textAnchor="middle">
        {axis[1]}
      </text>
      <text x={width - PAD.r} y={HEIGHT - 4} textAnchor="end">
        now
      </text>
      <clipPath id={clipId}>
        <rect x={PAD.l} y={PAD.t} width={iw} height={ih} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        {lines.map((l, i) =>
          l.segs
            .filter((seg) => seg.length > 1)
            .map((seg, si) => {
              const last = seg[seg.length - 1];
              return (
                <g key={`${i}-${si}`}>
                  <path d={d(seg)} fill="none" stroke={l.color} strokeWidth="1.8" strokeLinejoin="round" />
                  {si === l.segs.filter((s) => s.length > 1).length - 1 && <circle cx={xOf(last.at)} cy={yOf(last.value)} r="3" fill={l.color} />}
                </g>
              );
            })
        )}
      </g>
    </svg>
  );
}
