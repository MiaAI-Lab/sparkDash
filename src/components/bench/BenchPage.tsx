import type { SparkSnapshot } from "../../api/types";
import { benchTypeById } from "./benchCatalog";
import { BenchPageShell } from "./BenchPageShell";
import { BenchSparksContext } from "./SparkChips";
import { useBenchSpark } from "./useBenchSpark";
import { DecodeBenchPage, PrefillBenchPage, QualityBenchPage } from "./sparkdash";
import { ToolEvalBenchPage } from "./tooleval/ToolEvalBenchPage";

interface BenchPageProps {
  type: string;
  sparks: readonly SparkSnapshot[];
  benchShareImage?: boolean;
}

/** Router for the benchmark pages: shared header + Spark picker, then the page for this benchmark type. */
export function BenchPage({ type, sparks, benchShareImage = false }: BenchPageProps) {
  const { spark, select, eligible } = useBenchSpark(sparks);
  const bench = benchTypeById(type);
  let body;
  if (!bench) body = <p className="page-stub">Unknown benchmark.</p>;
  else if (type === "decode") body = <DecodeBenchPage spark={spark} benchShareImage={benchShareImage} />;
  else if (type === "prefill") body = <PrefillBenchPage spark={spark} benchShareImage={benchShareImage} />;
  else if (type === "quality") body = <QualityBenchPage spark={spark} benchShareImage={benchShareImage} />;
  else body = <ToolEvalBenchPage type={type} spark={spark} />;
  // The sparkDash benches fold the Spark chips into their own target row (with Remote).
  const ownsPicker = bench?.engine === "sparkdash";
  return (
    <BenchPageShell type={type} spark={spark} sparks={eligible} onSelectSpark={select} picker={!ownsPicker}>
      <BenchSparksContext.Provider value={{ sparks: eligible, onSelect: select }}>{body}</BenchSparksContext.Provider>
    </BenchPageShell>
  );
}
