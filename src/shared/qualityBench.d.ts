export type QualityCategoryId = "qa" | "reason" | "arith" | "track" | "gsm8k" | "mmlu" | "follow" | "long";

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

export interface QualityCompareRow {
  category: QualityCategoryId;
  pctA: number | null;
  pctB: number | null;
  paired: number;
  identical: number;
  bothOk: number;
  bothFail: number;
  onlyA: number;
  onlyB: number;
  p: number;
  withinNoise: boolean;
}

export interface QualityComparable {
  results?: {
    categories?: Partial<Record<string, { passed: number; total: number; pct: number | null }>>;
    items?: Array<{ id: string; category: string; ok: boolean; hash?: string | null }>;
  } | null;
}

export function compareQualityRuns(
  a: QualityComparable | null,
  b: QualityComparable | null
): QualityCompareRow[];
