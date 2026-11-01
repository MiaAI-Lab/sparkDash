import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

function worker(): SparkSnapshot {
  return { ...makeSpark("w"), role: "worker", workerNode: true, workerHeadId: "h", workerLabel: "cfg-label" } as SparkSnapshot;
}
function head(online: boolean): SparkSnapshot {
  const h = makeSpark("h", online);
  return {
    ...h,
    role: "head",
    metrics: { ...h.metrics, llm: [{ available: true, backend: "vllm", modelId: "big-model", generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}

describe("SparkCard", () => {
  it("shows one bar per card on a multi-GPU host, with load, temperature and power under it", () => {
    const spark = makeSpark("rtx");
    const card = (index: number, used: number, temperature: number, draw: number) => ({
      index, name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", uuid: `GPU-${index}`, temperature, usage: 100,
      power: { draw, limit: 300 }, vram: { used, total: 97887, percentage: Math.round((used / 97887) * 100), available: 97887 - used },
    });
    spark.metrics.gpu = {
      ...spark.metrics.gpu!, usage: 100, temperature: 81, power: { draw: 600.08, limit: 600 },
      vram: { used: 59426, total: 195774, percentage: 30, available: 136348 },
      gpus: [card(0, 52646, 81, 300.04), card(1, 6780, 63, 299.97)],
    };
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const bars = [...container.querySelectorAll(".ov-lbl")].map((row) => row.textContent);
    const stats = [...container.querySelectorAll(".ov-gpu-stats")].map((row) => row.textContent);
    expect(bars.filter((b) => b?.startsWith("GPU"))).toEqual(["GPU 0 VRAM51.4 / 95.6 GB", "GPU 1 VRAM6.6 / 95.6 GB"]);
    expect(stats).toEqual(["Load 100%Temp 81°CPower 300 / 300 W", "Load 100%Temp 63°CPower 300 / 300 W"]);
    // Only the hot card's temperature is marked.
    expect([...container.querySelectorAll(".ov-gpu-stats__hot")].map((el) => el.textContent)).toEqual(["81°C"]);
    // No aggregate VRAM, usage, temperature or power rows next to the per-card bars.
    expect(bars.some((b) => /^(VRAM|GPU temp|GPU power)/.test(b ?? ""))).toBe(false);
  });

  it("keeps the single GPU rows on a one-GPU unit", () => {
    const spark = makeSpark("one");
    spark.metrics.gpu = { ...spark.metrics.gpu!, gpus: [{ index: 0, name: "NVIDIA GB10", uuid: null, temperature: 55, usage: 42, power: { draw: 50, limit: 100 }, vram: { used: 1024, total: 4096, percentage: 25, available: 3072 } }] };
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const bars = [...container.querySelectorAll(".ov-lbl")].map((row) => row.textContent);
    expect(bars).toContain("GPU42%");
    expect(bars).toContain("GPU temp55°C");
    expect(bars).toContain("GPU power50 / 100 W");
    expect(bars.some((b) => b?.startsWith("GPU 0"))).toBe(false);
  });

  it.each([null, undefined, 0, 2])("renders queue %s without inventing a zero", (waiting) => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: 8, slotsTotal: 8,
      requestsRunning: 8, requestsWaiting: waiting,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain(
      waiting == null ? "8 running · queue unknown" : `8 running · ${waiting} queued`
    );
  });

  it("renders unknown slot occupancy without presenting it as zero", () => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: null, slotsTotal: 8, requestsRunning: null,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain("?/8 slots");
  });

  it("names the parallel capacity next to running and queued, so --parallel 4 and 8 read differently", () => {
    for (const total of [4, 8]) {
      const spark = makeSpark("fixture");
      Object.assign(spark.metrics.llm[0], {
        backend: "tensorfold", slotsActive: 1, slotsTotal: total, requestsRunning: 1, requestsWaiting: 0,
      });
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const chip = container.querySelector(".ov-chips")!;
      expect(chip.textContent).toContain(`1 running · 0 queued · ${total} slots`);
      expect(chip.querySelector(`[title="${total} requests decode in parallel on this engine"]`)).not.toBeNull();
    }
  });

  it("adds no slot count when the engine reports no capacity", () => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "vllm", slotsActive: 0, slotsTotal: 0, requestsRunning: 2, requestsWaiting: 1,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const text = container.querySelector(".ov-chips")!.textContent!;
    expect(text).toContain("2 running · 1 queued");
    expect(text).not.toContain("slots");
  });
  it("lists private loaded models alongside the monitored model without duplicates", () => {
    const spark = head(true);
    spark.metrics.residentModels = [
      { modelId: "big-model", container: "primary-vllm" },
      { modelId: "datalab-to/surya-ocr-2", container: "surya-vllm" },
    ];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const rows = [...container.querySelectorAll(".ov-modelrow code")].map((row) => row.textContent);
    expect(rows).toEqual(["big-model", "datalab-to/surya-ocr-2"]);
    expect(container.querySelectorAll(".ov-modelrow")[1].textContent).toContain("Loaded");
  });

  it("does not present an offline unit's discovered models as loaded", () => {
    const spark = head(false);
    spark.metrics.residentModels = [{ modelId: "surya-private", container: "surya-vllm" }];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("surya-private");
  });
  it("is a plain container whose name is the only link; no interactive element nests another", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    const card = container.querySelector(".ov-sc")!;
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>("a.ov-sc__link")!;
    expect(link.textContent).toBe("Spark a");
    for (const el of card.querySelectorAll("button, a, [role=button]")) {
      expect(el.querySelector("button, a, [role=button]")).toBeNull();
    }
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("does not select when clicking the card body (only the stretched name does)", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    act(() => container.querySelector<HTMLElement>(".ov-sc__body")?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a worker shows its online head's model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(true)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("big-model");
  });

  it("a worker does not show an offline head's stale model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(false)} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("big-model");
    expect(container.textContent).toContain("cfg-label");
    expect(container.textContent).toContain("Head is offline");
  });

  it("an online head with no available probe is unready, not known to have no model", () => {
    // A head that is cold-starting or switching model produces the same empty probe
    // state as an idle one, so residency is unknown and must not be asserted.
    const unready = { ...head(true) } as SparkSnapshot;
    unready.metrics = {
      ...unready.metrics,
      llm: [{ available: false, backend: "vllm", modelId: null, generationTps: 0, prefillTps: 0, contextLength: null }],
    } as unknown as SparkSnapshot["metrics"];
    const bare = { ...worker(), workerLabel: "", workerDerivedLabel: "" } as SparkSnapshot;
    const { container } = render(<SparkCard spark={bare} headSpark={unready} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("No model");
    expect(container.textContent).toContain("not ready");
  });

  it("says when no LLM port is watched on the head instead of claiming no model", () => {
    const unwatched = { ...head(true) } as SparkSnapshot;
    unwatched.metrics = { ...unwatched.metrics, llm: [] } as unknown as SparkSnapshot["metrics"];
    const bare = { ...worker(), workerLabel: "", workerDerivedLabel: "" } as SparkSnapshot;
    const { container } = render(<SparkCard spark={bare} headSpark={unwatched} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("No model");
    expect(container.textContent).toContain("No LLM port is watched on the head");
  });
});

describe("SparkCard per-stream decode rate", () => {
  it("shows the per-stream rate when the engine reports one", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { generationTps: 40, perStreamTps: 18.5 });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("18.5 tok/s per stream");
  });
  it("omits the per-stream line when the engine has no histogram", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { generationTps: 40, perStreamTps: null });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("per stream");
  });
});

describe("SparkCard effective prefill rate", () => {
  it("labels the per-request prefill as effective (incl. cached tokens)", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { prefillTps: 2813, perStreamPrefillTps: 2813 });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("2,813 tok/s per request — effective (incl. cached tokens)");
  });
  it("omits the prefill line when no request has finished", () => {
    const spark = head(true);
    Object.assign(spark.metrics.llm[0], { prefillTps: 0, perStreamPrefillTps: null });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("effective (incl. cached tokens)");
  });
});
