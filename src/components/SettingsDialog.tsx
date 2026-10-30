import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isValidTimeZone, listTimeZones } from "../shared/timeZone";
import { fetchSettings, updateSettings } from "../api/client";
import { clearToken, getToken, onTokenChange, requestTokenPrompt } from "../api/authToken";
import type { Settings } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import packageJson from "../../package.json";
import { XIcon } from "./ui/icons";
import { SettingRow, ToggleRow } from "./SettingRows";
import { AlertsDialog } from "./AlertsDialog";
import { BrowserAlertsSettings } from "./BrowserAlertsSettings";
import { FleetGpuClock, type FleetGpuClockApi } from "./FleetGpuClock";
import { LanguageSelector } from "./LanguageSelector";
import "../styles/dialogs.css";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
  onOpenHarness?: () => void;
  /** Version reported by the running server; absent when health could not be read. */
  serverVersion?: string | null;
}

/** Whether a broker URL carries a user name or password before the host (mqtt://user:pass@host). */
function mqttUrlHasCredentials(value: string): boolean {
  const v = value.trim();
  try {
    const url = new URL(v);
    return Boolean(url.username || url.password);
  } catch {
    return /^[a-z]+:\/\/[^/]*@/i.test(v);
  }
}

const HEALTH_TEMP_MIN_C = 40;
const HEALTH_TEMP_MAX_C = 110;

/** NaN stands for an empty field while typing; Save refuses it. */
function parseHealthTemp(raw: string): number {
  return raw.trim() === "" ? NaN : Number(raw);
}

function healthTempValue(value: number | undefined): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

/** The message for unusable thermal thresholds, or null when they can be saved. */
function healthTempsError(
  warn: number | undefined,
  critical: number | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string
): string | null {
  // A server that predates these settings does not send them; leave it alone.
  if (warn === undefined && critical === undefined) return null;
  const ok = (v: number | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= HEALTH_TEMP_MIN_C && v <= HEALTH_TEMP_MAX_C;
  if (!ok(warn) || !ok(critical)) return t("errors.healthTempsRange", { min: HEALTH_TEMP_MIN_C, max: HEALTH_TEMP_MAX_C });
  if (warn >= critical) return t("errors.healthTempsOrder");
  return null;
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

type ThemeId = "white" | "light" | "dark" | "oled";

const THEME_STORAGE_KEY = "sparkdash-theme";

/** Real swatches: background, text and accent mirror each theme's tokens. */
const THEME_CHOICES: Array<{ id: ThemeId; bg: string; fg: string; accent: string }> = [
  { id: "white", bg: "#ffffff", fg: "#14181e", accent: "#e8a21c" },
  { id: "light", bg: "#eaedf1", fg: "#12161c", accent: "#e8a21c" },
  { id: "dark", bg: "#12151a", fg: "#e9ecf0", accent: "#f0b03a" },
  { id: "oled", bg: "#000000", fg: "#e9ecf0", accent: "#f0b03a" },
];

function readTheme(): ThemeId {
  try {
    const attr = document.documentElement.getAttribute("data-theme");
    const stored = attr || localStorage.getItem(THEME_STORAGE_KEY);
    if (THEME_CHOICES.some((t) => t.id === stored)) return stored as ThemeId;
  } catch {
    /* storage can throw in private windows */
  }
  return "dark";
}

/** Apply a theme the same way ThemeSwitch does, then tell it to resync. */
function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("sparkdash:set-theme", { detail: theme }));
}

const POLL_PRESETS = [
  { value: 1000 },
  { value: 2000 },
  { value: 5000 },
  { value: 10000 },
];

const AGE_PRESETS = [
  { unit: "hours", count: 1, value: 60 * 60 * 1000 },
  { unit: "hours", count: 6, value: 6 * 60 * 60 * 1000 },
  { unit: "hours", count: 12, value: 12 * 60 * 60 * 1000 },
  { unit: "hours", count: 24, value: 24 * 60 * 60 * 1000 },
  { unit: "days", count: 3, value: 3 * 24 * 60 * 60 * 1000 },
  { unit: "days", count: 7, value: 7 * 24 * 60 * 60 * 1000 },
  { unit: "days", count: 14, value: 14 * 24 * 60 * 60 * 1000 },
];

