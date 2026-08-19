import { useEffect, useState } from "react";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay } from "../../api/types";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

export function LlmDailyChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const [days, setDays] = useState<LlmDailyDay[] | null>(null);

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
  const max = Math.max(1, ...decodeVals, ...prefillVals);
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

  return (
    <div className="border-t border-border pt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          Daily peak tok/s
        </span>
        <span className="text-[10px] text-muted">
          {hasSplit ? "decode · uncached prefill" : "decode · prefill"} · 14d
        </span>
      </div>
      {!busy ? (
        <p className="text-[10px] text-muted">No busy samples in the last 14 days.</p>
      ) : (
        <svg
          width={CHART_W}
          height={CHART_H}
          className="block max-w-full"
          role="img"
          aria-label="Daily peak decode and prefill tokens per second"
        >
          {days.map((d, i) => {
            const x0 = i * slot;
            const decH = ((d.decodeMax || 0) / max) * (CHART_H - 2);
            const pref = hasSplit ? d.uncachedPrefillMax || 0 : d.prefillMax || 0;
            const prefH = (pref / max) * (CHART_H - 2);
            const title = [
              d.date,
              `decode peak ${fmt(d.decodeMax)} (avg ${fmt(d.decodeAvg)})`,
              hasSplit
                ? `uncached prefill peak ${fmt(d.uncachedPrefillMax)} (avg ${fmt(d.uncachedPrefillAvg)})`
                : `prefill peak ${fmt(d.prefillMax)} (avg ${fmt(d.prefillAvg)})`,
              hasSplit
                ? `cached prefill peak ${fmt(d.cachedPrefillMax)} (avg ${fmt(d.cachedPrefillAvg)})`
                : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <g key={d.date}>
                <title>{title}</title>
                <rect
                  x={x0}
                  y={CHART_H - decH}
                  width={barW}
                  height={decH}
                  fill="var(--color-accent)"
                  opacity={0.9}
                />
                <rect
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
      )}
    </div>
  );
}
