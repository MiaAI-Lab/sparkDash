import { useTranslation } from "react-i18next";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { addLauncher, updateLauncher, discoverModels } from "../../api/client";
import type { LlmLauncher, ModelCandidate, ModelCandidateKind, ModelDiscoveryResponse } from "../../api/types";
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
export function validateLauncherForm(form: { name: string; dir: string; port: string }): "name" | "directory" | "absolute" | "spaces" | "port" | null {
  if (!form.name.trim()) return "name";
  const dir = form.dir.trim();
  if (!dir) return "directory";
  if (!(dir.startsWith("/") || dir.startsWith("~/"))) return "absolute";
  if (/\s/.test(dir)) return "spaces";
  if (form.port.trim()) {
    const p = Number(form.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return "port";
  }
  return null;
}

/** Display order and badge text for each discovery source. */
const DISCOVERY_GROUPS: { kind: ModelCandidateKind; badge: string }[] = [
  { kind: "scripted", badge: "launchable" },
  { kind: "ollama", badge: "ollama weights" },
  { kind: "huggingface", badge: "HF cache" },
];

/**
 * The candidate list of a finished scan: grouped, compact, scrollable. One
 * button per candidate; picking one prefills the form (the caller decides how).
 * Extracted so the list and its prefill are testable without the whole dialog.
 */
export function ModelDiscoveryList({
  result,
  onPick,
}: {
  result: ModelDiscoveryResponse;
  onPick: (candidate: ModelCandidate) => void;
}) {
  if (result.candidates.length === 0) {
    return (
      <p className="field-hint" role="status">
        Nothing launchable found in the scanned folders
      </p>
    );
  }
  return (
    <div className="model-discovery">
      <div className="model-discovery__list" role="list">
        {DISCOVERY_GROUPS.map((group) => {
          const items = result.candidates.filter((c) => c.kind === group.kind);
          if (items.length === 0) return null;
          return (
            <div key={group.kind} role="listitem">
              <p className="model-discovery__group">{group.badge}</p>
              {items.map((candidate) => (
                <button
                  key={`${candidate.kind}:${candidate.name}:${candidate.directory ?? ""}`}
                  type="button"
                  className="model-discovery__row"
                  onClick={() => onPick(candidate)}
                >
                  <span className="model-discovery__badge">{group.badge}</span>
                  <span className="model-discovery__name">
                    {candidate.name}
                    {candidate.directory ? <span className="model-discovery__dir">{candidate.directory}</span> : null}
                  </span>
                  {candidate.size ? <span className="model-discovery__meta">{candidate.size}</span> : null}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {result.scannedRoots.length > 0 ? (
        <p className="model-discovery__scan">Scanned {result.scannedRoots.join(", ")}</p>
      ) : null}
      {result.notes.map((note, i) => (
        <p className="field-hint" key={`note-${i}`}>
          {note}
        </p>
      ))}
    </div>
  );
}

export function LlmLauncherDialog({ open, sparkId, sparkName, launcher, onClose, onSaved }: LlmLauncherDialogProps) {
  const { t } = useTranslation("hardware");
  const validation = { name: t("launcher.validation.name"), directory: t("launcher.validation.directory"), absolute: t("launcher.validation.absolute"), spaces: t("launcher.validation.spaces"), port: t("launcher.validation.port") };
  const [problem, setProblem] = useState<ReturnType<typeof validateLauncherForm>>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const [form, setForm] = useState({ name: "", dir: "", startScript: "start.sh", stopScript: "stop.sh", port: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discovery, setDiscovery] = useState<
    { state: "idle" | "loading" | "error"; error?: string } | { state: "done"; result: ModelDiscoveryResponse }
  >({ state: "idle" });
  const [ollamaPicked, setOllamaPicked] = useState(false);
  const overlayClose = useOverlayClose(onClose, !saving);
  const editing = Boolean(launcher);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProblem(null);
    setSaving(false);
    setDiscovery({ state: "idle" });
    setOllamaPicked(false);
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

  // The point of discovery is that the user never has to type a name or a
  // directory they would have to look up first — so scanning starts the moment
  // the dialog opens (new unit), not after a button press. Editing an existing
  // model leaves the form alone: its path is already right. The server caches
  // the scan for 15 s, so reopening the dialog costs nothing. `scan` is read
  // from the latest render via the effect's timing, not captured stale: it
  // only touches setState, which is stable.
  useEffect(() => {
    if (open && !launcher) scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setProblem(problem);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    setProblem(null);
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

  /** Ask the server what is launchable on this Spark (fixed host-side scan). */
  async function scan() {
    setDiscovery({ state: "loading" });
    try {
      const result = await discoverModels();
      setDiscovery({ state: "done", result });
    } catch (e) {
      setDiscovery({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Prefill the form from a discovered candidate. Ollama weights have no folder to point at. */
  function pick(candidate: ModelCandidate) {
    if (candidate.kind === "ollama") {
      setOllamaPicked(true);
      set({ name: candidate.name, dir: "" });
      return;
    }
    setOllamaPicked(false);
    set({
      name: candidate.name,
      dir: candidate.directory ?? "",
      ...(candidate.kind === "scripted"
        ? { startScript: candidate.startScript || "start.sh", stopScript: candidate.stopScript || "stop.sh" }
        : {}),
    });
  }

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      {...overlayClose}
    >
      <div ref={trapRef} className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id={titleId}>
            {editing ? t("launcher.edit") : t("launcher.add")}
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
              {t("launcher.intro", { name: sparkName })}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-name`}>{t("launcher.name")}</label>
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
              <label htmlFor={`${titleId}-dir`}>{t("launcher.directory", { name: sparkName })}</label>
              <input
                id={`${titleId}-dir`}
                type="text"
                className="field-input--mono"
                value={form.dir}
                onChange={(e) => {
                  setOllamaPicked(false);
                  set({ dir: e.target.value });
                }}
                placeholder="/home/you/llms/glm-5.3"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="field-hint">{t("launcher.pathHelp")}</p>
              {ollamaPicked ? (
                <p className="field-hint" role="status">
                  {t("launcher.discover.ollamaHint")}
                </p>
              ) : null}
            </div>
            <div className="field">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void scan()}
                disabled={saving || discovery.state === "loading"}
              >
                {discovery.state === "loading" ? t("launcher.discover.scanning") : t("launcher.discover.button")}
              </button>
              {discovery.state === "done" ? <ModelDiscoveryList result={discovery.result} onPick={pick} /> : null}
              {discovery.state === "error" ? (
                <p className="field-hint is-warn" role="alert">
                  {t("launcher.discover.failed", { error: discovery.error })}
                </p>
              ) : null}
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${titleId}-start`}>{t("launcher.start")}</label>
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
                <label htmlFor={`${titleId}-stop`}>{t("launcher.stop")}</label>
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
                <label htmlFor={`${titleId}-port`}>{t("launcher.port")}</label>
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
              {t("launcher.portHelp")}
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-notes`}>{t("launcher.notes")}</label>
              <input
                id={`${titleId}-notes`}
                type="text"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder={t("launcher.notesPlaceholder")}
                autoComplete="off"
              />
            </div>
            {error || problem ? (
              <p className="field-hint is-warn" role="alert">
                {problem ? validation[problem] : error}
              </p>
            ) : null}
          </div>
          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                {t("launcher.cancel")}
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? t("launcher.saving") : editing ? t("launcher.save") : t("launcher.addAction")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
