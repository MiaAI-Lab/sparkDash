import type { RequestStat, RequestStats } from "../../../shared/types";
import { timeAgo } from "../../lib/timeAgo";
import { RequestStatCard } from "./RequestStatCard";

export interface RequestsPageProps {
  nodeId: string;
  nodeName: string;
  /** This node's raw request stats (polledAt shown in the header). */
  requests: RequestStats;
  /** Aggregated by model id. */
  byModel: Record<string, RequestStat[]>;
  /** Aggregated by engine. */
  byEngine: Record<string, RequestStat[]>;
  /** Aggregated by machine (node id). */
  byMachine: Record<string, RequestStat[]>;
}

function statKey(s: RequestStat): string {
  return `${s.nodeId}:${s.port}:${s.modelId}`;
}

function RequestSection({
  title,
  groups,
  emptyLabel,
}: {
  title: string;
  groups: Record<string, RequestStat[]>;
  emptyLabel: string;
}) {
  const entries = Object.entries(groups ?? {});
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
          {emptyLabel}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
          {entries.flatMap(([group, stats]) =>
            (stats ?? []).map((s) => (
              <RequestStatCard
                key={`${group}:${statKey(s)}`}
                modelId={s.modelId}
                engine={s.engine}
                nodeId={s.nodeId}
                port={s.port}
                queued={s.queued}
                running={s.running}
                finished={s.finished}
                polledAt={s.polledAt}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Requests viz for one node: queued / running / finished request stats
 * grouped by model, by engine, and by machine. Layout mirrors SparkPage.
 */
export function RequestsPage({
  nodeId,
  nodeName,
  requests,
  byModel,
  byEngine,
  byMachine,
}: RequestsPageProps) {
  const polledLabel =
    requests && Number.isFinite(requests.polledAt)
      ? ` · polled ${timeAgo(requests.polledAt)}`
      : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-strong">Requests</h1>
          <p className="mt-0.5 text-xs text-muted">
            {nodeName} · {nodeId}
            {polledLabel}
          </p>
        </div>
      </header>
      <RequestSection title="By model" groups={byModel} emptyLabel="No requests by model" />
      <RequestSection title="By engine" groups={byEngine} emptyLabel="No requests by engine" />
      <RequestSection title="By machine" groups={byMachine} emptyLabel="No requests by machine" />
    </div>
  );
}
