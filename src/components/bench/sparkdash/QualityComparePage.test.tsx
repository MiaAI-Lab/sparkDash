import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getQualityBench, listQualityBenchFleet } from "../../../api/client";
import type { QualityBenchJob } from "../../../api/types";
import { flush, render } from "../../../testing/render";
import { QualityComparePage } from "./QualityComparePage";

vi.mock("../../../api/client", () => ({
  getQualityBench: vi.fn(),
  getQualityFidelityCompare: vi.fn(),
  listQualityBenchFleet: vi.fn(),
  setQualityReference: vi.fn(),
  clearQualityReference: vi.fn(),
}));

function run(benchId: string, sparkId: string, unit: string, label: string, modelId: string, oks: boolean[]): QualityBenchJob {
  const passed = oks.filter(Boolean).length;
  return {
    benchId,
    sparkId,
    unit: { id: sparkId, name: unit },
    status: "completed",
    startedAt: 1_780_000_000_000,
    completedAt: 1_780_000_060_000,
    durationMs: 60_000,
    error: null,
    cost: { decodeTps1: sparkId === "rtx" ? 120 : 60, weightsGb: sparkId === "rtx" ? 60 : 230 },
    config: { port: 8888, modelId, contextLength: 32768, suiteVersion: 2, scoringVersion: 4, profile: "custom", categories: ["arith"], longSizes: [], longItems: 3, concurrency: 4, label },
    progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: oks.length, total: oks.length, message: "Done" },
    results: {
      overallPct: null,
      skippedLongSizes: [],
      itemCount: oks.length,
      categories: { arith: { passed, total: oks.length, scored: oks.length, pct: Math.round((passed / oks.length) * 1000) / 10, errors: 0, meanCompletionTokens: 5, hitMaxTokens: 0 } },
      items: oks.map((ok, i) => ({ id: `arith-${String(i + 1).padStart(3, "0")}`, category: "arith" as const, ok, excerpt: "x", hash: ok ? "p" : `f${i}`, finishReason: "stop", completionTokens: 5, promptTokens: 20, durationMs: 1, error: null, detail: null })),
    },
  };
}

describe("QualityComparePage", () => {
  const rtx = run("r1", "rtx", "RTX 6k", "exl3", "GLM-5.3-Flash", Array.from({ length: 40 }, (_, i) => i < 30));
  const spark = run("s1", "spark3", "Spark 1", "fp8", "GLM-5.3-Flash-FP8", Array.from({ length: 40 }, (_, i) => i < 39));
  const summary = (j: QualityBenchJob) => {
    const { items: _i, ...rest } = j.results;
    return { ...j, results: rest };
  };
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listQualityBenchFleet).mockResolvedValue({
      runs: [summary(spark), summary(rtx)],
      references: { "glm-5.3-flash": { sparkId: "spark3", benchId: "s1", modelId: "GLM-5.3-Flash-FP8", pinnedAt: 1 } },
    });
    vi.mocked(getQualityBench).mockImplementation(async (sparkId: string, benchId: string) => (benchId === "r1" ? rtx : spark));
  });

  it("lists every unit's runs, fills B with the pinned reference and renders the plain-words verdict", async () => {
    const { root } = render(<QualityComparePage />);
    await flush();
    const selects = document.querySelectorAll("select");
    expect(selects).toHaveLength(2);
    expect(document.querySelectorAll("optgroup").length).toBe(4); // two units in each picker
    expect(document.body.textContent).toContain("Nothing to compare yet");
    // pick A = the RTX run; B follows the pinned FP8 reference on the Spark
    await act(async () => {
      selects[0].value = "rtx\u0000r1";
      selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();
    expect(getQualityBench).toHaveBeenCalledWith("rtx", "r1");
    expect(getQualityBench).toHaveBeenCalledWith("spark3", "s1");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Where it differs");
    expect(text).toContain("Maths and reasoning");
    // 30/40 vs 39/40 on paired items: B (fp8) better, beyond noise
    expect(text).toContain("fp8 better");
    expect(text).toContain("Arithmetic chain -22.5 pts");
    expect(text).toContain("Speed and memory");
    expect(text).toContain("120.0 vs 60.0 tok/s single stream, 60.0 vs 230.0 GB");
    expect(text).toContain("this compares serving configurations, not only weights");
    expect(JSON.parse(localStorage.getItem("sparkdash.quality.compare") ?? "{}")).toEqual({ a: { sparkId: "rtx", benchId: "r1" }, b: { sparkId: "spark3", benchId: "s1" } });
    await act(async () => root.unmount());
  });
});
