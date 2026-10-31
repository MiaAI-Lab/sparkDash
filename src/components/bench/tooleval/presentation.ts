import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * Explicit, optional presentation bindings for Tool Eval's pure helpers.
 * Components pass i18n's `t` bound to toolMessages; omitting it preserves the
 * historical English output for API consumers and existing pure tests.
 */
export type ToolMessage = (key: string, values?: Record<string, string | number>) => string;

export interface ToolEvalPresentation {
  t: ToolMessage;
}

export const message = (
  presentation: ToolEvalPresentation | undefined,
  key: string,
  fallback: string,
  values?: Record<string, string | number>,
): string => presentation ? presentation.t(key, values) : fallback;

/** Bind only the finite helper vocabulary; i18next owns interpolation. */
export function useToolEvalPresentation(): ToolEvalPresentation {
  const { t } = useTranslation("toolMessages");
  return useMemo(() => ({ t: (key: string, values?: Record<string, string | number>) => {
    switch (key) {
      case "status.running": return t("status.running", values);
      case "status.unwatched": return t("status.unwatched", values);
      case "status.completed": return t("status.completed", values);
      case "status.failed": return t("status.failed", values);
      case "status.stopped": return t("status.stopped", values);
      case "status.gone": return t("status.gone", values);
      case "tier.excellent": return t("tier.excellent", values);
      case "tier.good": return t("tier.good", values);
      case "tier.adequate": return t("tier.adequate", values);
      case "tier.weak": return t("tier.weak", values);
      case "tier.poor": return t("tier.poor", values);
      case "error.noServer": return t("error.noServer", values);
      case "error.connectionFailed": return t("error.connectionFailed", values);
      case "error.noModels": return t("error.noModels", values);
      case "error.authFailed": return t("error.authFailed", values);
      case "error.modelNotFound": return t("error.modelNotFound", values);
      case "note.toolChoice": return t("note.toolChoice", values);
      case "note.excluded": return t("note.excluded", values);
      case "validation.number": return t("validation.number", values);
      case "validation.whole": return t("validation.whole", values);
      case "validation.atLeast": return t("validation.atLeast", values);
      case "validation.atMost": return t("validation.atMost", values);
      case "validation.oneOf": return t("validation.oneOf", values);
      case "validation.tooLong": return t("validation.tooLong", values);
      case "validation.invalidFormat": return t("validation.invalidFormat", values);
      case "validation.tooMany": return t("validation.tooMany", values);
      case "validation.invalidItem": return t("validation.invalidItem", values);
      case "validation.invalidEntry": return t("validation.invalidEntry", values);
      case "validation.absolutePath": return t("validation.absolutePath", values);
      case "validation.noParent": return t("validation.noParent", values);
      case "validation.urlProtocol": return t("validation.urlProtocol", values);
      case "validation.urlCredentials": return t("validation.urlCredentials", values);
      case "validation.urlInvalid": return t("validation.urlInvalid", values);
      case "validation.jsonObject": return t("validation.jsonObject", values);
      case "validation.jsonInvalid": return t("validation.jsonInvalid", values);
      case "validation.systemPrompt": return t("validation.systemPrompt", values);
      case "validation.pressure": return t("validation.pressure", values);
      case "validation.shortScenarios": return t("validation.shortScenarios", values);
      case "validation.suite": return t("validation.suite", values);
      case "validation.pressureRequired": return t("validation.pressureRequired", values);
      case "compare.score": return t("compare.score", values);
      case "compare.deployability": return t("compare.deployability", values);
      case "compare.responsiveness": return t("compare.responsiveness", values);
      case "compare.passed": return t("compare.passed", values);
      case "compare.partial": return t("compare.partial", values);
      case "compare.failed": return t("compare.failed", values);
      case "compare.safety": return t("compare.safety", values);
      case "compare.differentType": return t("compare.differentType", values);
      case "compare.models": return t("compare.models", values);
      case "compare.endpoints": return t("compare.endpoints", values);
      case "compare.options": return t("compare.options", values);
      case "validation.byteLimit": return t("validation.byteLimit", values);
      default: return key;
    }
  } }), [t]);
}
