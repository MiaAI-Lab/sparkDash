// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchTrainingProgress, type TrainingProgress } from "../../api/trainingClient";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { TrainingPage } from "./TrainingPage";

vi.mock("../../api/trainingClient", () => ({ fetchTrainingProgress: vi.fn() }));

function report(): TrainingProgress {
  return {
    enabled: true, error: null, truncated: false,
    units: [{ sparkId: "worker-host", label: "Example host", status: "live" }],
    runs: [{ id: "classification", campaign: "Synthetic classification", model: "Example model", sources: [{
      id: "reporter", sparkId: "worker-host", label: "Reporter A", status: "live", reportedAt: Date.now(),
      stages: {
        data: [{ id: "prepare", label: "Prepare examples", state: "complete", completed: 10, total: 10, unit: "samples" }],
        training: [{ id: "fit", label: "Optimizer", state: "running", completed: 0, total: null, unit: "steps", etaSeconds: 0,
          metrics: [{ label: "Loss", value: 0 }, { label: "Accuracy", value: null, unit: "%" }] }],
        evaluation: [{ id: "score", label: "Final validation", state: "waiting", completed: null, total: 20, unit: "samples" }],
      },
    }] }],
  };
}

beforeEach(async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(fetchTrainingProgress).mockResolvedValue(report());
  await setLocale("en");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await act(async () => setLocale("en"));
});

it("renders only reported counters, units, metrics and ETA, preserving zero and unknown", async () => {
  const { container } = render(<TrainingPage />);
  await flush();
  expect(container.textContent).toContain("Synthetic classification");
  expect(container.textContent).toContain("Example model");
  expect(container.textContent).toContain("Example host");
  const rows = container.querySelectorAll(".training-stage");
  expect(rows[0].textContent).toContain("10 / 10 samples");
  expect(rows[1].textContent).toContain("0 / unknown steps");
  expect(rows[1].querySelector(".training-eta")?.textContent).toBe("Reported remaining: 0 s");
  expect([...rows[1].querySelectorAll("dd")].map((row) => row.textContent)).toEqual(["0", "unknown %"]);
  expect(rows[2].textContent).toContain("unknown / 20 samples");
  expect(rows[2].querySelector(".training-eta")).toBeNull();
  expect(rows[0].querySelector(".tag")?.textContent).toBe("Complete");
  // A reported count reaching its total never supplies a state or ETA for another row.
  expect(rows[2].querySelector(".tag")?.textContent).toBe("Waiting");
});

it("labels stale reports and suppresses their current ETA while preserving historical measurements", async () => {
  const data = report();
  data.runs[0].sources[0].status = "stale";
  vi.mocked(fetchTrainingProgress).mockResolvedValue(data);
  const { container } = render(<TrainingPage />);
  await flush();
  expect(container.querySelector(".training-source")?.getAttribute("data-status")).toBe("stale");
  expect(container.textContent).toContain("Stale report");
  expect(container.textContent).toContain("Last reported: Running");
  expect(container.textContent).toContain("0 / unknown steps");
  expect(container.querySelector(".training-eta")).toBeNull();
});

it("does not round small reported values to zero or lose safe-integer progress precision", async () => {
  const data = report();
  const row = data.runs[0].sources[0].stages.training[0];
  row.completed = 0.00004;
  row.total = Number.MAX_SAFE_INTEGER;
  row.metrics = [{ label: "Small loss", value: 0.00000001 }];
  vi.mocked(fetchTrainingProgress).mockResolvedValue(data);
  const { container } = render(<TrainingPage />);
  await flush();
  expect(container.querySelectorAll(".training-count")[1].textContent).toContain("0.00004 / 9,007,199,254,740,991 steps");
  expect(container.querySelector(".training-metrics dd")?.textContent).toBe("0.00000001");
});

