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
  { id: "decode", label: "Decode", blurb: "Generation speed (tokens/s) at rising concurrency.", engine: "sparkdash", family: "sparkDash" },
  { id: "prefill", label: "Prefill", blurb: "Prompt processing speed and time to first token across context sizes.", engine: "sparkdash", family: "sparkDash" },
  { id: "quality", label: "Quality", blurb: "A fixed, seeded quality suite to compare models, quantisations and KV-cache formats.", engine: "sparkdash", family: "sparkDash" },
  { id: "tool-eval", label: "Tool Eval Bench", blurb: "Tool-calling quality across 69 deterministic scenarios (selection, parameters, multi-step, safety).", engine: "tool-eval", family: "Tool Eval Bench" },
];

const BY_ID = new Map(BENCH_TYPES.map((b) => [b.id, b]));

export function benchTypeById(id: string | null | undefined): BenchType | null {
  return (id && BY_ID.get(id)) || null;
}

/** localStorage key remembering which Spark the benchmark pages act on. */
export const BENCH_SPARK_KEY = "sparkdash.bench.spark";
