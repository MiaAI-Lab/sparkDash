import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { RoceDiagram, roleColor } from "./RoceDiagram";
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

const links: RoceLink[] = [
  { from: "head", to: "w0", fromIf: "enp1s0f1np1", toIf: "enp1s0f1np1", speedMbps: 200000, transport: "roce", up: true },
  { from: "head", to: "w1", speedMbps: 200000, transport: "roce", up: false },
];

describe("RoceDiagram", () => {
  it("renders one circle per node and one line per link", () => {
    const nodes = [
      node("head", { role: "head", rank: 0, groupId: "tp2", headId: null }),
      node("w0", { role: "worker", rank: 1, groupId: "tp2", headId: "head" }),
      node("w1", { role: "worker", rank: 2, groupId: "tp2", headId: "head" }),
    ];
    const { container } = render(<RoceDiagram nodes={nodes} links={links} />);
    expect(container.querySelectorAll("svg circle")).toHaveLength(3);
    expect(container.querySelectorAll("svg line")).toHaveLength(2);
    // Labels: node ids + speed labels
    expect(container.textContent).toContain("head");
    expect(container.textContent).toContain("w0");
    expect(container.textContent).toContain("w1");
    expect(container.textContent).toContain("200G");
  });

  it("renders 0 circles and 0 lines for empty nodes", () => {
    const { container } = render(<RoceDiagram nodes={[]} links={[]} />);
    expect(container.querySelectorAll("svg circle")).toHaveLength(0);
    expect(container.querySelectorAll("svg line")).toHaveLength(0);
    expect(container.textContent).toContain("No nodes in topology");
  });

  it("draws a dashed box around a TP group with 2+ members and colors by role", () => {
    const nodes = [
      node("head", { role: "head", rank: 0, groupId: "tp2" }),
      node("w0", { role: "worker", rank: 1, groupId: "tp2" }),
      node("alone", { role: "standalone" }),
    ];
    const { container } = render(<RoceDiagram nodes={nodes} links={[]} />);

    const boxes = container.querySelectorAll("svg rect[data-testid='roce-group-box']");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].getAttribute("stroke-dasharray")).toBe("6 4");
    expect(container.textContent).toContain("tp2");

    const circles = [...container.querySelectorAll("svg circle")];
    expect(circles.map((c) => c.getAttribute("fill"))).toContain(roleColor("head"));
    expect(circles.map((c) => c.getAttribute("fill"))).toContain(roleColor("worker"));
    expect(circles.map((c) => c.getAttribute("fill"))).toContain(roleColor("standalone"));
  });

  it("skips links to unknown nodes instead of crashing", () => {
    const nodes = [node("head", { role: "head" })];
    const { container } = render(
      <RoceDiagram
        nodes={nodes}
        links={[{ from: "head", to: "ghost", speedMbps: 10000, transport: "tcp", up: true }]}
      />
    );
    expect(container.querySelectorAll("svg circle")).toHaveLength(1);
    expect(container.querySelectorAll("svg line")).toHaveLength(0);
  });

  it("marks a down link with a dashed line", () => {
    const nodes = [node("a"), node("b")];
    const down: RoceLink = { from: "a", to: "b", speedMbps: null, transport: "tcp", up: false };
    const { container } = render(<RoceDiagram nodes={nodes} links={[down]} />);
    const line = container.querySelector("svg line");
    expect(line?.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(container.textContent).toContain("unknown");
  });
});
