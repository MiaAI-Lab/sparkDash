import { describe, expect, it } from "vitest";
import {
  blendedPerMillion,
  costBuckets,
  costOf,
  filterModels,
  fmtMoney,
  priceLabel,
} from "./costStats";
import type { ModelPrice } from "../../api/costTypes";
import type { TokenHistoryRow } from "../../api/types";

const price = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  id: "test-model",
  provider: "test",
  mode: "chat",
  inputCostPerToken: 2e-6, // $2 / 1M
  outputCostPerToken: 1e-5, // $10 / 1M
  cacheReadCostPerToken: 2e-7, // $0.20 / 1M
  cacheWriteCostPerToken: null,
  maxInputTokens: 128000,
  maxOutputTokens: 4096,
  ...over,
});

const row = (over: Partial<TokenHistoryRow>): TokenHistoryRow => ({
  t: "2026-10-16",
  sparkId: "s1",
  port: 8888,
  modelId: "local-model",
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  ...over,
});

describe("costOf", () => {
  it("prices computed prefill, cached prefill and completions separately", () => {
    const t = costOf([row({ promptTokens: 1_000_000, completionTokens: 100_000, cachedTokens: 400_000 })], price());
    // computed 600k @$2/M = $1.20; cached 400k @$0.20/M = $0.08
    expect(t.inputCost).toBeCloseTo(1.28, 6);
    // generated 100k @$10/M = $1
    expect(t.outputCost).toBeCloseTo(1, 6);
    expect(t.totalCost).toBeCloseTo(2.28, 6);
    // savings: 400k at full rate would be $0.80, cache rate is $0.08
    expect(t.cacheSavings).toBeCloseTo(0.72, 6);
  });

  it("charges the full input rate when no cache price is published", () => {
    const p = price({ cacheReadCostPerToken: null });
    const t = costOf([row({ promptTokens: 1000, cachedTokens: 1000 })], p);
    expect(t.inputCost).toBeCloseTo(1000 * 2e-6, 9);
    expect(t.cacheSavings).toBe(0);
  });

  it("clamps cached above prompt and ignores junk counters", () => {
    const t = costOf([row({ promptTokens: 100, cachedTokens: 500, completionTokens: -5 })], price());
    // cached clamps to 100 and is charged the cache rate; nothing computed
    expect(t.inputCost).toBeCloseTo(100 * 2e-7, 9);
    expect(t.outputCost).toBe(0);
  });
});

describe("costBuckets", () => {
  it("sums per requested key only, oldest first", () => {
    const rows = [
      row({ t: "2026-10-15", promptTokens: 1_000_000 }),
      row({ t: "2026-10-16", completionTokens: 1_000_000 }),
      row({ t: "2026-10-14", promptTokens: 1 }), // outside the window
    ];
    const out = costBuckets(rows, ["2026-10-15", "2026-10-16"], price());
    expect(out).toHaveLength(2);
    expect(out[0]!.input).toBeCloseTo(2, 6);
    expect(out[0]!.output).toBe(0);
    expect(out[1]!.output).toBeCloseTo(10, 6);
    expect(out[1]!.input).toBe(0);
  });
});

describe("formatting", () => {
  it("formats money with sensible precision", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(0.012345)).toBe("$0.01");
    expect(fmtMoney(0.0046)).toBe("$0.0046");
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(Number.NaN)).toBe("$0.00");
  });

  it("labels per-million prices", () => {
    expect(priceLabel(price())).toBe("$2 / 1M in · $10 / 1M out");
  });

  it("blends cost over tokens", () => {
    expect(blendedPerMillion(2.28, 1_100_000)).toBeCloseTo(2.0727, 3);
    expect(blendedPerMillion(5, 0)).toBeNull();
  });
});

describe("filterModels", () => {
  const all = [
    price({ id: "claude-sonnet-4-5", provider: "anthropic" }),
    price({ id: "gpt-5.2", provider: "openai" }),
    price({ id: "openai/gpt-5.2-mini", provider: "openai" }),
  ];

  it("ranks prefix matches before substring matches", () => {
    expect(filterModels(all, "gpt").map((m) => m.id)).toEqual(["gpt-5.2", "openai/gpt-5.2-mini"]);
  });

  it("matches on provider and is case-insensitive", () => {
    expect(filterModels(all, "ANTHROPIC").map((m) => m.id)).toContain("claude-sonnet-4-5");
  });

  it("caps results and handles empty queries", () => {
    expect(filterModels(all, "")).toHaveLength(3);
    expect(filterModels(all, "gpt", 1)).toHaveLength(1);
    expect(filterModels(all, "nope-nothing")).toEqual([]);
  });
});
