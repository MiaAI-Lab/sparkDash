import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteQualityBenchRun, getQualityBench, getQualityFidelityCompare, listQualityBench, listQualityBenchFleet, pauseQualityBench, resumeQualityBench } from "../../api/client";
import type { QualityBenchDefaults, QualityBenchJob } from "../../api/types";
import { mcnemarExactP } from "../../shared/qualityBench.js";
import { flush, render } from "../../testing/render";
import { QualityBenchDialog } from "./QualityBenchDialog";

vi.mock("../../api/client", () => ({
  cancelQualityBench: vi.fn(),
  pauseQualityBench: vi.fn(),
  resumeQualityBench: vi.fn(),
  clearQualityBenchHistory: vi.fn(),
  deleteQualityBenchRun: vi.fn(),
  getQualityBench: vi.fn(),
  listQualityBench: vi.fn(),
  startQualityBench: vi.fn(),
  getQualityFidelityCompare: vi.fn(),
  listQualityBenchFleet: vi.fn(),
  setQualityReference: vi.fn(),
  clearQualityReference: vi.fn(),
}));

function run(benchId: string, label: string, oks: boolean[], hashPrefix: string): QualityBenchJob {
  const passed = oks.filter(Boolean).length;
  const pct = Math.round((passed / oks.length) * 1000) / 10;
  return {
    benchId,
    sparkId: "s1",
    status: "completed",
    startedAt: 1_780_000_000_000,
    completedAt: 1_780_000_060_000,
    durationMs: 60_000,
    error: null,
    config: {
      port: 8888,
      modelId: "test-model",
      contextLength: 32768,
      suiteVersion: 1,
      categories: ["qa"],
      longSizes: [],
      longItems: 2,
      concurrency: 4,
      label,
    },
    progress: { currentCategory: null, categoryDone: 0, categoryTotal: 0, done: oks.length, total: oks.length, message: "Done" },
    results: {
      overallPct: pct,
      skippedLongSizes: [],
      categories: {
        qa: { passed, total: oks.length, pct, errors: 0, meanCompletionTokens: 5, hitMaxTokens: 0 },
      },
      items: oks.map((ok, i) => ({
        id: `qa-fixed-${i}`,
        category: "qa" as const,
        ok,
        excerpt: `reply ${i}`,
        hash: i === 0 ? "same" : `${hashPrefix}${i}`,
        finishReason: "stop",
        completionTokens: 5,
        promptTokens: 20,
        durationMs: 100,
        error: null,
        detail: null,
      })),
    },
  };
}

