import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { benchTypeById } from "./benchCatalog";
import { SparkChips } from "./SparkChips";
import { useTranslation } from "react-i18next";
import { localizeBenchType } from "./benchCatalog";

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
  const { t } = useTranslation();
  const rawBench = benchTypeById(type);
  const bench = rawBench ? localizeBenchType(rawBench, t) : null;
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t("bench.page.benchmarks", "Benchmarks")}{bench ? ` · ${bench.family}` : ""}</div>
          <h1>{bench?.label ?? t("bench.page.benchmark", "Benchmark")}</h1>
          {bench ? <p className="page-head__sub">{bench.blurb}</p> : null}
        </div>
        <div className="page-head__tools">
          {tools}
        </div>
      </div>
      {picker ? (
        <div className="bench-runon">
          <span className="eyebrow">{t("bench.page.runOn", "Run on")}</span>
          {sparks.length === 0 ? <span className="bench-runon__none">{t("bench.page.noSparks", "No Sparks available")}</span> : null}
          <SparkChips sparks={sparks} activeId={spark?.id ?? null} onSelect={onSelectSpark} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
