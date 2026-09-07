import { useState, useEffect, useRef, useCallback } from "react";
import type { LlmMetrics, LlmBenchTarget } from "../../api/types";
import { setLlmApiKey, updateLlmPort, updateLlmPorts } from "../../api/client";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { BotIcon, GearIcon, InfoIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { PrefillBenchDialog } from "./PrefillBenchDialog";
import { LlmDailyChart } from "./LlmDailyChart";
import { parseLlmTargetInput } from "../../shared/llmTarget.js";

interface LlmPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  llmPort: number;
  llmPorts?: number[];
  hasApiKey?: boolean;
  onRemovePort?: (port: number) => void;
  className?: string;
}

const VLLM_METRIC_INFO = {
  kvCache:
    "Fraction of the engine’s KV cache memory currently in use (0–100%). High values (≥80%) mean little room for new or long contexts and often lead to queuing or preemptions.",
  requests:
    "Run = requests actively generating on the GPU. Wait = accepted but not yet scheduled (capacity or constraints). Growing wait with high KV cache usually means the server is overloaded.",
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

const LAUNCHER_BTN =
  "rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft";
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

/** Decode / prefill / Showcase launchers — shown even when the live probe is empty
 *  (remote loopback-bound servers can still be benched via SSH tunnel). */
function LlmLaunchers({
  sparkId,
  llmPort,
  modelId,
  onDecode,
  onPrefill,
  onRemoteDecode,
  onRemotePrefill,
}: {
  sparkId: string;
  llmPort: number;
  modelId?: string | null;
  onDecode: () => void;
  onPrefill: () => void;
  onRemoteDecode: (target: LlmBenchTarget) => void;
  onRemotePrefill: (target: LlmBenchTarget) => void;
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

  const launchRemote = (kind: "decode" | "prefill") => {
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      persist(p);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
      if (kind === "decode") onRemoteDecode(p);
      else onRemotePrefill(p);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDecode}
          className={`${LAUNCHER_BTN} min-w-0 flex-1`}
          title="Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1."
        >
          Run decode benchmark
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`shrink-0 rounded border px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${
            remoteOpen
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-elevated text-muted hover:border-accent hover:text-accent"
          }`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          Remote
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrefill}
          className={`${LAUNCHER_BTN} min-w-0 flex-1`}
          title="Runs against this Spark’s LLM. Remote units use LAN HTTP, or an SSH tunnel to loopback if the server only listens on 127.0.0.1."
        >
          Run prefill benchmark
        </button>
        <button
          type="button"
          onClick={() => {
            setRemoteOpen((v) => !v);
            setRemoteError(null);
          }}
          className={`shrink-0 rounded border px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${
            remoteOpen
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-elevated text-muted hover:border-accent hover:text-accent"
          }`}
          aria-expanded={remoteOpen}
          title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
        >
          Remote
        </button>
      </div>
      {remoteOpen && (
        <div className="space-y-2 rounded border border-border bg-surface-elevated p-2">
          <p className="text-[10px] leading-snug text-muted">
            On-demand endpoint. Paste a URL or type host + port — nothing is probed until you run.
          </p>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">Host</span>
            <input
              type="text"
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onBlur={applyHostBlur}
              placeholder="https://name.tailxxxxx.ts.net/v1/models"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex shrink-0 items-center gap-1.5 pb-1.5 text-[10px] text-muted">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              HTTPS
            </label>
          </div>
          {remoteError && <p className="text-[10px] text-danger">{remoteError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => launchRemote("decode")}
              className={`${LAUNCHER_BTN} flex-1`}
            >
              Decode
            </button>
            <button
              type="button"
              onClick={() => launchRemote("prefill")}
              className={`${LAUNCHER_BTN} flex-1`}
            >
              Prefill
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          const params = new URLSearchParams();
          if (llmPort) params.set("port", String(llmPort));
          if (modelId) params.set("model", modelId);
          const q = params.toString() ? `?${params.toString()}` : "";
          window.open(
            `/showcase/${encodeURIComponent(sparkId)}${q}`,
            "_blank",
            "noopener,noreferrer"
          );
        }}
        className={`${LAUNCHER_BTN} w-full`}
      >
        Showcase
      </button>
    </div>
  );
}

/** Backend badge — neutral surfaces with a single accent dot. No blue/purple. */
function BackendBadge({ backend }: { backend: string | null }) {
  if (!backend) return <span className="text-xs text-muted">No backend</span>;

  const labels: Record<string, string> = {
    vllm: "vLLM",
    "llama.cpp": "llama.cpp",
    sglang: "sgLang",
    ds4: "ds4",
    exl3: "EXL3",
    q27: "q27",
  };

  return (
    <span className="llm-badge">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      {labels[backend] || backend}
    </span>
  );
}

/** Exposure / auth posture from the unauthenticated probe (issue #17). */
function PostureBadge({
  posture,
}: {
  posture: NonNullable<LlmMetrics["posture"]>;
}) {
  return (
    <span
      className={`llm-posture llm-posture--${posture.level}`}
      title={posture.detail}
    >
      <span className="llm-posture__dot" />
      {posture.label}
    </span>
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
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
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
            className={`absolute top-full z-20 mt-1 w-52 max-w-[min(13rem,calc(100vw-1.5rem))] rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug text-text shadow-lg ${
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
  llmPort,
  llmPorts,
  hasApiKey = false,
  onRemovePort,
  className,
}: LlmPanelProps) {
  // Tail keyed by port so multi-port LLM sparklines stay distinct (8b).
  const genHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.tps`);
  const prefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefill`);
  const cachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillCached`);
  const uncachedPrefillHistory = useMetricsHistoryTail(sparkId, `llm:${llmPort}.prefillUncached`);
  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(llmPort));
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [prefillBenchOpen, setPrefillBenchOpen] = useState(false);
  const [remoteTarget, setRemoteTarget] = useState<LlmBenchTarget | null>(null);
  const openRemoteDecode = useCallback((target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setBenchOpen(true);
  }, []);
  const openRemotePrefill = useCallback((target: LlmBenchTarget) => {
    setRemoteTarget(target);
    setPrefillBenchOpen(true);
  }, []);
  const openLocalDecode = useCallback(() => {
    setRemoteTarget(null);
    setBenchOpen(true);
  }, []);
  const openLocalPrefill = useCallback(() => {
    setRemoteTarget(null);
    setPrefillBenchOpen(true);
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

  return (
    <Panel
      title="LLM"
      accent={available}
      icon={<BotIcon />}
      className={`panel-llm ${className}`}
      actions={
        <div className="flex items-center gap-1.5">
          {onRemovePort && (
            <button
              type="button"
              title={`Remove port ${llmPort}`}
              onClick={() => onRemovePort(llmPort)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10"
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
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
              showSettings ? "bg-surface-elevated text-text" : ""
            }`}
          >
            <GearIcon />
            <span>{showSettings ? "Done" : "Settings"}</span>
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-3">
          <p className="text-[10px] text-muted">
            HTTP port of the LLM server on this Spark (vLLM / llama.cpp / sglang / ds4 / EXL3 / OpenAI-compatible gateway).
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Port</span>
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
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">API key (optional)</span>
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
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-accent disabled:opacity-50"
            />
          </label>
          {hasApiKey && (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked);
                  if (e.target.checked) setApiKeyDraft("");
                  setSaveError(null);
                }}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              Clear saved API key
            </label>
          )}
          {portInvalid && (
            <p className="text-[10px] text-danger">Enter an integer between 1 and 65535</p>
          )}
          {saveError && <p className="text-[10px] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
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
              className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSettings()}
              disabled={saving || portInvalid || !settingsDirty}
              className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 py-1">
            {llm?.posture ? (
              <PostureBadge posture={llm.posture} />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted" />
            )}
            <p className="text-xs text-muted">
              {llm?.posture?.auth === "protected"
                ? `${llm.posture.label} on :${llmPort}`
                : `No model loaded on :${llmPort}`}
            </p>
          </div>
          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onDecode={openLocalDecode}
            onPrefill={openLocalPrefill}
            onRemoteDecode={openRemoteDecode}
            onRemotePrefill={openRemotePrefill}
          />
          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <BackendBadge backend={llm?.backend ?? null} />
            {llm?.posture && <PostureBadge posture={llm.posture} />}
            {llm?.modelId && (
              <span
                className="min-w-0 flex-1 whitespace-normal break-words text-xs leading-snug text-text [overflow-wrap:anywhere]"
                title={llm.modelId}
              >
                {llm.modelId}
              </span>
            )}
            <span className="shrink-0 font-tabular text-[10px] text-muted">:{llmPort}</span>
          </div>
          {llm?.modelPath &&
            llm.modelPath !== llm.modelId &&
            !llm.modelPath.includes("models--") && (
            <div className="-mt-1.5 truncate text-[10px] text-muted" title={llm.modelPath}>
              {llm.modelPath}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Generation tok/s</span>
            <div className="flex items-center gap-2">
              <Sparkline data={genHistory} color="var(--color-accent)" height={24} />
              <span className="font-tabular text-sm font-semibold text-accent">
                {generationTps.toFixed(1)}
              </span>
            </div>
          </div>
          <div
            className="flex items-center justify-between"
            title="Tokens/sec while the engine is reading the prompt and building KV cache — before the first output token. Opening a saved chat in the UI does not hit the GPU; send (or regenerate) so the history is sent as the prompt. Prefix-cache hits do little compute, so this can stay ~0. Long cold prefills show here until decode starts."
          >
            <span className="text-xs text-muted">Prefill tok/s</span>
            <div className="flex items-center gap-2">
              <Sparkline data={prefillHistory} color="var(--color-text)" height={24} />
              <span className="font-tabular text-sm font-semibold text-text">
                {prefillTps.toFixed(1)}
              </span>
            </div>
          </div>
          {showPrefillSplit && (
            <>
              <div
                className="flex items-center justify-between"
                title="Prefill tokens served from prefix cache (little GPU work). High values mean prompt reuse, not a faster cold prefill."
              >
                <span className="text-xs text-muted">Cached prefill tok/s</span>
                <div className="flex items-center gap-2">
                  <Sparkline data={cachedPrefillHistory} color="var(--color-muted)" height={24} />
                  <span className="font-tabular text-sm font-semibold text-muted">
                    {cachedPrefillTps.toFixed(1)}
                  </span>
                </div>
              </div>
              <div
                className="flex items-center justify-between"
                title="Uncached (computed) prefill — tokens that actually build KV cache on the GPU."
              >
                <span className="text-xs text-muted">Uncached prefill tok/s</span>
                <div className="flex items-center gap-2">
                  <Sparkline data={uncachedPrefillHistory} color="var(--color-text)" height={24} />
                  <span className="font-tabular text-sm font-semibold text-text">
                    {uncachedPrefillTps.toFixed(1)}
                  </span>
                </div>
              </div>
            </>
          )}

          <LlmDailyChart sparkId={sparkId} llmPort={llmPort} />

          <div className="grid grid-cols-4 gap-2 border-t border-border pt-3">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Slots</div>
              <div className="font-tabular text-sm text-text">
                {(llm?.slotsTotal ?? 0) > 0
                  ? `${llm?.slotsActive ?? 0} / ${llm?.slotsTotal ?? 0}`
                  : (llm?.slotsActive ?? 0) > 0
                    ? `${llm?.slotsActive} running`
                    : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Context</div>
              <div className="font-tabular text-sm text-text">
                {llm?.contextLength ? llm.contextLength.toLocaleString() : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
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
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  {engineInfoOpen && (
                    <div
                      onMouseEnter={clearEngineInfoTimer}
                      onMouseLeave={startEngineInfoTimer}
                      className="absolute left-0 top-full z-10 mt-1 w-56 rounded-md border border-border bg-surface-elevated px-3 py-2 text-left text-[11px] font-normal normal-case text-text shadow-lg"
                    >
                      Active = processing or ready for requests. Sleeping = idle, GPU memory freed until next request.
                    </div>
                  )}
                </button>
              </div>
              <div className="font-tabular text-sm text-text">
                {llm?.gpuMemoryUtilization != null
                  ? llm.gpuMemoryUtilization === 0
                    ? "Sleeping"
                    : "Active"
                  : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Total Generated</div>
              <div className="font-tabular text-sm text-text">
                {llm && llm.totalOutputTokens > 0
                  ? llm.totalOutputTokens.toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>

          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="kvCache"
                  label="KV Cache"
                  text={VLLM_METRIC_INFO.kvCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div
                  className={`font-tabular text-sm ${
                    llm.kvCacheUsage == null
                      ? "text-text"
                      : llm.kvCacheUsage >= 0.8
                        ? "text-danger"
                        : llm.kvCacheUsage >= 0.5
                          ? "text-warning"
                          : "text-success"
                  }`}
                >
                  {llm.kvCacheUsage != null
                    ? `${(llm.kvCacheUsage * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="requests"
                  label="Requests"
                  text={VLLM_METRIC_INFO.requests}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.requestsRunning != null
                    ? `${Math.round(llm.requestsRunning)} run${
                        llm.requestsWaiting != null
                          ? ` / ${Math.round(llm.requestsWaiting)} wait`
                          : ""
                      }`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="ttftP95"
                  label="TTFT p95"
                  text={VLLM_METRIC_INFO.ttftP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.ttftP95Seconds != null ? `${llm.ttftP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="preempts"
                  label="Preempts"
                  text={VLLM_METRIC_INFO.preempts}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.preemptionsTotal != null
                    ? Math.round(llm.preemptionsTotal).toLocaleString()
                    : "—"}
                </div>
              </div>
            </div>
          )}

          {llm && (llm.backend === "vllm" || llm.backend === "q27") && (
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="prefixCache"
                  label="Prefix Cache"
                  text={VLLM_METRIC_INFO.prefixCache}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.prefixCacheHitRate != null
                    ? `${(llm.prefixCacheHitRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="e2eP95"
                  label="E2E p95"
                  text={VLLM_METRIC_INFO.e2eP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.e2eP95Seconds != null ? `${llm.e2eP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="itlP95"
                  label="ITL p95"
                  text={VLLM_METRIC_INFO.itlP95}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                />
                <div className="font-tabular text-sm text-text">
                  {llm.itlP95Seconds != null ? `${llm.itlP95Seconds.toFixed(3)}s` : "—"}
                </div>
              </div>
              <div className="space-y-0.5">
                <MetricInfoTip
                  id="mtpAccept"
                  label="MTP Accept"
                  text={VLLM_METRIC_INFO.mtpAccept}
                  openId={metricInfoId}
                  setOpenId={setMetricInfoId}
                  align="right"
                />
                <div className="font-tabular text-sm text-text">
                  {llm.mtpAcceptanceRate != null
                    ? `${(llm.mtpAcceptanceRate * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
            </div>
          )}

          <LlmLaunchers
            sparkId={sparkId}
            llmPort={llmPort}
            modelId={llm?.modelId}
            onDecode={openLocalDecode}
            onPrefill={openLocalPrefill}
            onRemoteDecode={openRemoteDecode}
            onRemotePrefill={openRemotePrefill}
          />
        </div>
      )}

      <BenchmarkDialog
        open={benchOpen}
        onClose={() => setBenchOpen(false)}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        remoteTarget={remoteTarget}
      />
      <PrefillBenchDialog
        open={prefillBenchOpen}
        onClose={() => setPrefillBenchOpen(false)}
        sparkId={sparkId}
        llmPort={llmPort}
        modelId={remoteTarget ? null : llm?.modelId ?? null}
        contextLength={remoteTarget ? null : llm?.contextLength ?? null}
        remoteTarget={remoteTarget}
      />
    </Panel>
  );
}
