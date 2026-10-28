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
export function validateLauncherForm(form: { name: string; dir: string; port: string }): string | null {
  if (!form.name.trim()) return "Give the model a name";
  const dir = form.dir.trim();
  if (!dir) return "Enter the directory that holds start.sh and stop.sh";
  if (!(dir.startsWith("/") || dir.startsWith("~/"))) return "The directory must start with / or ~/";
  if (/\s/.test(dir)) return "Spaces are not supported in the directory path";
  if (form.port.trim()) {
    const p = Number(form.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return "Port must be a number from 1 to 65535";
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
            {editing ? "Edit model" : "Add a model"}
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
              Point sparkDash at the folder on <b>{sparkName}</b> that holds your model&rsquo;s start and stop scripts. It runs
              those scripts as the SSH user and shows their output here.
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-name`}>Name (required)</label>
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
              <label htmlFor={`${titleId}-dir`}>Directory on {sparkName} (required)</label>
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
              <p className="field-hint">An absolute path, or one starting with ~/. No spaces.</p>
              {ollamaPicked ? (
                <p className="field-hint" role="status">
                  Ollama keeps its weights in the engine — enter the directory whose start.sh serves this model.
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
                {discovery.state === "loading" ? "Scanning…" : "Discover on this Spark"}
              </button>
              {discovery.state === "done" ? <ModelDiscoveryList result={discovery.result} onPick={pick} /> : null}
              {discovery.state === "error" ? (
                <p className="field-hint is-warn" role="alert">
                  Discovery failed: {discovery.error}
                </p>
              ) : null}
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${titleId}-start`}>Start script</label>
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
                <label htmlFor={`${titleId}-stop`}>Stop script</label>
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
                <label htmlFor={`${titleId}-port`}>Port</label>
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
              The port is optional. When set, the model shows as &ldquo;serving&rdquo; once the dashboard sees an LLM answering there.
            </p>
            <div className="field">
              <label htmlFor={`${titleId}-notes`}>Notes</label>
              <input
                id={`${titleId}-notes`}
                type="text"
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                placeholder="Optional, e.g. 2-node cluster, needs ~100 GB"
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
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save" : "Add model"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
