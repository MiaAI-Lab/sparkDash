import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../../hooks/useModalPresence";
import {
  closeModelEditDialog,
  CONTAINER_RE,
  MODEL_ID_RE,
  openModelEditDialog,
  RESERVED_MODEL_IDS,
  SCRIPT_RE,
  useModelEditDialog,
} from "../../../hooks/useModelEditDialog";
import { addModel, deleteModel, fetchModels, updateModel } from "../../../api/modelClient";
import type { ModelConfig } from "../../../api/modelTypes";
import { fetchSparks } from "../../../api/client";
import type { SparkConfig } from "../../../api/types";
import { GearIcon, RotateIcon } from "../../ui/icons";

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);

}

interface Draft {
  id: string;
  name: string;
  sparkId: string;
  dir: string;
  description: string;
  startScript: string;
  stopScript: string;
  restartScript: string;
  logsScript: string;
  container: string;
  port: string;
  startArgs: string;
  repoUrl: string;
}

const BLANK: Draft = {
  id: "",
  name: "",
  sparkId: "",
  dir: "",
  description: "",
  startScript: "start.sh",
  stopScript: "stop.sh",
  restartScript: "restart.sh",
  logsScript: "",
  container: "",
  port: "",
  startArgs: "",
  repoUrl: "",
};

function toDraft(m: ModelConfig): Draft {
  return {
    id: m.id,
    name: m.name ?? m.id,
    sparkId: m.sparkId ?? "",
    dir: m.dir,
    description: m.description ?? "",
    startScript: m.startScript ?? "",
    stopScript: m.stopScript ?? "",
    restartScript: m.restartScript ?? "",
    logsScript: m.logsScript ?? "",
    container: m.container ?? "",
    port: m.port != null ? String(m.port) : "",
    startArgs: (m.startArgs ?? []).join(" "),
    repoUrl: m.repoUrl ?? "",
  };
}

const orNull = (s: string) => {
  const t = s.trim();
  return t || null;
};

/** Field-level mirror of the server allowlist (the server always re-checks). */
function localErrors(target: string, d: Draft): string[] {
  const e: string[] = [];
  if (target === "new") {
    if (!MODEL_ID_RE.test(d.id)) e.push("id: [A-Za-z0-9._-] 1–64 chars");
    else if (RESERVED_MODEL_IDS.has(d.id)) e.push(`id "${d.id}" is reserved`);
  }
  if (!d.dir.trim()) e.push("dir is required");
  if (!d.sparkId) e.push("choose the Spark whose machine runs this model's scripts");
  if (!SCRIPT_RE.test(d.startScript.trim())) e.push("start script must look like start.sh");
  if (!SCRIPT_RE.test(d.stopScript.trim())) e.push("stop script must look like stop.sh");
  for (const [label, v] of [
    ["restart", d.restartScript],
    ["logs", d.logsScript],
  ] as const) {
    if (v.trim() && !SCRIPT_RE.test(v.trim())) e.push(`${label} script must look like ${label}.sh`);
  }
  if (d.container.trim() && !CONTAINER_RE.test(d.container.trim()))
    e.push("container: [A-Za-z0-9._-] only");
  if (d.port.trim()) {
    const n = Number(d.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) e.push("port must be 1–65535");
  }
  if (!d.container.trim() && !d.port.trim()) e.push("needs a container name or a port to detect running");
  if (d.repoUrl.trim() && !/^https?:\/\//i.test(d.repoUrl.trim()))
    e.push("repo URL must start with http:// or https://");
  return e;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block text-xs text-muted">
      {label}
      {children}
      {hint && <span className="mt-0.5 block text-[10px] leading-snug text-muted">{hint}</span>}
    </label>
  );
}

const INPUT =
  "mt-1 w-full rounded border border-border bg-surface-elevated px-2.5 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent";

/**
 * Create / edit / remove a model card. Cloned from AddSparkDialog (same
 * modal-sheet chrome and save flow) but the fields are the launcher's, and the
 * id is immutable after creation — mirroring the registry.
 *
 * Schedule windows are deliberately NOT edited here; that lives in
 * ModelScheduleDialog so the two concerns stay independent.
 */
