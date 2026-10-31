import { useTranslation } from "react-i18next";
import type { ShowcasePromptType } from "./showcasePrompts";

/** Known product labels only; unknown statuses and diagnostics remain verbatim. */
export function useShowcaseText() {
  const { t } = useTranslation("showcase");
  function status(value: string): string {
    switch (value) {
      case "pending": return t("status.pending");
      case "running": return t("status.running");
      case "streaming": return t("status.streaming");
      case "completed": return t("status.completed");
      case "cancelled": return t("status.cancelled");
      case "error": return t("status.error");
      case "failed": return t("status.failed");
      default: return value;
    }
  }
  function promptType(id: ShowcasePromptType): { label: string; hint: string } {
    switch (id) {
      case "text": return { label: t("promptType.text"), hint: t("promptType.textHint") };
      case "structural": return { label: t("promptType.structural"), hint: t("promptType.structuralHint") };
      case "mixed": return { label: t("promptType.mixed"), hint: t("promptType.mixedHint") };
    }
  }
  function error(message: string): string {
    switch (message) {
      case "Spark not found": return t("text.sparkNotFound");
      case "Failed to load Spark": return t("text.failedToLoadSpark");
      case "Could not copy to clipboard": return t("text.couldNotCopyToClipboard");
    }
    const promptCount = message.length < 100 ? /^Use between (\d+) and (\d+) non-empty prompts$/.exec(message) : null;
    return promptCount ? t("text.promptCountError", { min: promptCount[1], max: promptCount[2] }) : message;
  }
  return { status, promptType, error };
}
