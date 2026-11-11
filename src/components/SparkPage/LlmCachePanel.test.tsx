import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { LlmCacheMetrics, LlmMetrics } from "../../api/types";
import { LlmCachePanel } from "./LlmCachePanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

const EPOCH = "1793692800123456789";

function fullCache(overrides: Partial<LlmCacheMetrics> = {}): LlmCacheMetrics {
  return {
    status: "full",
    source: "health",
    schemaVersion: 1,
    engineEpoch: EPOCH,
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
    promptState: {
      enabled: true,
      budgetBytes: 536_870_912,
      heldBytes: 268_435_456,
      spareBytes: 268_435_456,
      entries: 7,
      hitsTotal: 120,
      missesTotal: 30,
      evictionsTotal: 4,
      refusalsTotal: 1,
      failuresTotal: 3,
      failuresKeepTotal: 1,
      failuresRestoreTotal: 1,
      failuresPeerForgetTotal: 1,
    },
    missing: [],
    ...overrides,
  };
}

function llmWith(cache: LlmCacheMetrics | null): LlmMetrics {
  return {
    ...makeSpark().metrics.llm[0],
    backend: "tensorfold" as const,
    totalPromptTokens: 1000,
    totalCachedTokens: 900,
    cache,
  };
}

describe("LlmCachePanel", () => {
  it("draws the four disjoint categories and the snapshot store", () => {
    const { container } = render(<LlmCachePanel llm={llmWith(fullCache())} />);
    const bar = container.querySelector("[data-cache-pool]")!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toContain("Active");
    expect(container.textContent).toContain("Kept prefixes");
    expect(container.textContent).toContain("Reclaimable growth");
    expect(container.textContent).toContain("8.39M"); // pool positions
    expect(container.textContent).toContain("1.05M"); // per-request limit
    expect(container.textContent).toContain("90%"); // lifetime reuse 900/1000
    // The detail block separates replacement, invalidation and classified failures.
    expect(container.textContent).toContain("Pool invalidated");
    expect(container.textContent).toContain("keep 1, restore 1, peer forget 1");
  });

  it("says unavailable instead of drawing a healthy zero for an old engine", () => {
    const { container } = render(
      <LlmCachePanel
        llm={llmWith({ status: "unavailable", source: "health", reason: "engine reports no cache group" })}
      />,
    );
    expect(container.querySelector("[data-cache-pool]")).toBeNull();
    expect(container.textContent).toContain("reports no cache telemetry");
    expect(container.textContent).not.toContain("0%");
  });

  it("says inconsistent and shows no values", () => {
    const { container } = render(
      <LlmCachePanel
        llm={llmWith({
          status: "inconsistent",
          source: "health",
          reason: "pool categories do not sum to the capacity",
          pool: null,
          promptState: null,
        })}
      />,
    );
    expect(container.querySelector("[data-cache-pool]")).toBeNull();
    expect(container.textContent).toContain("inconsistent cache accounting");
  });

  it("keeps a disabled store visible as a partial report", () => {
    const cache = fullCache({ status: "partial", missing: ["prompt_state"] });
    cache.promptState = { ...cache.promptState!, enabled: false };
    const { container } = render(<LlmCachePanel llm={llmWith(cache)} />);
    expect(container.textContent).toContain("disabled in this launch");
    expect(container.textContent).toContain("8.39M");
  });

  it("claims no reuse share for a window that spans an engine restart", () => {
    // LlmProbe drops the cached total at an epoch change (the two counters would belong to different
    // processes); the tile must say so rather than divide the new prompt tokens by the old cache.
    const llm = llmWith(fullCache());
    llm.totalCachedTokens = null;
    const { container } = render(<LlmCachePanel llm={llm} />);
    const tile = [...container.querySelectorAll(".sp-tile")].find((t) => t.textContent?.includes("Reused"));
    expect(tile?.textContent).toContain("—");
    expect(container.textContent).not.toContain("90%");
  });

  it("renders nothing for engines that do not publish the group at all", () => {
    const { container } = render(<LlmCachePanel llm={llmWith(null)} />);
    expect(container.textContent).toBe("");
  });
});
