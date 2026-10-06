import { describe, expect, it } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { MetricBar } from "../ui/MetricBar";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

/** RTX PRO 6000 host as observed live: sglang holds 93.9 of 95.6 GB. */
function rtxHost(llmAvailable = true) {
  const spark = makeSpark("rtx");
  Object.assign(spark, { kind: "host" });
  spark.metrics.gpu!.vram = { used: 94_612, total: 97_887, available: 3_275, percentage: 97 };
  spark.metrics.gpu!.processes = [
    { pid: 4009, name: "sglang::scheduler", vramMB: 93_932 },
    { pid: 3824, name: "python", vramMB: 550 },
  ];
  Object.assign(spark.metrics.llm[0], { available: llmAvailable, backend: "sglang", kvCacheUsage: 0 });
  return spark;
}

/** spark-1 as observed live: unified pool 94% full, 7.2 GB available. */
function spark1() {
  const spark = makeSpark("spark-1");
  Object.assign(spark, { role: "head" });
  spark.metrics.gpu!.vram = { used: 101_008, total: 124_610, available: 7_412, percentage: 81 };
  spark.metrics.gpu!.processes = [{ pid: 92_271, name: "python3", vramMB: 101_008 }];
  spark.metrics.unifiedMemory = {
    total: 124_610,
    gpuUsed: 101_008,
    cpuUsed: 16_190,
    used: 117_198,
    available: 7_412,
    percentage: 94,
    oomRisk: "high",
    bandwidth: { current: 0, peak: 400 },
  };
  Object.assign(spark.metrics.llm[0], { backend: "tensorfold", kvCacheUsage: 0.0549 });
  return spark;
}

/** spark-2 as observed live: a worker whose python3 rank holds 97.6 GB. */
function workerOf(headId: string) {
  const spark = makeSpark("spark-2");
  Object.assign(spark, { role: "worker", workerNode: true, workerHeadId: headId });
  spark.metrics.gpu!.vram = { used: 99_952, total: 124_610, available: 9_652, percentage: 80 };
  spark.metrics.gpu!.processes = [{ pid: 92_271, name: "/usr/bin/python3", vramMB: 99_952 }];
  spark.metrics.llm = [];
  return spark;
}

const cards = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".overview-card"));

function availableStat(card: HTMLElement) {
  const label = Array.from(card.querySelectorAll("span")).find((s) => s.textContent === "Available");
  return label?.nextElementSibling as HTMLElement | undefined;
}

describe("Overview VRAM bar", () => {
  it("is the breakdown by default: spark-1 shows engine + system and amber headroom", () => {
    const { container } = render(<OverviewPage sparks={[spark1()]} />);
    const card = cards(container)[0];
    const bar = card.querySelector<HTMLElement>("[data-vram-breakdown]")!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain("Unified memory");
    expect(
      Array.from(bar.querySelectorAll<HTMLElement>("[data-segment]")).map((s) => s.dataset.segment),
    ).toEqual(["engine", "system"]);
    const headroom = bar.querySelector<HTMLElement>("[data-headroom]")!;
    expect(headroom.textContent).toBe("7.2 GB free");
    expect(headroom.className).toContain("text-warning");
    // No legend on the card — the tooltip carries it.
    expect(bar.querySelector("[data-legend]")).toBeNull();
    // Available mini-stat agrees with the header (was red under 16 GB → amber now).
    const avail = availableStat(card)!;
    expect(avail.textContent).toBe("7.2 GB");
    expect(avail.className).toContain("text-warning");
  });

  it("judges the RTX host by discrete headroom: 3.2 GB free is fine", () => {
    const { container } = render(<OverviewPage sparks={[rtxHost()]} />);
    const card = cards(container)[0];
    const bar = card.querySelector<HTMLElement>("[data-vram-breakdown]")!;
    expect(bar.textContent).toContain("VRAM");
    expect(
      Array.from(bar.querySelectorAll<HTMLElement>("[data-segment]")).map((s) => s.dataset.segment),
    ).toEqual(["engine", "other"]);
    expect(bar.querySelector("[data-headroom]")?.className).toContain("text-text");
    expect(availableStat(card)?.className).toContain("text-text");
  });

  it("draws one GPU segment when no LLM endpoint is online", () => {
    const { container } = render(<OverviewPage sparks={[rtxHost(false)]} />);
    const segs = cards(container)[0].querySelectorAll<HTMLElement>("[data-segment]");
    expect(Array.from(segs).map((s) => s.dataset.segment)).toEqual(["gpu"]);
  });

  it("treats a worker as serving when its head has an endpoint online", () => {
    const { container } = render(<OverviewPage sparks={[spark1(), workerOf("spark-1")]} />);
    const bar = cards(container)[1].querySelector<HTMLElement>("[data-vram-breakdown]")!;
    expect(bar.querySelector('[data-segment="engine"]')).not.toBeNull();
    expect(bar.querySelector('[role="tooltip"]')?.textContent).toContain("KV in use 5%");
  });

  it("keeps a worker's GPU as one segment when its head is offline", () => {
    const head = makeSpark("spark-1", false);
    const { container } = render(<OverviewPage sparks={[head, workerOf("spark-1")]} />);
    const bar = cards(container)[1].querySelector<HTMLElement>("[data-vram-breakdown]")!;
    expect(bar.querySelector('[data-segment="engine"]')).toBeNull();
    expect(bar.querySelector('[data-segment="gpu"]')).not.toBeNull();
  });

  it("with the setting off, renders exactly today's single threshold bar and Available tone", () => {
    const { container } = render(<OverviewPage sparks={[spark1()]} showVramBreakdown={false} />);
    const card = cards(container)[0];
    expect(card.querySelector("[data-vram-breakdown]")).toBeNull();
    expect(card.querySelector("[data-segment]")).toBeNull();

    // The card's first bar block is byte-for-byte the MetricBar main renders.
    const expected = render(
      <MetricBar label="VRAM" value={101_008} max={124_610} color="bg-accent" caption="98.6 / 121.7 GB" />,
    ).container.firstElementChild!.outerHTML;
    const vramBlock = Array.from(card.querySelectorAll("span"))
      .find((s) => s.textContent === "VRAM")!
      .closest(".space-y-1")!;
    expect(vramBlock.outerHTML).toBe(expected);
    expect(vramBlock.querySelector(".metric-bar-fill")?.className).toContain("bg-warning"); // 81%

    // Old Available rule: < 16384 MB warning, < 4096 danger.
    const avail = availableStat(card)!;
    expect(avail.textContent).toBe("7.2 GB");
    expect(avail.className).toContain("text-warning");
  });

  it("with the setting off, the RTX host keeps its red bar and red Available", () => {
    const { container } = render(<OverviewPage sparks={[rtxHost()]} showVramBreakdown={false} />);
    const card = cards(container)[0];
    expect(card.querySelector("[data-vram-breakdown]")).toBeNull();
    const fill = Array.from(card.querySelectorAll("span"))
      .find((s) => s.textContent === "VRAM")!
      .closest(".space-y-1")!
      .querySelector(".metric-bar-fill");
    expect(fill?.className).toContain("bg-danger");
    expect(availableStat(card)?.className).toContain("text-danger");
  });
});
