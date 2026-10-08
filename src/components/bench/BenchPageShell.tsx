import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { benchTypeById } from "./benchCatalog";
import { SparkChips } from "./SparkChips";

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
  const bench = benchTypeById(type);
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Benchmarks{bench ? ` · ${bench.family}` : ""}</div>
          <h1>{bench?.label ?? "Benchmark"}</h1>
          {bench ? <p className="page-head__sub">{bench.blurb}</p> : null}
        </div>
        <div className="page-head__tools">
          {tools}
        </div>
      </div>
      {picker ? (
        <div className="bench-runon">
          <span className="eyebrow">Run on</span>
          {sparks.length === 0 ? <span className="bench-runon__none">No Sparks available</span> : null}
          <SparkChips sparks={sparks} activeId={spark?.id ?? null} onSelect={onSelectSpark} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
