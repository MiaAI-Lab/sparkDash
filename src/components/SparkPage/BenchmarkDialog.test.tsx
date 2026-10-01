import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { BenchmarkDialog } from "./BenchmarkDialog";
import { listDecodeBench, startDecodeBench } from "../../api/client";
import type { DecodeBenchJob } from "../../api/types";
import { buildDecodeShareCard } from "./benchShareCard";

vi.mock("../../api/client", () => ({
  listDecodeBench: vi.fn(), startDecodeBench: vi.fn(), getDecodeBench: vi.fn(),
  cancelDecodeBench: vi.fn(), clearDecodeBenchHistory: vi.fn(),
}));
vi.mock("./BenchCopyButton", () => ({
  BenchCopyButton: ({ text, buildCard }: { text: string; buildCard: () => unknown }) =>
    <button onClick={buildCard} data-share-text={text}>Copy results</button>,
}));
vi.mock("./benchShareCard", () => ({ buildDecodeShareCard: vi.fn(), shareCardFileName: vi.fn() }));

const props = { open: true, onClose: vi.fn(), sparkId: "spark-a", llmPort: 8888, modelId: "alpha", models: ["alpha", "beta", "gamma"] };
const picker = () => document.querySelector("select") as HTMLSelectElement | null;
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const choose = (id: string) => act(() => {
  picker()!.value = id;
  picker()!.dispatchEvent(new Event("change", { bubbles: true }));
});
const click = async (text: string) => act(async () => button(text).click());
const job = (modelId: string | null, model = modelId): DecodeBenchJob => ({
  benchId: "saved", sparkId: "spark-a", status: "completed", startedAt: 1, completedAt: 2,
  config: { port: 8888, concurrencies: [1], maxTokens: 400, modelId, promptType: "structured" },
  progress: { currentConcurrency: null, completedLevels: 1, totalLevels: 1, message: "Done" },
  results: [{ concurrency: 1, model, totalDecodeTokens: 10, totalCompletionTokens: 11, aggregateDecodeTps: 10, meanDecodeTps: 10, meanTtftMs: 100 } as DecodeBenchJob["results"][number]],
  error: null, durationMs: 1000,
});

beforeEach(() => {
  vi.mocked(listDecodeBench).mockResolvedValue({ active: null, last: null, history: [], defaults: {
    allowedConcurrencies: [1, 2], defaultMaxTokens: 400, minMaxTokens: 64, maxMaxTokens: 2048,
    promptTypes: ["structured", "prose", "code", "json"], defaultPromptType: "structured",
  } });
  vi.mocked(startDecodeBench).mockResolvedValue({ ...job("beta"), status: "running", results: [] });
});