export function ModelEditDialog() {
  const target = useModelEditDialog();
  const open = target != null;
  const { mounted, visible } = useModalPresence(open);
  useEscape(closeModelEditDialog, open && mounted);
  useBodyScrollLock(open && mounted);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [baseline, setBaseline] = useState<Draft>(BLANK);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Editable target list for the "run on Spark" select. */
  const [sparks, setSparks] = useState<SparkConfig[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSparks()
      .then(({ sparks }) => {
        if (!cancelled) setSparks(sparks);
      })
      .catch(() => {
        /* empty select; the save still round-trips the server allowlist */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || target == null) return;
    setError(null);
    if (target === "new") {
      setDraft(BLANK);
      setBaseline(BLANK);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchModels()
      .then(({ models }) => {
        if (cancelled) return;
        const m = models.find((x) => x.id === target);
        if (!m) {
          setError("Model not found");
          return;
        }
        const d = toDraft(m);
        setDraft(d);
        setBaseline(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  const errors = useMemo(() => (target ? localErrors(target, draft) : []), [target, draft]);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  if (!mounted || target == null) return null;

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const buildBody = (): Partial<ModelConfig> & Pick<ModelConfig, "id" | "dir" | "startScript" | "stopScript"> => ({
    id: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    dir: draft.dir.trim(),
    sparkId: draft.sparkId || null,
    description: orNull(draft.description),
    startScript: draft.startScript.trim(),
    stopScript: draft.stopScript.trim(),
    restartScript: orNull(draft.restartScript),
    logsScript: orNull(draft.logsScript),
    container: orNull(draft.container),
    port: draft.port.trim() ? Number(draft.port) : null,
    startArgs: draft.startArgs.trim() ? draft.startArgs.trim().split(/\s+/) : [],
    repoUrl: orNull(draft.repoUrl),
  });

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const body = buildBody();
      if (target === "new") await addModel(body as ModelConfig);
      else await updateModel(target, body);
      setBaseline(draft);
      closeModelEditDialog();
    } catch (err: unknown) {
      // Surface the server's allowlist verdict verbatim — it is more precise
      // than the client mirror and names the offending field.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (target === "new") return;
    setError(null);
    setSaving(true);
    try {
      await deleteModel(target);
      closeModelEditDialog();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModelEditDialog();
      }}
    >
      <div className="modal-sheet max-w-md" role="dialog" aria-modal="true" aria-labelledby="model-edit-title">
        <header className="modal-sheet__header" id="model-edit-title">
          <div className="flex items-center gap-2">
            <GearIcon className="h-4 w-4 shrink-0 text-accent" />
            <span>{target === "new" ? "Add model" : `Edit ${target}`}</span>
          </div>
          <p className="mt-1 text-xs font-normal text-muted">
            Scripts run inside the repo directory on the selected Spark, over SSH
            (password auth today, keys after the migration). Only allowlisted names
            are accepted, so a config value can never become shell syntax.
          </p>
        </header>

        <div className="modal-sheet__body space-y-3">
          {loading && <p className="text-xs text-muted">Loading…</p>}

          {!loading && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="id">
                  <input
                    type="text"
                    value={draft.id}
                    disabled={target !== "new"}
                    onChange={(e) => patch({ id: e.target.value })}
                    className={`${INPUT} disabled:opacity-50`}
                    placeholder="glm-53-exl3"
                  />
                </Field>
                <Field label="Display name">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    className={INPUT}
                    placeholder="GLM-5.3 Flash"
                  />
                </Field>
              </div>
              <Field
                label="run on Spark"
                hint="Where the repo lives: start/stop/logs and liveness probes all execute there."
              >
                <select
                  value={draft.sparkId}
                  onChange={(e) => patch({ sparkId: e.target.value })}
                  className={INPUT}
                >
                  <option value="">— choose a Spark —</option>
                  {sparks.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.ssh?.host || s.lanIp || "no host"})
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Repo directory" hint="Path on the selected Spark — absolute, or relative to the configured repos base.">
                <input
                  type="text"
                  value={draft.dir}
                  onChange={(e) => patch({ dir: e.target.value })}
                  className={INPUT}
                  placeholder="/home/you/cluster/docker/my-model"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="start script">
                  <input
                    type="text"
                    value={draft.startScript}
                    onChange={(e) => patch({ startScript: e.target.value })}
                    className={INPUT}
                  />
                </Field>
                <Field label="stop script">
                  <input
                    type="text"
                    value={draft.stopScript}
                    onChange={(e) => patch({ stopScript: e.target.value })}
                    className={INPUT}
                  />
                </Field>
                <Field label="restart script (optional)">
                  <input
                    type="text"
                    value={draft.restartScript}
                    onChange={(e) => patch({ restartScript: e.target.value })}
                    className={INPUT}
                  />
                </Field>
                <Field label="logs script (optional)">
                  <input
                    type="text"
                    value={draft.logsScript}
                    onChange={(e) => patch({ logsScript: e.target.value })}
                    className={INPUT}
                    placeholder="logs.sh"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="container name" hint="docker ps name of the head container.">
                  <input
                    type="text"
                    value={draft.container}
                    onChange={(e) => patch({ container: e.target.value })}
                    className={INPUT}
                    placeholder="vllm-fn"
                  />
                </Field>
                <Field label="API port" hint="127.0.0.1:<port>/v1/models answers once ready.">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(e) => patch({ port: e.target.value })}
                    className={INPUT}
                    placeholder="8000"
                  />
                </Field>
              </div>

              <Field label="start args (optional)" hint="Space-separated flag tokens only, e.g. --host 0.0.0.0">
                <input
                  type="text"
                  value={draft.startArgs}
                  onChange={(e) => patch({ startArgs: e.target.value })}
                  className={INPUT}
                />
              </Field>

              <Field label="description (optional)">
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  className="mt-1 w-full rounded border border-border bg-surface-elevated px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
              </Field>

              <Field
                label="repo URL (optional)"
                hint="Auto-detected from `git remote get-url origin` when left empty; shows as the card's repo link."
              >
                <input
                  type="text"
                  value={draft.repoUrl}
                  onChange={(e) => patch({ repoUrl: e.target.value })}
                  className={INPUT}
                  placeholder="https://github.com/MiaAI-Lab/…"
                />
              </Field>

              {errors.length > 0 && (
                <div className="space-y-1 rounded-md border border-danger/40 bg-danger/10 p-3">
                  {errors.map((e, i) => (
                    <p key={i} className="text-[11px] text-danger">
                      {e}
                    </p>
                  ))}
                </div>
              )}

              {error && <p className="break-words text-xs text-danger">{error}</p>}
            </>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {target !== "new" && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={saving}
                className="mr-auto rounded border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
                title="Remove this card (does not touch the repo or any container)"
              >
                Remove
              </button>
            )}
            {saving && <RotateIcon className="h-3 w-3 animate-spin text-muted" />}
            <button
              type="button"
              onClick={closeModelEditDialog}
              disabled={saving}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || loading || errors.length > 0 || !isDirty}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
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

export { openNewModelDialog } from "../../../hooks/useModelEditDialog";
