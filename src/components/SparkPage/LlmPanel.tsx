import { benchId } from "../../constants";
import { BenchIcon } from "../bench/BenchIcon";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { LlmMetrics, LlmBenchTarget } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts } from "../../api/client";
import { TrendLine } from "../ui/TrendLine";
import { Panel } from "../ui/Panel";
import { Tag, type TagTone } from "../ui/Tag";
import { BotIcon, ExpandIcon, FlaskIcon, GearIcon, InfoIcon, ServerIcon } from "../ui/icons";
import {
  useMetricsHistory,
  useMetricsHistoryTail,
  avgPositive,
} from "../../hooks/metricsStore";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { PrefillBenchDialog } from "./PrefillBenchDialog";
import { QualityBenchDialog } from "./QualityBenchDialog";
import { LlmDailyChart } from "./LlmDailyChart";
import { LlmTokenTotals } from "./LlmTokenTotals";
import { ENGINE_GENERATED_LABEL, ENGINE_GENERATED_TITLE } from "./tokenTotalsCopy";
import { parseLlmTargetInput } from "../../shared/llmTarget.js";
import { backendLabel } from "../../shared/llmBackends.js";
import { LlmTrendChart } from "./LlmTrendChart";
import type { BenchKind } from "./BenchSwitcher";
import { engineStateLabel } from "./llmEngineState";
import { idleLabel, isLlmIdle } from "../../shared/llmIdle";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  /** Unit display name — lands on the benchmark share card. */
  sparkName?: string;
  llmPort: number;
  llmPorts?: number[];
  hasApiKey?: boolean;
  /** Show "Copy image" in the benchmark dialogs (Settings, off by default). */
  shareImage?: boolean;
  onRemovePort?: (port: number) => void;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Free tokens left in the engine’s KV-cache pool, over the allocated pool (tokens and memory). The pool is shared across concurrent requests and can be larger than one request’s max context. High usage (≥80% full) means little room for new or long contexts and often leads to queuing or preemptions.",
  requests:
    "Run = requests actively generating on the GPU. Wait = accepted but not yet scheduled (capacity or constraints). Growing wait with high KV cache usually means the server is overloaded.",
  ttftMean:
    "Mean time-to-first-token reported by FreeToken (a mean, not a percentile): how long requests wait until the first output token.",
  ttftP95:
    "95th percentile time-to-first-token from the engine’s request history: how long “slow” requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths—not average decode speed.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits ÷ queries). Higher means more prompt reuse and less prefill work; — when the series is missing or unused.",
  e2eP95:
    "95th percentile end-to-end request latency from the engine’s request history: arrival until the request finishes. Includes queue wait, prefill, and decode—not just token generation speed.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from the engine’s request history. Spikes mean decode stalls or contention; lower is smoother streaming.",
  mtpAccept:
    "Lifetime speculative / MTP acceptance rate (accepted draft tokens ÷ drafted tokens). Higher means speculative decoding is paying off; — when speculation is off or unused.",
} as const;

