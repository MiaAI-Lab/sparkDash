import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { RequestStatCard } from "./RequestStatCard";

const NOW = 1_800_000_000_000;

describe("RequestStatCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders header, engine badge, machine, counts, and relative polled time", async () => {
    const { container } = render(
      <RequestStatCard
        modelId="qwen3.8-27b"
        engine="vllm"
        nodeId="gx10-1c2c"
        port={8080}
        queued={3}
        running={2}
        finished={4567}
        polledAt={NOW - 10_000}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("qwen3.8-27b");
    expect(text).toContain("vllm");
    expect(text).toContain("gx10-1c2c:8080");
    expect(text).toContain("Queued");
    expect(text).toContain("Running");
    expect(text).toContain("Finished");
    expect(text).toContain("4567");
    expect(text).toContain("10s ago");
  });

  it("renders the bare node id when port is 0 and em-dash / other for empty fields", async () => {
    const { container } = render(
      <RequestStatCard
        modelId=""
        engine=""
        nodeId=""
        port={0}
        queued={0}
        running={0}
        finished={0}
        polledAt={NOW - 30_000}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("—"); // empty model header + machine
    expect(text).toContain("other"); // empty engine badge
    expect(text).not.toContain(":0");
  });
});
