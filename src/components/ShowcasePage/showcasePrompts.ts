/**
 * Showcase prompt catalogs by workload type.
 * Canonical lists live in src/shared/llmPrompts.js (also used by Decode bench).
 */

export type ShowcasePromptType = "structural" | "text" | "mixed";

export const PROMPT_TYPES: { id: ShowcasePromptType; label: string; hint: string }[] = [
  {
    id: "text",
    label: "Text",
    hint: "Prose / narrative — no code or structured formats",
  },
  {
    id: "structural",
    label: "Structural",
    hint: "JSON, HTML, YAML, SQL, schemas, tables, logs",
  },
  {
    id: "mixed",
    label: "Mixed",
    hint: "Half structural, half text — interleaved",
  },
];

export {
  TEXT_PROMPTS,
  STRUCTURAL_PROMPTS,
  pickShowcasePrompts,
  withFillToMaxInstruction,
} from "../../shared/llmPrompts.js";
