import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { RequestStat, RequestStats } from "../../../shared/types";
import { RequestsPage } from "./RequestsPage";

const NOW = 1_800_000_000_000;

function stat(overrides: Partial<RequestStat> = {}): RequestStat {
  return {
    modelId: "model-a",
    engine: "vllm",
    nodeId: "gx10-1c2c",
    port: 8080,
    queued: 1,
    running: 2,
    finished: 10,
    polledAt: NOW - 5_000,
    ...overrides,
  };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("RequestsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the header and by-model / by-engine / by-machine sections", async () => {
    const modelB = { modelId: "model-b", engine: "sglang", nodeId: "gx10-27c1", finished: 99 };
    const requests: RequestStats = {
      nodeId: "gx10-1c2c",
      stats: [stat(), stat(modelB)],
      polledAt: NOW - 5_000,
    };
    const byModel: Record<string, RequestStat[]> = { "model-a": [stat()], "model-b": [stat(modelB)] };
    const byEngine: Record<string, RequestStat[]> = { vllm: [stat()] };
    const byMachine: Record<string, RequestStat[]> = {
      "gx10-1c2c": [stat()],
      "gx10-27c1": [stat(modelB)],
    };

    const { container } = render(
      <RequestsPage
        nodeId="gx10-1c2c"
        nodeName="Node 1"
        requests={requests}
        byModel={byModel}
        byEngine={byEngine}
        byMachine={byMachine}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Requests");
    expect(text).toContain("Node 1");
    expect(text).toContain("gx10-1c2c");
    expect(text).toContain("5s ago"); // polled label
    expect(text).toContain("By model");
    expect(text).toContain("By engine");
    expect(text).toContain("By machine");
    // model-a appears in all three groupings; model-b in model + machine.
    expect(count(text, "model-a")).toBe(3);
    expect(count(text, "model-b")).toBe(2);
    expect(text).toContain("gx10-27c1:8080");
    expect(text).toContain("99");
  });

  it("shows empty sections and the header when there are no requests", async () => {
    const { container } = render(
      <RequestsPage
        nodeId="gx10-1c2c"
        nodeName="Node 1"
        requests={{ nodeId: "gx10-1c2c", stats: [], polledAt: NOW - 5_000 }}
        byModel={{}}
        byEngine={{}}
        byMachine={{}}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Requests");
    expect(text).toContain("Node 1");
    expect(text).toContain("No requests by model");
    expect(text).toContain("No requests by engine");
    expect(text).toContain("No requests by machine");
    expect(text).not.toContain("Queued");
  });
});
