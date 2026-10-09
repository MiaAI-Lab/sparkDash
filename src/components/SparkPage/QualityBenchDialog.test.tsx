import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { getQualityBench, listQualityBench } from "../../api/client";
import type { QualityBenchDefaults, QualityBenchJob } from "../../api/types";
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

  const defaults: QualityBenchDefaults = {
    categories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"],
    defaultCategories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu"],
    longSizes: [8192],
    defaultLongSizes: [32768],
    defaultLongItems: 2,
    maxLongItems: 5,
    defaultConcurrency: 4,
    maxConcurrency: 16,
  };

  it("refuses to compare runs scored by different rules", async () => {
    const current = run("b2", "new", [true, true, true, false], "a");
    current.config.scoringVersion = 2;
    const previous = run("b1", "old", [true, false, true, true], "b");
    previous.config.scoringVersion = 1;
    const { items: _items, ...prevSummary } = previous.results;
    vi.mocked(listQualityBench).mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...previous, results: prevSummary }],
      defaults,
    });
    vi.mocked(getQualityBench).mockResolvedValue(previous);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "b1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(dialog.textContent).toContain("scored by different rules");
    expect(dialog.textContent).not.toContain("McNemar p =");
  });

  it("starts a new run with a blank label and marks the item filters as toggles", async () => {
    const current = run("b2", "fp4 KV", [true, false], "a");
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current], defaults });
    render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const input = document.querySelector('input[placeholder="e.g. fp4 KV"]') as HTMLInputElement;
    expect(input.value).toBe("");
    const filters = [...document.querySelectorAll("details button")] as HTMLButtonElement[];
    expect(filters.length).toBeGreaterThan(1);
    expect(filters.every((b) => b.getAttribute("aria-pressed") != null)).toBe(true);
    expect(filters[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a running job as a progressbar with a polite status", async () => {
    const running = run("b3", "", [true], "a");
    running.status = "running";
    running.progress = { currentCategory: "qa", categoryDone: 1, categoryTotal: 4, done: 1, total: 4, message: "QA…" };
    running.results = { overallPct: 100, skippedLongSizes: [], itemCount: 1, categories: running.results.categories };
    vi.mocked(listQualityBench).mockResolvedValue({ active: running, last: null, history: [], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(running);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Running");
  });

  it("disables long sizes with the server's context rule (1.2x + 512)", async () => {
    const current = run("b2", "x", [true], "a");
    current.config.categories = ["long"];
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: null, history: [], defaults });
    render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={10000} />);
    await flush();
    // enable the long category chip
    const chips = [...document.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[];
    const longChip = chips.find((b) => /Long-context/i.test(b.textContent ?? ""));
    expect(longChip).toBeTruthy();
    await act(async () => longChip!.click());
    const size8k = [...document.querySelectorAll('[aria-label="Long-context sizes"] button')].find((b) => b.textContent === "8k") as HTMLButtonElement;
    // 8192*1.2 = 9831 + 512 = 10343 > 10000 -> disabled (the old n+512 rule would allow it)
    expect(size8k.disabled).toBe(true);
  });
});
