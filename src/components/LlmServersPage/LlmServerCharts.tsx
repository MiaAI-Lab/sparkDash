import { useId } from "react";
import type { HistoryLlmPoint, LlmQueueBin, LlmQueueKnee } from "../../api/types";

const VIEW_W = 600;
const VIEW_H = 160;
const PAD = 6;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Bucket total for a per-sample series: avg × n. */
function total(point: HistoryLlmPoint, name: keyof HistoryLlmPoint): number | null {
  const stat = point[name];
  if (!stat || typeof stat !== "object") return null;
  const avg = num((stat as { avg?: number }).avg);
  const n = num((stat as { n?: number }).n);
  return avg == null || n == null || n <= 0 ? null : avg * n;
}

function avg(point: HistoryLlmPoint, name: keyof HistoryLlmPoint): number | null {
  const stat = point[name];
  if (!stat || typeof stat !== "object") return null;
  return num((stat as { avg?: number }).avg);
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return n.toFixed(digits);
}

export function fmtSeconds(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 3600) return `${(n / 3600).toFixed(1)} h`;
  if (n >= 120) return `${Math.round(n / 60)} min`;
  if (n >= 10) return `${n.toFixed(0)} s`;
  return `${n.toFixed(1)} s`;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

interface LineSeries {
  id: string;
  label: string;
  values: Array<number | null>;
  color: string;
  /** Normalise to this instead of the series max. */
  max?: number;
  format?: (n: number | null) => string;
}