it("retains a failed refresh as stale, retries on visibility and hides ETA without fabricating zero", async () => {
  vi.useFakeTimers();
  const { container } = render(<TrainingPage />);
  await flush();
  vi.mocked(fetchTrainingProgress).mockRejectedValueOnce(new Error("network"));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.querySelector("[role=alert]")?.textContent).toContain("last received reports are shown as stale");
  expect(container.querySelector(".training-source")?.getAttribute("data-status")).toBe("stale");
  expect(container.querySelector(".training-eta")).toBeNull();
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(container.querySelector("[role=alert]")).toBeNull();
  expect(container.querySelector(".training-source")?.getAttribute("data-status")).toBe("live");
});

it("does not poll a hidden page, aborts its own request on unmount and never overlaps requests", async () => {
  vi.useFakeTimers();
  let hidden = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const { root } = render(<TrainingPage />);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetchTrainingProgress).not.toHaveBeenCalled();
  vi.mocked(fetchTrainingProgress).mockImplementationOnce(() => new Promise(() => {}));
  hidden = false;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchTrainingProgress).toHaveBeenCalledOnce();
  const signal = vi.mocked(fetchTrainingProgress).mock.calls[0][0];
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fetchTrainingProgress).toHaveBeenCalledOnce();
  act(() => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(fetchTrainingProgress).toHaveBeenCalledOnce();
});

it("relocalizes labels without refetching or changing worker text, stage values and document IDs", async () => {
  const { container } = render(<TrainingPage />);
  await flush();
  await act(async () => setLocale("zh-CN"));
  expect(container.querySelector("h1")?.textContent).toBe("训练进度");
  expect(container.textContent).toContain("Synthetic classification");
  expect(container.textContent).toContain("0 / 未知 steps");
  expect(container.textContent).toContain("报告的剩余时间：0 秒");
  await act(async () => setLocale("en"));
  expect(container.querySelector("h1")?.textContent).toBe("Training progress");
  expect(fetchTrainingProgress).toHaveBeenCalledOnce();
});

it("shows unsupported/unavailable units, config errors and collection limits independently of empty data", async () => {
  const data = report();
  data.runs = [];
  data.error = "Invalid configuration <raw>";
  data.truncated = true;
  data.units = [{ sparkId: "offline", label: "Offline host", status: "unavailable", detail: "Read unavailable" },
    { sparkId: "other", label: "Other host", status: "unsupported" }];
  vi.mocked(fetchTrainingProgress).mockResolvedValue(data);
  const { container } = render(<TrainingPage />);
  await flush();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Invalid configuration <raw>");
  expect(container.querySelector("raw")).toBeNull();
  expect(container.textContent).toContain("No progress documents");
  expect(container.textContent).toContain("Collection unavailable");
  expect(container.textContent).toContain("Collection unsupported");
  expect(container.textContent).toContain("collection limit");
});

it("reports an initial request error rather than claiming there are no jobs", async () => {
  vi.mocked(fetchTrainingProgress).mockRejectedValue(new Error("HTTP 403"));
  const { container } = render(<TrainingPage />);
  await flush();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not load training progress");
  expect(container.textContent).not.toContain("No progress documents");
});

it("keeps successful worker reports visible while warning about partially unreadable documents", async () => {
  const data = report();
  data.units[0].detail = "Some progress documents could not be read";
  vi.mocked(fetchTrainingProgress).mockResolvedValue(data);
  const { container } = render(<TrainingPage />);
  await flush();
  const notice = container.querySelector(".training-notice")!;
  expect(notice.textContent).toContain("Example host · Partial collection");
  expect(notice.textContent).toContain("Some progress documents could not be read");
  expect(notice.textContent).not.toContain("Collection unavailable");
  expect(container.querySelector(".training-source")?.getAttribute("data-status")).toBe("live");
  expect(container.querySelector(".training-count")?.textContent).toBe("10 / 10 samples");
  expect(container.textContent).toContain("0 / unknown steps");
  expect(container.textContent).not.toContain("No progress documents");
  await act(async () => setLocale("zh-CN"));
  expect(notice.textContent).toContain("部分采集");
  expect(notice.textContent).toContain("Some progress documents could not be read");
});
