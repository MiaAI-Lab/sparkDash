import { describe, expect, it } from "vitest";
import type { QualityBenchJob, QualityFidelityCompare } from "../../api/types";
import type { QualityCompareRow } from "../../shared/qualityBench.js";
import type { DivergenceCompare } from "../../shared/qualityDivergence.js";
import { plainVerdict } from "./qualityVerdict";

const job = (cost: QualityBenchJob["cost"], divergence?: { jsonSchemaPct: number; toolOkPct: number }): QualityBenchJob =>
  ({
    benchId: "x", sparkId: "s", status: "completed", startedAt: 0, completedAt: 1, durationMs: 1, error: null, cost,
    config: { port: 1, modelId: "m", contextLength: null, suiteVersion: 2, categories: [], longSizes: [], longItems: 1, concurrency: 1, label: "" },
    progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: 0, total: 0, message: "" },
    results: { overallPct: null, skippedLongSizes: [], categories: divergence ? { divergence: { passed: 0, total: 1, pct: null, errors: 0, meanCompletionTokens: 0, hitMaxTokens: 0, divergence: { rows: 1, terminatedPct: 100, loops: 0, loopPct: 0, jsonValidPct: 100, jsonSchemaPct: divergence.jsonSchemaPct, toolOkPct: divergence.toolOkPct, meanChars: 1, meanTokens: 1 } } } : {} },
  }) as QualityBenchJob;

const row = (category: QualityCompareRow["category"], deltaPts: number, verdict: QualityCompareRow["verdict"], equivalent = false): QualityCompareRow =>
  ({ category, paired: 100, excluded: 0, identical: 0, bothOk: 0, bothFail: 0, onlyA: 0, onlyB: 0, p: 1, pAdj: 1, withinNoise: true, pctA: null, pctB: null, coverageA: null, coverageB: null, budgetedA: null, budgetedB: null, pairedPctA: null, pairedPctB: null, deltaPts, deltaCi: null, equivalent, margin: 2, verdict }) as QualityCompareRow;

describe("plainVerdict", () => {
  it("reads pass/fail deltas, fidelity by document kind, structured output and cost into area calls", () => {
    const fidelity = {
      a: "x", b: "y", comparable: true, reason: null,
      docs: [
        { id: "fid-code-shared", tokens: 4000, match: true, dNll: -0.035, top1AgreementPct: 93 },
        { id: "fid-code-atomic", tokens: 1000, match: true, dNll: -0.02, top1AgreementPct: 94 },
        { id: "fid-prose-readme-a", tokens: 5000, match: true, dNll: 0.004, top1AgreementPct: 88 },
        { id: "fid-maths-worked", tokens: 5000, match: true, dNll: -0.003, top1AgreementPct: 96 },
      ],
    } as QualityFidelityCompare;
    const divergence = { paired: 120, identical: 100, identicalPct: 83.3, medianFirstDivergence: 50, meanEditNorm: 0.1, meanLenRatio: 1, loopsA: 0, loopsB: 2, terminatedA: 120, terminatedB: 118, drift: [], kinds: { code: { paired: 20, identicalPct: 95, medianFirstDivergence: 10, meanEditNorm: 0.02 }, prose: { paired: 20, identicalPct: 50, medianFirstDivergence: 30, meanEditNorm: 0.2 } }, pairs: [] } as unknown as DivergenceCompare;
    const rows = [row("arith", 4.5, "different"), row("gsm8k", 0.5, "insufficient", true), row("mmlupro", -6, "different"), row("follow", 0, "same", true)];
    const v = plainVerdict({
      job: job({ decodeTps1: 120, weightsGb: 60 }, { jsonSchemaPct: 100, toolOkPct: 100 }),
      compareJob: job({ decodeTps1: 60, weightsGb: 230 }, { jsonSchemaPct: 80, toolOkPct: 100 }),
      rows, fidelity, divergence, band: null,
    });
    const by = Object.fromEntries(v.areas.map((a) => [a.key, a]));
    expect(by.maths.tag).toBe("A");
    expect(by.maths.evidence).toContain("Arithmetic chain +4.5 pts");
    expect(by.maths.evidence).toContain("GSM8K (Platinum) +0.5 pts (equivalent)");
    expect(by.knowledge.tag).toBe("B");
    expect(by.coding.tag).toBe("A");
    expect(by.coding.evidence).toContain("this run has the lower per-token loss (-0.032 nats per token, next-token agreement 93.2%)");
    expect(by.coding.evidence).toContain("19 of 20 replies identical");
    expect(by.prose.tag).toBe("same");
    expect(by.languages.tag).toBe("unknown");
    expect(by.instructions.tag).toBe("A"); // follow same, but JSON schema 100 vs 80
    expect(by.instructions.evidence).toContain("JSON schema 100% vs 80%");
    expect(by.reliability.tag).toBe("A");
    expect(by.reliability.evidence).toContain("loops 0 vs 2");
    expect(by.cost.tag).toBe("A");
    expect(by.cost.evidence).toBe("120.0 vs 60.0 tok/s single stream, 60.0 vs 230.0 GB");
    expect(v.summary).toBe("A better in 5, B better in 1, about the same in 1, not measured in 3");
  });

  it("calls a delta inside the measured noise floor the same, and a mixed area the same", () => {
    const rows = [row("arith", 2, "different"), row("track", -5, "different")];
    const v = plainVerdict({ job: job(null), compareJob: job(null), rows, fidelity: null, divergence: null, band: { overall: 3, categories: { arith: 3 } } });
    const maths = v.areas.find((a) => a.key === "maths")!;
    expect(maths.tag).toBe("B");
    expect(maths.evidence).toContain("Arithmetic chain +2.0 pts (inside noise)");
    const both = plainVerdict({ job: job(null), compareJob: job(null), rows: [row("arith", 5, "different"), row("track", -5, "different")], fidelity: null, divergence: null, band: null });
    expect(both.areas.find((a) => a.key === "maths")!.tag).toBe("same");
    expect(both.areas.find((a) => a.key === "maths")!.evidence).toMatch(/^mixed: /);
    expect(both.areas.find((a) => a.key === "cost")!.tag).toBe("unknown");
  });
});
