import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay } from "../../api/types";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * The y-axis top label: the value a full-height bar stands for. Prefill peaks
 * run to tens of thousands, so large values go compact (`50k tok/s`).
 */
export function formatAxisMax(max: number): string {
  if (max >= 1_000_000) return `${(max / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tok/s`;
  if (max >= 10_000) return `${(max / 1000).toFixed(0)}k tok/s`;
  if (max >= 1_000) return `${(max / 1000).toFixed(1).replace(/\.0$/, "")}k tok/s`;
  return `${fmt(max)} tok/s`;
}

/**
 * Bar height for one value on its own series' scale. Decode and prefill are
 * scaled independently: a 50k tok/s prefill peak next to a 200 tok/s decode
 * peak would otherwise flatten every decode bar to a fraction of a pixel.
 */
export function barHeight(value: number, seriesMax: number, height: number): number {
  if (!(seriesMax > 0) || !(value > 0)) return 0;
  return (Math.min(value, seriesMax) / seriesMax) * height;
}

type DailyTooltipCopy = {
  decode: (peak: string, average: string) => string;
  prefill: (peak: string, average: string) => string;
  uncachedPrefill: (peak: string, average: string) => string;
  cachedPrefill: (peak: string, average: string) => string;
};

const DEFAULT_TOOLTIP_COPY: DailyTooltipCopy = {
  decode: (peak, average) => `Decode peak ${peak} tok/s (avg ${average})`,
  prefill: (peak, average) => `Prefill peak ${peak} tok/s (avg ${average})`,
  uncachedPrefill: (peak, average) => `Uncached prefill peak ${peak} tok/s (avg ${average})`,
  cachedPrefill: (peak, average) => `Cached prefill peak ${peak} tok/s (avg ${average})`,
};

function tooltipLine(
  template: (peak: string, average: string) => string,
  peak: number | null,
  average: number | null
): string {
  return template(fmt(peak), fmt(average));
}

/** Tooltip lines for one day: date, decode peak, prefill peak(s). */
export function dailyTooltipLines(
  day: LlmDailyDay,
  hasSplit: boolean,
  copy: DailyTooltipCopy = DEFAULT_TOOLTIP_COPY
): string[] {
  return [
    day.date,
    tooltipLine(copy.decode, day.decodeMax, day.decodeAvg),
    hasSplit
      ? tooltipLine(copy.uncachedPrefill, day.uncachedPrefillMax, day.uncachedPrefillAvg)
      : tooltipLine(copy.prefill, day.prefillMax, day.prefillAvg),
    hasSplit
      ? tooltipLine(copy.cachedPrefill, day.cachedPrefillMax, day.cachedPrefillAvg)
      : null,
  ].filter((line): line is string => line != null);
}

