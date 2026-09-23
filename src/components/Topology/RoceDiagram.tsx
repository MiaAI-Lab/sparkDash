import type { NodeRole, RoceLink, TopologyInfo } from "../../../shared/types";

export interface RoceDiagramProps {
  nodes: TopologyInfo[];
  links: RoceLink[];
}

/** Role → fill color (head blue, worker green, standalone gray). */
export function roleColor(role: NodeRole): string {
  return role === "head" ? "#3b82f6" : role === "worker" ? "#22c55e" : "#6b7280";
}

const COL = 170;
const ROW = 110;
const PAD_X = 70;
const PAD_TOP = 50;
const PAD_BOTTOM = 40;
const R = 26;

interface Positioned {
  node: TopologyInfo;
  x: number;
  y: number;
}

/**
 * Deterministic layout: standalone nodes on the first row; each TP group
 * (same groupId) gets its own row below, in first-appearance order.
 */
function layoutNodes(nodes: TopologyInfo[]): { positioned: Positioned[]; groups: Map<string, Positioned[]>; width: number; height: number } {
  const groups = new Map<string, Positioned[]>();
  const standalone: Positioned[] = [];

  for (const node of nodes) {
    const key = node.groupId ?? "standalone";
    if (key === "standalone") {
      standalone.push({ node, x: 0, y: 0 });
    } else {
      const list = groups.get(key) ?? [];
      list.push({ node, x: 0, y: 0 });
      groups.set(key, list);
    }
  }

  // Assign coordinates row by row: standalone row first, then one row per TP group.
  const rows: Positioned[][] = [standalone, ...groups.values()].filter((row) => row.length > 0);
  rows.forEach((row, r) => {
    row.forEach((p, c) => {
      p.x = PAD_X + c * COL + COL / 2;
      p.y = PAD_TOP + r * ROW + R;
    });
  });

  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  const width = Math.max(320, maxCols * COL + PAD_X * 2);
  const height = Math.max(220, PAD_TOP * 2 + Math.max(0, rows.length - 1) * ROW + R * 2 + 30);

  return { positioned: rows.flat(), groups, width, height };
}

function speedLabel(speedMbps: number | null): string {
  if (speedMbps == null) return "unknown";
  if (speedMbps >= 1000) return `${(speedMbps / 1000).toFixed(speedMbps % 1000 === 0 ? 0 : 1)}G`;
  return `${speedMbps}M`;
}

/**
 * RoCE connections diagram: one circle per node (colored by role), one line
 * per link (labeled with speed), and a dashed box around each TP group.
 */
export function RoceDiagram({ nodes, links }: RoceDiagramProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted">
        No nodes in topology
      </div>
    );
  }

  const { positioned, groups, width, height } = layoutNodes(nodes);
  const byId = new Map(positioned.map((p) => [p.node.nodeId, p]));

  // Dashed boxes: each TP group with 2+ nodes gets one.
  const boxes: { key: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [groupId, members] of groups) {
    if (members.length < 2) continue;
    const xs = members.map((m) => m.x);
    const ys = members.map((m) => m.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    boxes.push({ key: groupId, x: minX - 48, y: minY - 40, w: maxX - minX + 96, h: maxY - minY + 80 });
  }

  return (
    <svg
      data-testid="roce-diagram"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`RoCE topology with ${nodes.length} nodes and ${links.length} links`}
      className="rounded-lg border border-border bg-surface"
    >
      {/* Link lines (drawn first, under the nodes) */}
      {links.map((link, i) => {
        const from = byId.get(link.from);
        const to = byId.get(link.to);
        if (!from || !to) return null; // link to unknown node — skip, don't crash
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;
        return (
          <g key={`${link.from}->${link.to}:${i}`}>
            <line
              data-testid="roce-link"
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={link.up ? "var(--color-accent, #6366f1)" : "var(--color-danger, #ef4444)"}
              strokeWidth={2}
              strokeDasharray={link.up ? undefined : "6 4"}
            />
            <text
              x={midX}
              y={midY - 6}
              textAnchor="middle"
              fontSize="11"
              fill="var(--color-muted, #9ca3af)"
            >
              {speedLabel(link.speedMbps)}
            </text>
          </g>
        );
      })}

      {/* TP group dashed boxes */}
      {boxes.map((box) => (
        <g key={box.key}>
          <rect
            data-testid="roce-group-box"
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            fill="none"
            stroke="var(--color-border, #d1d5db)"
            strokeWidth={1.5}
            strokeDasharray="6 4"
            rx={12}
          />
          <text
            x={box.x + 10}
            y={box.y - 8}
            fontSize="11"
            fill="var(--color-muted, #9ca3af)"
          >
            {box.key}
          </text>
        </g>
      ))}

      {/* Node circles */}
      {positioned.map((p) => (
        <g key={p.node.nodeId}>
          <circle
            data-testid="roce-node"
            cx={p.x}
            cy={p.y}
            r={R}
            fill={roleColor(p.node.role)}
            opacity={0.9}
          />
          {p.node.rank != null && (
            <text
              x={p.x}
              y={p.y + 4}
              textAnchor="middle"
              fontSize="12"
              fontWeight="bold"
              fill="#fff"
            >
              {p.node.rank}
            </text>
          )}
          <text
            x={p.x}
            y={p.y + R + 16}
            textAnchor="middle"
            fontSize="12"
            fill="var(--color-text, #111827)"
          >
            {p.node.nodeId}
          </text>
        </g>
      ))}
    </svg>
  );
}
