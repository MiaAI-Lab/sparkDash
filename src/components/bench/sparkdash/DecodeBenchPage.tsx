import type { SparkSnapshot } from "../../../api/types";
import { BenchmarkDialog } from "../../SparkPage/BenchmarkDialog";
import { BenchTargetFrame } from "./BenchTargetFrame";

/** Decode benchmark as a page: generation tok/s at rising concurrency. */
export function DecodeBenchPage({ spark, benchShareImage = false }: { spark: SparkSnapshot | null; benchShareImage?: boolean }) {
  return (
    <BenchTargetFrame spark={spark} benchShareImage={benchShareImage}>
      {(t) => <BenchmarkDialog variant="page" {...t} />}
    </BenchTargetFrame>
  );
}
