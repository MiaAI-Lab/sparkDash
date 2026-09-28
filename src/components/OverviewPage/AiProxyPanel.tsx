import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAiProxyActiveRequests,
  fetchAiProxyObserverUrl,
  fetchAiProxyStats,
  fetchAiProxyStreams,
  killAiProxyRequest,
  killAiProxyStream,
} from "../../api/client";
import type {
  AiProxyActiveRequest,
  AiProxyStats,
  AiProxyStream,
} from "../../api/types";
import type { LlmMetrics } from "../../api/types";
import type { ProxyLive } from "../../shared/idleCounts";
import { Panel } from "../ui/Panel";
import { ChartIcon, ExternalLinkIcon, PowerOffIcon } from "../ui/icons";
import { AiProxyDetailDialog } from "./AiProxyDetailDialog";

const POLL_MS = 5000;

/** Aggregate available LLM throughput (mirrors the spark boxes' tok/s + prefill). */
function llmThroughput(metrics: LlmMetrics[] | undefined): {
  generationTps: number | null;
  prefillTps: number | null;
} {
  const avail = (metrics ?? []).filter((m) => m.available);
  if (avail.length === 0) return { generationTps: null, prefillTps: null };
  return {
    generationTps: avail.reduce((s, m) => s + (m.generationTps || 0), 0),
    prefillTps: avail.reduce((s, m) => s + (m.prefillTps || 0), 0),
  };
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function ageLabel(startTime: number): string {
  const sec = Math.max(0, Math.round((Date.now() - startTime) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rem = sec - m * 60;
  return `${m}m ${rem}s`;
}

type RunningItem =
  | (AiProxyStream & { kind: "stream" })
  | (AiProxyActiveRequest & { kind: "request" });

/**
 * A stream's visual state:
 * - "streaming": any data has arrived — answer text, reasoning/thinking text,
 *   or SSE chunks. The proxy streams reasoning tokens before the answer, so a
 *   stream with textLength 0 can still be actively outputting (thinking).
 *   (orange, like the proxy)
 * - "prefill": truly idle — no chunks and no chars yet (white)
 * - "request": a non-streaming request (blue)
 */
type StreamState = "streaming" | "prefill" | "request";

function streamState(item: RunningItem): StreamState {
  if (item.kind !== "stream") return "request";
  const text = item.textLength ?? 0;
  const thinking = item.thinkingLength ?? 0;
  const chunks = item.chunksReceived ?? 0;
  return text > 0 || thinking > 0 || chunks > 0 ? "streaming" : "prefill";
}

/** Sum of all output characters (answer text + tool calls + thinking). */
function outputChars(item: RunningItem): number {
  if (item.kind !== "stream") return 0;
  return (
    (item.textLength ?? 0) +
    (item.toolCallsChars ?? 0) +
    (item.thinkingLength ?? 0)
  );
}

function formatChars(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function RequestRow({
  item,
  onKill,
  killing,
}: {
  item: RunningItem;
  onKill: (id: string) => void;
  killing: boolean;
}) {
  const kind = item.kind;
  const state = streamState(item);
  const dotColor =
    state === "streaming"
      ? "var(--color-warning)"
      : state === "prefill"
        ? "var(--color-text)"
        : "var(--color-accent)";
  const label =
    state === "streaming"
      ? "Streaming"
      : state === "prefill"
        ? "Prefilling — no output yet"
        : "Non-streaming request";
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor, boxShadow: `0 0 6px ${dotColor}` }}
        title={label}
      />
      <span
        className="min-w-0 flex-1 truncate text-xs text-text"
        title={
          item.kind === "stream"
            ? `${label} · ${item.model ?? "unknown model"}`
            : item.model ?? "unknown model"
        }
      >
        {item.model ?? "unknown model"}
      </span>
      <div className="flex shrink-0 items-center gap-1 font-tabular text-xs text-muted">
        {item.kind === "stream" && (
          <span
            className="whitespace-nowrap tabular-nums"
            title={`${formatChars(outputChars(item))} output chars`}
          >
            {formatChars(outputChars(item))} chars
          </span>
        )}
        <span
          className="w-16 whitespace-nowrap text-right tabular-nums"
          title={`Started ${new Date(item.startTime).toLocaleTimeString()}`}
        >
          {ageLabel(item.startTime)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onKill(item.id)}
        disabled={killing}
        aria-label={`Kill ${kind} request`}
        title={`Kill ${kind} request`}
        className="rounded p-1 text-muted transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-40"
      >
        <PowerOffIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Compact "AI Proxy" box below the spark grid. Shows live running requests
 * (with kill buttons), a jump-to-observer link, and today's statistics.
 * Polls the bridge every POLL_MS. Offline/graceful when the proxy is down.
 *
 * Optionally receives LLM metrics from the sparks (the AI Proxy sits in front
 * of the cluster LLMs) so it can show the same tok/s + prefill as the spark
 * boxes — the spark boxes' own footer is hidden via CSS.
 */
export function AiProxyPanel({
  llmMetrics,
  onIdleCounts,
}: {
  llmMetrics?: LlmMetrics[];
  /** Publish this poll's live idle counts so AutoPower can display them without re-querying. */
  onIdleCounts?: (counts: ProxyLive) => void;
}) {
  const [streams, setStreams] = useState<AiProxyStream[]>([]);
  const [requests, setRequests] = useState<AiProxyActiveRequest[]>([]);
  const [stats, setStats] = useState<AiProxyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [observerUrl, setObserverUrl] = useState<string | null>(null);
  // Re-render on each poll so age labels stay current between polls.
  const [, forceTick] = useState(0);
  // Kept in a ref: the poll loop runs in a deps-less effect.
  const idleRef = useRef(onIdleCounts);
  idleRef.current = onIdleCounts;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      // Each endpoint degrades independently: a single upstream failure must
      // not clear the other panels' data, but total failure = proxy down.
      const [s, r, st] = await Promise.all([
        fetchAiProxyStreams().catch(() => null),
        fetchAiProxyActiveRequests().catch(() => null),
        fetchAiProxyStats(todayStr(), todayStr()).catch(() => null),
      ]);
      if (cancelled) return;
      let saw = false;
      if (s) {
        saw = true;
        setStreams(s);
      }
      if (r) {
        saw = true;
        setRequests(r);
      }
      if (st) {
        saw = true;
        setStats(st);
      }
      setError(saw ? null : "AI proxy unreachable — no data");
      // Publish for AutoPower: exact numbers this widget is showing right now.
      idleRef.current?.({
        ok: s != null && r != null,
        streams: s?.length ?? 0,
        requests: r?.length ?? 0,
        at: Date.now(),
      });
      forceTick((t) => t + 1);
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    void fetchAiProxyObserverUrl()
      .then((r) => {
        if (!cancelled) setObserverUrl(r.url);
      })
      .catch(() => {});

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleKill = useCallback(
    async (id: string, kind: "stream" | "request") => {
      setKillingId(id);
      setError(null);
      try {
        if (kind === "stream") {
          await killAiProxyStream(id);
        } else {
          await killAiProxyRequest(id);
        }
        // Optimistically remove so the UI responds even if the next poll lags.
        if (kind === "stream") {
          setStreams((prev) => prev.filter((x) => x.id !== id));
        } else {
          setRequests((prev) => prev.filter((x) => x.id !== id));
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setKillingId(null);
      }
    },
    []
  );

  const allRunning: RunningItem[] = [
    ...streams.map((s) => ({ ...s, kind: "stream" as const })),
    ...requests.map((r) => ({ ...r, kind: "request" as const })),
  ];
  const totals = stats?.totals ?? null;
  const tps = llmThroughput(llmMetrics);
  const online = !error;

  return (
    <>
      <Panel
        title="AI Proxy"
        icon={
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              online ? "bg-success dot-glow-success" : "bg-danger dot-glow-danger"
            }`}
            title={online ? "Proxy online" : "Proxy unreachable"}
          />
        }
        accent
        className="flex flex-col"
        bodyClassName="flex flex-1 flex-col space-y-3"
        actions={
          <div className="flex items-center gap-1.5">
            <a
              href={observerUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              title="Open the AI proxy observer"
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              Observer
            </a>
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              title="Show AI Proxy statistics"
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
            >
              <ChartIcon className="h-3 w-3" />
              Statistics
            </button>
          </div>
        }
      >
        {error ? (
          <div className="space-y-1">
            <p className="text-xs text-warning">AI proxy unreachable</p>
            <p className="break-all text-[11px] text-muted">{error}</p>
          </div>
        ) : allRunning.length > 0 ? (
          <div className="min-h-[10rem] space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Running requests ({allRunning.length})
            </p>
            {allRunning.map((item) => (
              <RequestRow
                key={item.id}
                item={item}
                onKill={(id) => void handleKill(id, item.kind)}
                killing={killingId === item.id}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No active requests.</p>
        )}

        {/* Bottom-anchored stat footers — LLM throughput (tok/s + prefill,
            cloned from the spark boxes) directly above today's reqs + total
            tokens, pinned together at the bottom of the panel. */}
        <div className="mt-auto space-y-3">
          {tps.generationTps !== null && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
              <div className="text-center">
                <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                  {tps.generationTps.toFixed(0)}
                </span>
                <span className="text-sm font-normal text-muted"> tok/s</span>
              </div>
              <div className="border-l border-border text-center">
                <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                  {tps.prefillTps !== null ? tps.prefillTps.toFixed(0) : "—"}
                </span>
                <span className="text-sm font-normal text-muted"> prefill</span>
              </div>
            </div>
          )}
          {/* Spark-style footer: today's requests + total + cached tokens */}
          <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
            <div className="text-center">
              <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                {totals ? totals.request_count.toLocaleString() : "—"}
              </span>
              <span className="text-sm font-normal text-muted" title="Requests today"> reqs</span>
            </div>
            <div className="border-l border-border text-center">
              <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                {totals ? formatTokens(totals.total_tokens) : "—"}
              </span>
              <span className="text-sm font-normal text-muted" title="Total tokens today"> tok</span>
            </div>
            <div className="border-l border-border text-center">
              <span className="font-tabular text-[28px] font-bold leading-none text-bar">
                {totals ? formatTokens(totals.cached_tokens ?? 0) : "—"}
              </span>
              <span
                className="text-sm font-normal text-muted"
                title={
                  totals && totals.input_tokens > 0
                    ? `Cached tokens today — ${Math.min(100, Math.round(((totals.cached_tokens ?? 0) / totals.input_tokens) * 100))}% of input served from the prompt cache`
                    : "Cached tokens today — input tokens served from the prompt cache"
                }
              > cache</span>
            </div>
          </div>
        </div>
      </Panel>
      <AiProxyDetailDialog open={detailOpen} onClose={() => setDetailOpen(false)} />
    </>
  );
}

function todayStr(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
