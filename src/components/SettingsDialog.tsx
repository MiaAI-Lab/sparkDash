import { useEffect, useState } from "react";
import {
  fetchSessionSources,
  fetchSettings,
  testSessionSources,
  updateSessionSources,
  updateSettings,
} from "../api/client";
import type {
  SessionSourceAttach,
  SessionSources,
  SessionSourcesHealth,
  SessionSourcesPatch,
  Settings,
} from "../api/types";
import { SessionSourceFields } from "./SessionSourceFields";
import { useModalPresence } from "../hooks/useModalPresence";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const POLL_PRESETS = [
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

const SOURCE_IDS = ["openclaw", "hermes"] as const;

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sessionSources, setSessionSources] = useState<SessionSources | null>(null);
  const [tokenDrafts, setTokenDrafts] = useState({ openclaw: "", hermes: "" });
  const [clearTokens, setClearTokens] = useState({ openclaw: false, hermes: false });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sourceHealth, setSourceHealth] = useState<SessionSourcesHealth | null>(null);
  const [checkingSources, setCheckingSources] = useState(false);

  useEscape(onClose);

  const sourceTestBody = (sources: SessionSources): SessionSourcesPatch => {
    const patch: SessionSourcesPatch = {};
    for (const id of SOURCE_IDS) {
      const src = sources[id];
      const draft = tokenDrafts[id];
      patch[id] = {
        enabled: src.enabled,
        mode: src.mode,
        url: src.url,
        stateDir: src.stateDir,
        ...(clearTokens[id] && !draft ? { token: "" } : draft ? { token: draft } : {}),
      };
    }
    return patch;
  };

  const runSourceCheck = async (sources: SessionSources) => {
    setCheckingSources(true);
    try {
      const result = await testSessionSources(sourceTestBody(sources));
      setSourceHealth(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingSources(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setSessionSources(null);
      setTokenDrafts({ openclaw: "", hermes: "" });
      setClearTokens({ openclaw: false, hermes: false });
      setSourceHealth(null);
      setCheckingSources(false);
      setError(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchSettings(), fetchSessionSources()])
      .then(([s, sources]) => {
        if (cancelled) return;
        setSettings(s);
        setSessionSources(sources);
        setCheckingSources(true);
        testSessionSources({
          openclaw: {
            enabled: sources.openclaw.enabled,
            mode: sources.openclaw.mode,
            url: sources.openclaw.url,
            stateDir: sources.openclaw.stateDir,
          },
          hermes: {
            enabled: sources.hermes.enabled,
            mode: sources.hermes.mode,
            url: sources.hermes.url,
            stateDir: sources.hermes.stateDir,
          },
        })
          .then((result) => {
            if (!cancelled) setSourceHealth(result);
          })
          .catch((err: unknown) => {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            if (!cancelled) setCheckingSources(false);
          });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { mounted, visible } = useModalPresence(open);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const patchSource = (id: (typeof SOURCE_IDS)[number], patch: Partial<SessionSourceAttach>) => {
    setSessionSources((prev) => (prev ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      if (sessionSources) {
        const sessionPatch: SessionSourcesPatch = {};
        for (const id of SOURCE_IDS) {
          const src = sessionSources[id];
          const draft = tokenDrafts[id];
          sessionPatch[id] = {
            enabled: src.enabled,
            mode: src.mode,
            url: src.url,
            stateDir: src.stateDir,
            ...(clearTokens[id] && !draft ? { token: "" } : draft ? { token: draft } : {}),
          };
        }
        await updateSessionSources(sessionPatch);
      }
      const result = await updateSettings(settings);
      setSettings(result);
      setDirty(false);
      onSaved(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`settings-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4${
        visible ? " is-open" : ""
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h2 className="mb-4 text-sm font-semibold text-text-strong">Settings</h2>

        {loading && <p className="text-xs text-muted">Loading…</p>}

        {settings && !loading && (
          <div className="space-y-4">
            {/* Poll interval */}
            <div>
              <label className="mb-2 block text-xs text-muted">Poll interval</label>
              <div className="flex gap-2">
                {POLL_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => update({ pollIntervalMs: preset.value })}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      settings.pollIntervalMs === preset.value
                        ? "bg-accent text-white"
                        : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Default LLM port */}
            <div>
              <label className="mb-1 block text-xs text-muted">Default LLM port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={settings.defaultLlmPort}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) update({ defaultLlmPort: val });
                }}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              />
              <p className="mt-1 text-[10px] text-muted">
                Pre-filled when adding a new Spark (1–65535)
              </p>
            </div>

            {/* Auto-hide offline */}
            <div>
              <label className="flex items-center gap-3 text-xs text-muted">
                <Toggle
                  on={settings.autoHideOffline}
                  onClick={() => update({ autoHideOffline: !settings.autoHideOffline })}
                />
                Auto-hide offline Sparks on Overview
              </label>
            </div>

            {/* Benchmark debug traces */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <Toggle
                  on={Boolean(settings.benchDebugTraces)}
                  onClick={() =>
                    update({ benchDebugTraces: !settings.benchDebugTraces })
                  }
                />
                <span>
                  <span className="block text-text">Enable debug traces for Benchmark runs</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Stores prompts, HTTP/completion IDs, content previews, and GPU
                    samples in bench history. Off by default — larger history files.
                  </span>
                </span>
              </label>
            </div>

            {/* Temperature unit */}
            <div>
              <label className="text-xs text-muted">Temperature unit</label>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => update({ temperatureUnit: "celsius" })}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    settings.temperatureUnit === "celsius"
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                  }`}
                >
                  °C
                </button>
                <button
                  type="button"
                  onClick={() => update({ temperatureUnit: "fahrenheit" })}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    settings.temperatureUnit === "fahrenheit"
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                  }`}
                >
                  °F
                </button>
              </div>
            </div>

            {/* Density */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <Toggle
                  on={settings.density === "compact"}
                  onClick={() =>
                    update({
                      density: settings.density === "compact" ? "comfortable" : "compact",
                    })
                  }
                />
                <span>
                  <span className="block text-text">Compact UI</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Tighter spacing, smaller radius, and reduced font size — fits more Sparks on a single screen.
                  </span>
                </span>
              </label>
            </div>

            {sessionSources && (
              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="text-xs font-medium text-text">Session sources</h3>
                <p className="text-[10px] leading-snug text-muted">
                  Optional OpenClaw and Hermes Agent conversations. Local defaults are{" "}
                  ~/.openclaw (or OPENCLAW_STATE_DIR) and ~/.hermes (or HERMES_HOME). Use a
                  state dir or URL when the product is on another host or in Docker.
                </p>
                {SOURCE_IDS.map((id) => (
                  <SessionSourceFields
                    key={id}
                    id={id}
                    source={sessionSources[id]}
                    tokenDraft={tokenDrafts[id]}
                    health={sourceHealth?.[id]}
                    checking={checkingSources}
                    onSource={(patch) => patchSource(id, patch)}
                    onToken={(value) => {
                      setTokenDrafts((prev) => ({ ...prev, [id]: value }));
                      if (value) {
                        setClearTokens((prev) => ({ ...prev, [id]: false }));
                      }
                      setDirty(true);
                    }}
                    onClearToken={() => {
                      setTokenDrafts((prev) => ({ ...prev, [id]: "" }));
                      setClearTokens((prev) => ({ ...prev, [id]: true }));
                      patchSource(id, { hasToken: false });
                    }}
                    onCheck={() => void runSourceCheck(sessionSources)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Links */}
        <div className="mt-5 flex items-center gap-3 border-t border-border pt-3">
          <span className="text-[10px] text-muted">sparkDash v1.3.0</span>
          <span className="text-border-strong text-[10px]">·</span>
          <a
            href="https://x.com/MiaAI_lab"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-accent transition-colors"
          >
            𝕏 @MiaAI_lab
          </a>
          <span className="text-border-strong text-[10px]">·</span>
          <a
            href="https://github.com/MiaAI-Lab"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-accent transition-colors"
          >
            GitHub MiaAI-Lab
          </a>
        </div>

        {error && (
          <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !settings || !dirty}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
