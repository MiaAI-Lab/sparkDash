import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchSparkMetrics, fetchSparks, listShowcase } from "../../api/client";
import type { SparkConfig } from "../../api/types";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { ShowcasePage } from "./ShowcasePage";

vi.mock("../../api/client", () => ({
  cancelShowcase: vi.fn(),
  cancelShowcaseBeacon: vi.fn(),
  clearShowcaseHistory: vi.fn(),
  fetchSparkMetrics: vi.fn(),
  fetchSparks: vi.fn(),
  getShowcase: vi.fn(),
  listShowcase: vi.fn(),
  startShowcase: vi.fn(),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await act(() => setLocale("en"));
});

it("localizes the clear-history confirmation after a locale switch", async () => {
  vi.mocked(fetchSparks).mockResolvedValue({
    sparks: [makeSpark() as unknown as SparkConfig],
  });
  vi.mocked(fetchSparkMetrics).mockResolvedValue({ metrics: { llm: [] } } as never);
  vi.mocked(listShowcase).mockResolvedValue({
    active: null,
    history: [{
      sessionId: "session-1", sparkId: "spark-1", status: "completed", port: 8000,
      streamCount: 1, totalTokens: 0, meanDecodeTps: 0, peakStreamTps: 0,
    }],
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { container } = render(<ShowcasePage sparkId="spark-1" embedded />);
  await flush();
  await flush();
  await act(() => setLocale("zh-CN"));
  await flush();

  expect(container.textContent).toContain("历史");
  const historyButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.startsWith("历史"))!;
  act(() => historyButton.click());
  await flush();
  const clearButton = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "清空")!;
  act(() => clearButton.click());

  expect(confirm).toHaveBeenCalledWith("清空此 Spark 的全部已保存演示历史？");
});
