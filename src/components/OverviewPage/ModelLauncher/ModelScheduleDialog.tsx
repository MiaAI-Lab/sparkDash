import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../../hooks/useModalPresence";
import { closeModelScheduleDialog, useModelScheduleDialog } from "../../../hooks/useModelScheduleDialog";
import { fetchModels, previewScheduler, saveModelSchedule } from "../../../api/modelClient";
import type { ModelConfig, SchedulerPreview } from "../../../api/modelTypes";
import type { ModelSchedule } from "../../../shared/modelSchedules";
import type { DayType } from "../../../shared/modelSchedules";
import { EMPTY_FORM, formsMatch, normalize, validateForm } from "./modelScheduleForm";
import type { RawWindow, ScheduleForm } from "./modelScheduleForm";
import { BoltIcon, PlusIcon, RotateIcon } from "../../ui/icons";

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

const DAY_LABEL: Record<DayType, string> = { weekday: "Weekday", weekend: "Weekend" };

/** What "Add window" inserts, and what enabling a schedule without one seeds. */
const DEFAULT_WINDOW: RawWindow = { start: "08:00", end: "18:00" };

function WindowRows({
  day,
  windows,
  onChange,
}: {
  day: DayType;
  windows: RawWindow[];
  onChange: (next: RawWindow[]) => void;
}) {
  const set = (i: number, patch: Partial<RawWindow>) =>
    onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-2">
      {windows.map((w, i) => (
        <div key={`${day}-${i}`} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-[10px] text-muted">{i + 1}</span>
          {/*
            Plain text, NOT type=time: the browser renders native time inputs
            in the locale's 12-hour format, so a window like 18:00 → 08:00
            displayed as "06:00 PM → 08:00 AM" and read as to→from. A text
            field shows the exact 24-hour string that gets saved; blur runs
            normalize() so "8" / "8:00" snap to "08:00", and validateForm()
            flags anything that is not a real HH:MM minute-precise time.
          */}
          <input
            type="text"
            inputMode="numeric"
            maxLength={5}
            placeholder="HH:MM"
            value={w.start}
            onChange={(e) => set(i, { start: e.target.value })}
            onBlur={(e) => set(i, { start: normalize(e.target.value) ?? e.target.value })}
            title="24-hour clock with minute precision, e.g. 08:00 (not 8 AM)"
            className="min-w-0 flex-1 rounded border border-border bg-surface-elevated px-2 py-1 font-tabular text-xs text-text outline-none placeholder:text-muted/60 focus:border-accent"
            aria-label={`${DAY_LABEL[day]} window ${i + 1} start`}
          />
          <span className="text-muted">→</span>
          <input
            type="text"
            inputMode="numeric"
            maxLength={5}
            placeholder="HH:MM"
            value={w.end}
            onChange={(e) => set(i, { end: e.target.value })}
            onBlur={(e) => set(i, { end: normalize(e.target.value) ?? e.target.value })}
            title="24-hour clock with minute precision, e.g. 08:00. End ≤ start wraps past midnight."
            className="min-w-0 flex-1 rounded border border-border bg-surface-elevated px-2 py-1 font-tabular text-xs text-text outline-none placeholder:text-muted/60 focus:border-accent"
            aria-label={`${DAY_LABEL[day]} window ${i + 1} end`}
          />
          <button
            type="button"
            onClick={() => onChange(windows.filter((_, j) => j !== i))}
            className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-danger"
            title="Remove window"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...windows, { ...DEFAULT_WINDOW }])}
        className="inline-flex items-center gap-1 rounded border border-border bg-surface-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
      >
        <PlusIcon className="h-3 w-3" /> Add {DAY_LABEL[day]} window
      </button>
      <p className="text-[10px] leading-snug text-muted">
        Default is the day shift 08:00 → 18:00. End ≤ start wraps past
        midnight (18:00 → 08:00 = the night shift). Equal start and end means
        the whole day. Windows may touch but not overlap.
      </p>
    </div>
  );
}

/**
 * Per-model running windows. Shape cloned from SlotSettingsDialog: an enable
 * toggle, a conditional nested block that only appears when enabled, and a
 * dirty-gated Save with a "Saved ✓" flash.
 *
 * A live preview (server-side, same pure code path the scheduler uses) shows
 * which model wins right now and flags any cross-model conflict before saving.
 */
