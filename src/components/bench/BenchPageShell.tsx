import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { benchId } from "../../constants";
import { BENCH_TYPES, benchTypeById, type BenchType } from "./benchCatalog";
import { SparkChips } from "./SparkChips";
import { useTranslation } from "react-i18next";

interface BenchPageShellProps {
  type: string;
  spark: SparkSnapshot | null;
  sparks: readonly SparkSnapshot[];
  onSelectSpark: (id: string) => void;
  /** Extra controls on the right of the header. */
  tools?: ReactNode;
  /** Show the "Run on" Spark chips here. Pages that fold them into their own target row turn this off. */
  picker?: boolean;
  children: ReactNode;
}

/** Common header for every benchmark page: title and blurb, then a "Run on" Spark picker right under it.
 * A bench that is a sub-page of another bench (Quality compare under Quality) keeps the parent's header
 * and shows the parent and its sub-pages as sub-tabs; the sub line follows the active tab. */
export function BenchPageShell({ type, spark, sparks, onSelectSpark, tools, picker = true, children }: BenchPageShellProps) {
  const { t } = useTranslation("benchmarks");
  const bench = benchTypeById(type);
  const headerBench = (bench?.subPageOf ? benchTypeById(bench.subPageOf) : bench) ?? bench;
  const subTabs = headerBench ? [headerBench, ...BENCH_TYPES.filter((b) => b.subPageOf === headerBench.id)] : [];
  const text = (b: BenchType | null) => {
    switch (b?.id) {
      case "decode": return { label: t("catalog.decode.label"), blurb: t("catalog.decode.blurb") };
      case "prefill": return { label: t("catalog.prefill.label"), blurb: t("catalog.prefill.blurb") };
      case "quality": return { label: t("catalog.quality.label"), blurb: t("catalog.quality.blurb") };
      case "quality-compare": return { label: t("catalog.qualityCompare.label"), blurb: t("catalog.qualityCompare.blurb") };
      case "tool-eval": return { label: t("catalog.toolEval.label"), blurb: t("catalog.toolEval.blurb") };
      default: return null;
    }
  };
  const tabLabel = (b: BenchType) => {
    switch (b.id) {
      case "quality": return t("catalog.quality.tab");
      case "quality-compare": return t("catalog.qualityCompare.tab");
      default: return text(b)?.label ?? b.label;
    }
  };
  const headerText = text(headerBench);
  const activeText = text(bench);
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t("page.benchmarks")}{headerBench ? ` · ${headerBench.family === "sparkDash" ? "sparkDash" : t("catalog.toolEval.family")}` : ""}</div>
          <h1>{headerText?.label ?? t("page.benchmark")}</h1>
          {activeText ? <p className="page-head__sub">{activeText.blurb}</p> : null}
        </div>
        <div className="page-head__tools">
          {tools}
        </div>
      </div>
      {subTabs.length > 1 ? (
        <div className="bench-subtabs" role="group" aria-label={t("quality.subTabsAria")}>
          {subTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={tab.id === bench?.id}
              className={`bench-subtabs__tab ${tab.id === bench?.id ? "is-active" : ""}`}
              onClick={() => window.dispatchEvent(new CustomEvent("sparkdash:navigate", { detail: benchId(tab.id) }))}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>
      ) : null}
      {picker ? (
        <div className="bench-runon">
          <span className="eyebrow">{t("page.runOn")}</span>
          {sparks.length === 0 ? <span className="bench-runon__none">{t("page.noSparks")}</span> : null}
          <SparkChips sparks={sparks} activeId={spark?.id ?? null} onSelect={onSelectSpark} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
