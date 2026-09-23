import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { FleetCard, type FleetCardProps } from "./FleetCard";
import type {
  ContainerInfo,
  CpuMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  NodeRole,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";

function gpu(): GpuMetrics {
  return {
    temperature: 62,
    usage: 40,
    powerDraw: 45,
    powerLimit: 90,
    vramUsedMB: 20480,
    vramTotalMB: 128000,
    vramPercentage: 16,
    vramAvailableMB: 107520,
    processes: [{ pid: 1001, name: "sglang", vramMB: 19000 }],
  };
}

function cpu(): CpuMetrics {
  return { usage: 25, temperature: 55, draw: 18, tdp: 60 };
}

function mem(): MemMetrics {
  return { usedMB: 40000, totalMB: 128000, availableMB: 88000, percentage: 31 };
}

function memoryBudget(overrides: Partial<MemoryBudget> = {}): MemoryBudget {
  return {
    nodeId: "gx10-1c2c",
    totalMB: 128000,
    usedMB: 96000,
    freeMB: 32000,
    servicesUsedMB: 90000,
    otherUsedMB: 6000,
    services: [
      { name: "llm-tp1", kind: "llm", footprintMB: 88000, running: true, needed: false },
    ],
    makeRoom: [],
    needMakeRoom: false,
    polledAt: Date.now(),
    ...overrides,
  };
}

function containers(): ContainerInfo[] {
  return [
    {
      name: "sglang",
      image: "lmsysorg/sglang:v1.2.0",
      imageDigest: null,
      status: "running",
      uptimeSeconds: 90000,
      ports: ["8080:8080"],
      memUsedMB: 90000,
      memLimitMB: null,
      cpuPercent: 120,
    },
    {
      name: "qdrant",
      image: "qdrant/qdrant:1.11",
      imageDigest: null,
      status: "running",
      uptimeSeconds: 200000,
      ports: [],
      memUsedMB: 512,
      memLimitMB: null,
      cpuPercent: 1,
    },
    {
      name: "old-worker",
      image: "vllm/vllm:0.8",
      imageDigest: null,
      status: "stopped",
      uptimeSeconds: null,
      ports: [],
      memUsedMB: null,
      memLimitMB: null,
      cpuPercent: null,
    },
  ];
}

function services(): ServiceInstance[] {
  return [
    {
      name: "llm-tp1",
      kind: "llm",
      engine: "sglang",
      port: 8080,
      status: "running",
      modelId: "qwen3.8-27b",
      engineVersion: "v1.2.0",
      footprintMB: 88000,
      active: true,
      polledAt: Date.now(),
    },
    {
      name: "comfy",
      kind: "image",
      engine: "comfyui",
      port: 8188,
      status: "stopped",
      modelId: null,
      engineVersion: null,
      footprintMB: 2048,
      active: false,
      polledAt: Date.now(),
    },
  ];
}

function requests(): RequestStats {
  return {
    nodeId: "gx10-1c2c",
    stats: [
      { modelId: "qwen3.8-27b", engine: "sglang", nodeId: "gx10-1c2c", port: 8080, queued: 1, running: 2, finished: 10, polledAt: Date.now() },
    ],
    polledAt: Date.now(),
  };
}

function topology(): TopologyInfo {
  return {
    nodeId: "gx10-1c2c",
    role: "head",
    rank: 0,
    groupId: "tp2-glm",
    headId: null,
    links: [],
  };
}

function makeCard(overrides: Partial<FleetCardProps> = {}): FleetCardProps {
  const now = Date.now();
  return {
    nodeId: "gx10-1c2c",
    nodeName: "gx10-1c2c",
    lanIp: "192.168.50.226",
    role: "head",
    rank: 0,
    groupId: "tp2-glm",
    online: true,
    gpu: gpu(),
    cpu: cpu(),
    mem: mem(),
    containers: containers(),
    services: services(),
    versions: [] as VersionInfo[],
    requests: requests(),
    topology: topology(),
    memory: memoryBudget(),
    polledAt: now - 65_000, // stable in the "1m ago" bucket for the test window
    ...overrides,
  };
}

describe("FleetCard", () => {
  it("renders header, GPU, CPU, mem, containers, services, requests, memory budget, and polled-at", () => {
    const { container } = render(<FleetCard {...makeCard()} />);
    const text = container.textContent ?? "";

    // Header
    expect(text).toContain("gx10-1c2c");
    expect(text).toContain("Head");
    expect(text).toContain("192.168.50.226");
    expect(container.querySelector('[data-testid="fleet-card-status"]')?.textContent).toBe("online");

    // GPU
    expect(text).toContain("45W / 90W"); // power draw / limit
    expect(text).toContain("62°C"); // temperature
    expect(text).toContain("40%"); // usage

    // CPU
    expect(text).toContain("25% · 55°C");

    // Mem
    expect(text).toContain("Mem");
    expect(text).toContain("39.1 / 125.0 GB"); // used / total in GB

    // Containers: 3 total, 2 running
    expect(text).toContain("3 (2 running)");

    // Services: 2 total, 1 running
    expect(text).toContain("2 (1 active)");

    // Requests
    expect(text).toContain("q1 · r2 · f10");

    // Memory budget
    expect(text).toContain("31.3 GB free");

    // PolledAt
    expect(container.querySelector('[data-testid="fleet-card-polledat"]')?.textContent).toContain("1m ago");
  });

  it("shows offline status and unreachable placeholder", () => {
    const { container } = render(<FleetCard {...makeCard({ online: false })} />);
    expect(container.querySelector('[data-testid="fleet-card-status"]')?.textContent).toBe("offline");
    expect(container.textContent).toContain("Host unreachable");
    // Metric rows are replaced by the placeholder
    expect(container.textContent).not.toContain("45W / 90W");
  });

  it("renders the role badge for each role", () => {
    const head = render(<FleetCard {...makeCard({ role: "head" as NodeRole })} />);
    expect(head.container.textContent).toContain("Head");

    const worker = render(
      <FleetCard {...makeCard({ role: "worker" as NodeRole, rank: 1, nodeId: "gx10-27c1" })} />
    );
    expect(worker.container.textContent).toContain("Worker");
    expect(worker.container.textContent).toContain("rank 1");

    const standalone = render(
      <FleetCard
        {...makeCard({
          role: "standalone" as NodeRole,
          rank: null,
          groupId: null,
          nodeId: "narthex",
          topology: null,
        })}
      />
    );
    expect(standalone.container.textContent).toContain("Standalone");
    // no rank/group line when null
    expect(standalone.container.textContent).not.toContain("rank null");
  });

  it("shows the make-room banner when the budget needs room", () => {
    const { container } = render(
      <FleetCard
        {...makeCard({
          memory: memoryBudget({
            freeMB: 1000,
            needMakeRoom: true,
            makeRoom: [{ serviceName: "comfy", freesMB: 2048, reason: "stoppable" }],
          }),
        })}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Make room needed");
    expect(text).toContain("stop: comfy");
    expect(text).toContain("1000 MB free");
  });

  it("renders waiting placeholder for an online node with no metrics", () => {
    const { container } = render(
      <FleetCard {...makeCard({ gpu: null, cpu: null, mem: null, memory: null, requests: null })} />
    );
    expect(container.textContent).toContain("Waiting for metrics…");
  });
});
