import { t } from "../../i18n";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
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
  if (!form.name.trim()) return t("launcher.err_name");
  const dir = form.dir.trim();
  if (!dir) return t("launcher.err_dir");
  if (!(dir.startsWith("/") || dir.startsWith("~/"))) return t("launcher.err_dir_prefix");
  if (/\s/.test(dir)) return "Spaces are not supported in the directory path";
  if (form.port.trim()) {
    const p = Number(form.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return t("launcher.err_port");
  }
  return null;
}

export function LlmLauncherDialog({ open, sparkId, sparkName, launcher, onClose, onSaved }: LlmLauncherDialogProps) {
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
            {editing ? t("launcher.edit_model") : t("launcher.add_a_model")}
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
              {t("launcher.lead", { spark: sparkName })}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-name`}>{t("launcher.lbl_name")}</label>
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
              <label htmlFor={`${titleId}-dir`}>{t("launcher.lbl_dir", { spark: sparkName })}</label>
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
              <p className="field-hint">{t("ui.an_absolute_path_or_one_7276")}</p>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${titleId}-start`}>{t("launcher.lbl_start")}</label>
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
                <label htmlFor={`${titleId}-stop`}>{t("launcher.lbl_stop")}</label>
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
                <label htmlFor={`${titleId}-port`}>{t("bench.port_n", { port: "" }).replace(": ", "")}</label>
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
              {t("launcher.port_hint")}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-notes`}>{t("launcher.lbl_notes")}</label>
              <input
                id={`${titleId}-notes`}
                type="text"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder={t("launcher.placeholder_notes")}
                autoComplete="off"
              />
            </div>
            {error ? (
              <p className="field-hint is-warn" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                {t("launcher.cancel")}
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? t("common.saving") : editing ? t("common.save") : t("models.add")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
