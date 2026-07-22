import { useSyncExternalStore } from "react";
import type { SparkSnapshot } from "../api/types";

/**
 * Central metrics history store (idea #8b).
 *
 * Fed once per WebSocket snapshot by useSnapshot. Components read time-series
 * via `useMetricsHistory` / `useMetricsHistoryTail` — a single source of truth that:
 *   - survives Spark tab switches (history is no longer per-panel useState),
 *   - caps each series at HISTORY_MAX samples (1 h at the default 2 s poll),
 *   - lets future time-range charts read from one place,
 *   - keeps sparklines on a short tail (SPARKLINE_TAIL) so 84px charts stay readable.
 *
 * Also keeps the latest snapshot per spark (`getSpark` / `useSpark`) as the
 * selective-subscription seam (#8a).
 *
 * Reference-stability contract (required by useSyncExternalStore):
 * getSnapshot returns a *cached* value that only changes when that slice
 * actually changed. On each ingest we replace the history array with a new ref
 * (slice + append), so subscribers to that key re-render and all others skip.
 * All listeners are woken on notify; unchanged keys keep the same ref → no render.
 */

const HISTORY_MAX = 1800; // 1 h at 2 s poll — the WS interval, not wall-clock guarantees
/** Samples shown in inline sparklines (≈1 min at 2 s poll). Full series stays in HISTORY_MAX. */
export const SPARKLINE_TAIL = 30;

const history = new Map<string, number[]>(); // key: `${sparkId}:${metric}`
/** Cached last-N views — refreshed whenever the full series is replaced. */
const historyTails = new Map<string, readonly number[]>();
const sparkMap = new Map<string, SparkSnapshot>();
const listeners = new Set<() => void>();

const EMPTY: readonly number[] = Object.freeze([] as number[]);

function notify() {
  for (const l of listeners) l();
}

export function subscribeMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setHistoryTail(key: string, full: number[]) {
  if (full.length === 0) {
    historyTails.delete(key);
    return;
  }
  // Share the full ref when short enough — one allocation, both hooks see the same array.
  historyTails.set(key, full.length <= SPARKLINE_TAIL ? full : full.slice(-SPARKLINE_TAIL));
}

function pushHistory(key: string, value: number) {
  const prev = history.get(key);
  // Build a fresh ref so useSyncExternalStore observes the change for this key.
  let next: number[];
  if (!prev || prev.length === 0) {
    next = [value];
  } else if (prev.length >= HISTORY_MAX) {
    next = prev.slice(prev.length - HISTORY_MAX + 1);
    next.push(value);
  } else {
    next = prev.slice();
    next.push(value);
  }
  history.set(key, next);
  setHistoryTail(key, next);
}

function removeHistoryForSpark(sparkId: string) {
  const prefix = `${sparkId}:`;
  for (const key of history.keys()) {
    if (key.startsWith(prefix)) {
      history.delete(key);
      historyTails.delete(key);
    }
  }
}

/** Ingest a full WS snapshot: update latest-per-spark + append history series. */
export function ingestSnapshots(sparks: SparkSnapshot[]): void {
  const alive = new Set<string>();

  for (const s of sparks) {
    alive.add(s.id);
    sparkMap.set(s.id, s);
    if (!s.online) continue; // don't record zero-samples for offline hosts
    const m = s.metrics;
    if (m.gpu) {
      pushHistory(`${s.id}:gpu.usage`, m.gpu.usage);
      pushHistory(`${s.id}:gpu.temp`, m.gpu.temperature);
    }
    if (m.cpu) {
      pushHistory(`${s.id}:cpu.usage`, m.cpu.usage);
    }
    if (Array.isArray(m.llm)) {
      // Zip with snapshot.llmPorts so multi-port LLM series key distinctly.
      const ports = s.llmPorts ?? [];
      for (let i = 0; i < m.llm.length; i++) {
        const llm = m.llm[i];
        const port = ports[i];
        const portKey = port != null ? `:${port}` : `:${i}`;
        pushHistory(`${s.id}:llm${portKey}.tps`, llm.generationTps);
      }
    }
  }

  // Drop series for Sparks no longer in the registry (deleted / removed from WS).
  for (const id of [...sparkMap.keys()]) {
    if (!alive.has(id)) {
      sparkMap.delete(id);
      removeHistoryForSpark(id);
    }
  }

  // Always notify: sparkMap refs refresh every frame (online flips included),
  // even when no history sample was appended.
  notify();
}

/** Read the latest cached snapshot for a spark (subscribe via useSpark). */
export function getSpark(id: string): SparkSnapshot | undefined {
  return sparkMap.get(id);
}

/** @internal getSnapshot for useMetricsHistory — stable ref per key. */
function getHistory(key: string): readonly number[] {
  return history.get(key) ?? EMPTY;
}

function getHistoryTail(key: string): readonly number[] {
  return historyTails.get(key) ?? EMPTY;
}

/**
 * Subscribe to one metric's full history series for one spark (up to HISTORY_MAX).
 * Re-renders only when that specific (sparkId, metric) array ref changes.
 */
export function useMetricsHistory(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistory(key),
    () => EMPTY
  );
}

/**
 * Last SPARKLINE_TAIL samples for inline sparklines. Prefer this over slicing
 * the full series in render — the tail ref is maintained at ingest time.
 */
export function useMetricsHistoryTail(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistoryTail(key),
    () => EMPTY
  );
}

/**
 * Subscribe to one spark's latest snapshot. Re-renders when that spark's
 * cached object is replaced (every WS frame that includes it).
 */
export function useSpark(id: string): SparkSnapshot | undefined {
  return useSyncExternalStore(
    subscribeMetrics,
    () => sparkMap.get(id),
    () => undefined
  );
}

/** Clear all cached state — used on hard reload paths / tests. */
export function _resetStore(): void {
  history.clear();
  historyTails.clear();
  sparkMap.clear();
}
