export const PREFILL_CONTEXT_SIZES: number[];
export const PREFILL_DEFAULT_CONTEXT_SIZES: number[];
export const PREFILL_MIN_CONTEXT_SIZE: number;
export const PREFILL_MAX_CONTEXT_SIZE: number;
export function prefillCeilingFor(contextLength: number | null | undefined): number;
export function parseContextSize(raw: unknown, maxTokens?: number): number | null;
export function formatContextSize(tokens: number): string;
