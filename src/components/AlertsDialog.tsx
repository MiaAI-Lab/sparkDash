import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { fetchAlerts, fetchAlertsConfig, testAlertChannel, updateAlertsConfig, updateSettings } from "../api/client";
import type { AlertChannel, AlertChannelType, AlertEvent, AlertInstance, AlertRule, AlertSeverity, AlertsConfig, Settings } from "../api/types";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalPresence } from "../hooks/useModalPresence";
import { formatSince } from "../shared/formatSince";
import { PlusIcon, XIcon } from "./ui/icons";
import { SettingRow, ToggleRow } from "./SettingRows";
import "../styles/dialogs.css";

interface AlertsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The switch was saved: Settings mirrors it without marking itself dirty. */
  onSettingsSaved: (settings: Settings) => void;
}

const CHANNEL_TYPES: Array<{ value: AlertChannelType; label: string; placeholder: string }> = [
  { value: "ntfy", label: "ntfy", placeholder: "https://ntfy.sh/your-topic or http://192.168.1.10/topic" },
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

const SOURCES: Array<{ id: AlertRule["source"]; title: string; help: string }> = [
  { id: "strip", title: "Overview exceptions", help: "The conditions the Overview exceptions strip shows." },
  { id: "health", title: "Health findings", help: "The findings on the unit cards, with the Health rules' own thresholds." },
];

/** Editable rule values; `forSec` stays a string so a half-typed number is not clobbered. */
type RuleDraft = { enabled: boolean; forSec: string };
type TestState = { pending: boolean; ok?: boolean; message?: string };

function ruleDraft(rule: AlertRule): RuleDraft {
  return {
    enabled: rule.overrides.enabled ?? rule.defaults.enabled,
    forSec: String(rule.overrides.forSec ?? rule.defaults.forSec),
  };
}

/** Only the values that differ from the rule's defaults are stored. */
function ruleOverrides(rule: AlertRule, draft: RuleDraft): { enabled?: boolean; forSec?: number } {
  const out: { enabled?: boolean; forSec?: number } = {};
  const forSec = Number(draft.forSec);
  if (!Number.isFinite(forSec) || draft.forSec.trim() === "") throw new Error(`${rule.name}: the wait must be a number of seconds`);
  if (draft.enabled !== rule.defaults.enabled) out.enabled = draft.enabled;
  if (forSec !== rule.defaults.forSec) out.forSec = forSec;
  return out;
}

const severityText = (s: AlertSeverity) => (s === "critical" ? "Critical" : "Warning");

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
        /* the lists are a convenience; a config error (if any) is shown */
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

  // Keep "Firing now" and the recent list current while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(loadStatus, 10_000);
    return () => window.clearInterval(timer);
  }, [open, loadStatus]);

  // Capture phase, so the Settings dialog underneath does not close too.
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

  const setRule = (id: string, patch: Partial<RuleDraft>) => {
    setRules((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
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
      const r = await testAlertChannel(ch.id, { name: ch.name.trim() || "Test", type: ch.type, url: ch.url, enabled: true, minSeverity: ch.minSeverity });
      setTests((prev) => ({ ...prev, [index]: { pending: false, ok: r.ok, message: r.ok ? "Sent" : r.error || "Failed" } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [index]: { pending: false, ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      loadStatus();
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const ruleUpdate: Record<string, { enabled?: boolean; forSec?: number }> = {};
      for (const rule of config.rules) {
        const o = ruleOverrides(rule, rules[rule.id] ?? ruleDraft(rule));
        if (Object.keys(o).length) ruleUpdate[rule.id] = o;
      }
      const next = await updateAlertsConfig({
        repeatIntervalMin: repeat,
        rules: ruleUpdate,
        channels: channels.map(({ status: _status, hasUrl: _hasUrl, ...c }) => ({ ...c, name: c.name.trim(), url: c.url.trim() })),
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
      <div ref={trapRef} className="modal-sheet modal-sheet--wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id={titleId}>
            Alert notifications
          </h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body">
          {loading && <p className="bench-sheet__hint">Loading…</p>}

          {config && !loading && (
            <>
              <ToggleRow
                title="Send notifications"
                help="The server watches the Health findings and the Overview exceptions and notifies the channels below when one holds for its wait, and again when it clears. Off by default: while off nothing is evaluated or sent. Saved immediately."
                checked={enabled}
                disabled={toggling}
                onChange={() => void toggleEnabled()}
              />

              {enabled && active.length > 0 && (
                <section className="alerts-section" aria-label="Firing now">
                  <h3 className="alerts-section__title">Firing now · {active.length}</h3>
                  <ul className="alerts-list">
                    {active.map((a) => (
                      <li key={a.key} className={a.severity === "critical" ? "is-critical" : "is-warning"}>
                        <b>{a.unitName}</b> {a.label} · {formatSince(a.startsAt, now) ?? "now"}
                        <small>{a.summary}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {!enabled && <p className="modal-sheet__lead alerts-off-note">Turn notifications on to change what notifies and where.</p>}

              <fieldset className="alerts-fieldset" disabled={!enabled}>
                {SOURCES.map((source) => (
                  <section key={source.id} className="alerts-section" aria-label={source.title}>
                    <h3 className="alerts-section__title">{source.title}</h3>
                    <p className="alerts-section__help">{source.help}</p>
                    {config.rules
                      .filter((r) => r.source === source.id)
                      .map((rule) => {
                        const draft = rules[rule.id] ?? ruleDraft(rule);
                        return (
                          <div key={rule.id} data-rule={rule.id}>
                            <ToggleRow
                              title={rule.name}
                              help={rule.description}
                              label={`${rule.name} notifications`}
                              checked={draft.enabled}
                              onChange={(v) => setRule(rule.id, { enabled: v })}
                            >
                              <label className="alerts-wait">
                                <span>after</span>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  aria-label={`${rule.name} wait (seconds)`}
                                  value={draft.forSec}
                                  onChange={(e) => setRule(rule.id, { forSec: e.target.value })}
                                  className="field-input"
                                />
                                <span>s</span>
                              </label>
                            </ToggleRow>
                          </div>
                        );
                      })}
                  </section>
                ))}

                <section className="alerts-section" aria-label="Channels">
                  <div className="alerts-section__head">
                    <h3 className="alerts-section__title">Channels</h3>
                    <button type="button" className="btn btn--sm" onClick={addChannel}>
                      <PlusIcon className="h-3.5 w-3.5" />
                      Add channel
                    </button>
                  </div>
                  <p className="alerts-section__help">
                    URLs are stored encrypted with the unit passwords and shown masked. They may point at the LAN (a self-hosted ntfy) or the internet, under the same rules as unit and LLM addresses; redirects are not followed.
                  </p>
                  {channels.length === 0 && <p className="alerts-section__help">No channels yet: alerts still show on the Overview strip.</p>}
                  {channels.map((ch, i) => {
                    const meta = CHANNEL_TYPES.find((t) => t.value === ch.type) ?? CHANNEL_TYPES[0];
                    const test = tests[i];
                    return (
                      <div key={ch.id ?? `new-${i}`} className="alerts-channel" data-channel={i}>
                        <div className="alerts-channel__row">
                          <input
                            type="text"
                            aria-label="Channel name"
                            placeholder="Name"
                            value={ch.name}
                            maxLength={60}
                            onChange={(e) => setChannel(i, { name: e.target.value })}
                            className="field-input alerts-channel__name"
                          />
                          <select aria-label="Channel type" value={ch.type} onChange={(e) => setChannel(i, { type: e.target.value as AlertChannelType })}>
                            {CHANNEL_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <select aria-label="Minimum severity" value={ch.minSeverity} onChange={(e) => setChannel(i, { minSeverity: e.target.value as AlertSeverity })}>
                            <option value="warning">Warning and up</option>
                            <option value="critical">Critical only</option>
                          </select>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={ch.enabled}
                            aria-label={`Channel ${ch.name || i + 1} enabled`}
                            onClick={() => setChannel(i, { enabled: !ch.enabled })}
                            className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors${ch.enabled ? " is-on" : ""}`}
                          >
                            <span className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${ch.enabled ? "translate-x-4" : "translate-x-0"}`} />
                          </button>
                        </div>
                        <input
                          type="text"
                          aria-label="Channel URL"
                          placeholder={meta.placeholder}
                          value={ch.url}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => setChannel(i, { url: e.target.value })}
                          className="field-input field-input--mono"
                        />
                        {ch.id && ch.url.includes("…") && <p className="field-hint">Stored URL is hidden. Leave it to keep it, or paste a new one.</p>}
                        {ch.id && !ch.url && ch.hasUrl === false && <p className="field-hint is-warn">No URL is stored for this channel. Enter it again.</p>}
                        <div className="alerts-channel__actions">
                          <button type="button" className="btn btn--sm" onClick={() => void sendTest(i)} disabled={!ch.url.trim() || test?.pending}>
                            {test?.pending ? "Sending…" : "Send test"}
                          </button>
                          <button type="button" className="btn btn--sm btn--ghost" onClick={() => removeChannel(i)}>
                            Remove
                          </button>
                          {test && !test.pending && test.message && (
                            <span role="status" className={`field-hint ${test.ok ? "is-ok" : "is-warn"}`}>
                              {test.message}
                            </span>
                          )}
                          {!test?.message && ch.status?.lastError && (
                            <span className="field-hint is-warn" title={ch.status.lastErrorAt ? new Date(ch.status.lastErrorAt).toLocaleString() : undefined}>
                              Last send failed: {ch.status.lastError}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </section>

                <SettingRow title="Remind while still firing" help="Repeat the notification for an alert that has not cleared." htmlFor="alerts-repeat">
                  <select
                    id="alerts-repeat"
                    value={repeat}
                    onChange={(e) => {
                      setRepeat(Number(e.target.value));
                      touch();
                    }}
                  >
                    {(REPEAT_OPTIONS.some((o) => o.value === repeat) ? REPEAT_OPTIONS : [...REPEAT_OPTIONS, { value: repeat, label: `Every ${repeat} min` }]).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </fieldset>

              <section className="alerts-section" aria-label="Recent">
                <h3 className="alerts-section__title">Recent</h3>
                <p className="alerts-section__help">Fired and cleared since the server started. Every notification sent or failed is also on the Activity page.</p>
                {recent.length === 0 ? (
                  <p className="alerts-section__help">Nothing has fired yet.</p>
                ) : (
                  <ul className="alerts-list">
                    {recent.slice(0, 50).map((e) => (
                      <li key={e.id} className={e.status === "resolved" ? "is-ok" : e.severity === "critical" ? "is-critical" : "is-warning"}>
                        {e.status === "resolved" ? "Resolved" : severityText(e.severity)} · <b>{e.unitName}</b> {e.label} · {formatSince(e.at, now) ?? "—"} ago
                        <small>{e.summary}</small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        {error && (
          <div className="modal-sheet__error alerts-error" role="alert">
            {error}
          </div>
        )}

        <div className="modal-sheet__footer">
          <span className="field-hint" role="status">
            {savedNote ? "Saved" : dirty ? "Unsaved changes" : ""}
          </span>
          <div className="modal-sheet__footer-actions">
            <button type="button" onClick={onClose} className="btn btn--ghost">
              Close
            </button>
            <button type="button" onClick={() => void save()} disabled={!config || !enabled || saving || !dirty} className="btn btn--primary">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
