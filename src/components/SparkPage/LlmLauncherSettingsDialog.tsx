import { useTranslation } from "react-i18next";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { fetchLauncherSettings, saveLauncherSettings } from "../../api/client";
import type {
  LauncherManifest,
  LauncherSetting,
  LauncherSettingValue,
  LauncherSettingsResponse,
  LauncherRunState,
  LlmLauncher,
} from "../../api/types";
import "../../styles/dialogs.css";

/** Form state: numbers stay strings so a half-typed value is not rewritten under the cursor. */
export type SettingsForm = Record<string, string | boolean>;

export type SettingProblem = "number" | "integer" | "min" | "max" | "option" | "chars";

/** The manifest's values as form state. */
export function toFormValues(manifest: LauncherManifest, values: Record<string, LauncherSettingValue>): SettingsForm {
  const form: SettingsForm = {};
  for (const setting of manifest.settings) {
    const value = values[setting.key] ?? setting.default;
    form[setting.key] = setting.type === "boolean" ? Boolean(value) : String(value);
  }
  return form;
}

/** Form state back to typed values. Numbers are parsed; the server checks the bounds again. */
export function fromFormValues(manifest: LauncherManifest, form: SettingsForm): Record<string, LauncherSettingValue> {
  const values: Record<string, LauncherSettingValue> = {};
  for (const setting of manifest.settings) {
    const raw = form[setting.key];
    if (setting.type === "boolean") values[setting.key] = Boolean(raw);
    else if (setting.type === "integer" || setting.type === "number") values[setting.key] = Number(raw);
    // Trimmed like the check in validateSettingsForm: what is checked is what is sent.
    else values[setting.key] = String(raw ?? "").trim();
  }
  return values;
}

/** Client-side check, so an obvious mistake reads before a round trip. The server is the authority. */
export function validateSettingsForm(manifest: LauncherManifest, form: SettingsForm): Record<string, SettingProblem> {
  const problems: Record<string, SettingProblem> = {};
  for (const setting of manifest.settings) {
    if (setting.type === "boolean") continue;
    const raw = String(form[setting.key] ?? "").trim();
    if (setting.type === "integer" || setting.type === "number") {
      if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
        problems[setting.key] = setting.type === "integer" ? "integer" : "number";
        continue;
      }
      const n = Number(raw);
      if (setting.type === "integer" && !Number.isInteger(n)) {
        problems[setting.key] = "integer";
        continue;
      }
      if (setting.min != null && n < setting.min) problems[setting.key] = "min";
      else if (setting.max != null && n > setting.max) problems[setting.key] = "max";
    } else if (setting.type === "enum") {
      if (!setting.options?.includes(raw)) problems[setting.key] = "option";
    } else if (!/^[A-Za-z0-9._:@%+=,/-]{0,128}$/.test(raw)) {
      problems[setting.key] = "chars";
    }
  }
  return problems;
}

export interface MemoryWarning {
  /** How much the value rises, in the setting's unit. */
  delta: number;
  /** MemAvailable on the unit now, in GiB. */
  availableGiB: number;
  /** Free memory kept back, in GiB. */
  marginGiB: number;
}

/**
 * A setting that declares `memory: "GiB"` reserves that much host memory. Raising it
 * past what the unit has free (less a safety margin) is worth saying before the model
 * is restarted into an out-of-memory failure. It never blocks the save.
 */
export function memoryWarning(
  setting: LauncherSetting,
  next: string | number,
  current: string | number,
  availableMb: number | null,
  marginGiB = 1
): MemoryWarning | null {
  if (setting.memory !== "GiB" || availableMb == null || !Number.isFinite(availableMb)) return null;
  const delta = Number(next) - Number(current);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  const availableGiB = availableMb / 1024;
  if (delta <= availableGiB - marginGiB) return null;
  return { delta, availableGiB, marginGiB };
}

interface LlmLauncherSettingsDialogProps {
  open: boolean;
  sparkId: string;
  sparkName: string;
  launcher: LlmLauncher | null;
  /**
   * Whether the model's script is running now. A restart is needed to apply a
   * change to a running model; "unknown" means the status check failed, so the
   * dialog cannot say the model is stopped.
   */
  runState: LauncherRunState;
  /** MemAvailable on the unit in MB, or null when unknown. */
  availableMemoryMb: number | null;
  onClose: () => void;
  /** Stop and start the model through the existing job machinery. */
  onRestart: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: LauncherSettingsResponse };

