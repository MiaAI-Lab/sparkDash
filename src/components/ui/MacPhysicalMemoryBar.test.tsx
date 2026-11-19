import { expect, it } from "vitest";
import { render } from "../../testing/render";
import { MacPhysicalMemoryBar } from "./MacPhysicalMemoryBar";
import { UnifiedMemoryPanel } from "../SparkPage/UnifiedMemoryPanel";
import { OverviewPage } from "../OverviewPage/OverviewPage";
import { makeSpark } from "../../testing/fixtures";

const memory = {
  total: 16384, used: 8704, available: 7680, memoryPressure: "normal" as const,
  physical: { apps: 4608, wired: 2048, compressed: 1024, cached: 3584, free: 4096, other: 1024 },
  swap: { total: 8192, used: 2048, free: 6144 },
};

it("shows a conserved physical stack and labels reclaimable cache and disk swap", () => {
  const { container } = render(<MacPhysicalMemoryBar memory={memory} />);
  const segments = [...container.querySelectorAll<HTMLElement>("[data-memory-segment]")];
  expect(segments.map((el) => el.dataset.memorySegment)).toEqual(["apps", "wired", "compressed", "cached", "other", "free"]);
  expect(segments.reduce((sum, el) => sum + parseFloat(el.style.getPropertyValue("--bar-pct")), 0)).toBeCloseTo(100);
  expect(container.textContent).toContain("Cache (reclaimable)");
  expect(container.textContent).toContain("Swap on disk");
  expect(container.textContent).toContain("Normal");
  expect(container.querySelector('[data-memory-segment="swap"]')).toBeNull();
});

it("keeps unavailable pressure and breakdown explicit", () => {
  const { container } = render(<MacPhysicalMemoryBar memory={{ ...memory, memoryPressure: "unknown", physical: null }} />);
  expect(container.textContent).toContain("Unavailable");
  expect(container.textContent).toContain("Physical breakdown unavailable");
  expect(container.querySelector("[data-memory-segment]")).toBeNull();
  expect(container.textContent).not.toContain("Normal");
});

it("uses the same physical stack in the Mac overview and detail panel", () => {
  const um = { ...memory, gpuUsed: 1024, cpuUsed: 7680, percentage: 53, oomRisk: "low" as const, bandwidth: { current: 0, peak: 0 } };
  const detail = render(<UnifiedMemoryPanel um={um} gpu={null} llm={[]} />);
  expect(detail.container.querySelector("[data-mac-memory]")).not.toBeNull();
  const spark = makeSpark("mac-host", true);
  spark.kind = "host";
  spark.platform = "darwin";
  spark.metrics.unifiedMemory = um;
  const overview = render(<OverviewPage sparks={[spark]} />);
  expect(overview.container.querySelectorAll("[data-mac-memory]")).toHaveLength(1);
  expect(overview.container.querySelector("[data-vram-breakdown]")).toBeNull();
  expect(overview.container.querySelector(".ov-sc__stats")?.textContent).not.toContain("VRAM");
});
