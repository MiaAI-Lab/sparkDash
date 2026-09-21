import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelShowcase,
  clearShowcaseHistory,
  fetchSparkMetrics,
  fetchSparks,
  getShowcase,
  listShowcase,
  startShowcase,
} from "../../api/client";
import type {
  ShowcaseHistorySummary,
  ShowcaseSessionState,
  SparkConfig,
} from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { BoltIcon } from "../ui/icons";
import { TerminalCard } from "./TerminalCard";
import { LiveRequestsPanel, type LiveCounts } from "./LiveRequestsPanel";
import {
  PROMPT_TYPES,
  pickShowcasePrompts,
  type ShowcasePromptType,
} from "./showcasePrompts";

const POLL_MS = 300;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_PROMPT_TYPE: ShowcasePromptType = "mixed";
const DEFAULT_TEMPERATURE = 0.7;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_TERMINALS = 1;
const MAX_TERMINALS = 32;
const TERMINAL_COUNTS = Array.from(
  { length: MAX_TERMINALS - MIN_TERMINALS + 1 },
  (_, i) => i + MIN_TERMINALS
);

/**
 * Choose a column count that fills the viewport grid with few empty cells
 * and a near-square shape (e.g. 4→2×2, 9→3×3, 8→4×2).
 */
function optimalGridCols(n: number): number {
  const count = Math.max(1, Math.min(MAX_TERMINALS, Math.floor(n)));
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  if (count === 4) return 2;

  const maxCols = Math.min(8, count);
  const ideal = Math.sqrt(count);
  let bestCols = Math.min(maxCols, Math.max(1, Math.round(ideal)));
  let bestScore = Number.POSITIVE_INFINITY;

  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(count / cols);
    const empty = cols * rows - count;
    const score =
      empty * 20 +
      (cols - ideal) ** 2 * 6 +
      (rows - ideal) ** 2 * 6 +
      (rows > cols ? 2 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }
  return bestCols;
}

interface ShowcasePageProps {
  sparkId: string;
}

interface LocalStream {
  streamId: string;
  label: string;
  prompt: string;
  status: string;
  content: string;
  reasoning: string;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  peakTokPerSec: number;
  error: string | null;
}

