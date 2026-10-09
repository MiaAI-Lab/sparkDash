export const CONTEXT_TOKEN_HEADROOM: number;
export const QUALITY_LONG_RESERVE_TOKENS: number;
export const PREFILL_RESERVE_TOKENS: number;
export function sizeFitsContext(
  size: number,
  contextLength: number | null | undefined,
  reserveTokens: number,
  headroom?: number
): boolean;
export function qualityLongFitsContext(size: number, contextLength: number | null | undefined): boolean;
export function prefillFitsContext(size: number, contextLength: number | null | undefined): boolean;
