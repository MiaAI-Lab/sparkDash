import { useTranslation } from "react-i18next";
import type { QualityCategory } from "../../api/types";

export function useQualityCategoryLabels(): Record<QualityCategory, string> {
  const { t } = useTranslation("benchmarks");
  return {
    qa: t("quality.categoryNames.qa"),
    reason: t("quality.categoryNames.reason"),
    arith: t("quality.categoryNames.arith"),
    track: t("quality.categoryNames.track"),
    gsm8k: t("quality.categoryNames.gsm8k"),
    mmlupro: t("quality.categoryNames.mmlupro"),
    math500: t("quality.categoryNames.math500"),
    mmlu: t("quality.categoryNames.mmlu"),
    follow: t("quality.categoryNames.follow"),
    long: t("quality.categoryNames.long"),
    tokenizer: t("quality.categoryNames.tokenizer"),
    fidelity: t("quality.categoryNames.fidelity"),
    divergence: t("quality.categoryNames.divergence"),
  };
}

export function useQualityCategoryHints(): Record<QualityCategory, string> {
  const { t } = useTranslation("benchmarks");
  return {
    qa: t("quality.categoryHints.qa"),
    reason: t("quality.categoryHints.reason"),
    arith: t("quality.categoryHints.arith"),
    track: t("quality.categoryHints.track"),
    gsm8k: t("quality.categoryHints.gsm8k"),
    mmlupro: t("quality.categoryHints.mmlupro"),
    math500: t("quality.categoryHints.math500"),
    mmlu: t("quality.categoryHints.mmlu"),
    follow: t("quality.categoryHints.follow"),
    long: t("quality.categoryHints.long"),
    tokenizer: t("quality.categoryHints.tokenizer"),
    fidelity: t("quality.categoryHints.fidelity"),
    divergence: t("quality.categoryHints.divergence"),
  };
}