function readPortQuery(fallback: number): number {
  try {
    const q = new URLSearchParams(window.location.search).get("port");
    if (q == null || q === "") return fallback;
    const n = parseInt(q, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  } catch {
    /* ignore */
  }
  return fallback;
}

function readModelQuery(): string | null {
  try {
    const q = new URLSearchParams(window.location.search).get("model");
    if (q == null || q === "") return null;
    const trimmed = q.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function buildTerminalPlainText(s: LocalStream): string {
  const parts: string[] = [`## ${s.label || s.streamId}`, `status: ${s.status}`];
  if (s.liveTokPerSec > 0 || s.decodeTps > 0 || s.peakTokPerSec > 0) {
    const live = s.liveTokPerSec || s.decodeTps;
    parts.push(
      `tok/s: ${live > 0 ? live.toFixed(1) : "—"}` +
        (s.peakTokPerSec > 0 ? `  peak ${s.peakTokPerSec.toFixed(1)}` : "") +
        (s.ttftMs != null ? `  TTFT ${s.ttftMs.toFixed(0)}ms` : "")
    );
  }
  parts.push("");
  if (s.reasoning) {
    parts.push("### Thinking", s.reasoning, "");
  }
  if (s.content) {
    parts.push("### Answer", s.content);
  }
  if (s.error) {
    parts.push("", `[error] ${s.error}`);
  }
  return parts.join("\n").trimEnd();
}

function buildAllPlainText(
  streams: LocalStream[],
  meta: {
    name: string;
    port: number;
    modelId: string | null;
    serverTps: number | null;
    sessionAvgTps?: number | null;
  }
): string {
  const head = [
    `${meta.name} | prompt showcase`,
    `port ${meta.port}` +
      (meta.modelId ? `  ·  ${meta.modelId}` : "") +
      (meta.sessionAvgTps != null && meta.sessionAvgTps > 0
        ? `  · avg ${meta.sessionAvgTps.toFixed(0)} tok/s/stream`
        : "") +
      (meta.serverTps != null ? `  · server ${meta.serverTps.toFixed(0)} tok/s` : ""),
    "",
  ];
  return [...head, ...streams.map((s) => buildTerminalPlainText(s)), ""]
    .join("\n")
    .trimEnd();
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function fmtTok(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function fmtWait(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60).toString().padStart(2, "0")}s`;
}

export function ShowcasePage({ sparkId }: ShowcasePageProps) {
  const [spark, setSpark] = useState<SparkConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [promptType, setPromptType] = useState<ShowcasePromptType>(DEFAULT_PROMPT_TYPE);
  const [prompts, setPrompts] = useState<string[]>(() =>
    pickShowcasePrompts(DEFAULT_PROMPT_TYPE, 4)
  );
  const [terminalCount, setTerminalCount] = useState(8);   // F723: eight lanes on the 3090s/agents — default to 8 windows
  const [port, setPort] = useState(8888);
  const [modelId, setModelId] = useState<string | null>(() => readModelQuery());
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [thinking, setThinking] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [barVisible, setBarVisible] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [streams, setStreams] = useState<LocalStream[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [serverTps, setServerTps] = useState<number | null>(null);
  const [serverTpsMax, setServerTpsMax] = useState<number | null>(null);
  const [aggregatePeakTps, setAggregatePeakTps] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [liveCounts, setLiveCounts] = useState<LiveCounts>({ prefill: 0, output: 0, running: 0 });
  // The prefill tok/s figure is a 60 s trailing window kept by the tap; it is only a real number once the
  // tap has been up 60 s. Pin the tap's start instant (from its reported uptime) and tick once a second so
  // the tile can count down to the moment the window is full, independent of the poll cadence.
  const tapStartedAtRef = useRef<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (liveCounts.tapUptime == null) { tapStartedAtRef.current = null; return; }
    const est = Date.now() - liveCounts.tapUptime * 1000;
    if (tapStartedAtRef.current == null || Math.abs(tapStartedAtRef.current - est) > 2000) tapStartedAtRef.current = est;
  }, [liveCounts.tapUptime]);
  useEffect(() => {
    if (!liveOpen) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [liveOpen]);
  const prefillWindowSecsLeft = tapStartedAtRef.current == null ? 0 : Math.max(0, Math.ceil(60 - (nowTick - tapStartedAtRef.current) / 1000));
  const [engine, setEngine] = useState<{
    generationTps?: number | null;
    prefillTps?: number | null;
    requestsRunning?: number | null;
    requestsWaiting?: number | null;
    kvCacheUsage?: number | null;
    prefixCacheHitRate?: number | null;
  } | null>(null);
  // Engine-side numbers for the model header while Live is ON (same snapshot the LLM panel uses).
  useEffect(() => {
    if (!liveOpen || !sparkId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const snap = await fetchSparkMetrics(sparkId);
        const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
        const llm = llmList.find((m) => m?.available && m?.modelId) || llmList[0];
        if (!cancelled && llm) {
          setEngine({
            generationTps: llm.generationTps,
            prefillTps: llm.prefillTps,
            requestsRunning: llm.requestsRunning,
            requestsWaiting: llm.requestsWaiting,
            kvCacheUsage: llm.kvCacheUsage,
            prefixCacheHitRate: llm.prefixCacheHitRate,
          });
        }
      } catch {
        /* keep last */
      }
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [liveOpen, sparkId]);
  const [history, setHistory] = useState<ShowcaseHistorySummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);

  const revRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = sessionStatus === "running";
  const controlsLocked = running || starting;

  const llmPorts = useMemo(() => {
    if (!spark) return [8888];
    if (Array.isArray(spark.llmPorts) && spark.llmPorts.length) return spark.llmPorts;
    if (spark.llmPort) return [spark.llmPort];
    return [8888];
  }, [spark]);

  const canRun =
    Boolean(spark) &&
    isLlmMonitoringEnabled(spark!) &&
    !spark!.workerNode &&
    !controlsLocked;

  const displayStreams = useMemo(() => {
    // Keep finished-run results only while the stream count still matches selection.
    if (streams.length > 0 && streams.length === prompts.length) {
      return streams;
    }
    return prompts.map((p, i) => ({
      streamId: String(i),
      label: p.replace(/\s+/g, " ").trim().slice(0, 40),
      prompt: p,
      status: "pending",
      content: "",
      reasoning: "",
      tokenCount: 0,
      ttftMs: null,
      decodeTps: 0,
      liveTokPerSec: 0,
      peakTokPerSec: 0,
      error: null,
    }));
  }, [streams, prompts]);

  /** Sum of per-stream live (or final decode) tok/s — concurrent aggregate throughput. */
  const aggregateTps = useMemo(() => {
    return displayStreams.reduce((sum, s) => {
      const rate =
        s.liveTokPerSec > 0
          ? s.liveTokPerSec
          : s.status === "completed"
            ? s.decodeTps
            : 0;
      return sum + rate;
    }, 0);
  }, [displayStreams]);

  const totalTokens = useMemo(
    () => displayStreams.reduce((sum, s) => sum + (s.tokenCount || 0), 0),
    [displayStreams]
  );

  /** Mean final/live decode tok/s across active streams (session avg per terminal). */
  const sessionAvgTps = useMemo(() => {
    const rates = displayStreams
      .map((s) => {
        if (s.decodeTps > 0) return s.decodeTps;
        if (s.liveTokPerSec > 0) return s.liveTokPerSec;
        return 0;
      })
      .filter((r) => r > 0);
    if (!rates.length) return 0;
    return rates.reduce((sum, r) => sum + r, 0) / rates.length;
  }, [displayStreams]);

  const runFinished =
    sessionStatus != null &&
    sessionStatus !== "running" &&
    sessionStatus !== "pending";

  useEffect(() => {
    if (aggregateTps <= 0) return;
    setAggregatePeakTps((prev) => (aggregateTps > prev ? aggregateTps : prev));
  }, [aggregateTps]);

  useEffect(() => {
    let cancelled = false;
    fetchSparks()
      .then(({ sparks }) => {
        if (cancelled) return;
        const found = sparks.find((s) => s.id === sparkId) || null;
        if (!found) {
          setLoadError("Spark not found");
          setSpark(null);
          return;
        }
        setSpark(found);
        setLoadError(null);
        const ports =
          Array.isArray(found.llmPorts) && found.llmPorts.length
            ? found.llmPorts
            : found.llmPort
              ? [found.llmPort]
              : [8888];
        setPort(readPortQuery(ports[0]));
        const fromQuery = readModelQuery();
        if (fromQuery) setModelId(fromQuery);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.message || "Failed to load Spark");
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId]);

  useEffect(() => {
    if (!sparkId || !spark) return;
    let cancelled = false;
    const ports =
      Array.isArray(spark.llmPorts) && spark.llmPorts.length
        ? spark.llmPorts
        : spark.llmPort
          ? [spark.llmPort]
          : [8888];
    fetchSparkMetrics(sparkId)
      .then((snap) => {
        if (cancelled) return;
        const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
        const portIndex = ports.indexOf(port);
        const llm =
          (portIndex >= 0 ? llmList[portIndex] : null) ||
          llmList.find((m) => m?.available && m?.modelId) ||
          llmList[0];
        const id = llm?.modelId?.trim() || null;
        if (id) setModelId(id);
      })
      .catch(() => {
        /* keep query / prior modelId */
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId, spark, port]);

  const setTerminalCountSafe = useCallback(
    (n: number) => {
      setTerminalCount(n);
      if (!running && !starting) {
        // Preserve edited prompts; only fill new slots from the catalog.
        setPrompts((prev) => {
          const catalog = pickShowcasePrompts(promptType, n);
          return catalog.map((d, i) =>
            i < prev.length && prev[i] != null && prev[i] !== "" ? prev[i] : d
          );
        });
        setStreams([]);
        setViewingHistory(false);
      }
    },
    [running, starting, promptType]
  );

  const setPromptTypeSafe = useCallback(
    (t: ShowcasePromptType) => {
      setPromptType(t);
      if (!running && !starting) {
        setPrompts(pickShowcasePrompts(t, terminalCount));
        setStreams([]);
        setViewingHistory(false);
      }
    },
    [running, starting, terminalCount]
  );

  const stopPolling = useCallback(() => {
    if (pollTimer.current != null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const flashCopied = useCallback((id: string) => {
    setCopiedId(id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleCopyOne = useCallback(
    async (s: LocalStream) => {
      const ok = await copyText(buildTerminalPlainText(s));
      if (ok) flashCopied(s.streamId);
      else setRunError("Could not copy to clipboard");
    },
    [flashCopied]
  );

  const handleCopyAll = useCallback(async () => {
    if (!spark || !displayStreams.some((s) => s.content || s.reasoning || s.error)) {
      return;
    }
    const ok = await copyText(
      buildAllPlainText(displayStreams, {
        name: spark.name,
        port,
        modelId,
        serverTps,
        sessionAvgTps: runFinished ? sessionAvgTps : null,
      })
    );
    if (ok) flashCopied("all");
    else setRunError("Could not copy to clipboard");
  }, [spark, displayStreams, port, modelId, serverTps, runFinished, sessionAvgTps, flashCopied]);

  const applySession = useCallback((data: ShowcaseSessionState, full: boolean) => {
    setSessionStatus(data.status);
    revRef.current = data.rev;
    if (data.modelId) setModelId(data.modelId);
    else {
      const fromStream = data.streams.find((s) => s.model)?.model;
      if (fromStream) setModelId(fromStream);
    }
    if (data.serverGenerationTps != null) setServerTps(data.serverGenerationTps);
    if (data.serverGenerationTpsMax != null) setServerTpsMax(data.serverGenerationTpsMax);
    setStreams((prev) => {
      const byId = new Map(prev.map((s) => [s.streamId, s]));
      return data.streams.map((s) => {
        const old = byId.get(s.streamId);
        let content = old?.content ?? "";
        let reasoning = old?.reasoning ?? "";
        if (full || s.resetContent || s.content != null) {
          content = s.content ?? "";
        } else if (s.contentAppend) {
          content += s.contentAppend;
        }
        if (full || s.resetContent || s.reasoning != null) {
          reasoning = s.reasoning ?? "";
        } else if (s.reasoningAppend) {
          reasoning += s.reasoningAppend;
        }
        const live = s.liveTokPerSec || 0;
        const peak = Math.max(
          old?.peakTokPerSec ?? 0,
          s.peakTokPerSec ?? 0,
          live,
          s.decodeTps || 0
        );
        return {
          streamId: s.streamId,
          label: s.label,
          prompt: s.prompt,
          status: s.status,
          content,
          reasoning,
          tokenCount: s.tokenCount,
          ttftMs: s.ttftMs,
          decodeTps: s.decodeTps,
          liveTokPerSec: live,
          peakTokPerSec: peak,
          error: s.error,
        };
      });
    });
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!sparkId) return;
    setHistoryLoading(true);
    try {
      const data = await listShowcase(sparkId);
      setHistory(data.history || []);
    } catch {
      /* ignore list failures in UI */
    } finally {
      setHistoryLoading(false);
    }
  }, [sparkId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (historyOpen) void refreshHistory();
  }, [historyOpen, refreshHistory]);

  useEffect(() => {
    if (runFinished) void refreshHistory();
  }, [runFinished, refreshHistory]);

  const pollOnce = useCallback(
    async (sid: string) => {
      const since = revRef.current;
      const data = await getShowcase(
        sparkId,
        sid,
        since != null ? { since } : undefined
      );
      applySession(data, since == null);
      return data;
    },
    [sparkId, applySession]
  );

  const schedulePoll = useCallback(
    (sid: string) => {
      stopPolling();
      pollTimer.current = setTimeout(() => {
        void (async () => {
          if (sessionIdRef.current !== sid) return;
          try {
            const data = await pollOnce(sid);
            if (sessionIdRef.current !== sid) return;
            if (data.status === "running") {
              schedulePoll(sid);
            } else {
              stopPolling();
            }
          } catch (err) {
            setRunError(err instanceof Error ? err.message : String(err));
            stopPolling();
          }
        })();
      }, POLL_MS);
    },
    [pollOnce, stopPolling]
  );

  const handleStop = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    stopPolling();
    try {
      const data = await cancelShowcase(sparkId, sid);
      applySession(data, false);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [sparkId, applySession, stopPolling]);

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    setRunError(null);
    setStarting(true);
    setViewingHistory(false);
    revRef.current = null;
    setStreams([]);
    setServerTps(null);
    setServerTpsMax(null);
    setAggregatePeakTps(0);
    try {
      const trimmed = prompts.map((p) => p.trim()).filter(Boolean);
      if (trimmed.length < MIN_TERMINALS || trimmed.length > MAX_TERMINALS) {
        throw new Error(`Use between ${MIN_TERMINALS} and ${MAX_TERMINALS} non-empty prompts`);
      }
      const started = await startShowcase(sparkId, {
        port,
        maxTokens,
        temperature,
        thinking,
        modelId: modelId || undefined,
        promptType,
        prompts: trimmed,
      });
      sessionIdRef.current = started.sessionId;
      setSessionId(started.sessionId);
      setSessionStatus("running");
      setConfigOpen(false);
      setHistoryOpen(false);
      const data = await pollOnce(started.sessionId);
      if (data.status === "running") schedulePoll(started.sessionId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setSessionStatus(null);
      sessionIdRef.current = null;
      setSessionId(null);
    } finally {
      setStarting(false);
    }
  }, [
    canRun,
    prompts,
    sparkId,
    port,
    maxTokens,
    temperature,
    thinking,
    modelId,
    promptType,
    pollOnce,
    schedulePoll,
  ]);

  const handleOpenHistoryRun = useCallback(
    async (sid: string) => {
      if (running || starting) return;
      setRunError(null);
      stopPolling();
      revRef.current = null;
      try {
        const data = await getShowcase(sparkId, sid);
        setViewingHistory(Boolean(data.fromHistory) || data.status !== "running");
        sessionIdRef.current = data.sessionId;
        setSessionId(data.sessionId);
        applySession(data, true);
        if (typeof data.port === "number") setPort(data.port);
        if (data.maxTokens != null) setMaxTokens(data.maxTokens);
        if (data.temperature != null) setTemperature(data.temperature);
        if (typeof data.thinking === "boolean") setThinking(data.thinking);
        if (
          data.promptType === "text" ||
          data.promptType === "structural" ||
          data.promptType === "mixed"
        ) {
          setPromptType(data.promptType);
        }
        if (Array.isArray(data.streams) && data.streams.length) {
          setTerminalCount(data.streams.length);
          setPrompts(data.streams.map((s) => s.prompt || ""));
        }
        const peaks = (data.streams || []).map(
          (s) => Math.max(s.peakTokPerSec || 0, s.decodeTps || 0, s.liveTokPerSec || 0)
        );
        const aggPeak = peaks.reduce((a, b) => a + b, 0);
        setAggregatePeakTps(aggPeak);
        setHistoryOpen(false);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    },
    [running, starting, sparkId, stopPolling, applySession]
  );

  const handleUseHistorySettings = useCallback(
    (row: ShowcaseHistorySummary) => {
      if (running || starting) return;
      if (row.port) setPort(row.port);
      if (row.maxTokens != null) setMaxTokens(row.maxTokens);
      if (row.temperature != null) setTemperature(row.temperature);
      if (typeof row.thinking === "boolean") setThinking(row.thinking);
      if (row.modelId) setModelId(row.modelId);
      if (
        row.promptType === "text" ||
        row.promptType === "structural" ||
        row.promptType === "mixed"
      ) {
        setPromptType(row.promptType);
      }
      // Load full session only for prompts
      void (async () => {
        try {
          const data = await getShowcase(sparkId, row.sessionId);
          if (
            data.promptType === "text" ||
            data.promptType === "structural" ||
            data.promptType === "mixed"
          ) {
            setPromptType(data.promptType);
          }
          if (Array.isArray(data.streams) && data.streams.length) {
            setTerminalCount(data.streams.length);
            setPrompts(data.streams.map((s) => s.prompt || ""));
          }
          setConfigOpen(true);
          setHistoryOpen(false);
          setViewingHistory(false);
        } catch (err) {
          setRunError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [running, starting, sparkId]
  );

  const handleClearHistory = useCallback(async () => {
    if (running || starting) return;
    if (!window.confirm("Clear all saved showcase history for this Spark?")) return;
    try {
      await clearShowcaseHistory(sparkId);
      setHistory([]);
      if (viewingHistory) {
        setViewingHistory(false);
        setStreams([]);
        setSessionId(null);
        setSessionStatus(null);
        sessionIdRef.current = null;
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [running, starting, sparkId, viewingHistory]);

  useEffect(() => {
    const cancelBeacon = () => {
      const sid = sessionIdRef.current;
      if (!sid || sessionStatus !== "running") return;
      const url = `/api/sparks/${encodeURIComponent(sparkId)}/llm/showcase/${encodeURIComponent(sid)}`;
      try {
        void fetch(url, { method: "DELETE", keepalive: true });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", cancelBeacon);
    window.addEventListener("beforeunload", cancelBeacon);
    return () => {
      window.removeEventListener("pagehide", cancelBeacon);
      window.removeEventListener("beforeunload", cancelBeacon);
    };
  }, [sparkId, sessionStatus]);

  useEffect(
    () => () => {
      stopPolling();
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [stopPolling]
  );

  if (loadError) {
    return (
      <div className="showcase-page">
        <div className="showcase-page__empty">
          <h1>Showcase</h1>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  if (!spark) {
    return (
      <div className="showcase-page">
        <div className="showcase-page__empty">
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  const monitoringOff = !isLlmMonitoringEnabled(spark) || spark.workerNode;
  const hasCopyable = displayStreams.some((s) => s.content || s.reasoning || s.error);
  const showMetricsStrip =
    aggregateTps > 0 ||
    sessionAvgTps > 0 ||
    totalTokens > 0 ||
    serverTps != null ||
    serverTpsMax != null ||
    running ||
    (sessionStatus != null && sessionStatus !== "pending");

  const gridCols = optimalGridCols(displayStreams.length);
  const gridRows = Math.max(1, Math.ceil(displayStreams.length / gridCols));

  const formatToks = (n: number) =>
    n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();

  return (
    <div className="showcase-page">
      {!barVisible ? (
        <div className="showcase-config-peek">
          <div className="showcase-config__title">
            <a href="/" className="logo-pill showcase-brand" title="sparkDash home">
              <BoltIcon className="showcase-brand__bolt" />
              <span>
                spark<span className="logo-pill-dash">Dash</span>
              </span>
            </a>
            <div className="showcase-config__subtitle">
              <span className="showcase-config__name">{spark.name}</span>
              <span className="showcase-config__meta">
                <span className="showcase-config__meta-label">Prompt Showcase</span>
              </span>
            </div>
          </div>
          <div className="showcase-config-peek__actions">
            <button
              type="button"
              className="showcase-btn showcase-btn--ghost showcase-config-peek__show"
              onClick={() => setBarVisible(true)}
              title="Show controls"
            >
              Show controls
            </button>
            {(aggregateTps > 0 || totalTokens > 0) && (
              <div className="showcase-config-peek__tps" title="Aggregate tokens per second across all terminals">
                <span className="showcase-config-peek__tps-value font-tabular">
                  {aggregateTps > 0 ? `${aggregateTps.toFixed(0)}` : "—"}
                </span>
                <span className="showcase-config-peek__tps-unit">tok/s</span>
                {totalTokens > 0 && (
                  <span className="showcase-config-peek__tps-tokens font-tabular">
                    · {formatToks(totalTokens)} tok
                  </span>
                )}
              </div>
            )}
            {running && (
              <button
                type="button"
                className="showcase-btn showcase-btn--danger"
                onClick={() => {
                  if (window.confirm("Stop all showcase streams?")) void handleStop();
                }}
              >
                Stop
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className={`showcase-config${configOpen ? "" : " is-collapsed"}`}>
        <div className="showcase-config__bar">
          <div className="showcase-config__title">
            <a href="/" className="logo-pill showcase-brand" title="sparkDash home">
              <BoltIcon className="showcase-brand__bolt" />
              <span>
                spark<span className="logo-pill-dash">Dash</span>
              </span>
            </a>
            <div className="showcase-config__subtitle">
              <span className="showcase-config__name">{spark.name}</span>
              <span className="showcase-config__meta">
                <span className="showcase-config__meta-label">Prompt Showcase</span>
              </span>
            </div>
          </div>
          <div className="showcase-config__controls">
            <fieldset className="showcase-config__lockgroup" disabled={controlsLocked}>
              <label className="showcase-field">
                <span className="showcase-field__label">Port</span>
                <select
                  value={port}
                  disabled={controlsLocked}
                  onChange={(e) => setPort(Number(e.target.value))}
                >
                  {llmPorts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="showcase-field">
                <span className="showcase-field__label">Terminals</span>
                <select
                  value={terminalCount}
                  disabled={controlsLocked}
                  onChange={(e) => setTerminalCountSafe(Number(e.target.value))}
                >
                  {TERMINAL_COUNTS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="showcase-field"
                title={PROMPT_TYPES.find((t) => t.id === promptType)?.hint}
              >
                <span className="showcase-field__label">Prompt type</span>
                <select
                  value={promptType}
                  disabled={controlsLocked}
                  onChange={(e) =>
                    setPromptTypeSafe(e.target.value as ShowcasePromptType)
                  }
                >
                  {PROMPT_TYPES.map((t) => (
                    <option key={t.id} value={t.id} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="showcase-field">
                <span className="showcase-field__label">Max tokens</span>
                <input
                  type="number"
                  min={64}
                  max={2048}
                  step={64}
                  value={maxTokens}
                  disabled={controlsLocked}
                  onChange={(e) => setMaxTokens(Number(e.target.value) || DEFAULT_MAX_TOKENS)}
                />
              </label>
              <label className="showcase-field">
                <span className="showcase-field__label">Temp</span>
                <input
                  type="number"
                  min={MIN_TEMPERATURE}
                  max={MAX_TEMPERATURE}
                  step={0.1}
                  value={temperature}
                  disabled={controlsLocked}
                  title="Sampling temperature (0–2)"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) {
                      setTemperature(DEFAULT_TEMPERATURE);
                      return;
                    }
                    setTemperature(
                      Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, n))
                    );
                  }}
                />
              </label>
              <div className="showcase-field">
                <span className="showcase-field__label showcase-field__label--spacer" aria-hidden="true">
                  &nbsp;
                </span>
                <label className="showcase-check" title="Enable model thinking / reasoning tokens">
                  <input
                    type="checkbox"
                    checked={thinking}
                    disabled={controlsLocked}
                    onChange={(e) => setThinking(e.target.checked)}
                  />
                  <span>Thinking</span>
                </label>
              </div>
            </fieldset>
            <div className="showcase-field">
              <span className="showcase-field__label showcase-field__label--spacer" aria-hidden="true">
                &nbsp;
              </span>
              <label className="showcase-check">
                <input
                  type="checkbox"
                  checked={configOpen}
                  onChange={(e) => setConfigOpen(e.target.checked)}
                />
                <span>Show prompts</span>
              </label>
            </div>
            <div className="showcase-field showcase-field--actions">
              <span className="showcase-field__label showcase-field__label--spacer" aria-hidden="true">
                &nbsp;
              </span>
              <div className="showcase-config__actions">
                <button
                  type="button"
                  className="showcase-btn showcase-btn--primary"
                  disabled={!canRun || monitoringOff || controlsLocked}
                  onClick={() => void handleRun()}
                >
                  {starting ? "Starting…" : "Run"}
                </button>
                {running && (
                  <button
                    type="button"
                    className="showcase-btn showcase-btn--danger"
                    onClick={() => {
                      if (window.confirm("Stop all showcase streams?")) void handleStop();
                    }}
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  className="showcase-btn showcase-btn--ghost"
                  disabled={!hasCopyable}
                  onClick={() => void handleCopyAll()}
                  title="Copy all terminals as plain text"
                >
                  {copiedId === "all" ? "Copied!" : "Copy all"}
                </button>
                <button
                  type="button"
                  className={`showcase-btn showcase-btn--ghost${historyOpen ? " is-active" : ""}`}
                  onClick={() => setHistoryOpen((o) => !o)}
                  title="Past showcase runs"
                >
                  History{history.length > 0 ? ` (${history.length})` : ""}
                </button>
                <button
                  type="button"
                  className={`showcase-btn showcase-btn--ghost${liveOpen ? " is-active" : ""}`}
                  onClick={() => setLiveOpen((o) => !o)}
                  title="Show the actual requests hitting the engine — every agent and app, IN and OUT — in the terminals above instead of the sample prompts"
                >
                  {liveOpen ? "Live: ON" : "Live requests"}
                </button>
                <button
                  type="button"
                  className="showcase-btn showcase-btn--ghost"
                  onClick={() => setBarVisible(false)}
                  title="Hide controls"
                >
                  Hide
                </button>
              </div>
            </div>
          </div>
        </div>

        {historyOpen && (
          <div className="showcase-history">
            <div className="showcase-history__head">
              <span className="showcase-history__title">Past runs</span>
              <div className="showcase-history__head-actions">
                <button
                  type="button"
                  className="showcase-btn showcase-btn--ghost"
                  disabled={historyLoading}
                  onClick={() => void refreshHistory()}
                >
                  {historyLoading ? "Loading…" : "Refresh"}
                </button>
                <button
                  type="button"
                  className="showcase-btn showcase-btn--ghost"
                  disabled={!history.length || controlsLocked}
                  onClick={() => void handleClearHistory()}
                >
                  Clear
                </button>
              </div>
            </div>
            {!history.length && !historyLoading ? (
              <p className="showcase-history__empty">
                No saved runs yet. Finished showcases appear here automatically.
              </p>
            ) : (
              <ul className="showcase-history__list">
                {history.map((row) => {
                  const when = row.startedAt
                    ? new Date(row.startedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—";
                  const active = viewingHistory && sessionId === row.sessionId;
                  return (
                    <li
                      key={row.sessionId}
                      className={`showcase-history__item${active ? " is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="showcase-history__main"
                        disabled={controlsLocked}
                        onClick={() => void handleOpenHistoryRun(row.sessionId)}
                        title="View this run"
                      >
                        <span className="showcase-history__when">{when}</span>
                        <span className="showcase-history__meta">
                          <span className={`showcase-history__status showcase-history__status--${row.status}`}>
                            {row.status}
                          </span>
                          <span>· :{row.port}</span>
                          <span>· {row.streamCount} term</span>
                          {row.promptType ? (
                            <span>· {row.promptType}</span>
                          ) : null}
                          {row.meanDecodeTps > 0 && (
                            <span>· avg {row.meanDecodeTps.toFixed(0)} tok/s</span>
                          )}
                          {row.totalTokens > 0 && (
                            <span>· {formatToks(row.totalTokens)} tok</span>
                          )}
                        </span>
                        {row.modelId ? (
                          <span className="showcase-history__model" title={row.modelId}>
                            {row.modelId}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="showcase-btn showcase-btn--ghost showcase-history__reuse"
                        disabled={controlsLocked}
                        onClick={() => handleUseHistorySettings(row)}
                        title="Load prompts & settings into the form (does not re-run)"
                      >
                        Reuse
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {configOpen && (
          <div className="showcase-config__prompts">
            {prompts.map((p, i) => (
              <label key={i} className="showcase-prompt">
                <span className="showcase-prompt__label">Prompt {i + 1}</span>
                <textarea
                  value={p}
                  disabled={controlsLocked}
                  rows={2}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPrompts((prev) => prev.map((x, j) => (j === i ? v : x)));
                  }}
                />
              </label>
            ))}
          </div>
        )}

        {(runError || monitoringOff) && (
          <p className="showcase-config__error">
            {monitoringOff
              ? "LLM monitoring is off or this Spark is a worker — showcase unavailable."
              : runError}
          </p>
        )}
      </div>
      )}

      {modelId ? (
        <header className={`showcase-model-header${liveOpen ? " showcase-model-header--live" : ""}`} title={modelId}>
          {liveOpen && (
            <div className="live-stats live-stats--left" aria-label="engine throughput">
              <div className={`live-stat${(liveCounts.prefillTokS60 ?? 0) > 0 ? " is-hot" : ""}`} title="prompt tokens read by the engine over the last 60 s, ÷ 60 — from the tap's usage records (vLLM's own gauge only ticks when a request finishes prefill, so it reads 0 between them). While the tap's 60 s window is still filling the tile counts down to the first usable figure.">
                {(() => {
                  const secsLeft = prefillWindowSecsLeft;
                  if (liveCounts.prefillTokS60 == null) {
                    // no tap data at all — fall back to the engine's own (instantaneous) gauge
                    return (
                      <>
                        <span className="live-stat__n">{(engine?.prefillTps ?? 0) > 0 ? Math.round(engine!.prefillTps!).toLocaleString() : "—"}</span>
                        <span className="live-stat__k">prefill tok/s · engine gauge</span>
                      </>
                    );
                  }
                  if (secsLeft > 0) {
                    return (
                      <>
                        <span className="live-stat__n">{secsLeft}s</span>
                        <span className="live-stat__k">prefill tok/s · ready in</span>
                      </>
                    );
                  }
                  return (
                    <>
                      <span className="live-stat__n">{Math.round(liveCounts.prefillTokS60).toLocaleString()}</span>
                      <span className="live-stat__k">prefill tok/s · 60 s</span>
                    </>
                  );
                })()}
              </div>
              {liveCounts.prefillTokS60 != null && prefillWindowSecsLeft === 0 && (
                <div className={`live-stat${liveCounts.prefill ? " is-hot" : ""}`} title={`requests the engine is reading right now (same count as the yellow tile) and the prompt tokens they add up to; ${liveCounts.prefillReq60 ?? 0} prefill${liveCounts.prefillReq60 === 1 ? "" : "s"} finished inside the last 60 s — those are what the tok/s figure is built from`}>
                  <span className="live-stat__n">{liveCounts.prefill}</span>
                  <span className="live-stat__k">prefills · {fmtTok(liveCounts.prefillTokens ?? 0)} tok</span>
                </div>
              )}
              <div className={`live-stat live-stat--green${(engine?.generationTps ?? 0) > 0 ? " is-hot" : ""}`}>
                <span className="live-stat__n">{engine?.generationTps != null ? Math.round(engine.generationTps).toLocaleString() : "—"}</span>
                <span className="live-stat__k">output tok/s</span>
              </div>
              <div className={`live-stat live-stat--total${(engine?.requestsRunning ?? liveCounts.running) ? " is-hot" : ""}`}>
                <span className="live-stat__n">{engine?.requestsRunning ?? liveCounts.running}</span>
                <span className="live-stat__k">sessions running</span>
              </div>
            </div>
          )}
          <div className="showcase-model-header__center">
            <span className="showcase-model-header__label">Model</span>
            <h1 className="showcase-model-header__name">{modelId}</h1>
          </div>
          {liveOpen && (
            <div className="live-stats live-stats--right" aria-label="engine state">
              <div className={`live-stat live-stat--red${(engine?.requestsWaiting ?? 0) > 0 ? " is-hot" : ""}`}>
                <span className="live-stat__n">{engine?.requestsWaiting ?? "—"}</span>
                <span className="live-stat__k">waiting</span>
              </div>
              {(engine?.requestsWaiting ?? 0) > 0 && liveCounts.queuedAvgWaitS != null && (
                <div className="live-stat live-stat--red is-hot" title="mean time the queued requests have been waiting for an engine slot (from the tap's arrival times) — only shown while there is a queue">
                  <span className="live-stat__n">{fmtWait(liveCounts.queuedAvgWaitS)}</span>
                  <span className="live-stat__k">avg wait</span>
                </div>
              )}
              <div className={`live-stat live-stat--yellow${liveCounts.prefill ? " is-hot" : ""}`}>
                <span className="live-stat__n">{liveCounts.prefill}</span>
                <span className="live-stat__k">in prefill</span>
              </div>
              <div className={`live-stat live-stat--green${liveCounts.output ? " is-hot" : ""}`}>
                <span className="live-stat__n">{liveCounts.output}</span>
                <span className="live-stat__k">generating</span>
              </div>
              <div className={`live-stat live-stat--total${(engine?.kvCacheUsage ?? 0) > 0.5 ? " is-hot" : ""}`}>
                <span className="live-stat__n">{engine?.kvCacheUsage != null ? `${Math.round(engine.kvCacheUsage * 100)}%` : "—"}</span>
                <span className="live-stat__k">kv cache</span>
              </div>
              <div className={`live-stat live-stat--total${(engine?.prefixCacheHitRate ?? 0) > 0 ? " is-hot" : ""}`}>
                <span className="live-stat__n">{engine?.prefixCacheHitRate != null ? `${Math.round(engine.prefixCacheHitRate * 100)}%` : "—"}</span>
                <span className="live-stat__k">prefix hit</span>
              </div>
            </div>
          )}
        </header>
      ) : null}

      {showMetricsStrip && (
        <div className="showcase-metrics" aria-live="polite">
          <div className="showcase-metrics__hero" title="Sum of live decode tok/s across all terminals">
            <span className="showcase-metrics__label">Aggregate</span>
            <span className="showcase-metrics__hero-value font-tabular">
              {aggregateTps > 0 ? aggregateTps.toFixed(0) : "—"}
              <span className="showcase-metrics__hero-unit">tok/s</span>
            </span>
            {aggregatePeakTps > 0 && (
                <span className="showcase-metrics__sub">
                  peak {aggregatePeakTps.toFixed(0)}
                </span>
              )}
          </div>
          {runFinished && sessionAvgTps > 0 && (
            <>
              <span className="showcase-metrics__sep" aria-hidden>
                ·
              </span>
              <div
                className="showcase-metrics__item"
                title="Average decode tok/s per terminal for this session"
              >
                <span className="showcase-metrics__label">Avg</span>
                <span className="showcase-metrics__value font-tabular">
                  {sessionAvgTps.toFixed(0)}
                  <span className="showcase-metrics__unit"> tok/s</span>
                </span>
                <span className="showcase-metrics__sub">per stream</span>
              </div>
            </>
          )}
          <span className="showcase-metrics__sep" aria-hidden>
            ·
          </span>
          <div className="showcase-metrics__item">
            <span className="showcase-metrics__label">Tokens</span>
            <span className="showcase-metrics__value font-tabular">
              {totalTokens > 0 ? formatToks(totalTokens) : "—"}
            </span>
          </div>
          <span className="showcase-metrics__sep" aria-hidden>
            ·
          </span>
          <div className="showcase-metrics__item">
            <span className="showcase-metrics__label">Server</span>
            <span className="showcase-metrics__value font-tabular">
              {serverTps != null ? `${serverTps.toFixed(0)}` : "—"}
              {serverTps != null && (
                <span className="showcase-metrics__unit"> tok/s</span>
              )}
            </span>
            {serverTpsMax != null && serverTpsMax > 0 && (
                <span className="showcase-metrics__sub">
                  peak {serverTpsMax.toFixed(0)}
                </span>
              )}
          </div>
          <span className="showcase-metrics__sep" aria-hidden>
            ·
          </span>
          <div className="showcase-metrics__item">
            <span className="showcase-metrics__label">Streams</span>
            <span className="showcase-metrics__value font-tabular">
              {
                displayStreams.filter(
                  (s) => s.status === "streaming" || s.status === "completed"
                ).length
              }
              /{displayStreams.length}
            </span>
          </div>
        </div>
      )}

      {liveOpen && <LiveRequestsPanel sparkId={sparkId} terminalCount={terminalCount} onCounts={setLiveCounts} engineWaiting={engine?.requestsWaiting ?? null} />}

      <div
        className="showcase-grid"
        style={{
          ["--showcase-cols" as string]: String(gridCols),
          ["--showcase-rows" as string]: String(gridRows),
          display: liveOpen ? "none" : undefined,
        }}
      >
        {displayStreams.map((s) => (
          <TerminalCard
            key={s.streamId}
            label={s.label}
            status={s.status}
            liveTokPerSec={s.liveTokPerSec}
            peakTokPerSec={s.peakTokPerSec}
            content={s.content}
            reasoning={s.reasoning}
            error={s.error}
            onCopy={
              s.content || s.reasoning || s.error
                ? () => void handleCopyOne(s)
                : undefined
            }
            copied={copiedId === s.streamId}
          />
        ))}
      </div>

      {sessionId && sessionStatus && sessionStatus !== "running" && (
        <p className="showcase-page__footer-note">
          {viewingHistory ? "History · " : "Session "}
          {sessionStatus}
          {sessionId ? ` · ${sessionId.slice(0, 8)}…` : ""}
          {viewingHistory ? " · read-only" : ""}
        </p>
      )}
    </div>
  );
}
