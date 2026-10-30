import { useEffect, useState } from "react";
import { getUnitHistory } from "../../api/client";
import type { HistoryLlmPoint, HistoryPoint, SparkSnapshot } from "../../api/types";
import { getMetricHistorySamples, type MetricSample } from "../../hooks/metricsStore";
import { tracesFromHistory, type KioskTraces } from "./kioskModel";

const REFRESH_MS = 60_000;
const STEP_MS = 60_000;
/** History reads in flight at once, so a large fleet does not send one request per unit together. */
export const HISTORY_CONCURRENCY = 4;

/** One-minute means of the browser's own samples, as history points carrying `key`. */
function bucket<K extends string>(samples: readonly MetricSample[], key: K): Array<{ t: number } & Record<K, { avg: number; max: number }>> {
  const sums = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const t = Math.floor(s.at / STEP_MS) * STEP_MS;
    const b = sums.get(t) ?? { sum: 0, n: 0 };
    b.sum += s.value;
    b.n += 1;
    sums.set(t, b);
  }
  return [...sums].map(([t, b]) => ({ t, [key]: { avg: b.sum / b.n, max: b.sum / b.n } }) as { t: number } & Record<K, { avg: number; max: number }>);
}

/** Traces from what this browser collected, for a server with Settings → Metrics history off. */
function tracesFromBrowser(spark: SparkSnapshot, now: number): KioskTraces {
  const points: HistoryPoint[] = [
    ...bucket(getMetricHistorySamples(spark.id, "gpu.usage"), "gpuUtil"),
    ...bucket(getMetricHistorySamples(spark.id, "cpu.usage"), "cpuUtil"),
  ];
  const llm = (spark.llmPorts ?? []).map((port) => ({
    points: [
      ...bucket(getMetricHistorySamples(spark.id, `llm:${port}.tps`), "genTps"),
      ...bucket(getMetricHistorySamples(spark.id, `llm:${port}.prefill`), "prefillTps"),
    ] as HistoryLlmPoint[],
  }));
  return tracesFromHistory(points, llm, STEP_MS, now);
}

/** Run `task` for every item with at most `limit` running at once (`task` handles its own errors: one rejection rejects the run). */
export async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

/**
 * The traces to hold after a refresh: this fetch's series for each unit that returned one, the
 * unit's previous series where its own fetch failed (the wall keeps its last good frame), and
 * nothing for a unit that is no longer in the fleet — otherwise a removed unit's series would
 * stay in the map for the lifetime of a wall that is never reloaded.
 */
export function mergeTraces(
  previous: Record<string, KioskTraces>,
  fetched: Record<string, KioskTraces>,
  ids: readonly string[]
): Record<string, KioskTraces> {
  const kept: Record<string, KioskTraces> = {};
  for (const id of ids) {
    const traces = fetched[id] ?? previous[id];
    if (traces) kept[id] = traces;
  }
  return kept;
}

/**
 * 30-minute traces for every unit, refreshed once a minute from the server's metric history
 * so a reloaded wall shows the last half hour at once. A unit whose fetch fails keeps the
 * traces it last had (the wall holds its last good frame); with history off on the server,
 * traces come from this browser's own samples.
 */
export function useKioskTraces(sparks: readonly SparkSnapshot[]): Record<string, KioskTraces> {
  const [traces, setTraces] = useState<Record<string, KioskTraces>>({});
  const ids = sparks.map((s) => s.id).join("\n");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const now = Date.now();
      const next: Record<string, KioskTraces> = {};
      await forEachLimited(sparks, HISTORY_CONCURRENCY, async (spark) => {
        try {
          const h = await getUnitHistory(spark.id, "1h");
          next[spark.id] = h.enabled ? tracesFromHistory(h.points, h.llm, h.stepMs, now) : tracesFromBrowser(spark, now);
        } catch {
          /* keep this unit's previous traces */
        }
      });
      if (!cancelled) setTraces((prev) => mergeTraces(prev, next, sparks.map((s) => s.id)));
    };
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Refetch when the fleet's membership changes, not on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return traces;
}
