import { useState } from "react";
import type { FormState } from "./options";

export const MAX_TRIALS = 50;

/** Clamp to a whole number in 1..MAX_TRIALS (anything unusable becomes 1). */
export function clampTrials(n: number): number {
  return Math.max(1, Math.min(MAX_TRIALS, Math.round(n) || 1));
}

/** Current trials count of a form (1 when unset). */
export function trialsOf(state: FormState): number {
  return clampTrials(Number(state.values["trials"]));
}

/** The form with `trials` set to n (clamped); 1 removes the option. */
export function withTrials(state: FormState, n: number): FormState {
  const v = clampTrials(n);
  const { trials: _t, ...rest } = state.values;
  return { ...state, values: v > 1 ? { ...rest, trials: String(v) } : rest };
}

/** `--trials N`: repeat the whole run N times for Pass@k statistics. Shared by the Simple and Advanced views. */
export function TrialsRow({ state, onChange, disabled }: { state: FormState; onChange: (next: FormState) => void; disabled?: boolean }) {
  const trials = trialsOf(state);
  // While typing the input keeps its own text, so it can be emptied before the next number goes in.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (n: number) => onChange(withTrials(state, n));
  const step = (n: number) => {
    if (disabled) return;
    setDraft(null);
    commit(n);
  };
  const atMin = Boolean(disabled) || trials <= 1;
  const atMax = Boolean(disabled) || trials >= MAX_TRIALS;
  return (
    <div className="te-simple__trials">
      <div className="te-simple__trials-text">
        <span className="eyebrow">Trials</span>
        <span className="te-simple__hint">
          Repeat the whole run N times for Pass@k statistics. {trials > 1 ? `Takes about ${trials}× as long.` : "1 = a single run."}
        </span>
      </div>
      <div className="te-stepper" role="group" aria-label="Number of trials">
        <button type="button" onClick={() => !atMin && step(trials - 1)} aria-disabled={atMin} aria-label="Fewer trials">
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft ?? String(trials)}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "").slice(0, 3);
            setDraft(raw);
            const n = Number(raw);
            if (raw && n >= 1 && n <= MAX_TRIALS) commit(n);
          }}
          onBlur={() => {
            if (draft === null) return;
            commit(Number(draft));
            setDraft(null);
          }}
          aria-label={`Trials (1 to ${MAX_TRIALS})`}
        />
        <button type="button" onClick={() => !atMax && step(trials + 1)} aria-disabled={atMax} aria-label="More trials">
          +
        </button>
      </div>
    </div>
  );
}
