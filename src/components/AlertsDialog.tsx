import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchAlerts,
  fetchAlertsConfig,
  testAlertChannel,
  updateAlertsConfig,
  updateSettings,
} from "../api/client";
import type {
  AlertChannel,
  AlertChannelType,
  AlertEvent,
  AlertInstance,
  AlertRule,
  AlertSeverity,
  AlertsConfig,
  Settings,
} from "../api/types";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalPresence } from "../hooks/useModalPresence";
import { formatSince } from "../shared/formatSince";

interface AlertsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The master switch saved: Settings mirrors it without marking itself dirty. */
  onSettingsSaved: (settings: Settings) => void;
}

const CHANNEL_TYPES: Array<{ value: AlertChannelType; label: string; placeholder: string }> = [
  { value: "ntfy", label: "ntfy", placeholder: "https://ntfy.sh/your-topic" },
  { value: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/…" },
  { value: "slack", label: "Slack", placeholder: "https://hooks.slack.com/services/…" },
  { value: "webhook", label: "Webhook (JSON)", placeholder: "https://example.com/hook" },
];

const REPEAT_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 60, label: "Every hour" },
  { value: 240, label: "Every 4 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every day" },
];

const inputClass =
  "w-full rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text outline-none focus:border-accent";

/** Editable rule values as strings, so a half-typed number is not clobbered. */
type RuleDraft = Record<string, string | boolean>;
type TestState = { pending: boolean; ok?: boolean; message?: string };

function ruleDraft(rule: AlertRule): RuleDraft {
  const out: RuleDraft = {};
  for (const [k, v] of Object.entries(rule.defaults)) {
    const value = rule.overrides[k] ?? v;
    out[k] = typeof value === "boolean" ? value : String(value);
  }
  return out;
}

/** Only the values that differ from the rule's defaults are stored. */
function ruleOverrides(rule: AlertRule, draft: RuleDraft): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [k, def] of Object.entries(rule.defaults)) {
    const raw = draft[k];
    const value = typeof def === "boolean" ? Boolean(raw) : Number(raw);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${rule.name}: ${k === "forSec" ? "duration" : k} must be a number`);
    }
    if (value !== def) out[k] = value;
  }
  return out;
}

function Switch({ on, onToggle, label, disabled }: { on: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${on ? "is-on" : ""}`}
    >
      <span className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

function severityClass(severity: AlertSeverity) {
  return severity === "critical" ? "text-danger" : "text-warning";
}

function EventRow({ event, now }: { event: AlertEvent; now: number }) {
  const resolved = event.status === "resolved";
  return (
    <li className="flex items-start gap-2 py-1 text-[11px] leading-snug">
      <span className={`w-16 shrink-0 font-medium ${resolved ? "text-success" : severityClass(event.severity)}`}>
        {resolved ? "Resolved" : event.severity === "critical" ? "Critical" : "Warning"}
      </span>
      <span className="min-w-0 flex-1 text-text">
        <strong>{event.unitName}</strong> · {event.ruleName}
        <span className="block text-muted">{event.summary}</span>
      </span>
      <span className="shrink-0 text-muted" title={new Date(event.at).toLocaleString()}>
        {formatSince(event.at, now) ?? "—"} ago
      </span>
    </li>
  );
}

function ActiveRow({ alert, now }: { alert: AlertInstance; now: number }) {
  return (
    <li className={`py-1 text-[11px] leading-snug ${severityClass(alert.severity)}`}>
      <strong>{alert.unitName}</strong> · {alert.ruleName} · {formatSince(alert.startsAt, now) ?? "now"}
      <span className="block text-muted">{alert.summary}</span>
    </li>
  );
}