describe("decode served-model selection", () => {
  it("sends the picked second ID with the existing request fields and start lock", async () => {
    render(<BenchmarkDialog {...props} />);
    await flush();
    expect(picker()!.value).toBe("alpha");
    choose("beta");
    await act(async () => { button("Run benchmark").click(); button("Run benchmark").click(); });
    expect(startDecodeBench).toHaveBeenCalledTimes(1);
    expect(startDecodeBench).toHaveBeenCalledWith("spark-a", { port: 8888, modelId: "beta", maxTokens: 400, concurrencies: [1, 2], promptType: "structured" });
    expect(picker()!.disabled).toBe(true);
  });

  it("preserves user choice across reorders and a changed display identity", async () => {
    const { root } = render(<BenchmarkDialog {...props} />);
    await flush(); choose("beta");
    act(() => root.render(<BenchmarkDialog {...props} modelId="gamma" models={["gamma", "alpha", "beta"]} />));
    expect(picker()!.value).toBe("beta");
    expect(listDecodeBench).toHaveBeenCalledTimes(1);
  });

  it("selects the first remaining ID and announces removal", async () => {
    const { root } = render(<BenchmarkDialog {...props} />);
    await flush(); choose("beta");
    act(() => root.render(<BenchmarkDialog {...props} models={["gamma", "alpha"]} />));
    expect(picker()!.value).toBe("gamma");
    expect(document.querySelector('[role="status"]')!.textContent).toContain("Switched to gamma");
    await click("Run benchmark");
    expect(startDecodeBench).toHaveBeenCalledWith("spark-a", expect.objectContaining({ modelId: "gamma" }));
  });

  it.each([{ sparkId: "spark-b" }, { llmPort: 9000 }, { open: false }])("resets selection on target change or reopen: %j", async (change) => {
    const { root } = render(<BenchmarkDialog {...props} />);
    await flush(); choose("beta");
    act(() => root.render(<BenchmarkDialog {...props} {...change} />));
    if (change.open === false) act(() => root.render(<BenchmarkDialog {...props} />));
    await flush();
    expect(picker()!.value).toBe("alpha");
  });

  it("uses the raw single request ID when the display model is normalized", async () => {
    const raw = "/root/models--org--name/snapshots/abc";
    render(<BenchmarkDialog {...props} modelId="org/name" models={[raw]} />);
    await flush();
    expect(picker()).toBeNull();
    await click("Run benchmark");
    expect(startDecodeBench).toHaveBeenCalledWith("spark-a", expect.objectContaining({ modelId: raw }));
  });

  it("disables an empty/unavailable discovered list rather than using the old display model", async () => {
    const { root } = render(<BenchmarkDialog {...props} />);
    await flush(); choose("beta");
    act(() => root.render(<BenchmarkDialog {...props} models={[]} />));
    expect(button("Run benchmark").disabled).toBe(true);
    expect(picker()).toBeNull();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    await click("Run benchmark");
    expect(startDecodeBench).not.toHaveBeenCalled();
    act(() => root.render(<BenchmarkDialog {...props} />));
    expect(picker()!.value).toBe("alpha");
    expect(button("Run benchmark").disabled).toBe(false);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps native targets without discovery working", async () => {
    render(<BenchmarkDialog {...props} models={undefined} />);
    await flush();
    await click("Run benchmark");
    expect(startDecodeBench).toHaveBeenCalledWith("spark-a", expect.objectContaining({ modelId: "alpha" }));
  });

  it("isolates on-demand remote targets from local IDs and resets on remote change", async () => {
    const { root } = render(<BenchmarkDialog {...props} />);
    await flush(); choose("beta");
    act(() => root.render(<BenchmarkDialog {...props} remoteTarget={{ host: "remote-a.example", port: 443, tls: true }} />));
    await flush();
    expect(picker()).toBeNull();
    await click("Run benchmark");
    expect(startDecodeBench).toHaveBeenCalledWith("spark-a", expect.objectContaining({ host: "remote-a.example", tls: true, port: 443, modelId: undefined }));
    act(() => root.render(<BenchmarkDialog {...props} remoteTarget={{ host: "remote-b.example", port: 9000, tls: false }} />));
    await flush();
    expect(button("Run benchmark")).toBeTruthy();
    await click("Run benchmark");
    expect(startDecodeBench).toHaveBeenLastCalledWith("spark-a", expect.objectContaining({ host: "remote-b.example", tls: false, port: 9000, modelId: undefined }));
  });

  it.each([["saved-model", "actual-model", "saved-model"], [null, "actual-model", "actual-model"]])("labels saved text and image with the job model (%s)", async (configModel, actualModel, expected) => {
    vi.mocked(listDecodeBench).mockResolvedValue({ active: null, last: job(configModel, actualModel), history: [] } as unknown as Awaited<ReturnType<typeof listDecodeBench>>);
    const { root } = render(<BenchmarkDialog {...props} shareImage />);
    await flush();
    act(() => root.render(<BenchmarkDialog {...props} shareImage modelId="next-model" models={["next-model", "another"]} />));
    expect(button("Copy results").dataset.shareText).toContain(`${expected} | decode`);
    await click("Copy results");
    expect(buildDecodeShareCard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelId: expected }));
  });
});
