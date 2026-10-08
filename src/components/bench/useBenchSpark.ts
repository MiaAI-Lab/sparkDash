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
  const eligible = useMemo(() => sparks.filter((s) => !isWorkerSpark(s)), [sparks]);

  const spark = useMemo(() => {
    const pool = eligible.length ? eligible : sparks;
    return (
      pool.find((s) => s.id === stored) ??
      pool.find((s) => s.online && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available)) ??
      pool.find((s) => s.online) ??
      pool[0] ??
      null
    );
  }, [eligible, sparks, stored]);

  const select = useCallback((id: string) => {
    setStored(id);
    try {
      localStorage.setItem(BENCH_SPARK_KEY, id);
    } catch {
      /* private mode */
    }
  }, []);

  return { spark, select, eligible: eligible.length ? eligible : [...sparks] };
}
