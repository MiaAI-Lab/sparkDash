import { act } from "react";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { LlmCacheMetrics } from "../../api/types";
import { SparkCard } from "./SparkCard";

function cache(): LlmCacheMetrics {
  return {
    status: "full",
    source: "health",
    engineEpoch: "1793692800123456789",
    observedAt: 1793692801000,
    contextLimitPositions: 1_048_576,
    streamCapacity: 16,
    pool: {
      capacityPositions: 8_388_608,
      activeReservedPositions: 1_048_576,
      retainedPrefixPositions: 2_097_152,
      retainedGrowthPositions: 524_288,
      unclaimedPositions: 4_718_592,
      validStates: 7,
      invalidationsTotal: 3,
      placementBlocksTotal: 11,
    },
    promptState: null,
    missing: ["prompt_state"],
  };
}

describe("Overview cache chip", () => {
  it("retranslates cache accounting while preserving measured values", async () => {
    const spark = makeSpark("spark-1");
    Object.assign(spark.metrics.llm[0], { backend: "tensorfold", cache: cache() });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const tag = [...container.querySelectorAll("[title]")].find((el) =>
      (el.getAttribute("title") ?? "").includes("8,388,608 positions"),
    );
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe("13% active · 25% kept");
    try {
      await act(() => setLocale("zh-CN"));
      expect(tag!.textContent).toBe("13% 活跃 · 25% 保留");
      expect(tag!.getAttribute("title")).toContain("共享池 8,388,608 个位置");
      expect(tag!.getAttribute("title")).toContain("快照存储 未报告");
    } finally {
      await act(() => setLocale("en"));
    }
  });

  it("adds no chip when the engine reports no cache group", () => {
    const spark = makeSpark("spark-1");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold",
      cache: { status: "unavailable", source: "health", reason: "engine reports no cache group" },
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("active ·");
  });
});
