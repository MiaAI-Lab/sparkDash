import { useCallback, useMemo, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { BENCH_SPARK_KEY } from "./benchCatalog";

function readStored(): string | null {
  try {
    return localStorage.getItem(BENCH_SPARK_KEY);
  } catch {
    return null;
  }
}

/**
 * Which Spark the benchmark pages act on. Remembered across pages and visits;
 * defaults to the first online non-worker Spark that has a reachable LLM.
 */
export function useBenchSpark(sparks: readonly SparkSnapshot[]) {
  const [stored, setStored] = useState<string | null>(readStored);
  // Every Spark stays selectable so its saved results can be read even when it has no LLM now
  // (workers included); runnable ones come first and are preferred as the default.
  const eligible = useMemo(
    () => [...sparks].sort((a, b) => Number(isWorkerSpark(a)) - Number(isWorkerSpark(b))),
    [sparks]
  );

  const spark = useMemo(() => {
    const pool = eligible.filter((s) => !isWorkerSpark(s));
    const all = eligible;
    return (
      all.find((s) => s.id === stored) ??
      pool.find((s) => s.online && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available)) ??
      pool.find((s) => s.online) ??
      pool[0] ??
      all[0] ??
      null
    );
  }, [eligible, stored]);

  const select = useCallback((id: string) => {
    setStored(id);
    try {
      localStorage.setItem(BENCH_SPARK_KEY, id);
    } catch {
      /* private mode */
    }
  }, []);

  return { spark, select, eligible };
}
