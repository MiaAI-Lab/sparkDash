import { useTranslation } from "react-i18next";
import { useMemo } from "react";

export interface BenchLabel {
  label: string;
  blurb: string;
}

/** Localized navigation labels for the fixed benchmark catalog. */
export function useBenchLabels(): Record<string, BenchLabel> {
  const { t } = useTranslation("shell");
  return useMemo(() => ({
    decode: { label: t("bench.decode.label"), blurb: t("bench.decode.blurb") },
    prefill: { label: t("bench.prefill.label"), blurb: t("bench.prefill.blurb") },
    quality: { label: t("bench.quality.label"), blurb: t("bench.quality.blurb") },
    "tool-eval": { label: t("bench.toolEval.label"), blurb: t("bench.toolEval.blurb") },
  }), [t]);
}