export function SettingsDialog({ open, onClose, onSaved, onOpenHarness, serverVersion }: SettingsDialogProps) {
  const { t } = useTranslation("settings");
  /** The server's own version wins: a stale dist must not report its build as the server's. */
  const displayVersion = serverVersion || packageJson.version;
  const themeLabel = (themeId: ThemeId) => {
    switch (themeId) {
      case "white": return t("appearance.white");
      case "light": return t("appearance.light");
      case "dark": return t("appearance.dark");
      case "oled": return t("appearance.oled");
    }
  };
  const pollLabel = (value: number) => {
    switch (value) {
      case 1000: return t("refresh.oneSecond");
      case 2000: return t("refresh.twoSeconds");
      case 5000: return t("refresh.fiveSeconds");
      case 10000: return t("refresh.tenSeconds");
      default: return "";
    }
  };
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidTimeZone, setInvalidTimeZone] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // The GPU clock row applies through Save, so a pick there is unsaved work too.
  const fleetClock = useRef<FleetGpuClockApi | null>(null);
  const [fleetClockPending, setFleetClockPending] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readTheme);
  const [tokenSet, setTokenSet] = useState(() => getToken() !== "");
  const [showAlerts, setShowAlerts] = useState(false);

  // While the Alerts dialog is open on top, Escape belongs to it alone.
  const closeOnEscape = useCallback(() => {
    if (!showAlerts) onClose();
  }, [showAlerts, onClose]);
  useEscape(closeOnEscape);

  useEffect(() => onTokenChange((token) => setTokenSet(token !== "")), []);

  useEffect(() => {
    if (!open) {
      setShowAlerts(false);
      setSettings(null);
      setError(null);
      setInvalidTimeZone(null);
      setDirty(false);
      return;
    }
    setTheme(readTheme());
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
  const overlayClose = useOverlayClose(onClose);

  const timeZones = useMemo(() => listTimeZones(), []);
  const [tzTouched, setTzTouched] = useState(false);
  const [tzFocused, setTzFocused] = useState(false);
  const tzInput = useRef<HTMLInputElement | null>(null);
  const browserTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  // Say a zone is unknown only once the field has been left (not while "Eur" is half typed).
  const tzInvalid = tzTouched && !tzFocused && Boolean(settings?.timeZone) && !isValidTimeZone(settings?.timeZone);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  // The Alerts dialog saves its switch itself; mirror it here without marking
  // Settings dirty, so a later Save does not undo it.
  const handleAlertsSettings = (saved: Settings) => {
    setSettings((prev) => (prev ? { ...prev, alertsEnabled: saved.alertsEnabled } : prev));
    onSaved(saved);
  };

  const handleSave = async () => {
    if (!settings) return;
    if (settings.timeZone && !isValidTimeZone(settings.timeZone)) {
      // The server would silently fall back to the browser's zone; say so instead.
      setError(null);
      setInvalidTimeZone(settings.timeZone);
      return;
    }
    if (settings.mqttUrl && !/^(mqtt|ws)s?:\/\//i.test(settings.mqttUrl.trim())) {
      // The server would silently clear it; say so instead.
      setError(`"${settings.mqttUrl}" is not a broker URL — use mqtt://host:1883 (or mqtts://, ws://, wss://), or clear the field.`);
      return;
    }
    if (settings.mqttUrl && mqttUrlHasCredentials(settings.mqttUrl)) {
      // settings.json is world-readable, so the server refuses (and clears) such a URL.
      setError("Remove the user name and password from the broker URL: put the user name in MQTT username and the password in the SPARKDASH_MQTT_PASSWORD environment variable.");
      return;
    }
    const tempsError = healthTempsError(settings.healthTempWarnC, settings.healthTempCriticalC, t);
    if (tempsError) {
      setInvalidTimeZone(null);
      setError(tempsError);
      return;
    }
    setSaving(true);
    setError(null);
    setInvalidTimeZone(null);
    try {
      // Hardware first: Save is the only thing that changes a clock, and a unit
      // that refuses it must not leave the settings half-saved behind.
      if (fleetClockPending && !(await fleetClock.current?.apply())) return;
      // The settings write remains unsaved work even when only the GPU changed.
      // Keep it retryable if it fails after the hardware choice has been cleared.
      setDirty(true);
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

  const pickTheme = (next: ThemeId) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div
      className={`settings-overlay${visible ? " is-open" : ""}`}
      {...overlayClose}
    >
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id="settings-title">
            {t("dialog.title")}
          </h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label={t("dialog.close")}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body">
          {loading && <p className="bench-sheet__hint">{t("dialog.loading")}</p>}

          <LanguageSelector />

          <SettingRow
            title={t("appearance.title")}
            help={t("appearance.help")}
          >
            <div className="swatches" role="radiogroup" aria-label={t("appearance.theme")}>
              {THEME_CHOICES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.id}
                  className={`sw sw--${t.id}${theme === t.id ? " is-on" : ""}`}
                  onClick={() => pickTheme(t.id)}
                >
                  <i className="sw__dot" aria-hidden />
                  {themeLabel(t.id)}
                </button>
              ))}
            </div>
          </SettingRow>

          {settings && !loading && (
            <>
              <SettingRow title={t("refresh.title")} help={t("refresh.help")}>
                <div className="seg" role="radiogroup" aria-label={t("refresh.interval")}>
                  {POLL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.pollIntervalMs === preset.value}
                      className={settings.pollIntervalMs === preset.value ? "is-on" : ""}
                      onClick={() => update({ pollIntervalMs: preset.value })}
                    >
                      {pollLabel(preset.value)}
                    </button>
                  ))}
                </div>
              </SettingRow>

              <SettingRow title={t("sessionAge.title")} help={t("sessionAge.help")} stack>
                <div className="seg" role="radiogroup" aria-label={t("sessionAge.title")}>
                  {AGE_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      role="radio"
                      aria-checked={(settings.occupancyMaxAgeMs ?? AGE_PRESETS[2].value) === preset.value}
                      className={(settings.occupancyMaxAgeMs ?? AGE_PRESETS[2].value) === preset.value ? "is-on" : ""}
                      onClick={() => update({ occupancyMaxAgeMs: preset.value })}
                    >
                      {preset.unit === "hours"
                        ? t("sessionAge.hours", { count: preset.count })
                        : t("sessionAge.days", { count: preset.count })}
                    </button>
                  ))}
                </div>
              </SettingRow>

              <SettingRow title={t("harnessSessions.title")} help={t("harnessSessions.help")}>
                <button type="button" className="btn btn--sm" onClick={() => onOpenHarness?.()}>
                  {t("harnessSessions.setup")}
                </button>
              </SettingRow>

              <SettingRow title={t("temperature.title")}>
                <div className="seg" role="radiogroup" aria-label={t("temperature.aria")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={settings.temperatureUnit === "celsius"}
                    className={settings.temperatureUnit === "celsius" ? "is-on" : ""}
                    onClick={() => update({ temperatureUnit: "celsius" })}
                  >
                    °C
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={settings.temperatureUnit === "fahrenheit"}
                    className={settings.temperatureUnit === "fahrenheit" ? "is-on" : ""}
                    onClick={() => update({ temperatureUnit: "fahrenheit" })}
                  >
                    °F
                  </button>
                </div>
              </SettingRow>

              <SettingRow
                title={t("healthTemps.title")}
                help={
                  <>
                    {t("healthTemps.help")}
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost set-row__action"
                      disabled={settings.healthTempWarnC === 85 && settings.healthTempCriticalC === 90}
                      onClick={() => update({ healthTempWarnC: 85, healthTempCriticalC: 90 })}
                    >
                      {t("healthTemps.reset")}
                    </button>
                  </>
                }
                htmlFor="settings-health-temp-warn"
              >
                <div className="set-price">
                  <input
                    id="settings-health-temp-warn"
                    type="number"
                    aria-label={t("healthTemps.warn")}
                    min={HEALTH_TEMP_MIN_C}
                    max={HEALTH_TEMP_MAX_C}
                    step="1"
                    inputMode="decimal"
                    placeholder="85"
                    value={healthTempValue(settings.healthTempWarnC)}
                    onChange={(e) => update({ healthTempWarnC: parseHealthTemp(e.target.value) })}
                    className="field-input field-input--price"
                  />
                  <input
                    id="settings-health-temp-critical"
                    type="number"
                    aria-label={t("healthTemps.critical")}
                    min={HEALTH_TEMP_MIN_C}
                    max={HEALTH_TEMP_MAX_C}
                    step="1"
                    inputMode="decimal"
                    placeholder="90"
                    value={healthTempValue(settings.healthTempCriticalC)}
                    onChange={(e) => update({ healthTempCriticalC: parseHealthTemp(e.target.value) })}
                    className="field-input field-input--price"
                  />
                </div>
              </SettingRow>

              <SettingRow
                title={t("timeZone.title")}
                help={t("timeZone.help", { timeZone: browserTimeZone })}
                htmlFor="settings-time-zone"
                stack
              >
                <div className="set-tz">
                  <input
                    id="settings-time-zone"
                    type="text"
                    list="settings-time-zones"
                    value={settings.timeZone ?? ""}
                    placeholder={t("timeZone.placeholder")}
                    title={t("timeZone.inputTitle", { timeZone: browserTimeZone })}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={tzInvalid}
                    aria-describedby="settings-time-zone-msg"
                    ref={tzInput}
                    onChange={(e) => update({ timeZone: e.target.value })}
                    onFocus={() => setTzFocused(true)}
                    onBlur={() => {
                      setTzFocused(false);
                      setTzTouched(true);
                    }}
                    className="field-input"
                  />
                  <datalist id="settings-time-zones">
                    {timeZones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={!settings.timeZone}
                    onClick={() => {
                      update({ timeZone: "" });
                      setTzTouched(false);
                      tzInput.current?.focus(); // the button disables itself: keep keyboard focus somewhere sensible
                    }}
                  >
                    {t("timeZone.useBrowser")}
                  </button>
                </div>
                {/* One reserved line: the message appears after the field is left, and never moves anything. */}
                <small id="settings-time-zone-msg" className="set-tz__msg" role="status" aria-live="polite">
                  {tzInvalid ? t("timeZone.unknown") : ""}
                </small>
              </SettingRow>

              <SettingRow
                title={t("defaultLlmPort.title")}
                help={t("defaultLlmPort.help")}
                htmlFor="settings-default-llm-port"
              >
                <input
                  id="settings-default-llm-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.defaultLlmPort}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) update({ defaultLlmPort: val });
                  }}
                  className="field-input field-input--port"
                />
              </SettingRow>

              <ToggleRow
                title={t("toggles.hideOffline.title")}
                help={t("toggles.hideOffline.help")}
                checked={settings.autoHideOffline}
                onChange={(v) => update({ autoHideOffline: v })}
              />
              <ToggleRow
                title={t("toggles.hideWorkers.title")}
                help={t("toggles.hideWorkers.help")}
                checked={Boolean(settings.hideWorkers)}
                onChange={(v) => update({ hideWorkers: v })}
              />
              <ToggleRow
                title={t("toggles.overviewSearch.title")}
                help={t("toggles.overviewSearch.help")}
                checked={Boolean(settings.showOverviewSearch)}
                onChange={(v) => update({ showOverviewSearch: v })}
              />
              <ToggleRow
                title={t("toggles.benchShareImage.title")}
                help={t("toggles.benchShareImage.help")}
                checked={Boolean(settings.benchShareImage)}
                onChange={(v) => update({ benchShareImage: v })}
              />
              <ToggleRow
                title={t("toggles.vramBreakdown.title")}
                help={t("toggles.vramBreakdown.help")}
                checked={settings.showVramBreakdown ?? true}
                onChange={(v) => update({ showVramBreakdown: v })}
              />
              <ToggleRow
                title={t("toggles.prometheus.title")}
                help={t("toggles.prometheus.help", { origin: window.location.origin })}
                checked={Boolean(settings.prometheusExport)}
                onChange={(v) => update({ prometheusExport: v })}
              />
              <ToggleRow
                title={t("toggles.intelVramSudo.title")}
                help={t("toggles.intelVramSudo.help")}
                checked={Boolean(settings.intelVramSudo)}
                onChange={(v) => update({ intelVramSudo: v })}
              />
              <ToggleRow
                title={t("toggles.metricsHistory.title")}
                help={t("toggles.metricsHistory.help")}
                checked={Boolean(settings.metricsHistory)}
                onChange={(v) => update({ metricsHistory: v })}
              />
              <ToggleRow
                title="MQTT publishing"
                help="Publishes the activity feed events and every unit's readings to your MQTT broker (Home Assistant, Node-RED, …) as they change. Off by default. The README's MQTT section lists the topics."
                checked={Boolean(settings.mqttEnabled)}
                onChange={(v) => update({ mqttEnabled: v })}
              />
              <SettingRow
                title="MQTT broker URL"
                help="mqtt://host:1883, mqtts:// for TLS, ws(s):// for a websocket broker. The password is read from the SPARKDASH_MQTT_PASSWORD environment variable, never stored in settings.json."
                htmlFor="settings-mqtt-url"
              >
                <input
                  id="settings-mqtt-url"
                  type="text"
                  value={settings.mqttUrl ?? ""}
                  placeholder="mqtt://homeassistant.local:1883"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update({ mqttUrl: e.target.value })}
                  className="field-input"
                />
              </SettingRow>
              <SettingRow
                title="MQTT username"
                help="Leave empty for a broker that allows anonymous publish."
                htmlFor="settings-mqtt-username"
              >
                <input
                  id="settings-mqtt-username"
                  type="text"
                  value={settings.mqttUsername ?? ""}
                  placeholder="empty"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update({ mqttUsername: e.target.value })}
                  className="field-input"
                />
              </SettingRow>
              <SettingRow
                title="MQTT topic prefix"
                help="Topic root for everything published: PREFIX/events, PREFIX/status/… and PREFIX/metrics/…"
                htmlFor="settings-mqtt-prefix"
              >
                <input
                  id="settings-mqtt-prefix"
                  type="text"
                  value={settings.mqttTopicPrefix ?? ""}
                  placeholder="sparkdash"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => update({ mqttTopicPrefix: e.target.value })}
                  className="field-input"
                />
              </SettingRow>
              <ToggleRow
                title={t("toggles.fleetEnergy.title")}
                help={t("toggles.fleetEnergy.help")}
                checked={Boolean(settings.showFleetEnergy)}
                onChange={(v) => update({ showFleetEnergy: v })}
              />
              <SettingRow
                title={t("electricityPrice.title")}
                help={t("electricityPrice.help")}
                htmlFor="settings-energy-price"
              >
                <div className="set-price">
                  <input
                    id="settings-energy-currency"
                    type="text"
                    aria-label={t("electricityPrice.currency")}
                    maxLength={4}
                    value={settings.energyCurrency ?? "$"}
                    onChange={(e) => update({ energyCurrency: e.target.value })}
                    className="field-input field-input--currency"
                  />
                  <input
                    id="settings-energy-price"
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.15"
                    value={settings.energyPricePerKwh ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") return update({ energyPricePerKwh: null });
                      const val = parseFloat(raw);
                      if (!isNaN(val)) update({ energyPricePerKwh: val });
                    }}
                    className="field-input field-input--price"
                  />
                </div>
              </SettingRow>
              <ToggleRow
                title={t("toggles.llmTokenTotals.title")}
                help={t("toggles.llmTokenTotals.help")}
                checked={Boolean(settings.showLlmTokenTotals)}
                onChange={(v) => update({ showLlmTokenTotals: v })}
              />
              <ToggleRow
                title={t("toggles.recentActivity.title")}
                help={t("toggles.recentActivity.help")}
                checked={settings.showActivityFeed ?? true}
                onChange={(v) => update({ showActivityFeed: v })}
              />
              <ToggleRow
                title={t("toggles.fleetDecode.title")}
                help={t("toggles.fleetDecode.help")}
                checked={settings.showKpiDecode ?? true}
                onChange={(v) => update({ showKpiDecode: v })}
              />
              <ToggleRow
                title={t("toggles.fleetPower.title")}
                help={t("toggles.fleetPower.help")}
                checked={settings.showKpiPower ?? true}
                onChange={(v) => update({ showKpiPower: v })}
              />
              <ToggleRow
                title={t("toggles.memoryInUse.title")}
                help={t("toggles.memoryInUse.help")}
                checked={settings.showKpiMemory ?? true}
                onChange={(v) => update({ showKpiMemory: v })}
              />
              <ToggleRow
                title={t("toggles.tokens24Hours.title")}
                help={t("toggles.tokens24Hours.help")}
                checked={settings.showKpiTokens ?? true}
                onChange={(v) => update({ showKpiTokens: v })}
              />
              <ToggleRow
                title={t("toggles.fleetExceptions.title")}
                help={t("toggles.fleetExceptions.help")}
                checked={Boolean(settings.showFleetExceptions)}
                onChange={(v) => update({ showFleetExceptions: v })}
              />
              <SettingRow
                title={t("alertNotifications.title")}
                help={t("alertNotifications.help")}
              >
                <div className="set-token">
                  <span className={`set-token__state${settings.alertsEnabled ? " is-set" : ""}`} data-testid="alerts-state">
                    <i aria-hidden />
                    {settings.alertsEnabled ? t("alertNotifications.on") : t("alertNotifications.off")}
                  </span>
                  <button type="button" className="btn btn--sm" onClick={() => setShowAlerts(true)}>
                    {t("alertNotifications.configure")}
                  </button>
                </div>
              </SettingRow>
              <BrowserAlertsSettings />
              <ToggleRow
                title={t("toggles.benchDebugTraces.title")}
                help={t("toggles.benchDebugTraces.help")}
                checked={Boolean(settings.benchDebugTraces)}
                onChange={(v) => update({ benchDebugTraces: v })}
              />
            </>
          )}

          {/* Outside the settings block: a fleet GPU action needs no saved settings. */}
          <SettingRow
            title="GPU clock cap"
            help="Caps the GPU graphics clock on every Spark at once (nvidia-smi -lgc): pick the state they should be in — Full capacity or 1800–2400 MHz — and Save applies it. Offline or GPU-less units are skipped and reported."
            stack
          >
            <FleetGpuClock apiRef={fleetClock} onPendingChange={setFleetClockPending} />
          </SettingRow>

          {/* Outside the settings block: a rejected token is exactly when settings fail to load. */}
          <SettingRow
            title={t("accessToken.title")}
            help={t("accessToken.help")}
          >
            <div className="set-token">
              <span className={`set-token__state${tokenSet ? " is-set" : ""}`} data-testid="access-token-state">
                <i aria-hidden />
                {tokenSet ? t("accessToken.set") : t("accessToken.notSet")}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => requestTokenPrompt()}>
                {tokenSet ? t("accessToken.change") : t("accessToken.add")}
              </button>
              {tokenSet ? (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => clearToken()}>
                  {t("accessToken.clear")}
                </button>
              ) : null}
            </div>
          </SettingRow>

          <div className="settings-links">
            <span>{t("about.version", { version: displayVersion })}</span>
            <span aria-hidden>·</span>
            <a href="https://mia-ai.net/" target="_blank" rel="noopener noreferrer">
              mia-ai.net
            </a>
            <span aria-hidden>·</span>
            <a href="https://x.com/MiaAI_lab" target="_blank" rel="noopener noreferrer">
              𝕏 @MiaAI_lab
            </a>
            <span aria-hidden>·</span>
            <a href="https://github.com/MiaAI-Lab" target="_blank" rel="noopener noreferrer">
              {t("about.github")}
            </a>
          </div>
        </div>

        {(invalidTimeZone || error) && <div className="modal-sheet__error">{invalidTimeZone ? t("errors.invalidTimeZone", { timeZone: invalidTimeZone }) : error}</div>}

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" onClick={onClose} className="btn btn--ghost">
              {t("dialog.cancel")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !settings || !(dirty || fleetClockPending)}
              className="btn btn--primary"
            >
              {saving ? t("dialog.saving") : t("dialog.save")}
            </button>
          </div>
        </div>
      </div>
      <AlertsDialog open={showAlerts} onClose={() => setShowAlerts(false)} onSettingsSaved={handleAlertsSettings} />
    </div>
  );
}