describe("QualityBenchDialog", () => {
  beforeEach(() => {
    vi.mocked(listQualityBenchFleet).mockResolvedValue({ runs: [], references: {} });
  });

  it("starts a new run from the Defaults preset, not the last run's categories", async () => {
    const last = run("b-last", "custom run", [true, true, false, true], "z");
    last.config.categories = ["qa"];
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last, history: [last], defaults });
    render(
      <QualityBenchDialog variant="page" sparkId="s1" llmPort={8888} modelId="GLM-5.3-Flash" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    await flush();
    // The six default categories are selected; the last run's ["qa"]-only set was not copied in.
    expect(document.querySelectorAll(".qsel-item.is-on")).toHaveLength(6);
  });

  it("WP4: offers other units' runs as compare targets, defaults to the pinned reference and names serving differences", async () => {
    const current = run("b-rtx", "exl3 4-bit", [true, true, true, false], "a");
    current.unit = { id: "s1", name: "RTX" };
    current.cost = { decodeTps1: 120.5, weightsGb: 60 };
    current.engine = { probedAt: 1, record: { backend: "tensorfold", modelId: "GLM-5.3-Flash", ownedBy: "tensorfold", engineVersion: "1.1.9", gitCommit: "f350cd3e", patches: null, device: null, checkpoint: null, checkpointSha256: "8be9949d", quantization: { quant_method: "exl3", bits: 4 }, computeDtype: null, kvCacheDtype: "fp8", tensorParallel: 2, contextLength: null, speculative: null, tokenizerSha256: null, tokenizerName: null, promptBos: null, promptLogprobsCap: null, reasoning: null }, capabilities: null };
    const other = run("b-spark", "bf16", [true, true, true, true], "b");
    other.sparkId = "s2";
    other.unit = { id: "s2", name: "Spark one" };
    other.cost = { decodeTps1: 40.2, weightsGb: 230 };
    other.engine = { probedAt: 1, record: { ...current.engine.record!, kvCacheDtype: "bf16", tensorParallel: 1 }, capabilities: null };
    const { items: _i, ...otherSummary } = other.results;
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current], defaults });
    vi.mocked(listQualityBenchFleet).mockResolvedValue({
      runs: [{ ...other, results: { ...otherSummary, itemCount: 4 } }],
      references: { "glm-5.3-flash": { sparkId: "s2", benchId: "b-spark", modelId: "GLM-5.3-Flash", pinnedAt: 1 } },
    });
    current.config.modelId = "GLM-5.3-Flash-FP8";
    other.config.modelId = "GLM-5.3-Flash";
    vi.mocked(getQualityBench).mockResolvedValue(other);
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="GLM-5.3-Flash-FP8" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    // the pinned reference of the family was selected on its own, fetched from the other unit
    expect(getQualityBench).toHaveBeenCalledWith("s2", "b-spark");
    const select = dialog.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("b-spark");
    expect(dialog.querySelector("optgroup")?.getAttribute("label")).toBe("Other units");
    expect(select.options[1].textContent).toContain("Spark one");
    expect(select.options[1].textContent).toContain("reference");
    const text = dialog.textContent ?? "";
    expect(text).toContain("this compares serving configurations, not only weights");
    expect(text).toContain("unit, KV cache, tensor parallel");
    expect(dialog.querySelector(".q-quant")?.textContent).toContain("Decode tok/s120.5 (bench ×1)40.2 (bench ×1)+80.3 tok/s");
    expect(dialog.querySelector(".q-quant")?.textContent).toContain("60.0 GB weights230.0 GB weights-170.0 GB");
    expect([...dialog.querySelectorAll("button")].some((b) => b.textContent === "Pin as reference")).toBe(true);
    await act(async () => root.unmount());
  });

  it("drops a pinned reference whose run was deleted instead of showing 'Benchmark not found'", async () => {
    const current = run("b-rtx", "exl3 4-bit", [true, true, true, false], "a");
    current.config.modelId = "GLM-5.3-Flash";
    const older = run("b-old", "older", [true, true, false, false], "c");
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current, older], defaults });
    vi.mocked(listQualityBenchFleet).mockResolvedValue({
      runs: [],
      references: { "glm-5.3-flash": { sparkId: "s1", benchId: "b-gone", modelId: "GLM-5.3-Flash", pinnedAt: 1 } },
    });
    vi.mocked(getQualityBench).mockImplementation((_id, benchId) =>
      benchId === "b-gone" ? Promise.reject(new Error("Benchmark not found")) : Promise.resolve(current)
    );
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="GLM-5.3-Flash" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    await flush();
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(getQualityBench).toHaveBeenCalledWith("s1", "b-gone");
    const text = dialog.textContent ?? "";
    expect(text).not.toContain("Benchmark not found");
    expect(text).toContain("The run picked for comparison is no longer saved");
    expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("");
    await act(async () => root.unmount());
  });

  it("reports truncated and disputed items as unscored with the stored reply, and flags a budget-limited score", async () => {
    const job = run("b-v3", "v3", [true, true, false, false], "x");
    job.config.scoringVersion = 3;
    job.results.categories.qa = {
      passed: 2, total: 4, scored: 3, pct: 66.7, errors: 0, truncated: 1, disputed: 0, budgetLimited: true, meanCompletionTokens: 5, hitMaxTokens: 1,
    };
    const items = job.results.items!;
    items[2] = { ...items[2], finishReason: "length", reply: "75 ÷ 2 = 37 remainder 1 …", detail: null };
    items[3] = { ...items[3], category: "gsm8k", id: "gsm8k-0952", disputed: true, reply: "… 60 × 30 = 1800 reports Answer: 1800", detail: "parsed 1800 · disputed reference, not scored: Reference answer 360 is wrong" };
    job.results.categories.gsm8k = { passed: 0, total: 1, scored: 0, pct: null, errors: 0, truncated: 0, disputed: 1, budgetLimited: false, meanCompletionTokens: 5, hitMaxTokens: 0 };
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: job, history: [job], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(job);
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const text = dialog.textContent ?? "";
    expect(text).toContain("1 reply ran out of token budget before answering, left out");
    expect(text).toContain("budget-limited");
    expect(text).toContain("1 disputed, not scored");
    expect(dialog.querySelector(".q-flag")).not.toBeNull();
    const cells = Array.from(dialog.querySelectorAll("td")).map((td) => td.textContent?.trim());
    expect(cells).toContain("cut");
    expect(cells).toContain("n/a");
    expect(dialog.querySelectorAll(".q-reply__text").length).toBe(2);
    expect(text).toContain("60 × 30 = 1800 reports");
    await act(async () => root.unmount());
  });

  it("WP0: shows the engine record, the noise floor and reasoning tokens on rows", async () => {
    const job = run("b-wp0", "wp0", [true, true, false, true], "x");
    job.config.noiseFloor = true;
    job.engine = {
      probedAt: 1,
      modelsReachable: true,
      record: {
        backend: "tensorfold", modelId: "test-model", ownedBy: "tensorfold", engineVersion: "1.1.9", gitCommit: "f350cd3e", patches: "19c01c48",
        device: "RTX", checkpoint: "/model", checkpointSha256: "8be9949d8f6aef14f299194d51069efae530aafdfb5a991560bcae65d8537f7f",
        quantization: { quant_method: "exl3", bits: 4 }, computeDtype: "bfloat16", kvCacheDtype: "fp8", tensorParallel: 2, contextLength: 875520,
        speculative: { enabled: true, kind: "DFlash2" }, tokenizerSha256: "19e7", tokenizerName: "TokenizersBackend", promptBos: false, promptLogprobsCap: 128, reasoning: null,
      },
      capabilities: { promptLogprobs: true, shape: "openai-completions", reason: null, probedAt: 1, cap: 128, capSource: "advertised", actualIncluded: true, aligned: true },
    };
    job.results.noise = {
      primaryConcurrency: 4,
      repeatFlipPct: 25,
      batchFlipPct: 50,
      passes: [
        { index: 1, kind: "repeat", concurrency: 4, pairs: 4, discordant: 1, identical: 3, flipPct: 25, identicalPct: 75, categories: { qa: { pairs: 4, discordant: 1, identical: 3, flipPct: 25 } } },
        { index: 2, kind: "serial", concurrency: 1, pairs: 4, discordant: 2, identical: 1, flipPct: 50, identicalPct: 25, categories: { qa: { pairs: 4, discordant: 2, identical: 1, flipPct: 50 } } },
      ],
    };
    const items = job.results.items!;
    items[2] = { ...items[2], reasoningTokens: 3, reasoningChars: 13, reasoning: "let me think " };
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: job, history: [job], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(job);
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const text = dialog.textContent ?? "";
    expect(text).toContain("tensorfold 1.1.9 · exl3 4-bit · KV fp8 · TP 2 · spec DFlash2 · ckpt 8be9949d8f6a");
    expect(text).toContain("prompt logprobs: yes, K ≤ 128");
    expect(dialog.querySelector(".q-engine__grid")?.textContent).toContain("8be9949d8f6aef14f299194d51069efae530aafdfb5a991560bcae65d8537f7f");
    expect(text).toContain("Run-to-run noise 25.0% · batch effect 50.0%");
    expect(text).toContain("Repeat at concurrency 4");
    expect(text).toContain("Serial pass (concurrency 1)");
    expect(text).toContain("1/4 · 25.0%");
    expect(text).toContain("3 reasoning tok");
    expect(dialog.querySelector(".q-reply__text--reasoning")?.textContent).toBe("let me think ");
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull(); // the options panel is folded behind a finished run
    await act(async () => root.unmount());
  });

  it("WP3: a divergence run shows its structural rates and the reply-by-reply comparison", async () => {
    const div = (benchId: string, replyB: string) => {
      const job = run(benchId, benchId, [true, true], "d");
      job.config.categories = ["divergence"];
      job.config.profile = "fidelity";
      job.results.overallPct = null;
      job.results.categories = {
        divergence: {
          passed: 2, total: 2, scored: 2, pct: null, errors: 0, meanCompletionTokens: 40, hitMaxTokens: 0, coveragePct: 100,
          divergence: { rows: 2, terminatedPct: 100, loops: 0, loopPct: 0, jsonValidPct: 100, jsonSchemaPct: 100, toolOkPct: null, meanChars: 120, meanTokens: 40 },
        },
      };
      job.results.items = [
        { id: "div-prose-01", category: "divergence", kind: "prose", ok: true, excerpt: "same", hash: "same", finishReason: "stop", completionTokens: 40, promptTokens: 30, durationMs: 1, error: null, detail: null, reply: "the same reply", chars: 14, terminated: true, loop: { loop: false, cycle: null, tailShare: 0 } },
        { id: "div-json-01", category: "divergence", kind: "json", ok: true, excerpt: "json", hash: `j-${replyB}`, finishReason: "stop", completionTokens: 40, promptTokens: 30, durationMs: 1, error: null, detail: null, reply: replyB, chars: replyB.length, terminated: true, loop: { loop: false, cycle: null, tailShare: 0 }, json: { valid: true, schema: true, fenced: false, missing: [] } },
      ];
      return job;
    };
    const current = div("d-quant", '{"name":"Ada","age":36}');
    const reference = div("d-ref", '{"name":"Ada","age":37}');
    const { items: _i, ...refSummary } = reference.results;
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current, { ...reference, results: refSummary }], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(reference);
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("2 stored replies, greedy, thinking off");
    expect(dialog.querySelector(".q-div")?.textContent).toContain("Terminated100.0%");
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "d-ref";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const text = dialog.querySelector(".q-div")?.textContent ?? "";
    expect(text).toContain("Identical replies50.0%1/2");
    expect(text).toContain("First divergence (median)21 ch");
    expect(text).toContain("how sensitive the output is to the serving stack");
    await act(async () => root.unmount());
  });

  it("WP2: a fidelity run shows corpus NLL and perplexity, and compares token by token against a reference run", async () => {
    const fid = (benchId: string, nll: number) => {
      const job = run(benchId, benchId, [true, true], "f");
      job.config.categories = ["fidelity"];
      job.config.profile = "fidelity";
      job.results.overallPct = null;
      job.results.fidelity = { corpusVersion: 1, corpusSha256: "9bb6", k: 20, docs: 2, sideFile: true };
      job.results.categories = {
        fidelity: {
          passed: 2, total: 2, scored: 2, pct: null, errors: 0, meanCompletionTokens: 0, hitMaxTokens: 0, coveragePct: 100,
          fidelity: { docs: 2, tokens: 8000, bytes: 30000, sumNll: nll * 8000, k: 20, nll, ppl: Math.exp(nll), bitsPerByte: (nll * 8000) / Math.LN2 / 30000 },
        },
      };
      job.results.items = [
        { id: "fid-prose-a", category: "fidelity", ok: true, excerpt: "", hash: "a", finishReason: null, completionTokens: 0, promptTokens: 5000, durationMs: 1, error: null, detail: null, docId: "prose-a", kind: "prose", lang: "en", tokens: 5000, nll, ppl: Math.exp(nll), top1Pct: 61.2 },
        { id: "fid-code-b", category: "fidelity", ok: true, excerpt: "", hash: "b", finishReason: null, completionTokens: 0, promptTokens: 3000, durationMs: 1, error: null, detail: null, docId: "code-b", kind: "code", lang: "js", tokens: 3000, nll: nll + 0.1, ppl: Math.exp(nll + 0.1), top1Pct: 70 },
      ];
      return job;
    };
    const current = fid("f-quant", 1.2345);
    const reference = fid("f-ref", 1.2);
    const { items: _i, ...refSummary } = reference.results;
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current, { ...reference, results: refSummary }], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(reference);
    vi.mocked(getQualityFidelityCompare).mockResolvedValue({
      a: "f-quant", b: "f-ref", comparable: true, reason: null, k: { a: 20, b: 20 }, tokens: 8000, matchedDocs: 2, mismatchedDocs: 0,
      nllA: 1.2345, nllB: 1.2, pplA: 3.44, pplB: 3.32, dNll: 0.0345, dNllCi: [0.01, 0.06], top1AgreementPct: 97.5, tailLossPct: 0.4, divergence: 0.012,
      docs: [
        { id: "fid-prose-a", tokens: 5000, match: true, dNll: 0.03, top1AgreementPct: 98, tailLossPct: 0.3, divergence: 0.01, scoredTop: 5000 },
        { id: "fid-code-b", tokens: 3000, match: true, dNll: 0.04, top1AgreementPct: 96.7, tailLossPct: 0.6, divergence: 0.015, scoredTop: 3000 },
      ],
    });
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    let text = dialog.textContent ?? "";
    expect(text).toContain("8,000 tokens in 2 documents · top-20");
    expect(text).toContain("1.2345");
    expect(text).not.toContain("Partial run");
    expect(dialog.querySelector(".q-fid__docs")?.textContent).toContain("prose-a");
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "f-ref";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();
    expect(getQualityFidelityCompare).toHaveBeenCalledWith("s1", "f-quant", "f-ref", "s1");
    text = dialog.textContent ?? "";
    expect(text).toContain("+0.0345");
    expect(text).toContain("+0.0100 to +0.0600");
    expect(text).toContain("97.5%");
    expect(text).toContain("not a KL");
    await act(async () => root.unmount());
  });

  it("WP1: a named profile shows the overall with its interval, coverage columns and a thinking warning; a partial run shows none", async () => {
    const job = run("b-wp1", "wp1", [true, true, true, false], "x");
    job.config.profile = "default";
    job.config.categories = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"];
    job.results.overallPct = 94.4;
    job.results.overallCi = [91.9, 96.2];
    job.results.categories.qa = {
      passed: 3, total: 4, scored: 4, pct: 75, errors: 0, truncated: 0, disputed: 0, budgetLimited: false, meanCompletionTokens: 5, hitMaxTokens: 0,
      coveragePct: 80, budgetedPct: 60, ci: [30.1, 95.4], budgetedCi: [20, 90],
    };
    job.results.warnings = [{ kind: "thinkingNotHonoured", category: "qa", rows: 4, reasoningRows: 2, truncated: 1 }];
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: job, history: [job], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(job);
    const { root } = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const text = dialog.textContent ?? "";
    expect(text).toContain("94.4");
    expect(text).toContain("95% CI 91.9–96.2");
    expect(text).not.toContain("Partial run");
    expect(text).toContain("30.1–95.4");
    expect(text).toContain("coverage 80.0% · budgeted 60.0%");
    expect(dialog.querySelector(".q-warning")?.textContent).toContain(
      "Thinking off was not honoured by test-model in QA: 2 of 4 replies carried reasoning and 1 were cut off"
    );
    await act(async () => root.unmount());

    // A custom category set: no headline, the categories named instead; Wilson computed client-side.
    const partial = run("b-partial", "partial", [true, true, false, false], "y");
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: partial, history: [partial], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(partial);
    const second = render(
      <QualityBenchDialog open sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} onClose={() => {}} />
    );
    await flush();
    const dialog2 = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog2.textContent).toContain("Partial run — no headline overall");
    expect(dialog2.querySelector(".q-score__ring")?.textContent).toContain("—");
    expect(dialog2.textContent).toContain("15.0–85.0");
    await act(async () => second.root.unmount());
  });

  it("shows the last run's score and compares with a previous run", async () => {
    const current = run("b2", "fp4 KV", [true, true, true, false], "a");
    const previous = run("b1", "bf16 KV", [true, false, true, true], "b");
    const { items: _items, ...prevSummary } = previous.results;
    vi.mocked(listQualityBench).mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...previous, results: prevSummary }],
      defaults: {
        categories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"],
        defaultCategories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu"],
        longSizes: [8192],
        defaultLongSizes: [32768],
        defaultLongItems: 2,
        maxLongItems: 5,
        defaultConcurrency: 4,
        maxConcurrency: 16,
      },
    });
    vi.mocked(getQualityBench).mockResolvedValue(previous);

    render(
      <QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />
    );
    await flush();

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("75.0%");
    expect(dialog.textContent).toContain("3/4");

    const select = dialog.querySelector("select") as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    await act(async () => {
      select.value = "b1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(getQualityBench).toHaveBeenCalledWith("s1", "b1");
    expect(dialog.textContent).toContain("insufficient evidence of a difference");
    // one item only right in this run, one only in the other → p = 1
    expect(mcnemarExactP(1, 1)).toBe(1);
    expect(dialog.textContent).toContain("1/4");
  });

  const defaults: QualityBenchDefaults = {
    categories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"],
    defaultCategories: ["qa", "reason", "arith", "track", "gsm8k", "mmlu"],
    longSizes: [8192],
    defaultLongSizes: [32768],
    defaultLongItems: 2,
    maxLongItems: 5,
    defaultConcurrency: 4,
    maxConcurrency: 16,
  };

  it("lists and compares saved runs from every port, not only the selected one", async () => {
    const current = run("b2", "model B", [true, true, true, false], "a");
    const other = run("b1", "model A", [true, false, true, true], "b");
    current.config.port = 18891;
    other.config.port = 8888;
    const { items: _items, ...otherSummary } = other.results;
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...other, results: otherSummary }],
      defaults,
    });
    vi.mocked(getQualityBench).mockResolvedValue(other);

    render(
      <QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={18891} modelId="m" contextLength={32768} />
    );
    await flush();

    // The port selects the endpoint of the new run; history is requested for all ports.
    expect(listQualityBench).toHaveBeenCalledWith("s1", 18891, "all");
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const select = dialog.querySelector("select") as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    expect(select.options[1].textContent).toContain("port 8888");
    const clear = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Clear all ports");
    expect(clear?.getAttribute("title")).toContain("all LLM ports");
  });

  it("refuses to compare runs scored by different rules", async () => {
    const current = run("b2", "new", [true, true, true, false], "a");
    current.config.scoringVersion = 2;
    const previous = run("b1", "old", [true, false, true, true], "b");
    previous.config.scoringVersion = 1;
    const { items: _items, ...prevSummary } = previous.results;
    vi.mocked(listQualityBench).mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...previous, results: prevSummary }],
      defaults,
    });
    vi.mocked(getQualityBench).mockResolvedValue(previous);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const select = dialog.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "b1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(dialog.textContent).toContain("scored by different rules");
    expect(dialog.textContent).not.toContain("McNemar p =");
  });

  it("starts a new run with a blank label and marks the item filters as toggles", async () => {
    const current = run("b2", "fp4 KV", [true, false], "a");
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: current, history: [current], defaults });
    render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const input = document.querySelector('input[placeholder="e.g. fp4 KV"]') as HTMLInputElement;
    expect(input.value).toBe("");
    const filters = [...document.querySelectorAll("details button")] as HTMLButtonElement[];
    expect(filters.length).toBeGreaterThan(1);
    expect(filters.every((b) => b.getAttribute("aria-pressed") != null)).toBe(true);
    expect(filters[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a running job as a progressbar with a polite status", async () => {
    const running = run("b3", "", [true], "a");
    running.status = "running";
    running.progress = { currentCategory: "qa", categoryDone: 1, categoryTotal: 4, done: 1, total: 4, message: "QA…" };
    running.results = { overallPct: 100, skippedLongSizes: [], itemCount: 1, categories: running.results.categories };
    vi.mocked(listQualityBench).mockResolvedValue({ active: running, last: null, history: [], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(running);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const bar = document.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Running");
  });

  it("pauses and resumes a running job from the footer, and reads a paused job as Paused", async () => {
    const running = run("b3", "", [true], "a");
    running.status = "running";
    running.progress = { currentCategory: "qa", categoryDone: 1, categoryTotal: 4, done: 1, total: 4, message: "QA…" };
    running.results = { overallPct: 100, skippedLongSizes: [], itemCount: 1, categories: running.results.categories };
    const paused = { ...running, paused: true, pausedAt: 1, pausedMs: 0, progress: { ...running.progress, message: "Paused" } };
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({ active: running, last: null, history: [], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(running);
    vi.mocked(pauseQualityBench).mockResolvedValue(paused);
    vi.mocked(resumeQualityBench).mockResolvedValue(running);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const footer = dialog.querySelector("footer") as HTMLElement;
    const pause = [...footer.querySelectorAll("button")].find((b) => b.textContent === "Pause") as HTMLButtonElement;
    expect(pause).toBeTruthy();
    expect([...footer.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(true);
    await act(async () => pause.click());
    await flush();
    expect(pauseQualityBench).toHaveBeenCalledWith("s1", "b3");
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Paused");
    const resume = [...footer.querySelectorAll("button")].find((b) => b.textContent === "Resume") as HTMLButtonElement;
    expect(resume).toBeTruthy();
    await act(async () => resume.click());
    await flush();
    expect(resumeQualityBench).toHaveBeenCalledWith("s1", "b3");
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Running");
  });

  it("offers to resume an interrupted run from its scored rows and polls the relaunched job", async () => {
    const interrupted = run("b4", "exl3", [true, true, false], "a");
    interrupted.status = "failed";
    interrupted.error = "Interrupted — server restarted while the benchmark was running";
    interrupted.resumable = true;
    interrupted.progress = { ...interrupted.progress, done: 3, total: 40 };
    const relaunched = { ...interrupted, status: "running" as const, error: null, resumable: undefined, resumes: 1, resumedFrom: 3, progress: { ...interrupted.progress, message: "Resuming from 3 scored items…" } };
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({ active: null, last: interrupted, history: [interrupted], defaults });
    vi.mocked(resumeQualityBench).mockResolvedValue(relaunched);
    vi.mocked(getQualityBench).mockResolvedValue(relaunched);
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const resume = [...dialog.querySelectorAll("button")].filter((b) => b.textContent === "Resume from 3 scored");
    expect(resume.length).toBeGreaterThan(0);
    await act(async () => resume[0].click());
    await flush();
    expect(resumeQualityBench).toHaveBeenCalledWith("s1", "b4");
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Running");
  });

  it("disables long sizes with the server's context rule (1.2x + 512)", async () => {
    const current = run("b2", "x", [true], "a");
    current.config.categories = ["long"];
    vi.mocked(listQualityBench).mockResolvedValue({ active: null, last: null, history: [], defaults });
    render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="m" contextLength={10000} />);
    await flush();
    // enable the long category chip
    const chips = [...document.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[];
    const longChip = chips.find((b) => /Long-context/i.test(b.textContent ?? ""));
    expect(longChip).toBeTruthy();
    await act(async () => longChip!.click());
    const size8k = [...document.querySelectorAll('[aria-label="Long-context sizes"] button')].find((b) => b.textContent === "8k") as HTMLButtonElement;
    // 8192*1.2 = 9831 + 512 = 10343 > 10000 -> disabled (the old n+512 rule would allow it)
    expect(size8k.disabled).toBe(true);
  });

  it("deletes one saved run after a confirmation and keeps the rest", async () => {
    const current = run("b2", "fp4 KV", [true, true], "a");
    const previous = run("b1", "bf16 KV", [true, false], "b");
    const { items: _items, ...prevSummary } = previous.results;
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({
      active: null,
      last: current,
      history: [current, { ...previous, results: prevSummary }],
      defaults,
    });
    vi.mocked(deleteQualityBenchRun).mockResolvedValue({ success: true });
    const confirmStub = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmStub);
    try {
      render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
      await flush();

      const historyTable = [...document.querySelectorAll("table")].find((t) =>
        (t.querySelector("thead")?.textContent ?? "").includes("Label")
      ) as HTMLTableElement;
      const rows = [...historyTable.querySelectorAll("tbody tr")] as HTMLElement[];
      expect(rows).toHaveLength(2);
      const del = [...rows[1].querySelectorAll("button")].find((b) => b.textContent === "Delete") as HTMLButtonElement;
      expect(del).toBeTruthy();

      await act(async () => del.click());
      await flush();

      expect(confirmStub).toHaveBeenCalled();
      expect(deleteQualityBenchRun).toHaveBeenCalledWith("s1", "b1");
      // The list is reloaded so the deleted run stops being offered for comparison.
      expect(listQualityBench).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers no delete for a run still in flight", async () => {
    const running = run("b3", "live", [true], "a");
    running.status = "running";
    running.results = { overallPct: 100, skippedLongSizes: [], itemCount: 1, categories: running.results.categories };
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({ active: running, last: null, history: [running], defaults });
    vi.mocked(getQualityBench).mockResolvedValue(running);
    render(<QualityBenchDialog open variant="page" onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
    await flush();

    const historyTable = [...document.querySelectorAll("table")].find((t) =>
      (t.querySelector("thead")?.textContent ?? "").includes("Label")
    ) as HTMLTableElement;
    const rows = [...historyTable.querySelectorAll("tbody tr")] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    expect([...rows[0].querySelectorAll("button")].some((b) => b.textContent === "Delete")).toBe(false);
  });

  it("deletes the open run from the dialog footer", async () => {
    const current = run("b2", "fp4 KV", [true, true], "a");
    vi.mocked(listQualityBench).mockReset().mockResolvedValue({ active: null, last: current, history: [current], defaults });
    vi.mocked(deleteQualityBenchRun).mockResolvedValue({ success: true });
    const confirmStub = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmStub);
    try {
      render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8888} modelId="test-model" contextLength={32768} />);
      await flush();

      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const del = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete run") as HTMLButtonElement;
      expect(del).toBeTruthy();
      await act(async () => del.click());
      await flush();
      expect(deleteQualityBenchRun).toHaveBeenCalledWith("s1", "b2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
