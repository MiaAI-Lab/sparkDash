import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { InferenceTrafficCard } from "./InferenceTrafficCard";
import { flush, render } from "../../testing/render";
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

  it("expires the last live response while a later browser fetch remains pending", async () => {
    let now = Date.parse("2026-10-11T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let poll = () => {};
    vi.spyOn(window, "setInterval").mockImplementation((handler) => { poll = handler as () => void; return 1; });
    fetchActivity.mockResolvedValue(activity());
    const { container } = render(<InferenceTrafficCard />);
    await flush();
    expect(container.textContent).toContain("2 in flight");
    let finish!: (value: InferenceActivity) => void;
    fetchActivity.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    now += 5000;
    await act(async () => poll());
    now += 26000;
    await act(async () => poll());
    expect(container.textContent).toContain("counts are unknown");
    expect(container.textContent).not.toMatch(/2 in flight|service-a/);
    await act(async () => finish(activity()));
    expect(container.textContent).toContain("2 in flight");
  });
});