/** One line per series, scaled to its own peak; gaps break the line. */
export function LlmLineChart({
  points,
  series,
  height = VIEW_H,
  ariaLabel,
}: {
  points: HistoryLlmPoint[];
  series: LineSeries[];
  height?: number;
  ariaLabel: string;
}) {
  const clipId = useId();
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0 + 1;
  const span = t1 - t0 || 1;

  const drawn = series.map((s) => {
    const peak = s.max ?? Math.max(1, ...s.values.map((v) => (num(v) ?? 0)));
    const segs: string[] = [];
    let current: string[] = [];
    points.forEach((point, i) => {
      const value = s.values[i];
      if (num(value) == null) {
        if (current.length > 1) segs.push(current.join(" "));
        current = [];
        return;
      }
      const x = ((point.t - t0) / span) * VIEW_W;
      const y = VIEW_H - PAD - (Math.min(peak, Math.max(0, value as number)) / peak) * (VIEW_H - PAD * 2);
      current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    if (current.length > 1) segs.push(current.join(" "));
    return { ...s, peak, segs };
  });

  return (
    <div className="ls-line">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="ls-line__svg"
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={VIEW_W} height={VIEW_H} />
          </clipPath>
        </defs>
        {drawn.map((s) => (
          <g key={s.id} clipPath={`url(#${clipId})`}>
            {s.segs.map((seg, i) => (
              <polyline
                key={i}
                points={seg}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        ))}
      </svg>
      <ul className="ls-legend">
        {drawn.map((s) => {
          const latest = [...s.values].reverse().find((v) => num(v) != null) ?? null;
          const format = s.format ?? ((n: number | null) => fmtNum(n));
          return (
            <li key={s.id}>
              <span aria-hidden className="ls-legend__dot" style={{ background: s.color }} />
              <span className="ls-legend__label">{s.label}</span>
              <b className="font-tabular">{format(latest)}</b>
              <small>peak {format(s.peak)}</small>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Request-time stacked bars per bucket (avg × n); empty buckets stay empty. */
export function LlmStateChart({
  points,
  labels,
}: {
  points: HistoryLlmPoint[];
  labels: { queue: string; prefill: string; decode: string; overhead: string; empty: string };
}) {
  const rows = points.map((point) => ({
    t: point.t,
    queue: total(point, "queueWait") ?? 0,
    prefill: total(point, "prefillSeconds") ?? 0,
    decode: total(point, "decodeSeconds") ?? 0,
    overhead: total(point, "overheadSeconds") ?? 0,
  }));
  const max = Math.max(1, ...rows.map((r) => r.queue + r.prefill + r.decode + r.overhead));
  const hasData = rows.some((r) => r.queue + r.prefill + r.decode + r.overhead > 0);

  if (!hasData) return <p className="sp-muted">{labels.empty}</p>;

  return (
    <div className="ls-state">
      <div className="ls-state__plot" role="img" aria-label={`${labels.queue}, ${labels.prefill}, ${labels.decode}, ${labels.overhead} per bucket`}>
        {rows.map((row, i) => {
          const sum = row.queue + row.prefill + row.decode + row.overhead;
          const pct = (v: number) => (sum > 0 ? (v / sum) * 100 : 0);
          const heightPct = (sum / max) * 100;
          return (
            <div key={i} className="ls-state__col">
              <div className="ls-state__stack" style={{ height: `${Math.max(2, heightPct)}%` }}>
                <i
                  className="ls-seg ls-seg--queue"
                  style={{ height: `${pct(row.queue)}%` }}
                  title={`${labels.queue} ${fmtSeconds(row.queue)}`}
                />
                <i
                  className="ls-seg ls-seg--prefill"
                  style={{ height: `${pct(row.prefill)}%` }}
                  title={`${labels.prefill} ${fmtSeconds(row.prefill)}`}
                />
                <i
                  className="ls-seg ls-seg--decode"
                  style={{ height: `${pct(row.decode)}%` }}
                  title={`${labels.decode} ${fmtSeconds(row.decode)}`}
                />
                <i
                  className="ls-seg ls-seg--overhead"
                  style={{ height: `${pct(row.overhead)}%` }}
                  title={`${labels.overhead} ${fmtSeconds(row.overhead)}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <ul className="ls-legend">
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--queue" />
          <span className="ls-legend__label">{labels.queue}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--prefill" />
          <span className="ls-legend__label">{labels.prefill}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--decode" />
          <span className="ls-legend__label">{labels.decode}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--overhead" />
          <span className="ls-legend__label">{labels.overhead}</span>
        </li>
      </ul>
    </div>
  );
}

/** Cached vs computed prompt tokens per bucket (avg × n). */
export function LlmTokenFlowChart({
  points,
  labels,
}: {
  points: HistoryLlmPoint[];
  labels: { cached: string; computed: string; empty: string };
}) {
  const rows = points.map((point) => {
    const prompt = total(point, "promptTokens");
    if (prompt == null) return { cached: 0, computed: 0 };
    const cached = Math.min(prompt, total(point, "cachedTokens") ?? 0);
    return { cached, computed: Math.max(0, prompt - cached) };
  });
  const max = Math.max(1, ...rows.map((r) => r.cached + r.computed));
  const hasData = rows.some((r) => r.cached + r.computed > 0);

  if (!hasData) return <p className="sp-muted">{labels.empty}</p>;

  return (
    <div className="ls-state">
      <div className="ls-state__plot" role="img" aria-label={`${labels.cached}, ${labels.computed} prompt tokens per bucket`}>
        {rows.map((row, i) => {
          const sum = row.cached + row.computed;
          const pct = (v: number) => (sum > 0 ? (v / sum) * 100 : 0);
          const heightPct = (sum / max) * 100;
          return (
            <div key={i} className="ls-state__col">
              <div className="ls-state__stack" style={{ height: `${Math.max(2, heightPct)}%` }}>
                <i
                  className="ls-seg ls-seg--cached"
                  style={{ height: `${pct(row.cached)}%` }}
                  title={`${labels.cached} ${Math.round(row.cached).toLocaleString()}`}
                />
                <i
                  className="ls-seg ls-seg--computed"
                  style={{ height: `${pct(row.computed)}%` }}
                  title={`${labels.computed} ${Math.round(row.computed).toLocaleString()}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <ul className="ls-legend">
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--cached" />
          <span className="ls-legend__label">{labels.cached}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--computed" />
          <span className="ls-legend__label">{labels.computed}</span>
        </li>
      </ul>
    </div>
  );
}

/** Queue depth (bars) versus per-stream decode (line) on one bucket grid. */
export function LlmQueueChart({
  points,
  labels,
}: {
  points: HistoryLlmPoint[];
  labels: { queue: string; running: string; decode: string; empty: string };
}) {
  const waiting = points.map((p) => avg(p, "requestsWaiting"));
  const running = points.map((p) => avg(p, "requestsRunning"));
  const perStream = points.map((p) => avg(p, "perStreamTps"));
  const hasData =
    waiting.some((v) => num(v) != null) ||
    running.some((v) => num(v) != null) ||
    perStream.some((v) => num(v) != null);
  if (!hasData) return <p className="sp-muted">{labels.empty}</p>;

  const maxWaiting = Math.max(1, ...waiting.map((v) => v ?? 0));
  return (
    <div className="ls-queue">
      <div className="ls-queue__plot" role="img" aria-label={`${labels.queue}, ${labels.running} and ${labels.decode} per bucket`}>
        {points.map((point, i) => {
          const w = waiting[i];
          return (
            <div key={point.t} className="ls-queue__col">
              <i
                className="ls-queue__bar"
                style={{ height: `${num(w) == null ? 0 : ((w as number) / maxWaiting) * 100}%` }}
                title={`${labels.queue} ${fmtNum(w)}`}
              />
            </div>
          );
        })}
      </div>
      <LlmLineChart
        points={points}
        series={[
          {
            id: "decode",
            label: labels.decode,
            values: perStream,
            color: "var(--color-accent)",
            format: (n) => `${fmtNum(n)} tok/s`,
          },
          {
            id: "running",
            label: labels.running,
            values: running,
            color: "var(--color-info)",
            format: (n) => fmtNum(n),
          },
        ]}
        height={96}
        ariaLabel={labels.decode}
      />
      <ul className="ls-legend">
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--queue" />
          <span className="ls-legend__label">{labels.queue}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--running" />
          <span className="ls-legend__label">{labels.running}</span>
        </li>
      </ul>
    </div>
  );
}

/** The sweet-spot chart: per-stream decode at each queue depth, knee highlighted. */
export function LlmQueueDecodeChart({
  bins,
  knee,
  labels,
}: {
  bins: LlmQueueBin[];
  knee: LlmQueueKnee | null;
  labels: { tps: string; ttft: string; prefill: string; buckets: string; empty: string; knee: string };
}) {
  const usable = bins.filter((b) => b.buckets > 0 && b.perStreamTps != null);
  if (usable.length === 0) return <p className="sp-muted">{labels.empty}</p>;
  const max = Math.max(1, ...usable.map((b) => b.perStreamTps ?? 0));
  const kneeId = knee?.waiting ?? null;

  return (
    <div className="ls-qbins">
      <div className="ls-qbins__plot">
        {bins.map((bin) => {
          const value = bin.perStreamTps;
          const isKnee = kneeId != null && bin.label === kneeId;
          const beyond = kneeId != null && bin.buckets > 0 && bin.label !== kneeId &&
            !(usable.findIndex((b) => b.label === bin.label) <= usable.findIndex((b) => b.label === kneeId));
          return (
            <div
              key={bin.id}
              className={`ls-qbin${isKnee ? " is-knee" : ""}${beyond ? " is-beyond" : ""}${bin.buckets === 0 ? " is-empty" : ""}`}
              title={`${labels.tps} ${fmtNum(value)} · ${labels.ttft} ${fmtSeconds(bin.ttftSeconds)} · ${labels.prefill} ${fmtSeconds(bin.prefillSeconds)} · ${labels.buckets} ${bin.buckets}`}
            >
              <span className="ls-qbin__value">{fmtNum(value)}</span>
              <i
                className="ls-qbin__bar"
                style={{ height: `${value == null ? 0 : (value / max) * 100}%` }}
              />
              <span className="ls-qbin__label">{bin.label}</span>
              <small>{fmtSeconds(bin.ttftSeconds)}</small>
              {isKnee ? <span className="ls-qbin__knee">{labels.knee}</span> : null}
            </div>
          );
        })}
      </div>
      <ul className="ls-legend">
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--decode" />
          <span className="ls-legend__label">{labels.tps}</span>
        </li>
        <li>
          <span aria-hidden className="ls-legend__dot ls-legend__dot--queue" />
          <span className="ls-legend__label">{labels.ttft}</span>
        </li>
      </ul>
    </div>
  );
}
