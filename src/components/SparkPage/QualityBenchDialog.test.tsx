import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { getQualityBench, listQualityBench } from "../../api/client";
import type { QualityBenchJob } from "../../api/types";
import { mcnemarExactP } from "../../shared/qualityBench.js";
import { flush, render } from "../../testing/render";
import { QualityBenchDialog } from "./QualityBenchDialog";

vi.mock("../../api/client", () => ({
  cancelQualityBench: vi.fn(),
  clearQualityBenchHistory: vi.fn(),
  getQualityBench: vi.fn(),
  listQualityBench: vi.fn(),
  startQualityBench: vi.fn(),
}));

function run(benchId: string, label: string, oks: boolean[], hashPrefix: string): QualityBenchJob {
  const passed = oks.filter(Boolean).length;
  const pct = Math.round((passed / oks.length) * 1000) / 10;
  return {
    benchId,
    sparkId: "s1",
    status: "completed",
    startedAt: 1_780_000_000_000,
    completedAt: 1_780_000_060_000,
    durationMs: 60_000,
    error: null,
    config: {
      port: 8888,
      modelId: "test-model",
      contextLength: 32768,
      suiteVersion: 1,
      categories: ["qa"],
      longSizes: [],
      longItems: 2,
      concurrency: 4,
      label,
    },
    progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: oks.length, total: oks.length, message: "Done" },
    results: {
      overallPct: pct,
      skippedLongSizes: [],
      categories: {
        qa: { passed, total: oks.length, pct, errors: 0, meanCompletionTokens: 5, hitMaxTokens: 0 },
      },
      items: oks.map((ok, i) => ({
        id: `qa-fixed-${i}`,
        category: "qa" as const,
        ok,
        excerpt: `reply ${i}`,
        hash: i === 0 ? "same" : `${hashPrefix}${i}`,
        finishReason: "stop",
        completionTokens: 5,
        promptTokens: 20,
        durationMs: 100,
        error: null,
        detail: null,
      })),
    },
  };
}

describe("QualityBenchDialog", () => {
  it("shows the last run's score and compares with a previous run", async () => {
    const current = run("b2", "fp4 KV", [true, true, true, false], "a");
    const previous = run("b1", "bf16 KV", [true, false, true, true], "b");
    const { items: _items, ...prevSummary } = previous.results;
    vi.mocked(listQualityBench).mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...previous, results: prevSummary }],
      defaults: {
        categories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"],
        defaultCategories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu"],
        longSizes: [8192],
        defaultLongSizes: [32768],
        defaultLongItems: 2,
        maxLongItems: 5,
        defaultConcurrency: 4,
        maxConcurrency: 16,
      },
    });
    vi.mocked(getQualityBench).mockResolvedValue(previous);

    render(
      <QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />
    );
    await flush();

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("75.0%");
    expect(dialog.textContent).toContain("3/4");

    const select = dialog.querySelector("select") as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    await act(async () => {
      select.value = "b1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(getQualityBench).toHaveBeenCalledWith("s1", "b1");
    expect(dialog.textContent).toContain("difference within noise");
    // one item only right in this run, one only in the other → p = 1
    expect(mcnemarExactP(1, 1)).toBe(1);
    expect(dialog.textContent).toContain("1/4");
  });
});
