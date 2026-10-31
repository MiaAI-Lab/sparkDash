import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../../api/types";
import { formatContextSize } from "../../../shared/prefillBench.js";
import { decodeBenchSamplingLabel } from "../../SparkPage/decodeSampling";

/** One line of a bench page's run-history table. */
export interface HistoryRow {
  id: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Run label (quality) or the bench's own shape, e.g. "×1, 2, 4". */
  label: string;
  model: string | null;
  /** Endpoint port the run used, when the history spans several (quality). */
  port?: number | null;
  /** The number to compare runs by, already formatted. */
  headline: string;
  /** Secondary facts for the same run. */
  detail: string;
}

export interface BenchmarkHistoryLabels {
  peakAt: string;
  streamAtOne: string;
  startContext: string;
  bestAt: string;
  category: string;
  categories: string;
}

const DEFAULT_LABELS: BenchmarkHistoryLabels = {
  peakAt: "peak at", streamAtOne: "/stream at ×1", startContext: "start ctx", bestAt: "best at", category: "category", categories: "categories",
};

function aggregate(r: DecodeBenchJob["results"][number]): number {
  return r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
}

/** Peak aggregate decode tok/s over the levels that produced tokens. */
export function decodeHistoryRow(job: DecodeBenchJob, labels: BenchmarkHistoryLabels = DEFAULT_LABELS): HistoryRow {
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
      best ? `${labels.peakAt} ×${best.concurrency}` : null,
      single ? `${single.meanDecodeTps.toFixed(1)}${labels.streamAtOne}` : null,
      decodeBenchSamplingLabel(job.config),
      job.config.contextTokens ? `${formatContextSize(job.config.contextTokens)} ${labels.startContext}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Fastest prefill tok/s over the context sizes that completed. */
export function prefillHistoryRow(job: PrefillBenchJob, labels: BenchmarkHistoryLabels = DEFAULT_LABELS): HistoryRow {
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
    detail: best ? `${labels.bestAt} ${formatContextSize(best.targetTokens)}` : "",
  };
}

export function qualityHistoryRow(job: QualityBenchJob, labels: BenchmarkHistoryLabels = DEFAULT_LABELS): HistoryRow {
  const overall = job.results?.overallPct;
  const cats = Object.keys(job.results?.categories ?? {}).length;
  return {
    id: job.benchId,
    startedAt: job.startedAt,
    status: job.status,
    label: job.config.label || "—",
    model: job.config.modelId ?? null,
    port: Number.isInteger(job.config.port) ? job.config.port : null,
    headline: overall == null ? "—" : `${overall.toFixed(1)}%`,
    detail: cats ? `${cats} ${cats === 1 ? labels.category : labels.categories}` : "",
  };
}
