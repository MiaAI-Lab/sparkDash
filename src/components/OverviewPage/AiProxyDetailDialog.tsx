import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchAiProxyObserverUrl,
  fetchAiProxyStats,
} from "../../api/client";
import type { AiProxyModelStat, AiProxyStats } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { DatePicker, formatCzDate, formatCzDateWithDay } from "../ui/DatePicker";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ProxyIcon,
} from "../ui/icons";

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

/** Lock body scroll while the modal is open (important on iOS). */
function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function tokenBarWidth(used: number, max: number): number {
  return max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
}

function toDateStr(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function todayStr(): string {
  return toDateStr(new Date());
}

type DatePreset = "today" | "week" | "month" | "prevMonth" | "all";

const DATE_PRESETS: Array<{ key: DatePreset; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "Current week" },
  { key: "month", label: "Current month" },
  { key: "prevMonth", label: "Previous month" },
  { key: "all", label: "All time" },
];

/** Monday-based start of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = copy.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // shift to Monday
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Resolve a preset to an inclusive [start, end] YYYY-MM-DD range. */
function presetRange(
  preset: DatePreset
): { startDate: string; endDate: string; label: string } {
  const end = new Date();
  const endStr = toDateStr(end);
  switch (preset) {
    case "today":
      return { startDate: endStr, endDate: endStr, label: "Today" };
    case "week": {
      // Full 7-day span starting Monday.
      const start = startOfWeek(end);
      const weekEnd = new Date(start);
      weekEnd.setDate(weekEnd.getDate() + 6); // Monday + 6 = Sunday
      return {
        startDate: toDateStr(start),
        endDate: toDateStr(weekEnd),
        label: "Current week",
      };
    }
    case "month": {
      const start = new Date(end.getFullYear(), end.getMonth(), 1);
      return { startDate: toDateStr(start), endDate: endStr, label: "Current month" };
    }
    case "prevMonth": {
      const start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
      const last = new Date(end.getFullYear(), end.getMonth(), 0);
      return {
        startDate: toDateStr(start),
        endDate: toDateStr(last),
        label: "Previous month",
      };
    }
    case "all":
      // Far enough back to cover the proxy's history; API clamps to what it has.
      return { startDate: "2020-01-01", endDate: endStr, label: "All time" };
  }
}

function SummaryCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface-elevated/60 px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-tabular text-lg font-bold leading-tight ${tone ?? "text-text"} truncate`}>{value}</span>
      {sub && <span className="truncate text-[10px] text-muted">{sub}</span>}
    </div>
  );
}

function cachePct(cached: number, input: number): string | null {
  return input > 0 ? `${Math.min(100, Math.round((cached / input) * 100))}% of input` : null;
}

function ModelBreakdownTable({
  rows,
  maxInput,
  maxOutput,
  maxCached,
}: {
  rows: AiProxyModelStat[];
  maxInput: number;
  maxOutput: number;
  maxCached: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted">
            <th className="py-1 pr-3 font-normal">Model</th>
            <th className="py-1 pr-3 font-normal">Requests</th>
            <th className="py-1 pr-3 font-normal">Input</th>
            <th className="py-1 pr-3 font-normal" title="Input tokens served from the prompt cache">
              Cached
            </th>
            <th className="py-1 pr-3 font-normal">Output</th>
            <th className="py-1 text-right font-normal">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cached = row.cached_tokens ?? 0;
            const pct = cachePct(cached, row.input_tokens);
            return (
              <tr key={row.model} className="border-t border-border/60">
                <td className="max-w-[10rem] truncate py-1.5 pr-3 text-text" title={row.model}>
                  {row.model}
                </td>
                <td className="py-1.5 pr-3 font-tabular text-text">
                  {row.request_count.toLocaleString()}
                </td>
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-border">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${tokenBarWidth(row.input_tokens, maxInput)}%` }} />
                    </div>
                    <span className="font-tabular text-xs text-muted">{formatTokens(row.input_tokens)}</span>
                  </div>
                </td>
                <td className="py-1.5 pr-3" title={pct ?? undefined}>
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-border">
                      <div className="h-full rounded-full bg-bar" style={{ width: `${tokenBarWidth(cached, maxCached)}%` }} />
                    </div>
                    <span className="font-tabular text-xs text-muted">{formatTokens(cached)}</span>
                  </div>
                </td>
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-border">
                      <div className="h-full rounded-full bg-success" style={{ width: `${tokenBarWidth(row.output_tokens, maxOutput)}%` }} />
                    </div>
                    <span className="font-tabular text-xs text-muted">{formatTokens(row.output_tokens)}</span>
                  </div>
                </td>
                <td className="py-1.5 text-right font-tabular text-text">
                  {formatTokens(row.total_tokens)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyBreakdownTable({ stats }: { stats: AiProxyStats }) {
  // The plan collapses the daily breakdown to a single day. Sum by period so we
  // show one row per day with model chips. For today's range that's one row.
  const byPeriod = new Map<string, typeof stats.byModel>();
  for (const row of stats.daily) {
    const list = byPeriod.get(row.period) ?? [];
    list.push(row);
    byPeriod.set(row.period, list);
  }
  const periods = [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-2">
      {periods.map(([period, rows]) => {
        const total = rows.reduce((n, r) => n + r.total_tokens, 0);
        const maxInput = Math.max(0, ...rows.map((r) => r.input_tokens));
        const maxOutput = Math.max(0, ...rows.map((r) => r.output_tokens));
        const maxCached = Math.max(0, ...rows.map((r) => r.cached_tokens ?? 0));
        return (
          <div key={period} className="rounded-md border border-border bg-surface-elevated/40">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
              <span className="text-xs font-semibold text-text-strong">
                {formatCzDateWithDay(period)}
              </span>
              <span className="font-tabular text-xs text-muted">
                {formatTokens(total)} total
              </span>
            </div>
            <div className="px-3 py-2">
              <ModelBreakdownTable rows={rows} maxInput={maxInput} maxOutput={maxOutput} maxCached={maxCached} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface AiProxyDetailDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Full AI Proxy statistics dialog (same data as the proxy statistics page,
 * restyled to spark). Supports presets and a custom date range; fetches the
 * selected range on open and whenever the range changes.
 */
export function AiProxyDetailDialog({ open, onClose }: AiProxyDetailDialogProps) {
  const { mounted, visible } = useModalPresence(open);
  useEscape(onClose, open && mounted);
  useBodyScrollLock(open && mounted);

  const [stats, setStats] = useState<AiProxyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [observerUrl, setObserverUrl] = useState<string | null>(null);

  // Active applied range (drives the fetch). `custom` = user-picked dates.
  const [preset, setPreset] = useState<DatePreset | "custom">("today");
  const [startDate, setStartDate] = useState<string>(todayStr());
  const [endDate, setEndDate] = useState<string>(todayStr());
  // Draft custom range (edited in the inputs, applied on Apply).
  const [draftStart, setDraftStart] = useState<string>(todayStr());
  const [draftEnd, setDraftEnd] = useState<string>(todayStr());

  const applyPreset = (key: DatePreset) => {
    const { startDate: s, endDate: e } = presetRange(key);
    setPreset(key);
    setStartDate(s);
    setEndDate(e);
    setDraftStart(s);
    setDraftEnd(e);
  };

  const applyCustomRange = () => {
    if (!draftStart || !draftEnd) return;
    if (draftStart > draftEnd) {
      setError("Start date must be on or before end date");
      return;
    }
    setPreset("custom");
    setStartDate(draftStart);
    setEndDate(draftEnd);
  };

  // Move the applied range forward/back by the length of the current span.
  // Single-day ranges step by one day (08-20 → 08-19 / 08-21).
  const shiftRange = (direction: 1 | -1) => {
    if (!startDate || !endDate) return;
    const spanMs =
      new Date(`${endDate}T00:00:00`).getTime() -
      new Date(`${startDate}T00:00:00`).getTime();
    const stepMs = spanMs > 0 ? spanMs : 24 * 60 * 60 * 1000; // 1 day
    const newStart = toDateStr(
      new Date(new Date(`${startDate}T00:00:00`).getTime() + direction * stepMs)
    );
    const newEnd = toDateStr(
      new Date(new Date(`${endDate}T00:00:00`).getTime() + direction * stepMs)
    );
    setPreset("custom");
    setStartDate(newStart);
    setEndDate(newEnd);
    setDraftStart(newStart);
    setDraftEnd(newEnd);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchAiProxyObserverUrl()
      .then((r) => {
        if (!cancelled) setObserverUrl(r.url);
      })
      .catch(() => {
        // fallback below
      });
    void fetchAiProxyStats(startDate, endDate)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startDate, endDate]);

  if (!mounted) return null;

  const totals = stats?.totals ?? null;
  const maxInput = Math.max(0, ...(stats?.byModel ?? []).map((r) => r.input_tokens));
  const maxOutput = Math.max(0, ...(stats?.byModel ?? []).map((r) => r.output_tokens));
  const maxCached = Math.max(0, ...(stats?.byModel ?? []).map((r) => r.cached_tokens ?? 0));

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet modal-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-proxy-detail-title"
      >
        <header className="modal-sheet__header">
          <div className="flex items-center gap-2">
            <ProxyIcon className="h-4 w-4 shrink-0 text-accent" />
            <span>AI Proxy statistics</span>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs font-normal text-muted">
            <span className="rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-xs font-medium text-accent">
              {preset === "custom" ? "Custom" : presetRange(preset).label}
            </span>
            {startDate === endDate
              ? formatCzDate(startDate)
              : `${formatCzDate(startDate)} → ${formatCzDate(endDate)}`}
            {observerUrl && (
              <>
                <a
                  href={`${observerUrl}/statistics`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                >
                  Open statistics
                  <ExternalLinkIcon className="h-3 w-3" />
                </a>
                <a
                  href={observerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  Observer
                  <ExternalLinkIcon className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
        </header>

        <div className="modal-sheet__body">
          {/* Period filter */}
          <div className="mb-4 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {DATE_PRESETS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
                    preset === key
                      ? "border-accent/50 bg-accent/15 text-accent"
                      : "border-border text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => shiftRange(-1)}
                aria-label="Shift range earlier by current span"
                title="Shift range earlier by current span"
                className="rounded-md border border-border bg-surface-elevated px-1.5 py-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <ChevronLeftIcon className="h-3.5 w-3.5" />
              </button>
              <DatePicker
                value={draftStart}
                max={draftEnd || undefined}
                onChange={setDraftStart}
                ariaLabel="Start date"
              />
              <span className="text-xs text-muted">→</span>
              <DatePicker
                value={draftEnd}
                min={draftStart || undefined}
                onChange={setDraftEnd}
                ariaLabel="End date"
              />
              <button
                type="button"
                onClick={() => shiftRange(1)}
                aria-label="Shift range later by current span"
                title="Shift range later by current span"
                className="rounded-md border border-border bg-surface-elevated px-1.5 py-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <ChevronRightIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={applyCustomRange}
                disabled={!draftStart || !draftEnd || (draftStart === startDate && draftEnd === endDate)}
                className="rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
              >
                Apply
              </button>
            </div>
          </div>

          {loading && !totals && !error && (
            <p className="text-xs text-muted">Loading statistics…</p>
          )}

          {error && !loading && (
            <div className="rounded-md border border-warning/35 bg-warning/10 px-3 py-2.5">
              <p className="text-xs font-medium text-warning">
                Couldn't load statistics
              </p>
              <p className="mt-1 break-words text-xs text-muted">{error}</p>
            </div>
          )}

          {!error && totals && (
            <div className="space-y-4">
              {loading && (
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
                  Updating…
                </p>
              )}
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                <SummaryCard
                  label="Requests"
                  value={totals.request_count.toLocaleString()}
                  tone="text-accent"
                />
                <SummaryCard
                  label="Input tokens"
                  value={formatTokens(totals.input_tokens)}
                  tone="text-text"
                />
                <SummaryCard
                  label="Cached tokens"
                  value={formatTokens(totals.cached_tokens ?? 0)}
                  tone="text-bar"
                  sub={cachePct(totals.cached_tokens ?? 0, totals.input_tokens) ?? undefined}
                />
                <SummaryCard
                  label="Output tokens"
                  value={formatTokens(totals.output_tokens)}
                  tone="text-success"
                />
                <SummaryCard
                  label="Total tokens"
                  value={formatTokens(totals.total_tokens)}
                  tone="text-warning"
                />
              </div>

              {/* Breakdown by model */}
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  Breakdown by model
                </h3>
                {stats && stats.byModel.length > 0 ? (
                  <ModelBreakdownTable
                    rows={stats.byModel}
                    maxInput={maxInput}
                    maxOutput={maxOutput}
                    maxCached={maxCached}
                  />
                ) : (
                  <p className="text-xs text-muted">No requests in this period.</p>
                )}
              </section>

              {/* Daily breakdown */}
              {stats && stats.daily.length > 0 && (
                <section>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                    Daily breakdown
                  </h3>
                  <DailyBreakdownTable stats={stats} />
                </section>
              )}
            </div>
          )}
        </div>

        <div className="modal-sheet__footer">
          <p className="text-xs text-muted">
            Data relayed by sparkDash from the AI proxy observer API ({observerUrl ?? `:3001/observer`}).
          </p>
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
