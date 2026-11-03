import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: vi.fn() }));

import { fetchLlmTokenTotals } from "../../api/llmTokenClient";
import { setLocale } from "../../i18n";
import { cleanupRenders, flush, render } from "../../testing/render";
import { FleetTokenTotals } from "./FleetTokenTotals";

const fetchTotals = vi.mocked(fetchLlmTokenTotals);

beforeEach(async () => {
  await setLocale("en");
  fetchTotals.mockResolvedValue({
    range: "all",
    series: [{
      sparkId: "spark-a", port: 8080, updatedAt: null, lastModelId: "model-a",
      totals: { promptTokens: 20, cachedTokens: 5, completionTokens: 10 },
      models: [{ modelId: "model-a", promptTokens: 20, cachedTokens: 5, completionTokens: 10, lastSeenAt: 1 }],
    }],
  });
});

afterEach(async () => {
  cleanupRenders();
  vi.clearAllMocks();
  await setLocale("en");
});

it("switches metric labels without resetting the selected token range or fetching again", async () => {
  const { container } = render(<FleetTokenTotals />);
  await flush();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect(container.textContent).toContain("LLM token totals");
  expect(container.querySelector(".ov-leg--gen")?.textContent).toBe("Generated");
  expect(container.textContent).toContain("spark-a · model-a");
  expect(container.textContent).toContain("10");

  await act(async () => {
    select.value = "today";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  expect(fetchTotals).toHaveBeenCalledTimes(2);

  await act(async () => setLocale("zh-CN"));
  expect(container.textContent).toContain("LLM Token 总量");
  expect(select.value).toBe("today");
  expect(container.textContent).toContain("spark-a · model-a");
  expect(container.textContent).toContain("10");
  expect(fetchTotals).toHaveBeenCalledTimes(2);

  await act(async () => setLocale("en"));
  expect(container.textContent).toContain("LLM token totals");
  expect(container.querySelector(".ov-leg--gen")?.textContent).toBe("Generated");
  expect(select.value).toBe("today");
  expect(container.textContent).toContain("spark-a · model-a");
  expect(container.textContent).toContain("10");
  expect(fetchTotals).toHaveBeenCalledTimes(2);
});
