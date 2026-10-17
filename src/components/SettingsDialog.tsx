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
import { LanguageSelector } from "./LanguageSelector";
import "../styles/dialogs.css";

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

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const { t } = useTranslation("settings");
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
    setSaving(true);
    setError(null);
    setInvalidTimeZone(null);
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
                title={t("toggles.vulnHunter.title")}
                help={t("toggles.vulnHunter.help")}
                checked={Boolean(settings.vulnhuntEnabled)}
                onChange={(v) => update({ vulnhuntEnabled: v })}
              />
              <ToggleRow
                title={t("toggles.rea.title")}
                help={t("toggles.rea.help")}
                checked={Boolean(settings.reaEnabled)}
                onChange={(v) => update({ reaEnabled: v })}
              />
              <ToggleRow
                title={t("toggles.metricsHistory.title")}
                help={t("toggles.metricsHistory.help")}
                checked={Boolean(settings.metricsHistory)}
                onChange={(v) => update({ metricsHistory: v })}
              />
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
            <span>{t("about.version", { version: packageJson.version })}</span>
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
              disabled={saving || !settings || !dirty}
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
