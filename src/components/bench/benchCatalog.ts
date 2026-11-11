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
  /** Set when this bench is a sub-page of another bench: it opens from that bench's sub-tabs and is left out of the nav lists. */
  subPageOf?: string;
}

export const BENCH_TYPES: readonly BenchType[] = [
  { id: "decode", label: "Decode", blurb: "Generation speed (tokens/s) at rising concurrency.", engine: "sparkdash", family: "sparkDash" },
  { id: "prefill", label: "Prefill", blurb: "Prompt processing speed and time to first token across context sizes.", engine: "sparkdash", family: "sparkDash" },
  { id: "quality", label: "Quality", blurb: "A fixed, seeded quality suite to compare models, quantisations and KV-cache formats.", engine: "sparkdash", family: "sparkDash" },
  { id: "quality-compare", label: "Quality compare", blurb: "Any two saved quality runs side by side, from any units: where one build is better, in plain words and in numbers.", engine: "sparkdash", family: "sparkDash", subPageOf: "quality" },
  { id: "tool-eval", label: "Tool Eval Bench", blurb: "Tool-calling quality across 69 deterministic scenarios (selection, parameters, multi-step, safety).", engine: "tool-eval", family: "Tool Eval Bench" },
];

const BY_ID = new Map(BENCH_TYPES.map((b) => [b.id, b]));

export function benchTypeById(id: string | null | undefined): BenchType | null {
  return (id && BY_ID.get(id)) || null;
}

/** Bench types listed in the sidebars and the command palette; a bench that is a sub-page of another bench is left out. */
export const NAV_BENCH_TYPES: readonly BenchType[] = BENCH_TYPES.filter((b) => !b.subPageOf);

/** True when this nav entry reads as active: the bench itself or one of its sub-pages is open. */
export function benchNavActive(bench: BenchType, benchType: string | null | undefined): boolean {
  return benchType === bench.id || (benchType != null && benchTypeById(benchType)?.subPageOf === bench.id);
}

/** localStorage key remembering which Spark the benchmark pages act on. */
export const BENCH_SPARK_KEY = "sparkdash.bench.spark";
