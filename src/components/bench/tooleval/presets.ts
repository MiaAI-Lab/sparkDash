import { t } from "../../../i18n";
import type { FieldValue } from "./options";

export interface Preset {
  id: string;
  label: string;
  help: string;
  values: Record<string, FieldValue>;
  /** Accuracy page only: which suites to tick. */
  suites?: string[];
}

/** One-click starting points per page type. Applied on top of the page's defaults. */
export const PRESETS: Record<string, Preset[]> = {
  "tool-eval": [
    { id: "quick", label: t("presets.quick_check"), help: t("presets.quick_check_help"), values: { short: true } },
    { id: "full", label: t("presets.full"), help: t("presets.full_help"), values: {} },
    { id: "hard", label: t("presets.hard_only"), help: t("presets.hard_only_help"), values: { "hardmode-only": true } },
    { id: "repro", label: t("presets.reproducible"), help: t("presets.reproducible_help"), values: { temperature: "0", seed: "42" } },
    { id: "thinking", label: t("presets.thinking_model"), help: t("presets.thinking_help"), values: { "no-think": true, timeout: "120" } },
  ],
  throughput: [
    { id: "quick", label: t("presets.quick"), help: t("presets.quick_help"), values: { pp: "512", tg: "64", depth: "0", concurrency: "1", "benchy-runs": "1" } },
    { id: "standard", label: t("presets.standard"), help: t("presets.standard_help"), values: {} },
    { id: "deep", label: "Deep context", help: "Up to 32k of context and 8 concurrent requests.", values: { depth: "0,4096,8192,16384,32768", concurrency: "1,2,4,8" } },
  ],
  "spec-decode": [
    { id: "quick", label: "Quick", help: "One prompt type, one run per cell.", values: { "spec-runs": "1", "spec-prompts": "filler" } },
    { id: "standard", label: "Standard", help: "The tool's defaults.", values: {} },
    { id: "code", label: "Code and structured", help: "The prompt types where speculation helps most.", values: { "spec-prompts": "code,structured" } },
  ],
  "context-pressure": [
    { id: "single", label: "Single level (75%)", help: "Core scenarios with the context 75% full.", values: { "context-pressure": "0.75", short: true } },
    { id: "sweep", label: "Sweep 50–100%", help: "Core scenarios at five pressure levels.", values: { "context-pressure-sweep": "0.5-1.0", "sweep-steps": "5", short: true } },
    { id: "fine", label: "Fine sweep", help: "Ten levels from 10% to 100% (long).", values: { "context-pressure-sweep": "0.1-1.0", "sweep-steps": "10", short: true } },
  ],
  accuracy: [
    { id: "quick", label: "Quick", help: "A small sample of each suite.", values: { "gsm8k-limit": "50", "mmlu-limit": "100", "ifeval-limit": "100" }, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "standard", label: "Standard", help: "The tool's default question limits.", values: {}, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "full", label: "Full datasets", help: "Every question (slow).", values: { "gsm8k-limit": "0", "mmlu-limit": "0", "ifeval-limit": "0" }, suites: ["gsm8k", "mmlu", "ifeval"] },
    { id: "repro", label: "Reproducible", help: "Fixed seed and shuffled GSM8K.", values: { seed: "42", "gsm8k-shuffle": true }, suites: ["gsm8k", "mmlu", "ifeval"] },
  ],
  needle: [
    { id: "quick", label: "Quick", help: "Three depths and two lengths.", values: { "needle-depths": "3", "needle-lengths": "2" } },
    { id: "standard", label: "Standard", help: "The tool's defaults (5 depths, 4 lengths).", values: {} },
    { id: "thorough", label: "Thorough", help: "Ten depths and eight lengths (long).", values: { "needle-depths": "10", "needle-lengths": "8" } },
  ],
  decision: [{ id: "standard", label: "Default", help: "The tool's defaults.", values: {} }],
};

/** A ready-made run shown as a card in the Simple view. */
export interface SimpleTemplate extends Preset {
  /** Rough size, shown on the card. */
  size?: string;
  /** Rough time, shown on the card. */
  time?: string;
}

/**
 * The Simple view's templates. Tool Eval gets four basics, all with a fixed seed (42) so repeat runs stay comparable; (regular, regular + hard mode, short, hard mode only);
 * the other pages offer their ready presets as templates.
 */
export function simpleTemplates(type: string): SimpleTemplate[] {
  if (type === "tool-eval") {
    return [
      {
        id: "regular",
        label: t("presets.regular_run"),
        help: t("presets.regular_run_help"),
        values: { seed: "42" },
        size: "69 scenarios",
        time: "about 10–20 min",
      },
      {
        id: "regular-hard",
        label: t("presets.regular_hard"),
        help: t("presets.regular_hard_help"),
        values: { hardmode: true, seed: "42" },
        size: "92 scenarios",
        time: "about 15–30 min",
      },
      {
        id: "short",
        label: t("presets.short_run"),
        help: t("presets.short_run_help"),
        values: { short: true, seed: "42" },
        size: "15 scenarios",
        time: "about 2 min",
      },
      {
        id: "hard",
        label: t("presets.hard_only"),
        help: t("presets.hard_only_help2"),
        values: { "hardmode-only": true, seed: "42" },
        size: "23 scenarios",
        time: "about 5–10 min",
      },
    ];
  }
  return (PRESETS[type] ?? []).map((p) => ({ ...p }));
}

/** Where the run points, not how it runs: a custom URL or model never makes a template "custom". */
export const TARGET_KEYS: ReadonlySet<string> = new Set(["base-url", "model"]);

/** Settings the Simple view keeps across templates: the target, and how many trials to repeat. */
export const KEPT_KEYS: ReadonlySet<string> = new Set([...TARGET_KEYS, "trials"]);

const normValue = (v: unknown): string => (Array.isArray(v) ? v.join(" ") : String(v ?? "")).trim();

/** Does the form currently hold exactly this template (and nothing else)? */
export function matchesTemplate(
  state: { values: Record<string, unknown>; extraArgs: string; suites: string[] },
  template: Preset
): boolean {
  if (state.extraArgs.trim()) return false;
  const set = (v: unknown) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.every((x) => !String(x).trim()));
  const keys = new Set([...Object.keys(state.values).filter((k) => set(state.values[k])), ...Object.keys(template.values).filter((k) => set(template.values[k]))]);
  for (const k of KEPT_KEYS) keys.delete(k);
  for (const k of keys) {
    if (set(state.values[k]) !== set(template.values[k])) return false;
    if (normValue(state.values[k]) !== normValue(template.values[k]) && String(state.values[k]) !== String(template.values[k])) return false;
  }
  if (template.suites) {
    const a = [...template.suites].sort().join(",");
    const b = [...state.suites].sort().join(",");
    if (a !== b) return false;
  }
  return true;
}

/** The non-blank KEPT_KEYS values of a form: what survives picking a template or preset. */
export function keptValues(values: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries([...KEPT_KEYS].filter((k) => String(values[k] ?? "").trim()).map((k) => [k, values[k]]));
}