export function ModelScheduleDialog() {
  const modelId = useModelScheduleDialog();
  const open = modelId != null;
  const { mounted, visible } = useModalPresence(open);
  useEscape(closeModelScheduleDialog, open && mounted);
  useBodyScrollLock(open && mounted);

  const [models, setModels] = useState<ModelConfig[]>([]);
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<ScheduleForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<SchedulerPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const model = models.find((m) => m.id === modelId) || null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setSaved(false);
    setPreview(null);
    fetchModels()
      .then(({ models: list }) => {
        if (cancelled) return;
        setModels(list);
        const m = list.find((x) => x.id === modelId);
        const s = m?.schedule;
        const next: ScheduleForm = s
          ? { enabled: s.enabled, weekday: s.weekday ?? [], weekend: s.weekend ?? [] }
          : EMPTY_FORM;
        setForm(next);
        setBaseline(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, modelId]);

  // Preview the effect of the *draft* windows: patch this model into the list
  // client-side is not possible without the server's normalizer, so we save
  // nothing and just ask for the current-state preview plus local validation.
  const localErrors = useMemo(() => validateForm(form), [form]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreviewing(true);
    previewScheduler()
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, models]);

  if (!mounted) return null;

  const isDirty = !formsMatch(form, baseline);
  const canSave = model != null && isDirty && localErrors.length === 0 && !saving;

  const handleSave = async () => {
    if (!modelId) return;
    setError(null);
    setSaving(true);
    try {
      const schedule: ModelSchedule = {
        enabled: form.enabled,
        weekday: form.weekday.map((w) => ({ start: normalize(w.start) || w.start, end: normalize(w.end) || w.end })),
        weekend: form.weekend.map((w) => ({ start: normalize(w.start) || w.start, end: normalize(w.end) || w.end })),
      };
      await saveModelSchedule(modelId, schedule);
      setBaseline({ ...schedule });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      // Re-pull so other cards' "on call"/"scheduled" badges refresh with it.
      const { models: list } = await fetchModels();
      setModels(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const patchDay = (day: DayType, next: RawWindow[]) => setForm((f) => ({ ...f, [day]: next }));

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModelScheduleDialog();
      }}
    >
      <div className="modal-sheet max-w-md" role="dialog" aria-modal="true" aria-labelledby="model-schedule-title">
        <header className="modal-sheet__header" id="model-schedule-title">
          <div className="flex items-center gap-2">
            <BoltIcon className="h-4 w-4 shrink-0 text-accent" />
            <span>Schedule{model ? ` — ${model.name}` : ""}</span>
          </div>
          {preview && (
            <p className="mt-1 text-xs font-normal text-muted">
              Now: <span className="font-tabular text-accent">{preview.clock}</span> ·{" "}
              {preview.dayType} ·{" "}
              {preview.activeWindow ? (
                <>
                  <span className="text-accent">{preview.activeWindow.modelName}</span> wins (
                  {preview.activeWindow.label})
                </>
              ) : (
                "gap — nothing scheduled"
              )}
            </p>
          )}
        </header>

        <div className="modal-sheet__body space-y-4">
          {!model && <p className="text-xs text-muted">Loading…</p>}

          {model && (
            <>
              <div className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2">
                <span className="text-xs text-text">Run this model on a schedule</span>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) =>
                      setForm((f) => {
                        const enabled = e.target.checked;
                        // Enabling a schedule with no windows yet starts you on a
                        // concrete day shift instead of an empty list.
                        if (enabled && f.weekday.length === 0 && f.weekend.length === 0) {
                          return { ...f, enabled, weekday: [{ ...DEFAULT_WINDOW }] };
                        }
                        return { ...f, enabled };
                      })
                    }
                    className="peer sr-only"
                  />
                  <span className="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-accent" />
                  <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                </label>
              </div>

              {form.enabled && (
                <div className="space-y-4 rounded-md border border-border bg-surface-elevated p-3">
                  <div className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-muted">Weekday windows</p>
                    <WindowRows day="weekday" windows={form.weekday} onChange={(n) => patchDay("weekday", n)} />
                  </div>
                  <div className="space-y-1.5 border-t border-border pt-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted">Weekend windows</p>
                    <WindowRows day="weekend" windows={form.weekend} onChange={(n) => patchDay("weekend", n)} />
                  </div>
                </div>
              )}

              {localErrors.length > 0 && (
                <div className="space-y-1 rounded-md border border-danger/40 bg-danger/10 p-3">
                  {localErrors.map((e, i) => (
                    <p key={i} className="text-[11px] text-danger">
                      {e}
                    </p>
                  ))}
                </div>
              )}

              {preview?.conflicts.length ? (
                <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3">
                  <p className="text-[11px] font-medium text-warning">Conflicts with another model</p>
                  {preview.conflicts.map((c, i) => (
                    <p key={i} className="text-[11px] text-warning">
                      {c}
                    </p>
                  ))}
                </div>
              ) : null}

              <p className="text-[11px] leading-relaxed text-muted">
                Windows describe when this model <em>should</em> be up. Saving marks this model{" "}
                <em>on call</em>; the automation only acts while the global scheduler is enabled
                (panel header). A manual Start/Stop still wins until the next window boundary.
              </p>

              {error && <p className="text-xs text-danger">{error}</p>}
            </>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {previewing && <RotateIcon className="h-3 w-3 animate-spin text-muted" />}
            {saved && <span className="text-xs text-success">Saved ✓</span>}
            <button
              type="button"
              onClick={closeModelScheduleDialog}
              disabled={saving}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
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