/** Compact token counts for the KV pool tile (883552 → 884k). */
function formatKvTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = Math.round((n / 1_000_000) * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (abs >= 1000) {
    const v = abs >= 10_000 ? Math.round(n / 1000) : Math.round((n / 1000) * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return Math.round(n).toLocaleString();
}

function formatKvBytes(n: number): string {
  const gib = n / 1024 ** 3;
  if (gib >= 10) return `${Math.round(gib)} GB`;
  if (gib >= 1) {
    const v = Math.round(gib * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} GB`;
  }
  return `${Math.round(n / 1024 ** 2)} MB`;
}

const REMOTE_STORAGE_KEY = "sparkdash.remote-bench-target";

function readStoredRemote(): { host: string; port: string; tls: boolean } {
  try {
    const raw = localStorage.getItem(REMOTE_STORAGE_KEY);
    if (!raw) return { host: "", port: "443", tls: true };
    const v = JSON.parse(raw) as { host?: string; port?: number; tls?: boolean };
    return {
      host: typeof v.host === "string" ? v.host : "",
      port: v.port != null ? String(v.port) : "443",
      tls: v.tls !== false,
    };
  } catch {
    return { host: "", port: "443", tls: true };
  }
}

/** Decode / Prefill / Quality / Showcase launchers — shown even when the live probe is empty
 *  (remote loopback-bound servers can still be benched via SSH tunnel). */
function LlmLaunchers({
  sparkId,
  llmPort,
  modelId,
  onLaunch,
  onRemoteLaunch,
}: {
  sparkId: string;
  llmPort: number;
  modelId?: string | null;
  onLaunch: (kind: BenchKind) => void;
  onRemoteLaunch: (kind: BenchKind, target: LlmBenchTarget) => void;
}) {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState(() => readStoredRemote().host);
  const [portDraft, setPortDraft] = useState(() => readStoredRemote().port);
  const [tls, setTls] = useState(() => readStoredRemote().tls);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const persist = (t: LlmBenchTarget) => {
    try {
      localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
  };

  const applyHostBlur = () => {
    if (!hostDraft.trim()) return;
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
    } catch {
      /* leave as typed until Run */
    }
  };

  const launchRemote = (kind: BenchKind) => {
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      persist(p);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
      onRemoteLaunch(kind, p);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    }
  };

  const localHint =
    "Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1.";

  return (
    <div className="sp-launchers">
      <div className="sp-btns">
        {(
          [
            ["decode", "Decode", `Decode benchmark: generation speed at rising concurrency, on this Spark. ${localHint}`],
            ["prefill", "Prefill", `Prefill benchmark: prompt processing speed and time to first token, on this Spark. ${localHint}`],
            ["quality", "Quality", "Quality suite (QA, reasoning, arithmetic, state tracking, GSM8K, MMLU) against this port's model. Compare runs across models, quantizations and KV-cache formats."],
            ["tool-eval", "Tool Eval Bench", "Benchmark this model's tool calling."],
          ] as const
        ).map(([type, label, title]) => (
          <button
            key={type}
            type="button"
            // Opens the benchmark's own page, already set to this Spark.
            onClick={() => window.dispatchEvent(new CustomEvent("sparkdash:navigate", { detail: { id: benchId(type), spark: sparkId } }))}
            className="btn btn--sm"
            title={title}
          >
            <BenchIcon id={type} className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const params = new URLSearchParams();
            if (llmPort) params.set("port", String(llmPort));
            if (modelId) params.set("model", modelId);
            const q = params.toString() ? `?${params.toString()}` : "";
            window.open(`/showcase/${encodeURIComponent(sparkId)}${q}`, "_blank", "noopener,noreferrer");
          }}
          className="btn btn--sm"
        >
          <ExpandIcon className="h-3.5 w-3.5" />
          Showcase
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`btn btn--sm btn--ghost sp-btns__end ${remoteOpen ? "is-on" : ""}`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          <ServerIcon className="h-3.5 w-3.5" />
          Remote
        </button>
      </div>
      {remoteOpen && (
        <div className="sp-remote">
          <p className="sp-hint">
            On-demand endpoint. Paste a URL or type host + port — nothing is probed until you run.
          </p>
          <label className="sp-field">
            <span className="eyebrow">Host</span>
            <input
              type="text"
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onBlur={applyHostBlur}
              placeholder="https://name.tailxxxxx.ts.net/v1/models"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="sp-input"
            />
          </label>
          <div className="sp-field-row">
            <label className="sp-field sp-field--grow">
              <span className="eyebrow">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                className="sp-input"
              />
            </label>
            <label className="sp-check">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
              />
              HTTPS
            </label>
          </div>
          {remoteError && <p className="sp-error">{remoteError}</p>}
          <div className="sp-btns">
            <button type="button" onClick={() => launchRemote("decode")} className="btn btn--sm">
              Decode
            </button>
            <button type="button" onClick={() => launchRemote("prefill")} className="btn btn--sm">
              Prefill
            </button>
            <button type="button" onClick={() => launchRemote("quality")} className="btn btn--sm">
              Quality
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const POSTURE_TONE: Record<NonNullable<LlmMetrics["posture"]>["level"], TagTone> = {
  ok: "good",
  warn: "warn",
  danger: "bad",
};

/** Exposure / auth posture from the unauthenticated probe (issue #17). */
function PostureBadge({ posture }: { posture: NonNullable<LlmMetrics["posture"]> }) {
  return (
    <Tag tone={POSTURE_TONE[posture.level]} title={posture.detail}>
      {posture.label}
    </Tag>
  );
}

/** Small (i) next to a metric label; one open tooltip at a time. */
function MetricInfoTip({
  id,
  label,
  text,
  openId,
  setOpenId,
  /** Anchor tooltip to the right so edge columns don’t clip off-screen */
  align = "left",
}: {
  id: string;
  label: string;
  text: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  align?: "left" | "right";
}) {
  const open = openId === id;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setOpenId(null), 2000);
  }, [clearTimer, setOpenId]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <div className="sp-tile__label">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => {
          if (open) {
            clearTimer();
            setOpenId(null);
          } else {
            setOpenId(id);
            scheduleClose();
          }
        }}
        onMouseEnter={() => {
          clearTimer();
          setOpenId(id);
        }}
        onMouseLeave={scheduleClose}
        className="relative cursor-pointer opacity-60 hover:opacity-100"
        aria-label={`${label} info`}
      >
        <InfoIcon className="h-2.5 w-2.5" />
        {open && (
          <div
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            className={`absolute top-full z-20 mt-1 w-52 max-w-[min(13rem,calc(100vw-1.5rem))] rounded-xl border border-border-strong bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${
              align === "right" ? "right-0 left-auto" : "left-0 right-auto"
            }`}
          >
            {text}
          </div>
        )}
      </button>
    </div>
  );
}

export function LlmPanel({
  llm,
  sparkId,
  sparkName,
  llmPort,
  llmPorts,
  hasApiKey = false,
  shareImage = false,
  onRemovePort,
  className,
}: LlmPanelProps) {
  // Tail keyed by port so multi-port LLM sparklines stay distinct (8b).
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const prefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefill`);
  const cachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillUncached`);

  // Full series (~1 h) for running averages over busy (>0) samples only.
  const genFull = useMetricsHistory(sparkId, `llm:${llmPort}.tps`);
  const prefillFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefill`);
  const cachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedFull = useMetricsHistory(sparkId, `llm:${llmPort}.prefillUncached`);
  const genAvg = useMemo(() => avgPositive(genFull), [genFull]);
  const prefillAvg = useMemo(() => avgPositive(prefillFull), [prefillFull]);
  const cachedPrefillAvg = useMemo(() => avgPositive(cachedFull), [cachedFull]);
  const uncachedPrefillAvg = useMemo(() => avgPositive(uncachedFull), [uncachedFull]);
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const [openBench, setOpenBench] = useState<BenchKind | null>(null);
  const [remoteTarget, setRemoteTarget] = useState<LlmBenchTarget | null>(null);
  const launchLocal = useCallback((kind: BenchKind) => {
    setRemoteTarget(null);
    setOpenBench(kind);
  }, []);
  const launchRemote = useCallback((kind: BenchKind, target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setOpenBench(kind);
  }, []);
  /** Which vLLM metric info tip is open (kvCache | requests | ttftP95 | preempts). */
  const [metricInfoId, setMetricInfoId] = useState<string | null>(null);
  const engineInfoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEngineInfoTimer = useCallback(() => {
    if (engineInfoTimer.current != null) {
      clearTimeout(engineInfoTimer.current);
      engineInfoTimer.current = null;
    }
  }, []);

  const startEngineInfoTimer = useCallback(() => {
    clearEngineInfoTimer();
    engineInfoTimer.current = setTimeout(() => setEngineInfoOpen(false), 2000);
  }, [clearEngineInfoTimer]);

  const generationTps = llm?.generationTps ?? 0;
  const prefillTps = llm?.prefillTps ?? 0;
  const showPrefillSplit = llm?.cachedPrefillTps != null || llm?.uncachedPrefillTps != null;
  const cachedPrefillTps = llm?.cachedPrefillTps ?? 0;
  const uncachedPrefillTps = llm?.uncachedPrefillTps ?? 0;
  const available = llm?.available ?? false;
  // While nothing is flowing, say when the endpoint last served.
  const idleNote = available && isLlmIdle({ generationTps, prefillTps })
    ? idleLabel(llm?.lastActiveAt)
    : null;

  // Keep draft in sync when server pushes a different port (other tab / reload)
  useEffect(() => {
    if (!showSettings) {
      setPortDraft(String(llmPort));
      setApiKeyDraft("");
      setClearApiKey(false);
    }
  }, [llmPort, showSettings]);

  const parsedPort = (() => {
    const n = parseInt(portDraft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  })();

  const portDirty = parsedPort !== null && parsedPort !== llmPort;
  const portInvalid = portDraft.trim() !== "" && parsedPort === null;
  const apiKeyDirty = apiKeyDraft.trim() !== "" || clearApiKey;
  const settingsDirty = portDirty || apiKeyDirty;

  const handleSaveSettings = async () => {
    if (parsedPort === null) {
      setSaveError("Port must be an integer 1–65535");
      return;
    }
    if (!settingsDirty) {
      setShowSettings(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (portDirty) {
        const currentPorts =
          Array.isArray(llmPorts) && llmPorts.length > 0 ? llmPorts : [llmPort];
        if (currentPorts.includes(parsedPort) && parsedPort !== llmPort) {
          setSaveError(`Port ${parsedPort} is already configured`);
          setSaving(false);
          return;
        }
        // Rename this panel's port in-place so sibling ports (and their keys) survive
        if (currentPorts.length > 1) {
          const next = currentPorts.map((p) => (p === llmPort ? parsedPort : p));
          await updateLlmPorts(sparkId, next);
        } else {
          await updateLlmPort(sparkId, parsedPort);
        }
      }
      const keyPort = parsedPort;
      if (clearApiKey) {
        await setLlmApiKey(sparkId, keyPort, "");
      } else if (apiKeyDraft.trim() !== "") {
        await setLlmApiKey(sparkId, keyPort, apiKeyDraft.trim());
      }
      setApiKeyDraft("");
      setClearApiKey(false);
      setShowSettings(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save LLM settings");
    } finally {
      setSaving(false);
    }
  };

  const fmtTps = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(1));
  const fmtAvg = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
  const isVllm = llm != null && (llm.backend === "vllm" || llm.backend === "q27");
  // FreeToken reports KV use, active requests and a TTFT mean in /v1/stats; the tiles below are null-gated.
  const isFreeToken = llm?.backend === "freetoken";
  const showEngineTiles = isVllm || isFreeToken;
  const kvTone =
    llm?.kvCacheUsage == null
      ? ""
      : llm.kvCacheUsage >= 0.8
        ? "text-danger"
        : llm.kvCacheUsage >= 0.5
          ? "text-warning"
          : "text-success";
  const contextLabel = llm?.contextLength
    ? llm.contextLength >= 1000
      ? `${Math.round(llm.contextLength / 1024)}k ctx`
      : `${llm.contextLength} ctx`
    : null;
  const backend = backendLabel(llm?.backend ?? null);

  const tile = (id: string, label: string, value: string, opts?: { tone?: string; sub?: string; align?: "left" | "right" }) => (
    <div className="sp-tile" key={id}>
      <b className={opts?.tone ?? ""}>{value}</b>
      <MetricInfoTip
        id={id}
        label={label}
        text={VLLM_METRIC_INFO[id as keyof typeof VLLM_METRIC_INFO]}
        openId={metricInfoId}
        setOpenId={setMetricInfoId}
        align={opts?.align}
      />
      {opts?.sub && <small>{opts.sub}</small>}
    </div>
  );

  const kvValue =
    llm?.kvCacheUsage != null
      ? `${(llm.kvCacheUsage * 100).toFixed(0)}%`
      : llm?.kvCacheTokensAvailable != null
        ? `${formatKvTokens(llm.kvCacheTokensAvailable)} free`
        : llm?.kvCacheTokens != null
          ? formatKvTokens(llm.kvCacheTokens)
          : null;
  const kvSub = [
    llm?.kvCacheUsage != null && llm?.kvCacheTokensAvailable != null
      ? `${formatKvTokens(llm.kvCacheTokensAvailable)} free`
      : null,
    llm?.kvCacheTokens != null ? `${formatKvTokens(llm.kvCacheTokens)} pool` : null,
    llm?.kvCacheMemoryBytes != null ? formatKvBytes(llm.kvCacheMemoryBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Panel
      title="LLM server"
      accent={available}
      icon={<BotIcon />}
      className={`panel-llm ${className ?? ""}`}
      bodyClassName="sp-stack"
      actions={
        <div className="sp-actions">
          {available && backend && (
            <>
              {llm?.via === "ssh-tunnel" && (
                <Tag title="This engine's port is not reachable from the dashboard, so it is read through an SSH tunnel to the unit">
                  via SSH
                </Tag>
              )}
              <Tag tone="info" title={`Backend: ${backend}`}>
                {backend} · :{llmPort}
              </Tag>
            </>
          )}
          {onRemovePort && (
            <button
              type="button"
              title={`Remove port ${llmPort}`}
              onClick={() => onRemovePort(llmPort)}
              className="btn btn--sm btn--danger"
            >
              <span aria-hidden>×</span>
              <span>Remove</span>
            </button>
          )}
          <button
            type="button"
            title={showSettings ? "Done" : "LLM settings"}
            onClick={() => {
              if (showSettings) {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
              }
              setShowSettings(!showSettings);
            }}
            disabled={saving}
            className={`btn btn--sm btn--ghost ${showSettings ? "is-on" : ""}`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="sp-stack">
          <p className="sp-hint">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / ds4 / EXL3 / TensorFold / OpenAI-compatible gateway).
          </p>
          <label className="sp-field">
            <span className="eyebrow">Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="sp-input"
            />
          </label>
          <div className="sp-btns" role="group" aria-label="Server presets">
            <span className="eyebrow">Presets:</span>
            <button
              type="button"
              title="Fill LM Studio's default port (1234)"
              onClick={() => setPortDraft("1234")}
              className="btn btn--sm"
            >
              LM Studio :1234
            </button>
            <button
              type="button"
              title="Fill Ollama's default port (11434)"
              onClick={() => setPortDraft("11434")}
              className="btn btn--sm"
            >
              Ollama :11434
            </button>
            <button
              type="button"
              title="Fill TensorFold's default port (8888)"
              onClick={() => setPortDraft("8888")}
              className="btn btn--sm"
            >
              TensorFold :8888
            </button>
          </div>
          <label className="sp-field">
            <span className="eyebrow">API key (optional)</span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKeyDraft}
              disabled={clearApiKey}
              placeholder={hasApiKey && !clearApiKey ? "•••••••• (saved — leave blank to keep)" : "Bearer token if required"}
              onChange={(e) => {
                setApiKeyDraft(e.target.value);
                setClearApiKey(false);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSettings();
                }
              }}
              className="sp-input"
            />
          </label>
          {hasApiKey && (
            <label className="sp-check">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked);
                  if (e.target.checked) setApiKeyDraft("");
                  setSaveError(null);
                }}
              />
              Clear saved API key
            </label>
          )}
          {portInvalid && <p className="sp-error">Enter an integer between 1 and 65535</p>}
          {saveError && <p className="sp-error">{saveError}</p>}
          <div className="sp-btns sp-btns--end">
            <button
              type="button"
              onClick={() => {
                setPortDraft(String(llmPort));
                setApiKeyDraft("");
                setClearApiKey(false);
                setSaveError(null);
                setShowSettings(false);
              }}
              disabled={saving}
              className="btn btn--sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSettings()}
              disabled={saving || portInvalid || !settingsDirty}
              className="btn btn--sm btn--primary"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="sp-stack">
          <div className="sp-chips">
            {llm?.posture ? <PostureBadge posture={llm.posture} /> : <span className="sdot sdot--off" />}
            <p className="sp-muted">
              {llm?.posture?.auth === "protected"
                ? `${llm.posture.label} on :${llmPort}`
                : `No model loaded on :${llmPort}`}
            </p>
          </div>
          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onLaunch={launchLocal}
            onRemoteLaunch={launchRemote}
          />
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTokenTotals sparkId={sparkId} llmPort={llmPort} />
        </div>
      ) : (
        <div className="sp-stack">
          <div className="sp-model">
            <div className="eyebrow">
              <span>Model</span>
              {contextLabel && <span>{contextLabel}</span>}
            </div>
            <code title={llm?.modelId ?? undefined}>{llm?.modelId ?? "—"}</code>
            {llm?.modelPath && llm.modelPath !== llm.modelId && !llm.modelPath.includes("models--") && (
              <small title={llm.modelPath}>{llm.modelPath}</small>
            )}
          </div>

          <div className="sp-decode">
            <div className="sp-metric">
              <span className="eyebrow">Decode</span>
              <div className="big-num sp-big-lg">
                {fmtTps(generationTps)}
                <small>tok/s</small>
              </div>
              <TrendLine data={genHistory} height={44} color="var(--color-accent)" />
              {genAvg != null && <span className="sp-avg mono">avg {fmtAvg(genAvg)}</span>}
              {idleNote && (
                <span className="sp-avg" data-llm-idle>
                  {idleNote}
                </span>
              )}
            </div>
            <div
              className="sp-metric"
              title="Prompt tokens/sec taken in during the last poll window — cache-served + computed. Opening a saved chat in the UI does not hit the GPU; send (or regenerate) so the history is sent as the prompt. Cached prefill does little GPU work; uncached prefill is what builds KV cache."
            >
              <span className="eyebrow">Prefill</span>
              <div className="big-num sp-big-lg">
                {llm?.prefillActive && prefillTps <= 0 ? (
                  <>
                    <span className="ov-tps__dots" aria-hidden />
                    <small title="A prompt is being processed. The engine reports its speed only when the request finishes.">prefilling</small>
                  </>
                ) : (
                  <>
                    {fmtTps(prefillTps)}
                    <small>tok/s</small>
                  </>
                )}
              </div>
              <TrendLine data={prefillHistory} height={44} color="var(--color-info)" />
              {prefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(prefillAvg)}</span>}
            </div>
          </div>
          {showPrefillSplit && (
            <div className="sp-decode sp-decode--split">
              <div
                className="sp-metric"
                title="Prefill tokens served from prefix cache (little GPU work). High values mean prompt reuse, not a faster cold prefill."
              >
                <span className="eyebrow">Cached prefill</span>
                <div className="big-num sp-big-md">
                  {fmtTps(cachedPrefillTps)}
                  <small>tok/s</small>
                </div>
                <TrendLine data={cachedPrefillHistory} height={30} color="var(--color-muted)" />
                {cachedPrefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(cachedPrefillAvg)}</span>}
              </div>
              <div
                className="sp-metric"
                title="Uncached (computed) prefill — tokens that actually build KV cache on the GPU."
              >
                <span className="eyebrow">Uncached prefill</span>
                <div className="big-num sp-big-md">
                  {fmtTps(uncachedPrefillTps)}
                  <small>tok/s</small>
                </div>
                <TrendLine data={uncachedPrefillHistory} height={30} color="var(--color-violet)" />
                {uncachedPrefillAvg != null && <span className="sp-avg mono">avg {fmtAvg(uncachedPrefillAvg)}</span>}
              </div>
            </div>
          )}

          <div className="sp-tiles">
            {showEngineTiles && kvValue != null && tile("kvCache", "KV cache", kvValue, { tone: kvTone, sub: kvSub || undefined })}
            {showEngineTiles &&
              llm?.requestsRunning != null &&
              tile(
                "requests",
                "Running / waiting",
                `${Math.round(llm.requestsRunning)} / ${llm.requestsWaiting != null ? Math.round(llm.requestsWaiting) : "—"}`,
                { align: "right" }
              )}
            {isFreeToken && llm?.ttftSeconds != null && tile("ttftMean", "TTFT mean", `${Math.round(llm.ttftSeconds * 1000)} ms`)}
            {showEngineTiles && llm?.ttftP95Seconds != null && tile("ttftP95", "TTFT p95", `${Math.round(llm.ttftP95Seconds * 1000)} ms`)}
            {showEngineTiles &&
              llm?.preemptionsTotal != null &&
              tile("preempts", "Preempts", Math.round(llm.preemptionsTotal).toLocaleString(), { align: "right" })}
            {showEngineTiles &&
              llm?.prefixCacheHitRate != null &&
              tile("prefixCache", "Prefix hit", `${(llm.prefixCacheHitRate * 100).toFixed(0)}%`)}
            {showEngineTiles && llm?.e2eP95Seconds != null && tile("e2eP95", "E2E p95", `${llm.e2eP95Seconds.toFixed(2)}s`, { align: "right" })}
            {showEngineTiles && llm?.itlP95Seconds != null && tile("itlP95", "Inter-token p95", `${Math.round(llm.itlP95Seconds * 1000)} ms`)}
            {showEngineTiles &&
              llm?.mtpAcceptanceRate != null &&
              tile("mtpAccept", "MTP accept", llm.mtpAcceptanceRate.toFixed(2), { align: "right" })}
            <div className="sp-tile">
              <b>
                {(llm?.slotsTotal ?? 0) > 0
                  ? `${llm?.slotsActive ?? 0} / ${llm?.slotsTotal ?? 0}`
                  : (llm?.slotsActive ?? 0) > 0
                    ? `${llm?.slotsActive} running`
                    : "—"}
              </b>
              <span>Slots</span>
            </div>
            <div className="sp-tile">
              <b>{llm?.contextLength ? llm.contextLength.toLocaleString() : "—"}</b>
              <span>Context</span>
            </div>
            <div className="sp-tile">
              {(() => {
                const engine = engineStateLabel(llm);
                return (
                  <b className={engine.muted ? "text-muted" : undefined} title={engine.title}>
                    {engine.text}
                  </b>
                );
              })()}
              <div className="sp-tile__label">
                <span>Engine</span>
                <button
                  type="button"
                  onClick={() => {
                    setEngineInfoOpen((v) => {
                      if (!v) startEngineInfoTimer();
                      return !v;
                    });
                  }}
                  onMouseEnter={clearEngineInfoTimer}
                  onMouseLeave={startEngineInfoTimer}
                  className="relative cursor-pointer opacity-60 hover:opacity-100"
                  aria-label="Engine state info"
                >
                  <InfoIcon className="h-2.5 w-2.5" />
                  {engineInfoOpen && (
                    <div
                      onMouseEnter={clearEngineInfoTimer}
                      onMouseLeave={startEngineInfoTimer}
                      className="absolute left-0 top-full z-10 mt-1 w-56 rounded-xl border border-border-strong bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case text-text shadow-lg"
                    >
                      Active = processing or ready for requests. Sleeping = idle, GPU memory freed until next request.
                    </div>
                  )}
                </button>
              </div>
            </div>
            <div className="sp-tile" title={ENGINE_GENERATED_TITLE}>
              <b>{llm && llm.totalOutputTokens > 0 ? llm.totalOutputTokens.toLocaleString() : "—"}</b>
              <span>{ENGINE_GENERATED_LABEL}</span>
            </div>
          </div>

          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onLaunch={launchLocal}
            onRemoteLaunch={launchRemote}
          />
          {llm?.posture && (
            <div className="sp-chips">
              <PostureBadge posture={llm.posture} />
            </div>
          )}
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTrendChart sparkId={sparkId} llmPort={llmPort} />
          <LlmTokenTotals sparkId={sparkId} llmPort={llmPort} />
        </div>
      )}

      <BenchmarkDialog
        open={openBench === "decode"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        models={remoteTarget || (available && llm?.backend === "llama.cpp") ? undefined : llm?.models}
        remoteTarget={remoteTarget}
        shareImage={shareImage}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
        liveTps={remoteTarget ? null : llm?.generationTps ?? null}
      />
      <PrefillBenchDialog
        open={openBench === "prefill"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
        shareImage={shareImage}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
      />
      <QualityBenchDialog
        open={openBench === "quality"}
        onClose={() => setOpenBench(null)}
        onSwitchBench={setOpenBench}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
        sparkName={sparkName ?? null}
        engine={remoteTarget ? null : llm?.backend ?? null}
        posture={remoteTarget ? null : llm?.posture ?? null}
      />
    </Panel>
  );
}
