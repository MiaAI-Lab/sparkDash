export const TEXT_PROMPTS: string[];
export const STRUCTURAL_PROMPTS: string[];
export const FILL_TO_MAX_SUFFIX: string;

export function withFillToMaxInstruction(prompt: string): string;

export function pickShowcasePrompts(
  type: "structural" | "text" | "mixed",
  count: number
): string[];
