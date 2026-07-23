import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelShowcase,
  fetchSparkMetrics,
  fetchSparks,
  getShowcase,
  startShowcase,
} from "../../api/client";
import type { ShowcaseSessionState, SparkConfig } from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { BoltIcon } from "../ui/icons";
import { TerminalCard } from "./TerminalCard";

const DEFAULT_PROMPTS = [
  "Explain NVIDIA GB10 unified memory in plain language. Write a short essay of a few paragraphs.",
  "Emit only a JSON array of fake GPU metrics rows. Each object needs host, gpuIndex, utilPct, tempC, powerW, memUsedMb. Invent at least 12 rows. No markdown.",
  "Emit only an HTML FAQ about CUDA and vLLM. Use <h2> and <p> for several Q&A pairs. No markdown fences.",
  "Write a short sci-fi scene set in a server room at 3 a.m. Keep it vivid and under 400 words.",
  "List 20 shell one-liners useful for NVIDIA Sparks / DGX. Commands only, one per line, no commentary.",
  "Emit a Markdown comparison table: llama.cpp vs vLLM vs SGLang. Columns: feature, llama.cpp, vLLM, SGLang. Fill many rows.",
  "Stream a fake syslog of cluster events (timestamps, INFO/WARN/ERROR, services). Keep lines coming until the length limit.",
  "Write a sequence of haiku about tokens, GPUs, and heat. Separate each haiku with a blank line. Write at least eight.",
  "Write only valid YAML for a multi-service docker-compose stack with redis, postgres, api, and worker. Expand with env and volumes.",
  "Emit a CSV of invent datacenter PUE readings: date,site,pue,itKw,facilityKw. At least 40 rows. CSV only, no commentary.",
  "Write a pirate-captain monologue explaining KV-cache pressure to the crew. Keep it under 350 words.",
  "Generate a GraphQL schema as SDL only: types Query, Mutation, User, Job, Metric. Add many fields and enums.",
  "List 25 git aliases useful for ML infra repos. Format: alias = command. No explanations.",
  "Write a fake RFC-style abstract and intro for \"Token Streaming over QUIC\". Formal tone, continue until the length limit.",
  "Emit only a Python dataclass module for SparkHost, GpuSlice, and LlmEndpoint with typed fields and docstrings.",
  "Write a nursery-rhyme style poem about thermal throttling. Several stanzas.",
  "Generate an OpenAPI 3 paths snippet as JSON for /v1/models and /v1/chat/completions. Expand schemas heavily.",
  "Emit a Markdown cheatsheet: nvidia-smi flags vs what they show. Dense table, many rows.",
  "Write dialogue between two ops engineers debugging a stuck vLLM queue. Natural, continue for many turns.",
  "Generate a long TOML config for a fictional inference gateway: listeners, routes, retries, budgets.",
  "Emit only SQL: CREATE TABLE + many INSERT statements for gpu_jobs(id, host, model, tokens, ms).",
  "Write a travel-brochure parody for visiting a liquid-cooled GPU rack. Flowery marketing tone.",
  "Generate ASCII art labels (text only) for WARN, Crit, OK, and Idle banners. Several variants each.",
  "Emit a bullet-only runbook: cold-start a 4-GPU SGLang node. Commands and checks, no fluff.",
  "Write a courtroom cross-examination where the witness is a tokenizer. Continue with many Q&A exchanges.",
  "Generate a Mermaid sequenceDiagram as fenced code for client → proxy → vLLM → GPU. Expand with retries.",
  "Emit a long alphabetized glossary of ML-systems jargon (KV cache, TTFT, ITL, MTP, …) as Markdown definition list.",
  "Write a weather report for a cluster: temperature fronts across racks, token-storm warnings. Radio-host style.",
  "Generate only a Rust-flavored pseudocode module for a lock-free token ring buffer. Keep expanding functions.",
  "Emit a fake Prometheus scrape dump (text exposition format) for showcase_tokens_total and showcase_ttft_seconds.",
  "Write packaging copy for a fictional energy drink called Prefill Punch aimed at LLM operators.",
  "Generate a multi-chapter outline then expand chapter 1 into prose: \"The Day the Slots Went to Zero.\"",
];

