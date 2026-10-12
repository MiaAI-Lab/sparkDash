import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { InferenceTrafficCard } from "./InferenceTrafficCard";
import { cleanupRenders, flush, render } from "../../testing/render";
import type { InferenceActivity } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchInferenceActivity: vi.fn() }));
import { fetchInferenceActivity } from "../../api/client";
const fetchActivity = vi.mocked(fetchInferenceActivity);
const activity = (overrides: Partial<InferenceActivity> = {}): InferenceActivity => ({
  enabled: true, available: true, labels: ["service-a"], generatedAt: new Date(Date.now()).toISOString(), error: null,
  active: [{ principal: "service-a", model: "model-a", count: 2, oldestAgeMs: 1200, newestAgeMs: 100 }],
  recent: [{ principal: "service-a", model: "model-a", durationMs: 420, status: null, observedAt: "2026-10-11T12:00:00Z" }],
  overflowed: false, ...overrides,
});

describe("optional inference activity", () => {
  afterEach(() => { cleanupRenders(); vi.useRealTimers(); });

  it("shows approved labels, in-flight counts and actual durations, not token rates", async () => {
    fetchActivity.mockResolvedValue(activity());
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("service-a");
    expect(container.textContent).toContain("2 in flight");
    expect(container.textContent).toContain("420 ms");
    expect(container.textContent).toContain("not GPU slots or per-key tok/s");
    expect(container.textContent).not.toContain("200");
  });

  it("defensively hides an unapproved principal or recognizable key", async () => {
    fetchActivity.mockResolvedValue(activity({ active: [
      { ...activity().active[0], principal: "Bearer sk-secret" },
      { ...activity().active[0], principal: "unapproved" },
    ], recent: [] }));
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).not.toMatch(/sk-secret|unapproved/);
  });

  it("is hidden and stops requests when disabled", async () => {
    let poll = () => {};
    vi.spyOn(window, "setInterval").mockImplementation((handler) => { poll = handler as () => void; return 1; });
    fetchActivity.mockResolvedValue(activity({ enabled: false, available: false, active: [], recent: [] }));
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toBe("");
    await act(async () => poll());
    expect(fetchActivity).toHaveBeenCalledTimes(1);
  });

  it("distinguishes measured zero from a stale or failed source without leaking errors", async () => {
    let poll = () => {};
    vi.spyOn(window, "setInterval").mockImplementation((handler) => { poll = handler as () => void; return 1; });
    fetchActivity.mockResolvedValue(activity({ active: [], recent: [] }));
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("0 in flight");
    fetchActivity.mockResolvedValue(activity({ available: false }));
    await act(async () => poll());
    expect(container.textContent).toContain("counts are unknown");
    expect(container.textContent).not.toMatch(/0 in flight|service-a/);
    fetchActivity.mockRejectedValue(new Error("Bearer private-key http://private.example"));
    await act(async () => poll());
    expect(container.textContent).not.toMatch(/private-|Bearer|http/);
    fetchActivity.mockResolvedValue(activity());
    await act(async () => poll());
    expect(container.textContent).toContain("2 in flight");
  });

  it("marks truncated source counts as incomplete", async () => {
    fetchActivity.mockResolvedValue(activity({ overflowed: true }));
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("counts may be incomplete");
  });

  it.each([-3_600_000, 3_600_000])("trusts server availability with client clock skew %i ms", async (skew) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-11T12:00:00Z") + skew);
    fetchActivity.mockResolvedValue(activity({ generatedAt: "2026-10-11T12:00:00Z" }));
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("2 in flight");
    expect(container.textContent).toContain("service-a");
  });

  it("expires a stalled transport without reinterpreting server timestamps and recovers", async () => {
    vi.useFakeTimers();
    fetchActivity.mockResolvedValue(activity());
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("2 in flight");
    let finish!: (value: InferenceActivity) => void;
    fetchActivity.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => vi.advanceTimersByTime(5000));
    vi.setSystemTime(Date.now() - 3_600_000);
    await act(async () => vi.advanceTimersByTime(26000));
    expect(container.textContent).toContain("counts are unknown");
    expect(container.textContent).not.toMatch(/2 in flight|service-a/);
    await act(async () => finish(activity()));
    expect(container.textContent).toContain("2 in flight");
  });

  it("resets the transport timeout on a new response and clears timers on unmount", async () => {
    vi.useFakeTimers();
    fetchActivity.mockResolvedValue(activity());
    const { container, root } = render(<InferenceTrafficCard />);
    await flush();
    await act(async () => vi.advanceTimersByTime(20_000));
    await act(async () => vi.advanceTimersByTime(11_000));
    expect(container.textContent).toContain("2 in flight");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    const calls = fetchActivity.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetchActivity).toHaveBeenCalledTimes(calls);
  });
});
