import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { benchTypeById } from "./benchCatalog";
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

/** Common header for every benchmark page: title and blurb, then a "Run on" Spark picker right under it. */
export function BenchPageShell({ type, spark, sparks, onSelectSpark, tools, picker = true, children }: BenchPageShellProps) {
  const { t } = useTranslation("benchmarks");
  const bench = benchTypeById(type);
  const benchText = (() => {
    switch (bench?.id) {
      case "decode": return { label: t("catalog.decode.label"), blurb: t("catalog.decode.blurb") };
      case "prefill": return { label: t("catalog.prefill.label"), blurb: t("catalog.prefill.blurb") };
      case "quality": return { label: t("catalog.quality.label"), blurb: t("catalog.quality.blurb") };
      case "tool-eval": return { label: t("catalog.toolEval.label"), blurb: t("catalog.toolEval.blurb") };
      default: return null;
    }
  })();
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t("page.benchmarks")}{bench ? ` · ${bench.family === "sparkDash" ? "sparkDash" : t("catalog.toolEval.family")}` : ""}</div>
          <h1>{benchText?.label ?? t("page.benchmark")}</h1>
          {benchText ? <p className="page-head__sub">{benchText.blurb}</p> : null}
        </div>
        <div className="page-head__tools">
          {tools}
        </div>
      </div>
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
