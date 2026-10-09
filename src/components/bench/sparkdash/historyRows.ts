import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";

/** One line of a bench page's run-history table. */
export interface HistoryRow {
  id: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Run label (quality) or the bench's own shape, e.g. "×1, 2, 4". */
  label: string;
  model: string | null;
  /** The number to compare runs by, already formatted. */
  headline: string;
  /** Secondary facts for the same run. */
  detail: string;
}

function aggregate(r: DecodeBenchJob["results"][number]): number {
  return r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
}

/** Peak aggregate decode tok/s over the levels that produced tokens. */
export function decodeHistoryRow(job: DecodeBenchJob): HistoryRow {
  const ok = job.results.filter((r) => r.totalDecodeTokens > 0 || r.totalCompletionTokens > 0);
  const best = ok.reduce<DecodeBenchJob["results"][number] | null>(
    (b, r) => (b == null || aggregate(r) > aggregate(b) ? r : b),
    null
  );
  const single = ok.find((r) => r.concurrency === 1);
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: `×${job.config.concurrencies.join(", ")}`,
    model: job.config.modelId ?? job.results.find((r) => r.model)?.model ?? null,
    headline: best ? `${aggregate(best).toFixed(1)} tok/s` : "—",
    detail: [
      best ? `peak at ×${best.concurrency}` : null,
      single ? `${single.meanDecodeTps.toFixed(1)}/stream at ×1` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Fastest prefill tok/s over the context sizes that completed. */
export function prefillHistoryRow(job: PrefillBenchJob): HistoryRow {
  const ok = job.results.filter((r) => r.prefillTps > 0);
  const best = ok.reduce<PrefillBenchJob["results"][number] | null>(
    (b, r) => (b == null || r.prefillTps > b.prefillTps ? r : b),
    null
  );
  const sizes = job.config.contextSizes;
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: sizes.length ? sizes.map(formatContextSize).join(", ") : "—",
    model: job.config.modelId ?? job.results.find((r) => r.model)?.model ?? null,
    headline: best ? `${best.prefillTps.toFixed(1)} tok/s` : "—",
    detail: best ? `best at ${formatContextSize(best.targetTokens)}` : "",
  };
}

export function qualityHistoryRow(job: QualityBenchJob): HistoryRow {
  const overall = job.results?.overallPct;
  const cats = Object.keys(job.results?.categories ?? {}).length;
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: job.config.label || "—",
    model: job.config.modelId ?? null,
    headline: overall == null ? "—" : `${overall.toFixed(1)}%`,
    detail: cats ? `${cats} categor${cats === 1 ? "y" : "ies"}` : "",
  };
}
