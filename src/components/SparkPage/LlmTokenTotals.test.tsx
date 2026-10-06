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
});
