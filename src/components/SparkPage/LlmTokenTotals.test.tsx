import { describe, expect, it, vi } from "vitest";
import { LlmTokenTotals } from "./LlmTokenTotals";
import { FleetTokenTotals } from "../OverviewPage/FleetTokenTotals";
import { ENGINE_GENERATED_LABEL, ENGINE_GENERATED_TITLE } from "./tokenTotalsCopy";
import { flush, render } from "../../testing/render";
import type { LlmTokenTotalsResponse } from "../../api/llmTokenTypes";

vi.mock("../../api/llmTokenClient", () => ({
  fetchLlmTokenTotals: vi.fn(),
}));

import { fetchLlmTokenTotals } from "../../api/llmTokenClient";

const fetchTotals = vi.mocked(fetchLlmTokenTotals);

const RESPONSE: LlmTokenTotalsResponse = {
  range: "all",
  series: [
    {
      sparkId: "spark-1",
      port: 8888,
      updatedAt: 1,
      lastModelId: "GLM-5.3-Flash-EXL3",
      totals: { promptTokens: 3_000_000, completionTokens: 200_000, cachedTokens: 1_000_000 },
      models: [
        {
          modelId: "GLM-5.3-Flash-EXL3",
          promptTokens: 3_000_000,
          completionTokens: 200_000,
          cachedTokens: 1_000_000,
          lastSeenAt: 1,
        },
      ],
    },
  ],
};

describe("token totals wording", () => {
  it("names the engine counter for where it comes from", () => {
    expect(ENGINE_GENERATED_LABEL).toBe("Generated (engine)");
    expect(ENGINE_GENERATED_TITLE).toBe("Reported by the engine since it last started");
  });

  it("says the per-node table is sparkDash's own count", async () => {
    fetchTotals.mockResolvedValue(RESPONSE);
    const { container } = render(<LlmTokenTotals sparkId="spark-1" llmPort={8888} />);
    await flush();
    expect(container.textContent).toContain("Counted by sparkDash since tracking began");
    const header = [...container.querySelectorAll<HTMLElement>("[title]")].find((el) =>
      el.textContent?.includes("Total tokens by model")
    );
    expect(header?.title).toMatch(/survives engine restarts/);
  });

  it("uses the same wording on the fleet card", async () => {
    fetchTotals.mockResolvedValue(RESPONSE);
    const { container } = render(<FleetTokenTotals />);
    await flush();
    expect(container.textContent).toContain("Counted by sparkDash since tracking began, whole fleet");
  });

  it("lists one row per machine and model, merging ports of the same model on a machine", async () => {
    const model = (modelId: string, completionTokens: number) => ({
      modelId,
      promptTokens: 1000,
      completionTokens,
      cachedTokens: 0,
      lastSeenAt: 1,
    });
    const series = (sparkId: string, port: number, models: ReturnType<typeof model>[]) => ({
      sparkId,
      port,
      updatedAt: 1,
      lastModelId: models[0].modelId,
      totals: { promptTokens: 1000, completionTokens: 0, cachedTokens: 0 },
      models,
    });
    fetchTotals.mockResolvedValue({
      range: "all",
      series: [
        series("gx13", 8888, [model("Qwen", 10)]),
        series("gx12", 8888, [model("Qwen", 20)]),
        series("gx12", 8889, [model("Qwen", 30), model("Llama", 5)]),
      ],
    });
    const { container } = render(<FleetTokenTotals />);
    await flush();
    const names = [...container.querySelectorAll(".ov-row:not(.ov-row--head) .ov-row__name")].map((el) => el.textContent).filter((t) => t !== "Total");
    expect(names).toEqual(["gx12 · Llama", "gx12 · Qwen", "gx13 · Qwen"]);
    const gx12Qwen = container.querySelectorAll<HTMLElement>(".ov-row:not(.ov-row--head)")[1];
    expect(gx12Qwen.title).toContain("50 generated");
  });

  it("counts prompt the engine never measured as not reported, not as prefill, on both cards", async () => {
    // 3000 prompt: 800 cached, 2000 read before the engine published a cached counter, 200 computed
    const m = { modelId: "DS", promptTokens: 3000, completionTokens: 30, cachedTokens: 800, cacheReported: true, unreportedPromptTokens: 2000, lastSeenAt: 1 };
    fetchTotals.mockResolvedValue({
      range: "all",
      series: [{ sparkId: "gx1", port: 8888, updatedAt: 1, lastModelId: "DS", totals: { promptTokens: 3000, completionTokens: 30, cachedTokens: 800, unreportedPromptTokens: 2000 }, models: [m] }],
    });
    const fleet = render(<FleetTokenTotals />);
    await flush();
    const cells = (row: Element) => [...row.querySelectorAll(".ov-row__num")].map((el) => el.textContent);
    const [modelRow, totalRow] = [...fleet.container.querySelectorAll(".ov-row:not(.ov-row--head)")];
    expect(cells(modelRow)).toEqual(["800", "200", "30"]);
    expect(cells(totalRow)).toEqual(["800", "200", "30"]);
    expect((modelRow as HTMLElement).title).toContain("200 prefill");
    expect((modelRow as HTMLElement).title).toMatch(/2,?000 not reported/);
    const spark = render(<LlmTokenTotals sparkId="gx1" llmPort={8888} />);
    await flush();
    const row = [...spark.container.querySelectorAll<HTMLElement>(".sp-tok-rows > div")][0];
    expect([...row.querySelectorAll(".font-tabular > span")].map((el) => el.textContent)).toEqual(["800", "200", "30"]);
    expect(row.title).toMatch(/2,?000 not reported/);
  });
});
