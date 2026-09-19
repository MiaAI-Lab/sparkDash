import { useCallback, useEffect, useMemo, useState } from "react";
import { TerminalCard } from "./TerminalCard";
import { LiveDetail } from "./LiveDetail";

/**
 * Live engine traffic (F717/F718): the real requests hitting this Spark's model — every agent and
 * app — rendered as showcase terminals (IN = the last user message, OUT = the streamed answer),
 * as recorded by the glm-tap relay in front of the engine. Not the showcase's sample prompts.
 */
type LiveReq = {
  id: number;
  t0: number;
  client: string;
  model?: string;
  stream?: boolean;
  n_messages?: number;
  n_tool_results?: number;
  tools?: number;
  thinking?: boolean | null;
  effort?: string | null;
  prompt_chars?: number;
  last_user?: string;
  last_role?: string | null;
  status: string;
  chunks: number;
  out_tokens?: number | null;
  finish?: string | null;
  ttft?: number | null;
  tok_s?: number | null;
  tok_s_live?: number | null;
  wall?: number;
  elapsed?: number;
  out_text?: string;
  reasoning_text?: string;
  out_text_len?: number;
  reasoning_text_len?: number;
  error?: string;
  parse_error?: string;
};

type LivePayload = {
  available: boolean;
  reason?: string;
  host?: string;
  tapPort?: number;
  clientNames?: Record<string, string>;
  now?: number;
  active?: LiveReq[];
  recent?: LiveReq[];
  stats?: { requests: number; chat: number; errors: number; uptime: number };
};

let CLIENT_NAMES: Record<string, string> = {};

/** Label a client IP; the map comes from the server (`config/live-clients.json`), falling back to the IP. */
export function who(ip: string): string {
  return CLIENT_NAMES[ip] ?? ip;
}

function termStatus(r: LiveReq): string {
  if (r.status === "prefill") return "pending";
  if (r.status === "streaming") return "streaming";
  if (r.status === "done") return "completed";
  if (r.status === "aborted" || r.status === "disconnected") return "cancelled";
  return r.status;
}

function optimalGridCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 9) return 3;
  if (n <= 12) return 4;
  if (n <= 16) return 4;
  if (n <= 20) return 5;
  if (n <= 25) return 5;
  return 6;
}

export interface LiveCounts {
  prefill: number;
  output: number;
  running: number;
}

export interface LiveRequestsPanelProps {
  sparkId: string;
  terminalCount: number;
  onCounts?: (c: LiveCounts) => void;
  /** vLLM `num_requests_waiting` from the engine — the newest no-token requests are the queued ones. */
  engineWaiting?: number | null;
}

