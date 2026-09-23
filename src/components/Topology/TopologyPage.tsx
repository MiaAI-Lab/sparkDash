import type { RoceLink, TopologyInfo } from "../../../shared/types";
import { RoceDiagram } from "./RoceDiagram";

export interface TopologyPageProps {
  nodes: TopologyInfo[];
  links: RoceLink[];
}

function formatMbps(mbps: number | null): string {
  if (mbps == null) return "unknown";
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gbps`;
  return `${mbps} Mbps`;
}

/**
 * Topology page: RoCE diagram + node table + link table.
 */
export function TopologyPage({ nodes, links }: TopologyPageProps) {
  const linkCountByNode = new Map<string, number>();
  for (const link of links) {
    linkCountByNode.set(link.from, (linkCountByNode.get(link.from) ?? 0) + 1);
    linkCountByNode.set(link.to, (linkCountByNode.get(link.to) ?? 0) + 1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Topology
        </h1>
        <span className="text-[11px] text-muted">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} · {links.length} link
          {links.length === 1 ? "" : "s"}
        </span>
      </div>

      <RoceDiagram nodes={nodes} links={links} />

      {/* Node table */}
      <div className="panel" style={{ padding: "var(--density-panel-pad)" }}>
        <h3 className="panel-title mb-3">Nodes</h3>
        {nodes.length === 0 ? (
          <p className="text-xs text-muted">No nodes</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">Node</th>
                  <th className="py-1.5 pr-3 font-medium">Role</th>
                  <th className="py-1.5 pr-3 font-medium">Rank</th>
                  <th className="py-1.5 pr-3 font-medium">Group</th>
                  <th className="py-1.5 pr-3 font-medium">Head</th>
                  <th className="py-1.5 pr-3 font-medium">Links</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.nodeId} className="border-b border-border/50">
                    <td className="py-1.5 pr-3 font-medium text-text">{n.nodeId}</td>
                    <td className="py-1.5 pr-3 text-muted">{n.role}</td>
                    <td className="py-1.5 pr-3 font-tabular text-muted">
                      {n.rank != null ? n.rank : "—"}
                    </td>
                    <td className="py-1.5 pr-3 font-tabular text-muted">{n.groupId ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-tabular text-muted">{n.headId ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-tabular text-muted">
                      {linkCountByNode.get(n.nodeId) ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Link table */}
      <div className="panel" style={{ padding: "var(--density-panel-pad)" }}>
        <h3 className="panel-title mb-3">RoCE Links</h3>
        {links.length === 0 ? (
          <p className="text-xs text-muted">No links</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">From</th>
                  <th className="py-1.5 pr-3 font-medium">To</th>
                  <th className="py-1.5 pr-3 font-medium">Speed</th>
                  <th className="py-1.5 pr-3 font-medium">Transport</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l, i) => (
                  <tr key={`${l.from}->${l.to}:${i}`} className="border-b border-border/50">
                    <td className="py-1.5 pr-3 font-tabular text-text">{l.from}</td>
                    <td className="py-1.5 pr-3 font-tabular text-text">{l.to}</td>
                    <td className="py-1.5 pr-3 font-tabular text-muted">{formatMbps(l.speedMbps)}</td>
                    <td className="py-1.5 pr-3 text-muted">{l.transport}</td>
                    <td
                      className={`py-1.5 pr-3 font-medium ${l.up ? "text-success" : "text-danger"}`}
                    >
                      {l.up ? "up" : "down"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
