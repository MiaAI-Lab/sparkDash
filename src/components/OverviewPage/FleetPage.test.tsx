import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { FleetPage, type FleetPageProps } from "./FleetPage";
import type { MemoryBudget, NodeAgentSnapshot, RequestStat, RoceLink, TopologyInfo } from "../../../shared/types";

function budget(nodeId: string, overrides: Partial<MemoryBudget> = {}): MemoryBudget {
  return {
    nodeId,
    totalMB: 128000,
    usedMB: 96000,
    freeMB: 32000,
    servicesUsedMB: 90000,
    otherUsedMB: 6000,
    services: [],
    makeRoom: [],
    needMakeRoom: false,
    polledAt: Date.now(),
    ...overrides,
  };
}

function node(nodeId: string, overrides: Partial<NodeAgentSnapshot> = {}): NodeAgentSnapshot {
  const online = overrides.online ?? true;
  return {
    nodeId,
    nodeName: nodeId,
    lanIp: "192.168.50.226",
    agentVersion: "0.1.0",
    online,
    uptimeSeconds: online ? 100000 : null,
    gpu: online
      ? {
          temperature: 55,
          usage: 10,
          powerDraw: 30,
          powerLimit: 90,
          vramUsedMB: 8000,
          vramTotalMB: 128000,
          vramPercentage: 6,
          vramAvailableMB: 120000,
          processes: [],
        }
      : null,
    cpu: online ? { usage: 5, temperature: 40, draw: 10, tdp: 60 } : null,
    mem: online ? { usedMB: 20000, totalMB: 128000, availableMB: 108000, percentage: 16 } : null,
    disk: [],
    net: [],
    containers: [],
    versions: [],
    services: [],
    memory: online ? budget(nodeId) : null,
    requests: null,
    topology: null,
    polledAt: Date.now() - 1000,
    ...overrides,
  };
}

const topologyNodes: TopologyInfo[] = [
  { nodeId: "head", role: "head", rank: 0, groupId: "tp2", headId: null, links: [] },
  { nodeId: "w0", role: "worker", rank: 1, groupId: "tp2", headId: "head", links: [] },
  { nodeId: "solo", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
];

const links: RoceLink[] = [{ from: "head", to: "w0", speedMbps: 200000, transport: "roce", up: true }];

const stat = (nodeId: string): RequestStat => ({
  modelId: "qwen3.8-27b",
  engine: "sglang",
  nodeId,
  port: 8080,
  queued: 1,
  running: 2,
  finished: 10,
  polledAt: Date.now(),
});

function makeProps(overrides: Partial<FleetPageProps> = {}): FleetPageProps {
  const nodes = [node("head"), node("w0"), node("solo", { online: false })];
  return {
    nodes,
    topology: { nodes: topologyNodes, links },
    requests: {
      byModel: { "qwen3.8-27b": [stat("head"), stat("w0")] },
      byEngine: { sglang: [stat("head"), stat("w0")] },
      byMachine: { head: [stat("head")], w0: [stat("w0")] },
    },
    memory: {
      totalMB: 384000,
      usedMB: 212000,
      freeMB: 172000,
      byNode: { head: budget("head"), w0: budget("w0"), solo: budget("solo") },
    },
    ...overrides,
  };
}

describe("FleetPage", () => {
  it("renders one FleetCard per node plus the summary", () => {
    const { container } = render(<FleetPage {...makeProps()} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Fleet Overview");

    const cards = container.querySelectorAll("[aria-label^='Fleet node']");
    expect(cards).toHaveLength(3);
    for (const name of ["head", "w0", "solo"]) {
      expect(text).toContain(name);
    }

    // Summary
    expect(container.querySelector('[data-testid="fleet-summary-nodes"]')?.textContent).toBe(
      "3 total · 2 online · 1 offline"
    );
    expect(container.querySelector('[data-testid="fleet-summary-memory"]')?.textContent).toContain(
      "used"
    );
    // q1+1 · r2+2 · f10+10
    expect(container.querySelector('[data-testid="fleet-summary-requests"]')?.textContent).toBe(
      "q2 · r4 · f20"
    );
    expect(text).toContain("2/3 online");
  });

  it("resolves role/rank/group from the assembled topology graph", () => {
    const { container } = render(<FleetPage {...makeProps()} />);
    const w0Card = container.querySelector("[aria-label='Fleet node w0']");
    expect(w0Card?.textContent).toContain("Worker");
    expect(w0Card?.textContent).toContain("rank 1");
    expect(w0Card?.textContent).toContain("tp2");
  });

  it("renders 0 cards and an empty summary for no nodes", () => {
    const { container } = render(
      <FleetPage {...makeProps({ nodes: [], memory: { totalMB: 0, usedMB: 0, freeMB: 0, byNode: {} } })} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Fleet Overview");
    expect(container.querySelectorAll("[aria-label^='Fleet node']")).toHaveLength(0);
    expect(container.querySelector('[data-testid="fleet-summary-nodes"]')?.textContent).toBe(
      "0 total · 0 online · 0 offline"
    );
    expect(text).toContain("No nodes registered");
  });
});
