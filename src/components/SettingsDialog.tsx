import { useEffect, useState } from "react";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";
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

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEscape(onClose);

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setError(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
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

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
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
      <div className="settings-panel w-full max-w-sm p-6">
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoHideOffline}
                  onClick={() => update({ autoHideOffline: !settings.autoHideOffline })}
                  className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.autoHideOffline ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.autoHideOffline ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                Auto-hide offline Sparks on Overview
              </label>
            </div>

            {/* Benchmark debug traces */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.benchDebugTraces)}
                  onClick={() =>
                    update({ benchDebugTraces: !settings.benchDebugTraces })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.benchDebugTraces ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.benchDebugTraces ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.density === "compact"}
                  onClick={() =>
                    update({
                      density: settings.density === "compact" ? "comfortable" : "compact",
                    })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.density === "compact" ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.density === "compact" ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span>
                  <span className="block text-text">Compact UI</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Tighter spacing, smaller radius, and reduced font size — fits more Sparks on a single screen.
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        {/* Links */}
        <div className="mt-5 flex items-center gap-3 border-t border-border pt-3">
          <span className="text-[10px] text-muted">sparkDash v1.23.1</span>
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
