import { localizedServerText } from "../../i18n/messages";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { addLauncher, updateLauncher } from "../../api/client";
import type { LlmLauncher } from "../../api/types";
import "../../styles/dialogs.css";

interface LlmLauncherDialogProps {
  open: boolean;
  sparkId: string;
  sparkName: string;
  /** When set, the dialog edits this model instead of adding one. */
  launcher?: LlmLauncher | null;
  onClose: () => void;
  onSaved: (launcher: LlmLauncher) => void;
}

/** Quick client-side check, so obvious mistakes read before a round trip. The server is the authority. */
export function validateLauncherForm(form: { name: string; dir: string; port: string }): string | null {
  if (!form.name.trim()) return i18next.t("spark.llmLauncher.errName", "Give the model a name");
  const dir = form.dir.trim();
  if (!dir) return i18next.t("spark.llmLauncher.errDir", "Enter the directory that holds start.sh and stop.sh");
  if (!(dir.startsWith("/") || dir.startsWith("~/")))
    return i18next.t("spark.llmLauncher.errDirAbsolute", "The directory must start with / or ~/");
  if (/\s/.test(dir))
    return i18next.t("spark.llmLauncher.errDirSpaces", "Spaces are not supported in the directory path");
  if (form.port.trim()) {
    const p = Number(form.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      return i18next.t("spark.llmLauncher.errPort", "Port must be a number from 1 to 65535");
  }
  return null;
}

export function LlmLauncherDialog({ open, sparkId, sparkName, launcher, onClose, onSaved }: LlmLauncherDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const [form, setForm] = useState({ name: "", dir: "", startScript: "start.sh", stopScript: "stop.sh", port: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(launcher);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setForm(
      launcher
        ? {
            name: launcher.name,
            dir: launcher.dir,
            startScript: launcher.startScript,
            stopScript: launcher.stopScript,
            port: launcher.port != null ? String(launcher.port) : "",
            notes: launcher.notes ?? "",
          }
        : { name: "", dir: "", startScript: "start.sh", stopScript: "stop.sh", port: "", notes: "" }
    );
  }, [open, launcher]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!mounted) return null;

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    const problem = validateLauncherForm(form);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      dir: form.dir.trim(),
      startScript: form.startScript.trim() || "start.sh",
      stopScript: form.stopScript.trim() || "stop.sh",
      port: form.port.trim() ? Number(form.port) : null,
      notes: form.notes.trim(),
    };
    try {
      const res = launcher ? await updateLauncher(sparkId, launcher.id, body) : await addLauncher(sparkId, body);
      onSaved(res.launcher);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (!saving && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={trapRef} className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id={titleId}>
            {editing
              ? t("spark.llmLauncher.editTitle", "Edit model")
              : t("spark.llmLauncher.addTitle", "Add a model")}
          </h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="modal-sheet__body modal-sheet__stack">
            <p className="modal-sheet__lead">
              {t("spark.llmLauncher.leadBefore", "Point sparkDash at the folder on")} <b>{sparkName}</b>{" "}
              {t(
                "spark.llmLauncher.leadAfter",
                "that holds your model’s start and stop scripts. It runs those scripts as the SSH user and shows their output here."
              )}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-name`}>{t("spark.llmLauncher.nameRequired", "Name (required)")}</label>
              <input
                id={`${titleId}-name`}
                type="text"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="GLM 5.3 EXL3"
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor={`${titleId}-dir`}>
                {t("spark.llmLauncher.directoryOn", "Directory on {name} (required)", { name: sparkName })}
              </label>
              <input
                id={`${titleId}-dir`}
                type="text"
                className="field-input--mono"
                value={form.dir}
                onChange={(e) => set({ dir: e.target.value })}
                placeholder="/home/you/llms/glm-5.3"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="field-hint">
                {t("spark.llmLauncher.dirHint", "An absolute path, or one starting with ~/. No spaces.")}
              </p>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${titleId}-start`}>{t("spark.llmLauncher.startScript", "Start script")}</label>
                <input
                  id={`${titleId}-start`}
                  type="text"
                  className="field-input--mono"
                  value={form.startScript}
                  onChange={(e) => set({ startScript: e.target.value })}
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor={`${titleId}-stop`}>{t("spark.llmLauncher.stopScript", "Stop script")}</label>
                <input
                  id={`${titleId}-stop`}
                  type="text"
                  className="field-input--mono"
                  value={form.stopScript}
                  onChange={(e) => set({ stopScript: e.target.value })}
                  spellCheck={false}
                />
              </div>
              <div className="field field--port">
                <label htmlFor={`${titleId}-port`}>{t("spark.llmLauncher.portLabel", "Port")}</label>
                <input
                  id={`${titleId}-port`}
                  type="number"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => set({ port: e.target.value })}
                  placeholder="8888"
                />
              </div>
            </div>
            <p className="field-hint">
              {t(
                "spark.llmLauncher.portHint",
                "The port is optional. When set, the model shows as “serving” once the dashboard sees an LLM answering there."
              )}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-notes`}>{t("spark.llmLauncher.notesLabel", "Notes")}</label>
              <input
                id={`${titleId}-notes`}
                type="text"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder={t("spark.llmLauncher.notesPlaceholder", "Optional, e.g. 2-node cluster, needs ~100 GB")}
                autoComplete="off"
              />
            </div>
            {error ? (
              <p className="field-hint is-warn" role="alert">
                {localizedServerText(error)}
              </p>
            ) : null}
          </div>
          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                {t("common.action.cancel", "Cancel")}
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving
                  ? t("common.action.saving", "Saving…")
                  : editing
                    ? t("common.action.save", "Save")
                    : t("spark.llmLauncher.addModel", "Add model")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