export function AlertsDialog({ open, onClose, onSettingsSaved }: AlertsDialogProps) {
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<Record<string, RuleDraft>>({});
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [repeat, setRepeat] = useState(0);
  const [recent, setRecent] = useState<AlertEvent[]>([]);
  const [active, setActive] = useState<AlertInstance[]>([]);
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const applyConfig = useCallback((c: AlertsConfig) => {
    setConfig(c);
    setEnabled(c.enabled);
    setRepeat(c.repeatIntervalMin);
    setRules(Object.fromEntries(c.rules.map((r) => [r.id, ruleDraft(r)])));
    setChannels(c.channels.map((ch) => ({ ...ch })));
    setDirty(false);
  }, []);

  const loadStatus = useCallback(() => {
    fetchAlerts()
      .then((s) => {
        setRecent(s.recent);
        setActive(s.active);
        setNow(Date.now());
      })
      .catch(() => {
        /* the list is a convenience; the config error (if any) is shown */
      });
  }, []);

  useEffect(() => {
    if (!open) {
      setConfig(null);
      setError(null);
      setTests({});
      setSavedNote(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchAlertsConfig()
      .then((c) => {
        if (!cancelled) applyConfig(c);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    loadStatus();
    return () => {
      cancelled = true;
    };
  }, [open, applyConfig, loadStatus]);

  // Keep "Firing now" and the recent events current while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(loadStatus, 10_000);
    return () => window.clearInterval(timer);
  }, [open, loadStatus]);

  // Capture-phase Escape so Settings underneath does not close too.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const touch = () => {
    setDirty(true);
    setSavedNote(false);
  };

  const toggleEnabled = async () => {
    setToggling(true);
    setError(null);
    try {
      const s = await updateSettings({ alertsEnabled: !enabled });
      setEnabled(Boolean(s.alertsEnabled));
      onSettingsSaved(s);
      loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const setRuleValue = (id: string, key: string, value: string | boolean) => {
    setRules((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
    touch();
  };

  const setChannel = (index: number, patch: Partial<AlertChannel>) => {
    setChannels((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setTests((prev) => ({ ...prev, [index]: { pending: false } }));
    touch();
  };

  const addChannel = () => {
    setChannels((prev) => [...prev, { name: "", type: "ntfy", url: "", enabled: true, minSeverity: "warning" }]);
    touch();
  };

  const removeChannel = (index: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== index));
    setTests({});
    touch();
  };

  const sendTest = async (index: number) => {
    const ch = channels[index];
    setTests((prev) => ({ ...prev, [index]: { pending: true } }));
    try {
      const r = await testAlertChannel(ch.id, {
        name: ch.name.trim() || "Test",
        type: ch.type,
        url: ch.url,
        enabled: true,
        minSeverity: ch.minSeverity,
      });
      setTests((prev) => ({
        ...prev,
        [index]: { pending: false, ok: r.ok, message: r.ok ? "Sent" : r.error || "Failed" },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [index]: { pending: false, ok: false, message: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const ruleUpdate: Record<string, Record<string, number | boolean>> = {};
      for (const rule of config.rules) {
        const o = ruleOverrides(rule, rules[rule.id] ?? ruleDraft(rule));
        if (Object.keys(o).length) ruleUpdate[rule.id] = o;
      }
      const next = await updateAlertsConfig({
        repeatIntervalMin: repeat,
        rules: ruleUpdate,
        channels: channels.map(({ status: _status, ...c }) => ({ ...c, name: c.name.trim(), url: c.url.trim() })),
      });
      applyConfig(next);
      setTests({});
      setSavedNote(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="modal-sheet modal-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header" id={titleId}>
          Alerts
        </div>

        <div className="modal-sheet__body space-y-5">
          {loading && <p className="text-xs text-muted">Loading…</p>}

          {config && !loading && (
            <>
              <section className="flex items-start gap-3 text-xs">
                <Switch on={enabled} onToggle={() => void toggleEnabled()} label="Server alerts" disabled={toggling} />
                <span>
                  <span className="block text-text">Server alerts</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    The server checks these rules on every fleet snapshot and notifies the channels below
                    when an alert fires or resolves. Off by default — while off nothing is evaluated or sent.
                    Saved immediately.
                  </span>
                </span>
              </section>

              {enabled && active.length > 0 && (
                <section aria-label="Firing now">
                  <h3 className="mb-1 text-xs font-semibold text-text-strong">Firing now · {active.length}</h3>
                  <ul>
                    {active.map((a) => (
                      <ActiveRow key={a.key} alert={a} now={now} />
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label="Rules">
                <h3 className="mb-2 text-xs font-semibold text-text-strong">Rules</h3>
                <ul className="space-y-2">
                  {config.rules.map((rule) => {
                    const draft = rules[rule.id] ?? ruleDraft(rule);
                    const on = draft.enabled === true;
                    return (
                      <li key={rule.id} className="rounded border border-border p-2" data-rule={rule.id}>
                        <div className="flex items-start gap-3">
                          <Switch on={on} onToggle={() => setRuleValue(rule.id, "enabled", !on)} label={`${rule.name} rule`} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs text-text">{rule.name}</span>
                            <span className="mt-0.5 block text-[10px] leading-snug text-muted">{rule.description}</span>
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 pl-12">
                          <label className="flex items-center gap-1 text-[10px] text-muted">
                            For
                            <input
                              type="number"
                              min={0}
                              step={1}
                              aria-label={`${rule.name} duration (seconds)`}
                              value={String(draft.forSec ?? "")}
                              onChange={(e) => setRuleValue(rule.id, "forSec", e.target.value)}
                              className={`${inputClass} w-16`}
                            />
                            s
                          </label>
                          {rule.fields.map((f) => (
                            <label key={f.key} className="flex items-center gap-1 text-[10px] text-muted">
                              {f.label}
                              <input
                                type="number"
                                min={f.min}
                                max={f.max}
                                step="any"
                                aria-label={`${rule.name} ${f.label}`}
                                value={String(draft[f.key] ?? "")}
                                onChange={(e) => setRuleValue(rule.id, f.key, e.target.value)}
                                className={`${inputClass} w-16`}
                              />
                              {f.unit}
                            </label>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-label="Notification channels">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-text-strong">Notification channels</h3>
                  <button
                    type="button"
                    onClick={addChannel}
                    className="rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-muted hover:bg-surface-hover"
                  >
                    Add channel
                  </button>
                </div>
                {channels.length === 0 && (
                  <p className="text-[11px] text-muted">
                    No channels — alerts still show on the Overview strip. Add ntfy, Discord, Slack or a JSON webhook to be notified.
                  </p>
                )}
                <ul className="space-y-2">
                  {channels.map((ch, i) => {
                    const meta = CHANNEL_TYPES.find((t) => t.value === ch.type) ?? CHANNEL_TYPES[0];
                    const test = tests[i];
                    return (
                      <li key={ch.id ?? `new-${i}`} className="space-y-2 rounded border border-border p-2" data-channel={i}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Switch on={ch.enabled} onToggle={() => setChannel(i, { enabled: !ch.enabled })} label={`Channel ${ch.name || i + 1} enabled`} />
                          <input
                            aria-label="Channel name"
                            placeholder="Name"
                            value={ch.name}
                            maxLength={60}
                            onChange={(e) => setChannel(i, { name: e.target.value })}
                            className={`${inputClass} min-w-0 flex-1`}
                          />
                          <select
                            aria-label="Channel type"
                            value={ch.type}
                            onChange={(e) => setChannel(i, { type: e.target.value as AlertChannelType })}
                            className={`${inputClass} w-auto`}
                          >
                            {CHANNEL_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Minimum severity"
                            value={ch.minSeverity}
                            onChange={(e) => setChannel(i, { minSeverity: e.target.value as AlertSeverity })}
                            className={`${inputClass} w-auto`}
                          >
                            <option value="warning">Warning +</option>
                            <option value="critical">Critical only</option>
                          </select>
                        </div>
                        <input
                          aria-label="Channel URL"
                          placeholder={meta.placeholder}
                          value={ch.url}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => setChannel(i, { url: e.target.value })}
                          className={`${inputClass} font-mono`}
                        />
                        {ch.id && ch.url.includes("…") && (
                          <p className="text-[10px] text-muted">Stored URL is hidden. Leave it as is to keep it, or paste a new one.</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void sendTest(i)}
                            disabled={!ch.url.trim() || test?.pending}
                            className="rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
                          >
                            {test?.pending ? "Sending…" : "Send test"}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeChannel(i)}
                            className="rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-muted hover:bg-surface-hover"
                          >
                            Remove
                          </button>
                          {test && !test.pending && test.message && (
                            <span role="status" className={`text-[11px] ${test.ok ? "text-success" : "text-danger"}`}>
                              {test.message}
                            </span>
                          )}
                          {!test?.message && ch.status?.lastError && (
                            <span className="text-[11px] text-danger" title={ch.status.lastErrorAt ? new Date(ch.status.lastErrorAt).toLocaleString() : undefined}>
                              Last send failed: {ch.status.lastError}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                  Remind while still firing
                  <select
                    aria-label="Repeat reminder"
                    value={repeat}
                    onChange={(e) => {
                      setRepeat(Number(e.target.value));
                      touch();
                    }}
                    className={`${inputClass} w-auto`}
                  >
                    {(REPEAT_OPTIONS.some((o) => o.value === repeat)
                      ? REPEAT_OPTIONS
                      : [...REPEAT_OPTIONS, { value: repeat, label: `Every ${repeat} min` }]
                    ).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <section aria-label="Recent events">
                <h3 className="mb-1 text-xs font-semibold text-text-strong">Recent events</h3>
                {recent.length === 0 ? (
                  <p className="text-[11px] text-muted">Nothing has fired since the server started.</p>
                ) : (
                  <ul className="max-h-48 divide-y divide-border overflow-y-auto">
                    {recent.slice(0, 50).map((e) => (
                      <EventRow key={e.id} event={e} now={now} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {error && (
            <div role="alert" className="rounded bg-danger/20 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
        </div>

        <div className="modal-sheet__footer">
          <span className="text-[10px] text-muted" role="status">
            {savedNote ? "Saved" : dirty ? "Unsaved changes" : "Stored in config/alerts.json"}
          </span>
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!config || saving || !dirty}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