const POLL_MS = 300;
const DEFAULT_MAX_TOKENS = 512;
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
  if (s.liveTokPerSec > 0 || s.decodeTps > 0) {
    parts.push(
      `tok/s: ${(s.liveTokPerSec || s.decodeTps).toFixed(1)}` +
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
  meta: { name: string; port: number; modelId: string | null; serverTps: number | null }
): string {
  const head = [
    `${meta.name} | prompt showcase`,
    `port ${meta.port}` +
      (meta.modelId ? `  ·  ${meta.modelId}` : "") +
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

export function ShowcasePage({ sparkId }: ShowcasePageProps) {
  const [spark, setSpark] = useState<SparkConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<string[]>(() => DEFAULT_PROMPTS.slice(0, 4));
  const [terminalCount, setTerminalCount] = useState(4);
  const [port, setPort] = useState(8888);
  const [modelId, setModelId] = useState<string | null>(() => readModelQuery());
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
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

  useEffect(() => {
    setPrompts((prev) => {
      const next = DEFAULT_PROMPTS.slice(0, terminalCount);
      return next.map((d, i) => (prev[i] != null && prev[i] !== "" ? prev[i] : d));
    });
  }, [terminalCount]);

  const setTerminalCountSafe = useCallback(
    (n: number) => {
      setTerminalCount(n);
      // Rebuild the grid when idle so a finished run doesn't stick at the old count.
      if (!running && !starting) {
        setStreams([]);
      }
    },
    [running, starting]
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
      })
    );
    if (ok) flashCopied("all");
    else setRunError("Could not copy to clipboard");
  }, [spark, displayStreams, port, modelId, serverTps, flashCopied]);

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
        const peak = Math.max(old?.peakTokPerSec ?? 0, live, s.decodeTps || 0);
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
        thinking,
        modelId: modelId || undefined,
        prompts: trimmed,
      });
      sessionIdRef.current = started.sessionId;
      setSessionId(started.sessionId);
      setSessionStatus("running");
      setConfigOpen(false);
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
  }, [canRun, prompts, sparkId, port, maxTokens, thinking, pollOnce, schedulePoll]);

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
              {modelId ? (
                <span className="showcase-config__model" title={modelId}>
                  {modelId}
                </span>
              ) : null}
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
              {modelId ? (
                <span className="showcase-config__model" title={modelId}>
                  {modelId}
                </span>
              ) : null}
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

      {showMetricsStrip && (
        <div className="showcase-metrics" aria-live="polite">
          <div className="showcase-metrics__hero" title="Sum of live decode tok/s across all terminals">
            <span className="showcase-metrics__label">Aggregate</span>
            <span className="showcase-metrics__hero-value font-tabular">
              {aggregateTps > 0 ? aggregateTps.toFixed(0) : "—"}
              <span className="showcase-metrics__hero-unit">tok/s</span>
            </span>
            {aggregatePeakTps > 0 &&
              aggregateTps > 0 &&
              aggregatePeakTps > aggregateTps + 0.5 && (
                <span className="showcase-metrics__sub">
                  peak {aggregatePeakTps.toFixed(0)}
                </span>
              )}
          </div>
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
            {serverTpsMax != null &&
              serverTps != null &&
              serverTpsMax > serverTps + 0.5 && (
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

      <div
        className="showcase-grid"
        style={{
          ["--showcase-cols" as string]: String(gridCols),
          ["--showcase-rows" as string]: String(gridRows),
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
          Session {sessionStatus}
          {sessionId ? ` · ${sessionId.slice(0, 8)}…` : ""}
        </p>
      )}
    </div>
  );
}
