export const DIVERGENCE_DRIFT_CHARS: number[];
export const DIVERGENCE_EDIT_CHARS: number;

export interface DivergenceLoop {
  loop: boolean;
  cycle: number | null;
  tailShare: number;
}

export function detectLoop(text: string, opts?: { minCycles?: number; minTailShare?: number }): DivergenceLoop;
export function commonPrefixChars(a: string, b: string): number;
export function editDistanceNorm(a: string, b: string, cap?: number): number;

export interface DivergenceRates {
  rows: number;
  terminatedPct: number | null;
  loops: number;
  loopPct: number | null;
  jsonValidPct: number | null;
  jsonSchemaPct: number | null;
  toolOkPct: number | null;
  meanChars: number | null;
  meanTokens: number | null;
}
export function divergenceRates(rows: ReadonlyArray<object>): DivergenceRates;

export interface DivergencePair {
  id: string;
  kind: string;
  identical: boolean;
  firstDivergence: number | null;
  editNorm: number;
  lenRatio: number | null;
  charsA: number;
  charsB: number;
  loopA: boolean;
  loopB: boolean;
  terminatedA: boolean;
  terminatedB: boolean;
  drift: boolean[] | null;
}

export interface DivergenceCompare {
  paired: number;
  identical: number;
  identicalPct: number | null;
  medianFirstDivergence: number | null;
  meanEditNorm: number;
  meanLenRatio: number | null;
  loopsA: number;
  loopsB: number;
  terminatedA: number;
  terminatedB: number;
  drift: Array<{ chars: number; identicalPct: number | null; paired: number }>;
  kinds: Record<string, { paired: number; identicalPct: number | null; medianFirstDivergence: number | null; meanEditNorm: number | null }>;
  pairs: DivergencePair[];
}

export function compareDivergence(
  a: { results?: { items?: ReadonlyArray<object> } | null } | null,
  b: { results?: { items?: ReadonlyArray<object> } | null } | null
): DivergenceCompare | null;
