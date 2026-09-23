import type {
  MemoryBudget,
  NodeAgentSnapshot,
  RequestStat,
  RoceLink,
  TopologyInfo,
} from "../../../shared/types";
import { FleetCard } from "./FleetCard";

export interface FleetPageProps {
  nodes: NodeAgentSnapshot[];
  topology: {
    nodes: TopologyInfo[];
    links: RoceLink[];
  };
  requests: {
    byModel: Record<string, RequestStat[]>;
    byEngine: Record<string, RequestStat[]>;
    byMachine: Record<string, RequestStat[]>;
  };
  memory: {
    totalMB: number;
    usedMB: number;
    freeMB: number;
    byNode: Record<string, MemoryBudget>;
  };
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Resolve a node's role/rank/groupId from the assembled topology graph,
 * falling back to the node's own telemetry topology.
 */
function resolveRole(
  node: NodeAgentSnapshot,
  topologyNodes: TopologyInfo[]
): { role: TopologyInfo["role"]; rank: number | null; groupId: string | null } {
  const fromGraph = topologyNodes.find((t) => t.nodeId === node.nodeId);
  const info = fromGraph ?? node.topology;
  if (!info) return { role: "standalone", rank: null, groupId: null };
  return { role: info.role, rank: info.rank, groupId: info.groupId };
}

/** Sum request stats across the byMachine partition (each stat appears once). */
function sumRequests(byMachine: Record<string, RequestStat[]>) {
  let queued = 0;
  let running = 0;
  let finished = 0;
  for (const stats of Object.values(byMachine)) {
    for (const s of stats) {
      queued += s.queued;
      running += s.running;
      finished += s.finished;
    }
  }
  return { queued, running, finished };
}

/**
 * Fleet overview page: summary strip + one FleetCard per node.
 */
export function FleetPage({ nodes, topology, requests, memory }: FleetPageProps) {
  const onlineCount = nodes.filter((n) => n.online).length;
  const offlineCount = nodes.length - onlineCount;
  const reqs = sumRequests(requests.byMachine);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      {/* Header + summary */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Fleet Overview
        </h1>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{nodes.length} online
          </span>
          <span className="text-[11px] text-muted">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} ·{" "}
            {topology.links.length} link{topology.links.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Summary strip */}
      <div
        className="panel grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4"
        style={{ padding: "var(--density-panel-pad)" }}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Nodes</span>
          <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-nodes">
            {nodes.length} total · {onlineCount} online · {offlineCount} offline
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Memory</span>
          <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-memory">
            {formatMb(memory.usedMB)} / {formatMb(memory.totalMB)} used
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Requests</span>
          <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-requests">
            q{reqs.queued} · r{reqs.running} · f{reqs.finished}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Free</span>
          <span
            className="font-tabular text-[13px] font-semibold"
            data-testid="fleet-summary-free"
          >
            {formatMb(memory.freeMB)}
          </span>
        </div>
      </div>

      {/* Cards */}
      {nodes.length === 0 ? (
        <div className="panel mx-auto mt-8 max-w-md p-8 text-center">
          <h2 className="text-sm font-semibold text-text-strong">No nodes registered</h2>
          <p className="mt-1 text-xs text-muted">
            Register a Spark node-agent to see it here.
          </p>
        </div>
      ) : (
        <div
          className="overview-page grid sm:grid-cols-2 lg:grid-cols-3"
          style={{ gap: "var(--density-page-gap)" }}
        >
          {nodes.map((node) => {
            const { role, rank, groupId } = resolveRole(node, topology.nodes);
            return (
              <FleetCard
                key={node.nodeId}
                nodeId={node.nodeId}
                nodeName={node.nodeName}
                lanIp={node.lanIp}
                role={role}
                rank={rank}
                groupId={groupId}
                online={node.online}
                gpu={node.gpu}
                cpu={node.cpu}
                mem={node.mem}
                containers={node.containers}
                services={node.services}
                versions={node.versions}
                requests={node.requests}
                topology={node.topology}
                memory={node.memory}
                polledAt={node.polledAt}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
