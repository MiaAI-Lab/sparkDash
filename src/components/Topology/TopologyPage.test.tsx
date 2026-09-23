import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { TopologyPage } from "./TopologyPage";
import type { RoceLink, TopologyInfo } from "../../../shared/types";

function node(nodeId: string, overrides: Partial<TopologyInfo> = {}): TopologyInfo {
  return {
    nodeId,
    role: "standalone",
    rank: null,
    groupId: null,
    headId: null,
    links: [],
    ...overrides,
  };
}

const nodes: TopologyInfo[] = [
  node("head", { role: "head", rank: 0, groupId: "tp2-glm" }),
  node("w0", { role: "worker", rank: 1, groupId: "tp2-glm", headId: "head" }),
];

const links: RoceLink[] = [
  { from: "head", to: "w0", speedMbps: 200000, transport: "roce", up: true },
  { from: "w0", to: "head", speedMbps: null, transport: "tcp", up: false },
];

describe("TopologyPage", () => {
  it("renders header, diagram, node table, and link table", () => {
    const { container } = render(<TopologyPage nodes={nodes} links={links} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Topology");
    expect(text).toContain("2 nodes · 2 links");

    // Diagram present
    expect(container.querySelector("svg[data-testid='roce-diagram']")).not.toBeNull();
    expect(container.querySelectorAll("svg circle")).toHaveLength(2);

    // Node table rows
    for (const n of nodes) {
      expect(text).toContain(n.nodeId);
    }
    expect(text).toContain("head");
    expect(text).toContain("worker");
    expect(text).toContain("tp2-glm");
    expect(text).toContain("Rank");

    // Link table rows
    expect(text).toContain("200 Gbps");
    expect(text).toContain("roce");
    expect(text).toContain("unknown");
    expect(text).toContain("tcp");
    // link status: one up, one down
    expect(text).toContain("up");
    expect(text).toContain("down");
  });

  it("renders header with empty tables for no nodes/links", () => {
    const { container } = render(<TopologyPage nodes={[]} links={[]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Topology");
    expect(text).toContain("0 nodes · 0 links");
    expect(text).toContain("No nodes");
    expect(text).toContain("No links");
    expect(container.querySelectorAll("svg circle")).toHaveLength(0);
  });
});
