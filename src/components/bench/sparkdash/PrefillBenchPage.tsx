import type { SparkSnapshot } from "../../../api/types";
import { PrefillBenchDialog } from "../../SparkPage/PrefillBenchDialog";
import { BenchTargetFrame } from "./BenchTargetFrame";

/** Prefill benchmark as a page: prompt-processing tok/s and TTFT across context sizes. */
export function PrefillBenchPage({ spark, benchShareImage = false }: { spark: SparkSnapshot | null; benchShareImage?: boolean }) {
  return (
    <BenchTargetFrame spark={spark} benchShareImage={benchShareImage}>
      {(t) => <PrefillBenchDialog variant="page" {...t} />}
    </BenchTargetFrame>
  );
}
