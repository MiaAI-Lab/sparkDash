import { useEffect, useState } from "react";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay } from "../../api/types";

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
  const prefillOf = (d: LlmDailyDay) => (hasSplit ? d.uncachedPrefillMax || 0 : d.prefillMax || 0);
  const max = Math.max(1, ...days.map((d) => d.decodeMax || 0), ...days.map(prefillOf));
  const peak = Math.max(0, ...days.map((d) => d.decodeMax || 0));

  const busy = days.some((d) => (d.decodeMax || 0) > 0 || prefillOf(d) > 0 || (d.prefillMax || 0) > 0);
  const last = days.length - 1;
  const short = (iso: string) => {
    const t = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(t.getTime())
      ? iso
      : t.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };

  return (
    <div className="sp-section">
      <div className="sp-section__head">
        <span className="eyebrow">Daily peak tok/s</span>
        <span className="sp-muted">
          {hasSplit ? "decode · uncached prefill" : "decode · prefill"} · 14d
          {busy ? ` · peak ${fmt(peak)}` : ""}
        </span>
      </div>
      {!busy ? (
        <p className="sp-muted">No busy samples in the last 14 days.</p>
      ) : (
        <>
          <div className="sp-bars" role="img" aria-label="Daily peak decode and prefill tokens per second">
            {days.map((d, i) => {
              const title = [
                d.date,
                `decode peak ${fmt(d.decodeMax)} (avg ${fmt(d.decodeAvg)})`,
                hasSplit
                  ? `uncached prefill peak ${fmt(d.uncachedPrefillMax)} (avg ${fmt(d.uncachedPrefillAvg)})`
                  : `prefill peak ${fmt(d.prefillMax)} (avg ${fmt(d.prefillAvg)})`,
                hasSplit ? `cached prefill peak ${fmt(d.cachedPrefillMax)} (avg ${fmt(d.cachedPrefillAvg)})` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={d.date} className={`sp-bars__day ${i === last ? "is-today" : ""}`} title={title}>
                  <i
                    className="sp-bars__bar sp-bars__bar--decode"
                    style={{ height: `${Math.max(3, ((d.decodeMax || 0) / max) * 100)}%` }}
                  />
                  <i
                    className="sp-bars__bar sp-bars__bar--prefill"
                    style={{ height: `${Math.max(3, (prefillOf(d) / max) * 100)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="sp-axis mono">
            <span>{short(days[0].date)}</span>
            <span>Today</span>
          </div>
        </>
      )}
    </div>
  );
}
