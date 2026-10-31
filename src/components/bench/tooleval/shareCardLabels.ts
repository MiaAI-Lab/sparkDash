import { useTranslation } from "react-i18next";
import type { ShareCardLabels } from "../../SparkPage/benchShareCard";
import { useToolEvalCategories } from "./labels";
import { useToolEvalPresentation } from "./presentation";

/** Caller hook for localized share-card chrome; raw run/model/safety data is never translated here. */
export function useShareCardLabels(): ShareCardLabels {
  const { t } = useTranslation("shareCards");
  const categories = useToolEvalCategories();
  const presentation = useToolEvalPresentation();
  return {
    completed: t("completed"), running: t("running"), failed: t("failed"), cancelled: t("cancelled"),
    decodeTitle: t("decodeTitle"), prefillTitle: t("prefillTitle"), qualityTitle: t("qualityBenchmark"),
    load: t("load"), aggregate: t("aggregate"), stream: t("stream"), context: t("context"), prefill: t("prefill"), versusOther: t("versusOther"),
    qualityBenchmark: t("qualityBenchmark"), overall: t("overall"), unknownModel: t("unknownModel"), same: t("same"), pts: t("pts"),
    toolEvalBench: t("toolEvalBench"), toolEvalComparison: t("toolEvalComparison"), score: t("score"), category: t("category"),
    scenarioOutcomes: t("scenarioOutcomes"), safetyWarnings: (count) => t("safetyWarnings", { count }), more: (count) => t("more", { count }),
    pass: t("pass"), fail: t("fail"), partial: t("partial"), other: t("other"), scoreChange: t("scoreChange"), runBVsA: t("runBVsA"),
    scenarioChanges: t("scenarioChanges"), better: t("better"), worse: t("worse"), unchanged: (count) => t("unchanged", { count }), runA: t("runA"), runB: t("runB"), change: t("change"),
    decodeDetail: (ttft, ok, total) => t("decodeDetail", { ttft, ok, total }),
    decodeMeta: (prompt, tokens, sampling, context, concurrency, duration) => t("decodeMeta", { prompt, tokens, sampling, context: context ? ` · ${context} start ctx` : "", concurrency: concurrency || "—", duration: duration ? ` · ${duration}` : "" }),
    decodeLegend: t("decodeLegend"), prefillFailed: t("prefillFailed"),
    prefillDetail: (ttft, tokens, flags) => t("prefillDetail", { ttft, tokens, flags: flags ? ` · ${flags}` : "" }),
    samples: (actual, requested) => t("samples", { actual, requested }), lowConfidence: t("lowConfidence"),
    prefillMeta: (contexts, duration) => t("prefillMeta", { contexts: contexts || "—", duration: duration ? ` · ${duration}` : "" }), prefillLegend: t("prefillLegend"),
    qualityDetail: (passed, scored, errors) => t("qualityDetail", { passed, scored, errors: errors ? ` · ${errors} ${errors === 1 ? t("error") : t("errors")}` : "" }),
    qualitySummary: (categories, items, duration) => t("qualitySummary", { categories, items, duration: duration ? ` · ${duration}` : "" }),
    qualityMeta: (overall, runLabel, duration) => t("qualityMeta", { overall, runLabel: runLabel ? ` · ${runLabel}` : "", duration: duration ? ` · ${duration}` : "" }), qualityLegend: t("qualityLegend"),
    presentation, categoryName: (id, fallback) => categories[id] || fallback,
    deployability: t("deployability"), responsiveness: t("responsiveness"), scenariosPassed: t("scenariosPassed"),
    points: (value, max) => t("points", { value, max }), scenarioSummary: (total, duration) => t("scenarioSummary", { total, duration: duration ? ` · ${duration}` : "" }),
    safetyChip: (count) => t("safetyChip", { count }), scoreMeta: (score, rating, summary) => t("scoreMeta", { score, rating: rating ? ` · ${rating}` : "", summary }), scoreLegend: t("scoreLegend"),
    runHeading: (tag, spark, label) => t("runHeading", { tag, spark: spark ? ` · ${spark}` : "", label }), sideSummary: (pass, partial) => t("sideSummary", { pass, partial }),
    differentSetup: t("differentSetup"), sameSetup: t("sameSetup"), comparisonMeta: (score, a, b) => t("comparisonMeta", { score, a: a || t("runAFallback"), b: b || t("runBFallback") }), comparisonLegend: t("comparisonLegend"), caveat: (text, extra) => t("caveat", { text, extra: extra ? ` (+${extra} ${t("moreWord")})` : "" }),
  };
}
