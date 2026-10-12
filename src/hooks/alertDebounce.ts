/**
 * Hysteresis for alerts the browser derives itself (alert notifications off):
 * a condition must hold `holdMs` before it counts, and stay clear `holdMs`
 * before it stops counting. A reading that flaps across a threshold therefore
 * badges and notifies once, not on every crossing. The server's own alerts
 * already have this (pending → firing → resolved) and are not debounced again.
 */
import type { FleetAlert } from "../components/OverviewPage/FleetAlertStrip";

/** How long a browser-derived condition must hold, and stay clear, to change the badge. */
export const BROWSER_ALERT_HOLD_MS = 30_000;

export interface DebounceState {
  /** Seen but not held long enough yet: key → first seen. */
  pending: Map<string, number>;
  /** Counting: key → latest row, and since when it has been absent (null = present). */
  shown: Map<string, { row: FleetAlert; clearSince: number | null }>;
}

export function emptyDebounce(): DebounceState {
  return { pending: new Map(), shown: new Map() };
}

/**
 * One step. `seed` (the first ready state) counts what is already wrong at once,
 * so a page that opens on a problem shows it without waiting.
 * @returns the rows that count now, and when to step again (null = no change due)
 */
export function stepDebounce(
  state: DebounceState,
  rows: FleetAlert[],
  now: number,
  holdMs: number = BROWSER_ALERT_HOLD_MS,
  seed = false
): { visible: FleetAlert[]; nextCheckAt: number | null } {
  const present = new Map(rows.map((r) => [r.key, r]));
  for (const [key, row] of present) {
    const shown = state.shown.get(key);
    if (shown) {
      shown.row = row;
      shown.clearSince = null;
      continue;
    }
    if (seed) {
      state.shown.set(key, { row, clearSince: null });
      continue;
    }
    const since = state.pending.get(key) ?? now;
    if (now - since >= holdMs) {
      state.pending.delete(key);
      state.shown.set(key, { row, clearSince: null });
    } else {
      state.pending.set(key, since);
    }
  }
  for (const key of [...state.pending.keys()]) if (!present.has(key)) state.pending.delete(key);
  for (const [key, entry] of [...state.shown]) {
    if (present.has(key)) continue;
    entry.clearSince ??= now;
    if (now - entry.clearSince >= holdMs) state.shown.delete(key);
  }
  let nextCheckAt: number | null = null;
  const due = (t: number) => {
    if (nextCheckAt === null || t < nextCheckAt) nextCheckAt = t;
  };
  for (const since of state.pending.values()) due(since + holdMs);
  for (const entry of state.shown.values()) if (entry.clearSince !== null) due(entry.clearSince + holdMs);
  return { visible: [...state.shown.values()].map((e) => e.row), nextCheckAt };
}
