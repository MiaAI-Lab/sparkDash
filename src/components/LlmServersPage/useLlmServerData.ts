import { useEffect, useState } from "react";
import { getLlmInsights, getUnitHistory } from "../../api/client";
import type {
  HistoryLlmPoint,
  LlmInsightsResponse,
  MetricsHistoryData,
  MetricsHistoryRange,
  MetricsHistoryResponse,
} from "../../api/types";

const POLL_MS = 30_000;

export interface LlmServerData {
  /** `false` while Settings → Metrics history is off. */
  enabled: boolean | null;
  history: MetricsHistoryData | null;
  points: HistoryLlmPoint[];
  insights: LlmInsightsResponse | null;
  loadedAt: number | null;
  error: string | null;
}

const EMPTY: LlmServerData = {
  enabled: null,
  history: null,
  points: [],
  insights: null,
  loadedAt: null,
  error: null,
};

/** Bucketed history + server-side insights for one endpoint. */
export function useLlmServerData(
  sparkId: string,
  port: number,
  range: MetricsHistoryRange,
  active = true
): LlmServerData {
  const [data, setData] = useState<LlmServerData>(EMPTY);

  // A new endpoint or range starts from loading, not from the previous answer.
  useEffect(() => {
    setData(EMPTY);
  }, [sparkId, port, range]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const load = () => {
      Promise.allSettled([getUnitHistory(sparkId, range, true), getLlmInsights(sparkId, port, range)])
        .then(([historyResult, insightsResult]) => {
          if (cancelled) return;
          const historyResponse: MetricsHistoryResponse | null =
            historyResult.status === "fulfilled" ? historyResult.value : null;
          const insightsResponse: LlmInsightsResponse | null =
            insightsResult.status === "fulfilled" ? insightsResult.value : null;
          const enabled =
            historyResponse?.enabled === false || insightsResponse?.enabled === false
              ? false
              : historyResponse || insightsResponse
                ? true
                : null;
          const history: MetricsHistoryData | null =
            historyResponse && historyResponse.enabled === true
              ? (historyResponse as MetricsHistoryData)
              : null;
          const points = history?.llm.find((entry) => entry.port === port)?.points ?? [];
          const failure = [historyResult, insightsResult].find((r) => r.status === "rejected");
          setData({
            enabled,
            history,
            points,
            insights: insightsResponse,
            loadedAt: Date.now(),
            error:
              failure && failure.status === "rejected"
                ? failure.reason instanceof Error
                  ? failure.reason.message
                  : String(failure.reason)
                : null,
          });
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setData((prev) => ({
              ...prev,
              loadedAt: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        });
    };

    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sparkId, port, range, active]);

  return data;
}
