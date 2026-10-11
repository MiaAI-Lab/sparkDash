import { useEffect, useMemo, useRef, useState } from "react";
import { isValidTimeZone, listTimeZones } from "../shared/timeZone";
import { useTranslation } from "react-i18next";
import { activeLocale, setLocale, type Locale } from "../i18n";
import { fetchSettings, updateSettings } from "../api/client";
import { clearToken, getToken, onTokenChange, requestTokenPrompt } from "../api/authToken";
import type { Settings } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import packageJson from "../../package.json";
import { XIcon } from "./ui/icons";
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
const THEME_CHOICES: Array<{ id: ThemeId; label: string; bg: string; fg: string; accent: string }> = [
  { id: "white", label: "White", bg: "#ffffff", fg: "#14181e", accent: "#e8a21c" },
  { id: "light", label: "Light", bg: "#eaedf1", fg: "#12161c", accent: "#e8a21c" },
  { id: "dark", label: "Dark", bg: "#12151a", fg: "#e9ecf0", accent: "#f0b03a" },
  { id: "oled", label: "OLED", bg: "#000000", fg: "#e9ecf0", accent: "#f0b03a" },
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
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readTheme);
  const [tokenSet, setTokenSet] = useState(() => getToken() !== "");

  const themeLabels: Record<ThemeId, string> = {
    white: t("common.settings.theme.white", "White"),
    light: t("common.settings.theme.light", "Light"),
    dark: t("common.settings.theme.dark", "Dark"),
    oled: t("common.settings.theme.oled", "OLED"),
  };

  useEscape(onClose);

  useEffect(() => onTokenChange((token) => setTokenSet(token !== "")), []);

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setError(null);
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

  const handleSave = async () => {
    if (!settings) return;
    if (settings.timeZone && !isValidTimeZone(settings.timeZone)) {
      // The server would silently fall back to the browser's zone; say so instead.
      setError(`"${settings.timeZone}" is not a known time zone (for example Europe/Paris), or clear the field to follow the browser.`);
      return;
    }
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

  const pickTheme = (next: ThemeId) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div
      className={`settings-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id="settings-title">
            {t("common.settings.title", "Settings")}
          </h2>
          <button
            type="button"
            className="modal-sheet__close"
            onClick={onClose}
            aria-label={t("common.action.close", "Close")}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body">
          {loading && <p className="bench-sheet__hint">{t("common.settings.loading", "Loading…")}</p>}

          <SettingRow
            title={t("common.settings.appearance.title", "Appearance")}
            help={t("common.settings.appearance.help", "Applies instantly on this device. Saved in this browser.")}
          >
            <div
              className="swatches"
              role="radiogroup"
              aria-label={t("common.settings.appearance.themeAria", "Theme")}
            >
              {THEME_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === choice.id}
                  className={`sw sw--${choice.id}${theme === choice.id ? " is-on" : ""}`}
                  onClick={() => pickTheme(choice.id)}
                >
                  <i className="sw__dot" aria-hidden />
                  {themeLabels[choice.id]}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            title={t("common.settings.language.title", "Language")}
            help={t("common.settings.language.help", "Interface language. Saved in this browser.")}
          >
            <div
              className="seg"
              role="radiogroup"
              aria-label={t("common.settings.language.title", "Language")}
            >
              <button
                type="button"
                role="radio"
                aria-checked={activeLocale() === "zh-Hans"}
                className={activeLocale() === "zh-Hans" ? "is-on" : ""}
                onClick={() => void setLocale("zh-Hans")}
              >
                简体中文
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={activeLocale() === "en"}
                className={activeLocale() === "en" ? "is-on" : ""}
                onClick={() => void setLocale("en")}
              >
                English
              </button>
            </div>
          </SettingRow>

          {settings && !loading && (
            <>
              <SettingRow
                title={t("common.settings.refreshRate.title", "Refresh rate")}
                help={t(
                  "common.settings.refreshRate.help",
                  "How often every unit is polled for GPU, CPU, memory, network and LLM metrics, and how often the dashboard updates. Remote units are polled over SSH, so 1s costs the most; storage and liveness keep their own slower checks."
                )}
              >
                <div
                  className="seg"
                  role="radiogroup"
                  aria-label={t("common.settings.refreshRate.pollAria", "Poll interval")}
                >
                  {POLL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.pollIntervalMs === preset.value}
                      className={settings.pollIntervalMs === preset.value ? "is-on" : ""}
                      onClick={() => update({ pollIntervalMs: preset.value })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </SettingRow>

              <SettingRow title={t("common.settings.temperature.title", "Temperature unit")}>
                <div
                  className="seg"
                  role="radiogroup"
                  aria-label={t("common.settings.temperature.title", "Temperature unit")}
                >
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
                title={t("common.settings.timeZone.title", "Time zone")}
                help={t(
                  "common.settings.timeZone.help",
                  "Hour and day boundaries and labels on the Tokens, Energy and Activity charts. Empty follows this browser ({browserTimeZone}). Daily token buckets and monthly energy totals stay UTC.",
                  { browserTimeZone }
                )}
                htmlFor="settings-time-zone"
                stack
              >
                <div className="set-tz">
                  <input
                    id="settings-time-zone"
                    type="text"
                    list="settings-time-zones"
                    value={settings.timeZone ?? ""}
                    placeholder={t("common.settings.timeZone.browserDefault", "Browser default")}
                    title={t(
                      "common.settings.timeZone.emptyFollows",
                      "Empty follows this browser ({browserTimeZone})",
                      { browserTimeZone }
                    )}
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
                    {t("common.settings.timeZone.useBrowser", "Use browser")}
                  </button>
                </div>
                {/* One reserved line: the message appears after the field is left, and never moves anything. */}
                <small id="settings-time-zone-msg" className="set-tz__msg" role="status" aria-live="polite">
                  {tzInvalid ? t("common.settings.timeZone.unknown", "Unknown time zone. Try Europe/Paris.") : ""}
                </small>
              </SettingRow>

              <SettingRow
                title={t("common.settings.defaultLlmPort.title", "Default LLM port")}
                help={t("common.settings.defaultLlmPort.help", "Pre-filled when adding a new Spark (1–65535).")}
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
                title={t("common.settings.hideOffline.title", "Hide offline Sparks")}
                help={t("common.settings.hideOffline.help", "Auto-hide offline Sparks on Overview.")}
                checked={settings.autoHideOffline}
                onChange={(v) => update({ autoHideOffline: v })}
              />
              <ToggleRow
                title={t("common.settings.hideWorkers.title", "Hide worker nodes")}
                help={t(
                  "common.settings.hideWorkers.help",
                  "Removes Worker-role Sparks from Overview and the sidebar. Direct URLs and batch power / Hermes actions still include them."
                )}
                checked={Boolean(settings.hideWorkers)}
                onChange={(v) => update({ hideWorkers: v })}
              />
              <ToggleRow
                title={t("common.settings.overviewSearch.title", "Show search and status filters")}
                help={t(
                  "common.settings.overviewSearch.help",
                  "Overview search field and status dropdown (All / Online / Offline / Issues). Off by default."
                )}
                checked={Boolean(settings.showOverviewSearch)}
                onChange={(v) => update({ showOverviewSearch: v })}
              />
              <ToggleRow
                title={t("common.settings.benchShareImage.title", "Benchmark share image")}
                help={t(
                  "common.settings.benchShareImage.help",
                  "The decode/prefill Copy results button gains a caret with Copy as text / Copy as image (a share card). Turn it off to keep the plain text button."
                )}
                checked={Boolean(settings.benchShareImage)}
                onChange={(v) => update({ benchShareImage: v })}
              />
              <ToggleRow
                title={t("common.settings.vramBreakdown.title", "Detailed VRAM breakdown")}
                help={t(
                  "common.settings.vramBreakdown.help",
                  "VRAM bars split memory into LLM engine, system and free, and turn amber or red on low free memory rather than on a high percentage. Turn it off for the single percentage bar."
                )}
                checked={settings.showVramBreakdown ?? true}
                onChange={(v) => update({ showVramBreakdown: v })}
              />
              <ToggleRow
                title={t("common.settings.prometheus.title", "Prometheus metrics")}
                help={t(
                  "common.settings.prometheus.help",
                  "Serves every unit's metrics for Prometheus / Grafana to scrape at {origin}/metrics. Off by default.",
                  { origin: window.location.origin }
                )}
                checked={Boolean(settings.prometheusExport)}
                onChange={(v) => update({ prometheusExport: v })}
              />
              <ToggleRow
                title={t("common.settings.fleetEnergy.title", "Show Fleet Energy")}
                help={t(
                  "common.settings.fleetEnergy.help",
                  "Overview card with rolling fleet power estimates. The full Fleet energy page is always available from the sidebar."
                )}
                checked={Boolean(settings.showFleetEnergy)}
                onChange={(v) => update({ showFleetEnergy: v })}
              />
              <SettingRow
                title={t("common.settings.energyPrice.title", "Electricity price")}
                help={t(
                  "common.settings.energyPrice.help",
                  "Per kWh, used for the estimated cost on the Fleet energy page. Leave empty to hide cost."
                )}
                htmlFor="settings-energy-price"
              >
                <div className="set-price">
                  <input
                    id="settings-energy-currency"
                    type="text"
                    aria-label={t("common.settings.energyPrice.currencyAria", "Currency symbol")}
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
                title={t("common.settings.tokenTotals.title", "Show LLM Token Totals")}
                help={t(
                  "common.settings.tokenTotals.help",
                  "Overview card with cumulative prompt/generated tokens per model. The full Token totals page is always available from the sidebar."
                )}
                checked={Boolean(settings.showLlmTokenTotals)}
                onChange={(v) => update({ showLlmTokenTotals: v })}
              />
              <ToggleRow
                title={t("common.settings.fleetExceptions.title", "Show active fleet exceptions")}
                help={t(
                  "common.settings.fleetExceptions.help",
                  "Overview strip for offline hosts, GPU throttle, disk, LLM, and Tailnet alerts. Off by default."
                )}
                checked={Boolean(settings.showFleetExceptions)}
                onChange={(v) => update({ showFleetExceptions: v })}
              />
              <ToggleRow
                title={t("common.settings.benchDebugTraces.title", "Save benchmark debug traces")}
                help={t(
                  "common.settings.benchDebugTraces.help",
                  "Stores prompts, HTTP/completion IDs, content previews, and GPU samples in bench history. Off by default; larger history files."
                )}
                checked={Boolean(settings.benchDebugTraces)}
                onChange={(v) => update({ benchDebugTraces: v })}
              />
            </>
          )}

          {/* Outside the settings block: a rejected token is exactly when settings fail to load. */}
          <SettingRow
            title={t("common.settings.accessToken.title", "Access token")}
            help={t(
              "common.settings.accessToken.help",
              "Sent to servers that set SPARKDASH_TOKEN. Stored in this browser only."
            )}
          >
            <div className="set-token">
              <span className={`set-token__state${tokenSet ? " is-set" : ""}`} data-testid="access-token-state">
                <i aria-hidden />
                {tokenSet
                  ? t("common.settings.accessToken.set", "Set")
                  : t("common.settings.accessToken.notSet", "Not set")}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => requestTokenPrompt()}>
                {tokenSet
                  ? t("common.settings.accessToken.change", "Change")
                  : t("common.settings.accessToken.add", "Add token")}
              </button>
              {tokenSet ? (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => clearToken()}>
                  {t("common.settings.accessToken.clear", "Clear")}
                </button>
              ) : null}
            </div>
          </SettingRow>

          <div className="settings-links">
            <span>sparkDash v{packageJson.version}</span>
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
              GitHub MiaAI-Lab
            </a>
          </div>
        </div>

        {error && <div className="modal-sheet__error">{error}</div>}

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" onClick={onClose} className="btn btn--ghost">
              {t("common.action.cancel", "Cancel")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !settings || !dirty}
              className="btn btn--primary"
            >
              {saving ? t("common.action.saving", "Saving...") : t("common.action.save", "Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  help,
  htmlFor,
  stack = false,
  children,
}: {
  title: string;
  help?: string;
  htmlFor?: string;
  /** Text above, control below (for controls that need room or show messages). */
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`set-row${stack ? " set-row--stack" : ""}`}>
      <div className="set-row__text">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span className="set-row__title">{title}</span>}
        {help && <small>{help}</small>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

function ToggleRow({
  title,
  help,
  checked,
  onChange,
}: {
  title: string;
  help?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingRow title={title} help={help}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors${
          checked ? " is-on" : ""
        }`}
      >
        <span
          className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </SettingRow>
  );
}
