import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { LlamaSwapInfo, LlmMetrics } from "../../api/types";
import { LlmPanel } from "./LlmPanel";
import { LlamaSwapDetails } from "./LlamaSwapDetails";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

const info = (over: Partial<LlamaSwapInfo> = {}): LlamaSwapInfo => ({
  version: "v265",
  loaded: ["big/chat"],
  starting: [],
  models: [
    { id: "audio/music", name: "Music", state: "unloaded" },
    { id: "big/chat", name: "Chat", state: "ready" },
  ],
  engine: { url: "http://127.0.0.1:5804", available: true, backend: "tensorfold", modelId: "chat-tf" },
  activity: true,
  lastRequest: {
    id: 9,
    model: "big/chat",
    status: 200,
    at: 1_000_000,
    durationMs: 20_000,
    inputTokens: 23,
    cachedTokens: 0,
    outputTokens: 767,
    prefillTps: 153.3,
    decodeTps: 39.29,
  },
  ...over,
});

const swapLlm = (over: Partial<LlmMetrics> = {}): LlmMetrics => ({
  ...makeSpark().metrics.llm[0],
  available: true,
  backend: "llama-swap",
  modelId: "big/chat",
  models: ["big/chat", "audio/music"],
  llamaSwap: info(),
  ...over,
});

describe("llama-swap LLM panel", () => {
  it("shows the engine behind llama-swap and keeps the bench buttons", () => {
    const { container } = render(<LlmPanel llm={swapLlm()} sparkId="fixture" llmPort={8080} />);
    expect(container.textContent).toContain("llama-swap → TensorFold · :8080");
    expect(container.querySelector("[data-llama-swap]")).not.toBeNull();
    expect(container.querySelector(".sp-launchers")?.textContent).toContain("Decode");
  });

  it("says nothing is loaded instead of naming a listed model", () => {
    const llm = swapLlm({ modelId: null, llamaSwap: info({ loaded: [], engine: null }) });
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8080} />);
    expect(container.querySelector(".sp-model code")?.textContent).toBe("Nothing loaded");
  });

  it("other backends show no llama-swap block", () => {
    const llm = { ...makeSpark().metrics.llm[0], available: true, backend: "vllm" as const };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8000} />);
    expect(container.querySelector("[data-llama-swap]")).toBeNull();
  });
});

describe("LlamaSwapDetails", () => {
  it("lists model states and the last completed request", () => {
    const { container } = render(<LlamaSwapDetails info={info()} now={1_000_000 + 120_000} />);
    const chips = [...container.querySelectorAll('[aria-label="llama-swap models"] > *')].map((el) => el.textContent);
    expect(chips).toEqual(["audio/music · unloaded", "big/chat · loaded"]);
    const last = container.querySelector("[data-llama-swap-last]")?.textContent ?? "";
    expect(last).toContain("39.3 tok/s decode");
    expect(last).toContain("153 tok/s prefill");
    expect(last).toContain("767 out");
    expect(last).toContain("2m ago");
  });

  it("explains an unreachable engine", () => {
    const { container } = render(
      <LlamaSwapDetails info={info({ engine: { url: "http://10.0.0.2:5804", available: false, backend: null, modelId: null } })} />
    );
    expect(container.textContent).toContain("not reachable from here");
  });
});
