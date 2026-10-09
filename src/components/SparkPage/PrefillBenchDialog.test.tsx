import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { listPrefillBench } from "../../api/client";
import type { PrefillBenchJob, PrefillBenchSizeResult } from "../../api/types";
import { flush, render } from "../../testing/render";
import { PrefillBenchDialog } from "./PrefillBenchDialog";

vi.mock("../../api/client", () => ({
  cancelPrefillBench: vi.fn(),
  clearPrefillBenchHistory: vi.fn(),
  getPrefillBench: vi.fn(),
  listPrefillBench: vi.fn(),
  startPrefillBench: vi.fn(),
}));

const row = (over: Partial<PrefillBenchSizeResult>): PrefillBenchSizeResult => ({
  targetTokens: 4096,
  promptTokens: 4000,
  promptChars: 16000,
  prefillTps: 4000,
  method: "ttft",
  samples: 3,
  samplesRequested: 3,
  overheadMs: 100,
  ttftMs: 1000,
  ttftContentMs: null,
  completionTokens: 8,
  durationMs: 3300,
  model: "m",
  error: null,
  ...over,
});

function job(results: PrefillBenchSizeResult[], over: Partial<PrefillBenchJob> = {}): PrefillBenchJob {
  return {
    benchId: "p1",
    sparkId: "s1",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: { port: 8888, modelId: "m", contextSizes: results.map((r) => r.targetTokens) },
    progress: { currentContext: null, completedLevels: results.length, totalLevels: results.length, message: "Done" },
    results,
    error: null,
    durationMs: 1000,
    ...over,
  };
}

const defaults = { allowedContextSizes: [1024, 4096, 8192], defaultContextSizes: [4096], minContextSize: 256, maxContextSize: 300000 };

describe("PrefillBenchDialog", () => {
  it("shows why a size failed, has no bar for it, and flags partial and low-confidence rows", async () => {
    const j = job([
      row({ targetTokens: 1024, prefillTps: 0, error: "The whole prompt was served from the prefix cache", samples: 0 }),
      row({ targetTokens: 4096, samples: 1, notice: "1 of 3 samples succeeded (HTTP 500); later repeats were skipped", lowConfidence: true }),
    ]);
    vi.mocked(listPrefillBench).mockResolvedValue({ active: null, last: j, history: [j], defaults });
    render(<PrefillBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={32768} />);
    await flush();
    const rows = [...document.querySelectorAll(".bench-result-row")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("failed");
    expect(rows[0].textContent).toContain("The whole prompt was served from the prefix cache");
    expect(rows[0].querySelector(".bench-result-row__bar")).toBeNull();
    expect(rows[0].textContent).not.toContain("0.0tok/s");
    expect(rows[1].textContent).toContain("1 of 3 samples succeeded");
    expect(rows[1].textContent).toContain("Low confidence");
    expect(rows[1].querySelector(".bench-result-row__bar")).not.toBeNull();
  });

  it("describes the real prefill method in the legend", async () => {
    const j = job([row({})]);
    vi.mocked(listPrefillBench).mockResolvedValue({ active: null, last: j, history: [j], defaults });
    render(<PrefillBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={32768} />);
    await flush();
    const legend = document.querySelector(".bench-legend")!.textContent!;
    expect(legend).toContain("server");
    expect(legend).toContain("TTFT − calibrated request overhead");
    expect(legend).toContain("median-rate sample");
    expect(legend).not.toContain("prompt tokens ÷ time to first token");
  });

  it("marks context chips as toggles and disables sizes that do not fit with the template and reply", async () => {
    vi.mocked(listPrefillBench).mockResolvedValue({ active: null, last: null, history: [], defaults });
    render(<PrefillBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={4096} />);
    await flush();
    const chips = [...document.querySelectorAll('[aria-label="Context sizes"] button')] as HTMLButtonElement[];
    expect(chips.every((b) => b.hasAttribute("aria-pressed"))).toBe(true);
    const k4 = chips.find((b) => b.textContent === "4k")!;
    expect(k4.disabled).toBe(true); // 4096 + reserve > 4096
    expect(chips.find((b) => b.textContent === "2k")!.disabled).toBe(false);
  });

  it("exposes a running job as a progressbar with a polite live status", async () => {
    const j = job([row({})], {
      status: "running",
      progress: { currentContext: 8192, completedLevels: 1, totalLevels: 4, message: "Prefilling 8k…" },
    });
    vi.mocked(listPrefillBench).mockResolvedValue({ active: j, last: null, history: [], defaults });
    render(<PrefillBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={32768} />);
    await flush();
    await act(async () => {});
    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(document.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });
});
