export const TEXT_PROMPTS: string[];
export const STRUCTURAL_PROMPTS: string[];
export const FILL_TO_MAX_SUFFIX: string;
export const DECODE_STRUCTURED_PROMPT: string;
export const DECODE_PROSE_PROMPT: string;
export const DECODE_CODE_PROMPT: string;
export const DECODE_CODE_TASKS: string[];
export const DECODE_CODE_WARMUP_PROMPT: string;
export const DECODE_JSON_PROMPT: string;
export const DECODE_BENCH_TYPES: readonly ["structured", "prose", "code", "json"];
export const DECODE_BENCH_DEFAULT_TYPE: "structured";
export const DECODE_BENCH_PROMPTS: Record<DecodeBenchPromptType, string>;
export const DECODE_BENCH_TYPE_META: {
  id: DecodeBenchPromptType;
  label: string;
  hint: string;
}[];

export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

export function withFillToMaxInstruction(prompt: string): string;

export function pickShowcasePrompts(
  type: "structural" | "text" | "mixed",
  count: number
): string[];

export function normalizeDecodeBenchType(type: unknown): DecodeBenchPromptType;
export function decodeBenchPromptForType(type: unknown): string;
export function decodeBenchTypeLabel(type: unknown): string;
export function pickDecodeBenchPrompts(
  count: number,
  type?: unknown
): string[];
