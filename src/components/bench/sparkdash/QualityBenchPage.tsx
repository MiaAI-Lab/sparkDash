import type { SparkSnapshot } from "../../../api/types";
import { QualityBenchDialog } from "../../SparkPage/QualityBenchDialog";
import { BenchTargetFrame } from "./BenchTargetFrame";

/** Quality benchmark as a page: seeded suite, run history and run-vs-run comparison. */
export function QualityBenchPage({ spark, benchShareImage = false }: { spark: SparkSnapshot | null; benchShareImage?: boolean }) {
  return (
    <BenchTargetFrame spark={spark} benchShareImage={benchShareImage}>
      {(t) => {
        // Quality has no share-image option: its copy button always offers the card.
        const { shareImage: _s, ...rest } = t;
        return <QualityBenchDialog variant="page" {...rest} />;
      }}
    </BenchTargetFrame>
  );
}