export function LlmLauncherSettingsDialog({
  open,
  sparkId,
  sparkName,
  launcher,
  runState,
  availableMemoryMb,
  onClose,
  onRestart,
}: LlmLauncherSettingsDialogProps) {
  const { t } = useTranslation("hardware");
  // A restart is offered unless the model is known to be stopped: when the status
  // check failed it may well be running on the old values.
  const mayBeRunning = runState !== "stopped";
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [form, setForm] = useState<SettingsForm>({});
  const [problems, setProblems] = useState<Record<string, SettingProblem>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ restartRequired: boolean } | null>(null);
  const overlayClose = useOverlayClose(onClose, !saving);
  const launcherId = launcher?.id ?? null;

  useEffect(() => {
    if (!open || !launcherId) return;
    let live = true;
    setLoad({ status: "loading" });
    setForm({});
    setProblems({});
    setError(null);
    setSaving(false);
    setSaved(null);
    fetchLauncherSettings(sparkId, launcherId)
      .then((data) => {
        if (!live) return;
        setLoad({ status: "ready", data });
        if (data.manifest) setForm(toFormValues(data.manifest, data.values));
      })
      .catch((e: unknown) => {
        if (live) setLoad({ status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [open, sparkId, launcherId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  const manifest = load.status === "ready" ? load.data.manifest : null;
  const invalid = load.status === "ready" ? load.data.invalid : [];
  const envFile = load.status === "ready" ? load.data.envFile : "launcher.env";
  const currentValues = useMemo(
    () => (manifest ? toFormValues(manifest, load.status === "ready" ? load.data.values : {}) : {}),
    [manifest, load]
  );

  if (!mounted || !launcher) return null;

  const set = (key: string, value: string | boolean) => {
    setForm((f) => ({ ...f, [key]: value }));
    setProblems((p) => {
      if (!(key in p)) return p;
      const next = { ...p };
      delete next[key];
      return next;
    });
    setSaved(null);
  };

  async function save() {
    if (!manifest || !launcherId) return;
    const found = validateSettingsForm(manifest, form);
    if (Object.keys(found).length > 0) {
      setProblems(found);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await saveLauncherSettings(sparkId, launcherId, fromFormValues(manifest, form));
      setSaved({ restartRequired: res.restartRequired });
      setForm(toFormValues(manifest, res.values));
      // The saved values are now what the env file holds, so the memory hint compares against them.
      setLoad({ status: "ready", data: { manifest, values: res.values, invalid: [], envFile } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function problemText(setting: LauncherSetting, problem: SettingProblem): string {
    const label = setting.label;
    switch (problem) {
      case "integer":
        return t("models.settingsInteger", { label });
      case "min":
        return t("models.settingsMin", { label, min: setting.min });
      case "max":
        return t("models.settingsMax", { label, max: setting.max });
      case "option":
        return t("models.settingsOption", { label, options: (setting.options ?? []).join(", ") });
      case "chars":
        return t("models.settingsChars", { label });
      default:
        return t("models.settingsNumber", { label });
    }
  }

  function field(setting: LauncherSetting) {
    const id = `${titleId}-${setting.key}`;
    const value = form[setting.key];
    const problem = problems[setting.key];
    const warning = memoryWarning(setting, String(value ?? ""), String(currentValues[setting.key] ?? ""), availableMemoryMb);
    const range =
      setting.min != null && setting.max != null
        ? t("models.settingsRange", { min: setting.min, max: setting.max })
        : setting.min != null
          ? t("models.settingsMinOnly", { min: setting.min })
          : setting.max != null
            ? t("models.settingsMaxOnly", { max: setting.max })
            : null;
    const hint = [range, t("models.settingsDefault", { value: String(setting.default) })].filter(Boolean).join(" · ");
    return (
      <div className="field launcher-settings__field" key={setting.key}>
        {setting.type === "boolean" ? (
          <label className="check-row" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => set(setting.key, e.target.checked)}
            />
            <span>{setting.label}</span>
          </label>
        ) : (
          <>
            <label htmlFor={id}>{setting.label}</label>
            {setting.type === "enum" ? (
              <select id={id} value={String(value ?? "")} onChange={(e) => set(setting.key, e.target.value)}>
                {(setting.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <div className="launcher-settings__input">
                <input
                  id={id}
                  type={setting.type === "integer" || setting.type === "number" ? "number" : "text"}
                  inputMode={setting.type === "integer" ? "numeric" : setting.type === "number" ? "decimal" : undefined}
                  min={setting.min ?? undefined}
                  max={setting.max ?? undefined}
                  step={setting.step ?? (setting.type === "integer" ? 1 : undefined)}
                  value={String(value ?? "")}
                  onChange={(e) => set(setting.key, e.target.value)}
                  spellCheck={setting.type === "string" ? false : undefined}
                  autoComplete="off"
                />
                {setting.unit ? <span className="launcher-settings__unit">{setting.unit}</span> : null}
              </div>
            )}
          </>
        )}
        {setting.help ? <p className="field-hint">{setting.help}</p> : null}
        {setting.type !== "boolean" ? <p className="field-hint">{hint}</p> : null}
        {problem ? (
          <p className="field-hint is-warn" role="alert">
            {problemText(setting, problem)}
          </p>
        ) : null}
        {warning ? (
          <p className="field-hint is-warn" role="alert">
            {t("models.settingsMemoryWarn", {
              label: setting.label,
              delta: warning.delta,
              unit: setting.memory,
              margin: warning.marginGiB,
              name: sparkName,
              available: Math.round(warning.availableGiB * 10) / 10,
            })}
          </p>
        ) : null}
      </div>
    );
  }

  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div ref={trapRef} className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id={titleId}>
            {t("models.settingsTitle", { name: launcher.name })}
          </h2>
        </div>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="modal-sheet__body modal-sheet__stack">
            {load.status === "loading" ? (
              <p className="modal-sheet__lead">{t("models.settingsLoading", { name: launcher.name })}</p>
            ) : null}
            {load.status === "error" ? (
              <p className="modal-sheet__error" role="alert">
                {t("models.settingsFailed", { error: load.error })}
              </p>
            ) : null}
            {load.status === "ready" && !manifest ? (
              <p className="modal-sheet__lead">{t("models.settingsNone", { dir: launcher.dir })}</p>
            ) : null}
            {manifest && manifest.settings.length === 0 ? (
              <p className="modal-sheet__lead">{t("models.settingsEmpty")}</p>
            ) : null}
            {manifest && manifest.settings.length > 0 ? (
              <>
                <p className="modal-sheet__lead">{t("models.settingsEnv", { file: envFile })}</p>
                {invalid.map((entry) => (
                  <p className="field-hint is-warn" key={entry.key}>
                    {t("models.settingsInvalid", { file: envFile, key: entry.key })}
                  </p>
                ))}
                {manifest.settings.map(field)}
              </>
            ) : null}
            {error ? (
              <p className="modal-sheet__error" role="alert">
                {error}
              </p>
            ) : null}
            {saved ? (
              <div className="launcher-settings__saved">
                <p className="modal-sheet__success">{t("models.settingsSaved", { file: envFile })}</p>
                {saved.restartRequired && mayBeRunning ? (
                  <>
                    <p className="field-hint is-warn">
                      {runState === "running"
                        ? t("models.settingsRestartAsk", { name: launcher.name })
                        : t("models.settingsRestartUnknown", { name: launcher.name })}
                    </p>
                    <div className="launcher-settings__saved-actions">
                      <button type="button" className="btn btn--primary btn--sm" onClick={onRestart}>
                        {t("models.settingsRestart", { name: launcher.name })}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
                        {t("models.settingsLater")}
                      </button>
                    </div>
                  </>
                ) : null}
                {saved.restartRequired && !mayBeRunning ? (
                  <p className="field-hint">{t("models.settingsNextStart", { name: launcher.name })}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                {t("models.cancel")}
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving || !manifest || manifest.settings.length === 0}>
                {saving ? t("models.settingsSaving") : t("models.settingsSave")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
