export type QualityCategoryId = "qa" | "reason" | "arith" | "track" | "gsm8k" | "mmlu" | "mmlupro" | "math500" | "follow" | "long" | "tokenizer" | "fidelity" | "divergence";

export const QUALITY_CATEGORIES: QualityCategoryId[];
export const QUALITY_DEFAULT_CATEGORIES: QualityCategoryId[];
export const QUALITY_CATEGORY_LABELS: Record<QualityCategoryId, string>;
export const QUALITY_LONG_SIZES: number[];
export const QUALITY_DEFAULT_LONG_SIZES: number[];
export const QUALITY_DEFAULT_LONG_ITEMS: number;
export const QUALITY_MAX_LONG_ITEMS: number;
export const QUALITY_DEFAULT_CONCURRENCY: number;
export const QUALITY_MAX_CONCURRENCY: number;
export const QUALITY_LABEL_MAX: number;

export function mcnemarExactP(b: number, c: number): number;

/** Why a row is left out of a category's score (scoring v3), or null when it counts. */
export declare function qualityRowUnscored(
  row: { ok?: boolean; error?: string | null; finishReason?: string | null; disputed?: boolean | string | null } | null | undefined
): "error" | "truncated" | "disputed" | null;

export interface QualityCompareRow {
  category: QualityCategoryId;
  pctA: number | null;
  pctB: number | null;
  paired: number;
  /** Pairs left out because either run hit a request error / timeout. */
  excluded: number;
  identical: number;
  bothOk: number;
  bothFail: number;
  onlyA: number;
  onlyB: number;
  p: number;
  withinNoise: boolean;
  /** WP1: coverage (scored ÷ total) and budgeted success (passed ÷ ran) of each run; null on old runs. */
  coverageA: number | null;
  coverageB: number | null;
  budgetedA: number | null;
  budgetedB: number | null;
  /** Pass rates over the paired items only, and their difference in points with a paired-bootstrap 95 % CI. */
  pairedPctA: number | null;
  pairedPctB: number | null;
  deltaPts: number | null;
  deltaCi: [number, number] | null;
  /** The delta's CI sits inside ±margin: equivalent within the declared margin. */
  equivalent: boolean;
  margin: number;
  /** Holm-adjusted p across the categories of this comparison. */
  pAdj: number;
  verdict: "same" | "insufficient" | "different";
}

export interface QualityCompareOverall {
  categories: number;
  paired: number;
  excluded: number;
  onlyA: number;
  onlyB: number;
  p: number;
  deltaPts: number | null;
  deltaCi: [number, number] | null;
  equivalent: boolean;
  margin: number;
}

export function qualityFamilyKey(modelId: string | null | undefined): string;
export const QUALITY_PROFILES: Record<"default" | "full" | "fidelity", string[]>;
export const QUALITY_EQUIVALENCE_MARGIN_PTS: number;
export function qualityProfile(categories: readonly string[] | null | undefined): "default" | "full" | "fidelity" | "custom";
export function wilsonInterval(k: number, n: number, z?: number): [number, number] | null;
export function overallBootstrapCi(
  rows: ReadonlyArray<{ category: string; ok?: boolean; error?: string | null; finishReason?: string | null; disputed?: boolean }>,
  onlyCategories?: readonly string[] | null
): [number, number] | null;
export function longKeysBootstrapCi(
  rows: ReadonlyArray<{ category: string; longCorrect?: number; longTotal?: number; error?: string | null }>
): [number, number] | null;
export function pairedDeltaBootstrapCi(pairsByCategory: Record<string, Array<[number, number]>>): [number, number] | null;
export function holmAdjust(ps: readonly number[]): number[];
export function qualityIntervals(rows: ReadonlyArray<object>): { overallCi: [number, number] | null; keysCi: [number, number] | null; gradeCi: Record<string, [number, number] | null> };
export function compareQualityOverall(
  a: QualityComparable | null,
  b: QualityComparable | null,
  opts?: { margin?: number }
): QualityCompareOverall | null;

export interface QualityComparable {
  config?: { suiteVersion?: number; scoringVersion?: number } | null;
  results?: {
    categories?: Partial<
      Record<string, { passed: number; total: number; pct: number | null; coveragePct?: number | null; budgetedPct?: number | null }>
    >;
    items?: Array<{ id: string; category: string; ok: boolean; error?: string | null; hash?: string | null }>;
  } | null;
}

export function compareQualityRuns(
  a: QualityComparable | null,
  b: QualityComparable | null,
  opts?: { margin?: number }
): QualityCompareRow[];

export function checkQualityComparable(
  a: QualityComparable | null,
  b: QualityComparable | null
): { ok: boolean; reason: string | null };

export function engineRecordLine(
  rec:
    | {
        backend?: string | null;
        engineVersion?: string | null;
        quantization?: { quant_method?: string; bits?: number; scope?: string } | null;
        kvCacheDtype?: string | null;
        tensorParallel?: number | null;
        speculative?: { enabled?: boolean; kind?: string } | null;
        checkpointSha256?: string | null;
      }
    | null
    | undefined
): string;
export const QUALITY_GENERATION_CATEGORIES: QualityCategoryId[];
export const QUALITY_GRADED_CATEGORIES: QualityCategoryId[];
export function gradedBootstrapCi(
  rows: ReadonlyArray<{ category: string; gradeCorrect?: number; gradeTotal?: number; error?: string | null }>,
  category: string
): [number, number] | null;
