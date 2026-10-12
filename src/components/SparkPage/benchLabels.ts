import { i18next } from "../../i18n";
import type { QualityCategory } from "../../api/types";
import { normalizeDecodeBenchType } from "../../shared/llmPrompts.js";

// Display labels belong to the UI. Shared prompts, IDs and server metadata
// stay unchanged so selecting a language cannot change a benchmark workload.
export function decodeBenchTypeLabel(type: unknown): string {
  switch (normalizeDecodeBenchType(type)) {
    case "prose": return i18next.t("spark.benchLabels.prose", "Prose");
    case "code": return i18next.t("spark.benchLabels.code", "Code");
    case "json": return i18next.t("spark.benchLabels.json", "JSON");
    default: return i18next.t("spark.benchLabels.structured", "Structured");
  }
}

export function decodeBenchTypeHint(type: unknown): string {
  switch (normalizeDecodeBenchType(type)) {
    case "prose": return i18next.t("spark.benchLabels.proseHint", "Hash-map explanation — lab default bench prompt");
    case "code": return i18next.t("spark.benchLabels.codeHint", "Distinct Python tasks per stream — different prefixes, no comments");
    case "json": return i18next.t("spark.benchLabels.jsonHint", "JSON GPU-metrics catalog — output type only, not guided JSON");
    default: return i18next.t("spark.benchLabels.structuredHint", "Count 1→200, numbers only — lab structured protocol");
  }
}

export function qualityCategoryLabel(category: QualityCategory): string {
  switch (category) {
    case "qa": return i18next.t("spark.benchLabels.qa", "QA");
    case "reason": return i18next.t("spark.benchLabels.reason", "Reasoning");
    case "arith": return i18next.t("spark.benchLabels.arith", "Arithmetic chain");
    case "track": return i18next.t("spark.benchLabels.track", "State tracking");
    case "gsm8k": return i18next.t("spark.benchLabels.gsm8k", "GSM8K");
    case "mmlu": return i18next.t("spark.benchLabels.mmlu", "MMLU");
    case "follow": return i18next.t("spark.benchLabels.follow", "Instruction following");
    case "long": return i18next.t("spark.benchLabels.long", "Long-context recall");
  }
}
