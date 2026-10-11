import { i18next } from "../../i18n";
import type { ShowcasePromptType } from "./showcasePrompts";
import { localizedServerText } from "../../i18n/messages";

const t = i18next.t.bind(i18next);

/** Keep wire status values intact while translating their display labels. */
export function showcaseStatus(status: string): string {
  switch (status) {
    case "pending": return t("showcase.status.pending", "Pending");
    case "running": return t("showcase.status.running", "Running");
    case "streaming": return t("showcase.status.streaming", "Streaming");
    case "completed": return t("showcase.status.completed", "Completed");
    case "cancelled": return t("showcase.status.cancelled", "Cancelled");
    case "error": return t("showcase.status.error", "Error");
    case "failed": return t("showcase.status.failed", "Failed");
    default: return status;
  }
}

export function promptTypeText(id: ShowcasePromptType): { label: string; hint: string } {
  switch (id) {
    case "text": return { label: t("showcase.promptType.text", "Text"), hint: t("showcase.promptType.textHint", "Prose / narrative — no code or structured formats") };
    case "structural": return { label: t("showcase.promptType.structural", "Structural"), hint: t("showcase.promptType.structuralHint", "JSON, HTML, YAML, SQL, schemas, tables, logs") };
    case "mixed": return { label: t("showcase.promptType.mixed", "Mixed"), hint: t("showcase.promptType.mixedHint", "Half structural, half text — interleaved") };
  }
}

/** Re-render our own validation messages on a locale change; preserve external diagnostics. */
export function showcaseError(message: string): string {
  switch (message) {
    case "Spark not found": return t("showcase.text.sparkNotFound", "Spark not found");
    case "Failed to load Spark": return t("showcase.text.failedToLoadSpark", "Failed to load Spark");
    case "Could not copy to clipboard": return t("showcase.text.couldNotCopyToClipboard", "Could not copy to clipboard");
    default: {
      const prompts = /^Use between (\d+) and (\d+) non-empty prompts$/.exec(message);
      return prompts ? t("showcase.text.useBetween0And1NonEmptyPrompts", "Use between {value0} and {value1} non-empty prompts", { value0: Number(prompts[1]), value1: Number(prompts[2]) }) : localizedServerText(message);
    }
  }
}