export function LiveRequestsPanel({ sparkId, terminalCount, onCounts, engineWaiting }: LiveRequestsPanelProps) {
  const [data, setData] = useState<LivePayload | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Record<number, number>>({});
  const [detailId, setDetailId] = useState<number | null>(null);

  // The pop-out is a history entry: the system/browser Back (phone gesture, TV remote, mouse
  // back button) closes it and lands on the live grid instead of leaving the showcase page.
  const openDetail = useCallback((id: number) => {
    try {
      window.history.pushState({ liveDetail: id }, "", window.location.href);
    } catch {
      /* ignore */
    }
    setDetailId(id);
  }, []);
  const closeDetail = useCallback(() => {
    if (window.history.state && window.history.state.liveDetail != null) {
      window.history.back();          // popstate handler below clears the state
    } else {
      setDetailId(null);
    }
  }, []);
  useEffect(() => {
    const onPop = () => {
      if (!(window.history.state && window.history.state.liveDetail != null)) setDetailId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (!paused) {
        try {
          const r = await fetch(`/api/sparks/${encodeURIComponent(sparkId)}/llm/live-requests?n=${Math.max(terminalCount, 8) + 60}&tail=6000`);
          const j = (await r.json()) as LivePayload;
          if (!cancelled) {
            // A transient tap/proxy hiccup must not blank the board: keep the last good payload
            // and only surface the problem in the bar text.
            if (j.clientNames) CLIENT_NAMES = j.clientNames;
            if (j.available || !data?.available) setData(j);
            setError(j.available ? null : `tap: ${j.reason ?? "unavailable"} (showing last good data)`);
            setPeaks((prev) => {
              const next = { ...prev };
              for (const x of [...(j.active ?? []), ...(j.recent ?? [])]) {
                const v = x.tok_s_live ?? x.tok_s ?? 0;
                if (v > (next[x.id] ?? 0)) next[x.id] = v;
              }
              return next;
            });
          }
        } catch (err) {
          if (!cancelled) setError(String((err as Error)?.message ?? err));
        }
      }
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sparkId, paused, terminalCount]);

  // Fill the terminals: in-flight requests first (oldest first so a card keeps its slot), then the
  // most recent finished ones, up to the terminal count chosen in the bar above.
  // Continuous auto-sizing (F723): never hide a session that is in flight — the grid grows past the
  // terminal-count baseline while the engine is busy and shrinks back as requests finish.
  const slots = useMemo(() => {
    const active = [...(data?.active ?? [])].sort((a, b) => a.t0 - b.t0);
    const recent = (data?.recent ?? []).filter((r) => !active.some((a) => a.id === r.id));
    // Health probes ("ok", "2+2", one message, a few tokens) must not push real conversations off the
    // board: fill finished slots with substantive requests first, probes only if room remains.
    const isProbe = (r: LiveReq) => (r.n_messages ?? 0) <= 1 && (r.out_tokens ?? 0) <= 8 && (r.prompt_chars ?? 0) < 200;
    const substantive = recent.filter((r) => !isProbe(r));
    const probes = recent.filter(isProbe);
    const n = Math.min(32, Math.max(terminalCount, active.length));
    return [...active, ...substantive, ...probes].slice(0, n);
  }, [data, terminalCount]);

  // Phase per in-flight request. The tap knows "no token yet" vs "streaming"; the engine knows how
  // many requests are still waiting for a slot — those are the NEWEST no-token requests.
  const phaseOf = useMemo(() => {
    const noToken = (data?.active ?? []).filter((r) => !r.chunks).sort((a, b) => b.t0 - a.t0);
    const queuedIds = new Set(noToken.slice(0, Math.max(0, engineWaiting ?? 0)).map((r) => r.id));
    return (r: LiveReq): "queued" | "prefill" | "generating" | "done" | "cancelled" => {
      if (r.status === "streaming" || r.status === "prefill") {
        if (r.chunks) return "generating";
        return queuedIds.has(r.id) ? "queued" : "prefill";
      }
      if (r.status === "done") return "done";
      return "cancelled";
    };
  }, [data, engineWaiting]);

  const gridCols = optimalGridCols(Math.max(1, slots.length));
  const gridRows = Math.max(1, Math.ceil(Math.max(1, slots.length) / gridCols));
  const inFlight = data?.active?.length ?? 0;
  const prefillN = (data?.active ?? []).filter((r) => r.status === "prefill" || (r.status === "streaming" && !r.chunks)).length;
  const outputN = inFlight - prefillN;
  useEffect(() => {
    onCounts?.({ prefill: prefillN, output: outputN, running: inFlight });
  }, [prefillN, outputN, inFlight, onCounts]);

  return (
    <>
      <div className="live-requests__bar">
        <span className="live-requests__title">LIVE — actual engine traffic, not samples</span>
        <span className="live-requests__sub">
          {data?.available
            ? `${inFlight} in flight · ${data.stats?.chat ?? 0} requests since the tap started ${Math.round((data.stats?.uptime ?? 0) / 60)} min ago · tap ${data.host}:${data.tapPort ?? 8890}`
            : data
              ? `no tap on this Spark (${data.reason ?? "unavailable"})`
              : "loading…"}
          {error ? ` · ${error}` : ""}
        </span>
        <button
          type="button"
          className={`showcase-btn showcase-btn--ghost${paused ? " is-active" : ""}`}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <div
        className="showcase-grid"
        style={{
          ["--showcase-cols" as string]: String(gridCols),
          ["--showcase-rows" as string]: String(gridRows),
        }}
      >
        {slots.length === 0 && (
          <TerminalCard
            label="Waiting for the first request…"
            status="pending"
            liveTokPerSec={0}
            peakTokPerSec={0}
            content=""
            reasoning=""
            error={null}
          />
        )}
        {slots.map((r) => {
          const live = r.status === "streaming" || r.status === "prefill";
          const phase = phaseOf(r);
          const tokS = live ? (r.tok_s_live ?? 0) : 0;
          const meta = [
            `${r.n_messages ?? "?"} msgs${r.n_tool_results ? ` · ${r.n_tool_results} tool results` : ""}`,
            r.tools ? `${r.tools} tools` : null,
            r.thinking != null ? `thinking ${r.thinking ? "on" : "off"}${r.effort ? `/${r.effort}` : ""}` : null,
            r.out_tokens != null ? `${r.out_tokens} tok out` : null,
            r.ttft != null ? `ttft ${r.ttft}s` : null,
            r.wall != null ? `${r.wall}s` : live ? `${Math.round(r.elapsed ?? 0)}s` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          const input = (r.last_user ?? "").trim() || (r.parse_error ? `[unparsed: ${r.parse_error}]` : "[no user message]");
          const inLabel = r.last_role === "tool" ? "IN ▶ last user message (this call follows a tool result)" : "IN ▶ last user message";
          const out = (r.out_text ?? "").trim();
          const content = `${inLabel}\n${input}\n\n${"─".repeat(40)}\nOUT ◀ ${r.model ?? "model"}${r.finish ? ` (${r.finish})` : phase === "queued" ? " (queued — waiting for an engine slot)" : phase === "prefill" ? " (prefill — reading the prompt…)" : live ? " (streaming…)" : ""}\n${out || (live ? "…" : r.error ? "" : "[no text — tool call or empty]")}`;
          return (
            <div
              key={r.id}
              className={`live-slot live-slot--${phase}`}
              role="button"
              tabIndex={0}
              title="Open this inquiry full screen (history + current answer)"
              onClick={() => openDetail(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") openDetail(r.id);
              }}
            >
            <TerminalCard
              label={`${who(r.client)} → ${r.model ?? "?"}\n${meta}`}
              status={phase === "generating" ? "streaming" : phase === "done" ? "completed" : phase}
              liveTokPerSec={tokS}
              peakTokPerSec={peaks[r.id] ?? r.tok_s ?? 0}
              content={content}
              reasoning={(r.reasoning_text ?? "").trim()}
              error={r.error ?? null}
            />
            </div>
          );
        })}
      </div>
      {detailId != null && (
        <LiveDetail sparkId={sparkId} reqId={detailId} who={who} onBack={closeDetail} />
      )}
    </>
  );
}
