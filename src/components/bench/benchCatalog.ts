import { t } from "../../i18n";
/**
 * Every benchmark sparkDash has a page for (sidebar "Benchmarks" section).
 * Throughput, speculative decoding, context pressure, needle and decision-model runs are not
 * separate pages: their options live under Tool Eval > Advanced > "Advanced / all options".
 * `engine` says what runs it: sparkDash's own benches (decode / prefill / quality) or the
 * external tool-eval-bench CLI executed on the Spark.
 */
export type BenchEngine = "sparkdash" | "tool-eval";

export interface BenchType {
  id: string;
  label: string;
  /** One line shown under the page title and in the palette. */
  blurb: string;
  engine: BenchEngine;
  /** Sidebar sub-heading it sits under. */
  family: "sparkDash" | "Tool Eval Bench";
}

export const BENCH_TYPES: readonly BenchType[] = [
  { id: "decode", label: t("bench.name_decode"), blurb: t("bench.blurb_decode"), engine: "sparkdash", family: "sparkDash" },
  { id: "prefill", label: t("bench.name_prefill"), blurb: t("bench.blurb_prefill"), engine: "sparkdash", family: "sparkDash" },
  { id: "quality", label: t("bench.name_quality"), blurb: t("bench.blurb_quality"), engine: "sparkdash", family: "sparkDash" },
  { id: "tool-eval", label: t("bench.name_tooleval"), blurb: t("bench.blurb_tooleval"), engine: "tool-eval", family: "Tool Eval Bench" },
];

const BY_ID = new Map(BENCH_TYPES.map((b) => [b.id, b]));

export function benchTypeById(id: string | null | undefined): BenchType | null {
  return (id && BY_ID.get(id)) || null;
}

/** localStorage key remembering which Spark the benchmark pages act on. */
export const BENCH_SPARK_KEY = "sparkdash.bench.spark";
