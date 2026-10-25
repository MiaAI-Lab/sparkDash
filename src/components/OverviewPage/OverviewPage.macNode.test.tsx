/**
 * Non-DGX honesty on the overview card.
 *
 * A DGX Spark can answer every tile; a Mac cannot. The fixture here is the
 * shape the mac node agent produces on a machine where powermetrics was refused
 * for lack of root: GPU busy and GPU power are declared unavailable. The card
 * must say "unavailable", never 0% / 0W, and must show what is actually serving.
 */
import { describe, expect, it } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { OverviewPage } from "./OverviewPage";

const ROOT_POWER_GAP = {
  metric: "gpu.power",
  reason: "powermetrics requires root (run as a LaunchDaemon, or grant sudo -n)",
};

const UTIL_GAP = {
  metric: "gpu.utilization",
  reason: "powermetrics requires root (run as a LaunchDaemon, or grant sudo -n)",
};

function makeMacSpark(overrides: Partial<SparkSnapshot["metrics"]> = {}): SparkSnapshot {
  const base = makeSpark("macbook-m5", true);
  return {
    ...base,
    name: "macbook-m5",
    kind: "mac",
    hardware: {
      device: "Mac (Mac17,6)",
      cpuModel: "Apple M5 Max",
      cpuCores: 18,
      totalMemoryGB: 128,
      gpuChip: "Apple M5 Max",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      ...base.metrics,
      gpu: {
        ...base.metrics.gpu,
        temperature: 0,
        usage: 0,
        power: { draw: 0, limit: 0, systemDraw: 0 },
        vram: { used: 110_103, total: 131_072, percentage: 84, available: 20_969 },
        powermetricsAvailable: false,
        unavailable: [UTIL_GAP, ROOT_POWER_GAP],
      },
      cpu: { usage: 37.5, temperature: 0 },
      unifiedMemory: {
        total: 131_072,
        gpuUsed: 14_938,
        cpuUsed: 95_165,
        used: 110_103,
        available: 20_969,
        percentage: 84,
        oomRisk: "high",
        bandwidth: { current: 0, peak: 0 },
      },
      llm: [],
      ...overrides,
    },
  } as SparkSnapshot;
}

const SERVING = [
  {
    name: "tensorfold",
    label: "TensorFold",
    role: "server",
    pid: 2302,
    command: "python",
    script: "tensorfold",
    port: 8300,
    model: "qwen3.8-27b",
    state: "serving" as const,
    detectedBy: "inventory",
  },
  {
    name: "other-runtime",
    label: "infer.py",
    role: "server",
    pid: 41001,
    command: "python3",
    script: "infer.py",
    port: 9099,
    model: null,
    state: "listening" as const,
    detectedBy: "listener",
  },
];

function withAgent(spark: SparkSnapshot): SparkSnapshot {
  return {
    ...spark,
    metrics: {
      ...spark.metrics,
      runtimes: SERVING,
      unavailable: [UTIL_GAP, ROOT_POWER_GAP, { metric: "ane.power", reason: "powermetrics requires root" }],
      agentOnline: true,
    },
  } as SparkSnapshot;
}

describe("overview card for a Mac node", () => {
  it("badges the platform as Mac, not DGX", () => {
    const { container } = render(<OverviewPage sparks={[makeMacSpark()]} />);
    const badges = [...container.querySelectorAll('[data-testid="platform-badge"]')].map(
      (node) => node.textContent
    );
    expect(badges).toEqual(["Mac"]);
    expect(badges).not.toContain("DGX");
  });

  it("renders an unsupported metric as unavailable instead of zero", () => {
    const { container } = render(<OverviewPage sparks={[withAgent(makeMacSpark())]} />);
    const text = container.querySelector(".ov-sc")?.textContent ?? "";
    expect(text).toContain("unavailable");
    expect(text).not.toMatch(/\b0 ?W\b/);
    expect(text).not.toContain("0°C");
    // The unified-memory bar is a real reading, so it keeps its numbers.
    expect(text).toMatch(/128(\.0)? GB/);
  });

  it("carries the node's own reason into the tooltip", () => {
    const { container } = render(<OverviewPage sparks={[withAgent(makeMacSpark())]} />);
    const titled = [...container.querySelectorAll("[title]")].map((node) =>
      node.getAttribute("title")
    );
    expect(titled.some((title) => title?.includes("powermetrics requires root"))).toBe(true);
  });

  it("shows detected runtimes, keeping an uncatalogued server's own name", () => {
    const { container } = render(<OverviewPage sparks={[withAgent(makeMacSpark())]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Runtimes");
    expect(text).toContain("tensorfold");
    expect(text).toContain(":8300");
    expect(text).toContain("qwen3.8-27b");
    expect(text).toContain("infer.py");
  });

  it("says nothing is serving only when the agent actually answered", () => {
    const idle = {
      ...withAgent(makeMacSpark()),
      metrics: { ...withAgent(makeMacSpark()).metrics, runtimes: [] },
    } as SparkSnapshot;
    const { container } = render(<OverviewPage sparks={[idle]} />);
    expect(container.textContent).toContain("Nothing serving");

    const agentDown = {
      ...withAgent(makeMacSpark()),
      metrics: {
        ...withAgent(makeMacSpark()).metrics,
        runtimes: [],
        agentOnline: false,
      },
    } as SparkSnapshot;
    const down = render(<OverviewPage sparks={[agentDown]} />);
    expect(down.container.textContent).toContain("agent is not answering");
    expect(down.container.textContent).not.toContain("Nothing serving");
  });

  it("shows no runtime section at all for a Mac read over SSH", () => {
    const { container } = render(<OverviewPage sparks={[makeMacSpark()]} />);
    expect(container.textContent).not.toContain("Nothing serving");
    expect(container.textContent).not.toContain("Runtimes");
  });
});

describe("existing DGX behaviour is untouched", () => {
  it("still reports GPU power as draw over limit", () => {
    const { container } = render(<OverviewPage sparks={[makeSpark("spark-1", true)]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("50 / 100 W");
    expect(text).not.toContain("unavailable");
    const badge = container.querySelector('[data-testid="platform-badge"]')?.textContent;
    expect(badge).toBe("DGX");
  });
});