export function LlmDailyChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const { t } = useTranslation("spark");
  const [days, setDays] = useState<LlmDailyDay[] | null>(null);
  /** Day under the pointer or keyboard cursor; null hides the tooltip. */
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const tooltipId = useId();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmDaily(sparkId, llmPort, 14)
        .then((res) => {
          if (!cancelled) setDays(res.days || []);
        })
        .catch(() => {
          if (!cancelled) setDays([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId, llmPort]);

  if (!days || days.length === 0) return null;

  const hasSplit = days.some((d) => d.uncachedPrefillMax != null);
  const decodeVals = days.map((d) => d.decodeMax || 0);
  const prefillVals = days.map((d) =>
    hasSplit ? d.uncachedPrefillMax || 0 : d.prefillMax || 0
  );
  // Each series on its own 14-day scale (see barHeight).
  const decodeMax = Math.max(0, ...decodeVals);
  const prefillMax = Math.max(0, ...prefillVals);
  const prefillName = hasSplit ? t("llmDaily.uncachedPrefill") : t("llmDaily.prefill");
  const axisLabel = (m: number) => (m > 0 ? formatAxisMax(m) : "—");
  const tooltipCopy: DailyTooltipCopy = {
    decode: (peak, average) => t("llmDaily.tooltip.decode", { peak, average }),
    prefill: (peak, average) => t("llmDaily.tooltip.prefill", { peak, average }),
    uncachedPrefill: (peak, average) => t("llmDaily.tooltip.uncachedPrefill", { peak, average }),
    cachedPrefill: (peak, average) => t("llmDaily.tooltip.cachedPrefill", { peak, average }),
  };
  const n = days.length;
  const gap = 1.5;
  const slot = CHART_W / n;
  const barW = Math.max(1.5, (slot - gap) / 2);

  const busy = days.some(
    (d) =>
      (d.decodeMax || 0) > 0 ||
      (d.prefillMax || 0) > 0 ||
      (d.uncachedPrefillMax || 0) > 0
  );

  // A refresh can shorten the window; never point past the last day.
  const activeIdx = active != null && active < n ? active : null;
  const activeDay = activeIdx != null ? days[activeIdx] : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = activeIdx ?? n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(n - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next == null) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <div className="sp-section">
      <div className="sp-section__head">
        <span className="eyebrow">{t("llmDaily.title")}</span>
        <span className="sp-muted">
          <span className="text-accent">{t("llmDaily.decode")}</span> ·{" "}
          <span className="text-text opacity-60">{prefillName}</span> · {t("llmDaily.ownScales")} · {t("llmDaily.days", { count: 14 })}
        </span>
      </div>
      {!busy ? (
        <p className="text-[10px] text-muted">{t("llmDaily.empty", { count: 14 })}</p>
      ) : (
        <div className="flex items-stretch gap-1.5">
          <div
            className="flex shrink-0 flex-col justify-between text-right font-tabular text-[9px] leading-none text-muted"
            style={{ height: CHART_H }}
            aria-hidden="true"
          >
            <span className="space-y-0.5">
              <span
                className="block text-accent"
                data-testid="daily-chart-ymax-decode"
                title={t("llmDaily.axis.decodeTitle", { value: axisLabel(decodeMax) })}
              >
                {axisLabel(decodeMax)}
              </span>
              <span
                className="block text-text opacity-60"
                data-testid="daily-chart-ymax-prefill"
                title={t("llmDaily.axis.prefillTitle", { series: `${prefillName[0].toUpperCase()}${prefillName.slice(1)}`, value: axisLabel(prefillMax) })}
              >
                {axisLabel(prefillMax)}
              </span>
            </span>
            <span>0</span>
          </div>
          <div
            className="relative rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
            tabIndex={0}
            role="group"
            aria-label={t("llmDaily.aria.chart", {
              count: n,
              decodeMax: axisLabel(decodeMax),
              prefillName,
              prefillMax: axisLabel(prefillMax),
            })}
            aria-describedby={activeDay ? tooltipId : undefined}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true);
              setActive((cur) => (cur != null && cur < n ? cur : n - 1));
            }}
            onBlur={() => {
              setFocused(false);
              setActive(null);
            }}
            onMouseLeave={() => {
              if (!focused) setActive(null);
            }}
          >
            <svg
              width={CHART_W}
              height={CHART_H}
              className="block max-w-full"
              aria-hidden="true"
            >
              <line
                x1={0}
                x2={CHART_W}
                y1={2.5}
                y2={2.5}
                stroke="var(--color-border)"
                strokeDasharray="2 2"
                strokeWidth={1}
              />
              {days.map((d, i) => {
                const x0 = i * slot;
                const decH = barHeight(d.decodeMax || 0, decodeMax, CHART_H - 2);
                const pref = hasSplit ? d.uncachedPrefillMax || 0 : d.prefillMax || 0;
                const prefH = barHeight(pref, prefillMax, CHART_H - 2);
                return (
                  <g key={d.date} data-day={d.date} onMouseEnter={() => setActive(i)}>
                    {/* Full-height hit area, highlighted for the active day. */}
                    <rect
                      x={x0}
                      y={0}
                      width={slot}
                      height={CHART_H}
                      fill={i === activeIdx ? "var(--color-border)" : "transparent"}
                      opacity={i === activeIdx ? 0.6 : 1}
                    />
                    <rect
                      data-series="decode"
                      x={x0}
                      y={CHART_H - decH}
                      width={barW}
                      height={decH}
                      fill="var(--color-accent)"
                      opacity={0.9}
                    />
                    <rect
                      data-series="prefill"
                      x={x0 + barW + 0.5}
                      y={CHART_H - prefH}
                      width={barW}
                      height={prefH}
                      fill="var(--color-text)"
                      opacity={0.45}
                    />
                  </g>
                );
              })}
            </svg>
            {activeDay && activeIdx != null && (
              <div
                id={tooltipId}
                role="status"
                className="pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[16rem] rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-[10px] text-text shadow-lg"
                style={
                  activeIdx < n / 2
                    ? { left: activeIdx * slot }
                    : { right: CHART_W - (activeIdx + 1) * slot }
                }
              >
                {dailyTooltipLines(activeDay, hasSplit, tooltipCopy).map((line, i) => (
                  <div
                    key={i}
                    className={i === 0 ? "font-semibold text-text-strong" : "font-tabular"}
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
