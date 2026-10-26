import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { CostPage } from "./CostPage";
import type { TokenHistoryRow } from "../../api/types";
import { bucketKeys } from "../TokensPage/tokenStats";

const history = { hour: [] as TokenHistoryRow[], day: [] as TokenHistoryRow[] };
vi.mock("../../api/client", () => ({ fetchTokenHistory: vi.fn(async () => history) }));
vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: vi.fn(async () => ({ series: [] })) }));
vi.mock("../../api/costClient", () => ({ fetchModelPrices: vi.fn(async () => ({
  source: "fixture", models: [{ id: "unrelated-first-model", provider: "test", mode: "chat",
    inputCostPerToken: 0.0000003, outputCostPerToken: 0.0000125,
    cacheReadCostPerToken: null, cacheWriteCostPerToken: null, maxInputTokens: 1049000, maxOutputTokens: null }],
})) }));

beforeEach(() => {
  localStorage.clear();
  history.hour = [];
  history.day = [];
});

/** One day bucket of usage on the day the test runs. */
function dayRow(row: Partial<TokenHistoryRow>): TokenHistoryRow {
  return {
    t: bucketKeys("day", 1, Date.now())[0],
    sparkId: "spark-1",
    port: 8888,
    modelId: "local-model",
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    ...row,
  } as TokenHistoryRow;
}

it("requires an explicit hosted-model choice instead of pricing as the first catalog entry", async () => {
  const { container } = render(<CostPage />);
  await flush();
  expect(container.textContent).toContain("Choose a hosted model");
  expect(container.querySelector(".cp-toggle__price")).toBeNull();
  expect(localStorage.getItem("sparkdash.cost.model")).toBeNull();
  act(() => (container.querySelector(".cp-toggle") as HTMLButtonElement).click());
  act(() => (container.querySelector(".cp-item") as HTMLButtonElement).click());
  await flush();
  expect(localStorage.getItem("sparkdash.cost.model")).toBe("unrelated-first-model");
  expect(container.textContent).toContain("$0.3 / 1M in · $12.5 / 1M out");
});

it("uses a consistent USD locale for prices and context even with a German browser", async () => {
  const original = Number.prototype.toLocaleString;
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (this: number, locales, options) {
    return original.call(this, locales ?? "de-DE", options);
  });
  localStorage.setItem("sparkdash.cost.model", "unrelated-first-model");
  const { container } = render(<CostPage />);
  await flush();
  expect(container.textContent).toContain("1,049k context");
  expect(container.textContent).toContain("$0.3 / 1M in · $12.5 / 1M out");
});

it("says the cached share is unreported instead of pricing it as a measured zero", async () => {
  // An engine that publishes no cached-prompt counter leaves the split unknown. The
  // tiles used to read "0 of them cached" and "no cache discount published", which
  // looks like a measured cache miss and hides that the whole prompt is billed at the
  // full input rate.
  history.day = [dayRow({ promptTokens: 1_000_000, completionTokens: 1000, cachedTokens: 0, cacheReported: false })];
  localStorage.setItem("sparkdash.cost.model", "unrelated-first-model");
  const { container } = render(<CostPage />);
  await flush();
  expect(container.textContent).toContain("this engine reports no cached share");
  expect(container.textContent).toContain("this engine does not report cached prompt tokens");
  expect(container.textContent).not.toContain("0 of them cached");
  expect(container.textContent).not.toContain("no cache discount published");
});

it("keeps the measured cached share when the engine reports one", async () => {
  history.day = [
    dayRow({ promptTokens: 1_000_000, completionTokens: 1000, cachedTokens: 900_000, cacheReported: true }),
  ];
  localStorage.setItem("sparkdash.cost.model", "unrelated-first-model");
  const { container } = render(<CostPage />);
  await flush();
  expect(container.textContent).toContain("of them cached");
  expect(container.textContent).not.toContain("reports no cached share");
});
