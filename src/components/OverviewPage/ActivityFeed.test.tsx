import { describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";
import { flush, render } from "../../testing/render";
import type { ActivityEvent } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn() }));
import { fetchEvents } from "../../api/client";
const fetchMock = vi.mocked(fetchEvents);

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 1,
    ts: Date.now() - 120_000,
    type: "gpu.throttle.thermal",
    severity: "warn",
    sparkId: "s3",
    sparkName: "spark-03",
    message: "spark-03 started thermal throttling (84°C)",
    ...over,
  };
}

describe("activity formatting", () => {
  const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
  it("formats relative times", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("now");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2m");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe("2d");
    expect(formatRelativeTime(new Date(2026, 9, 5, 8).getTime() - 8 * 86400_000, now)).toBe("Sep 27");
  });
  it("maps severities and splits messages", () => {
    expect(severityDotClass("error")).toBe("bg-danger");
    expect(severityDotClass("success")).toBe("bg-success");
    expect(splitMessage("x went offline", "x")).toEqual({ before: "", name: "x", after: " went offline" });
    expect(splitMessage("hello", "zz").name).toBe("");
  });
});

describe("ActivityFeed", () => {
  it("shows the empty state", async () => {
    fetchMock.mockResolvedValue([]);
    const { container } = render(<ActivityFeed />);
    await flush();
    expect(container.textContent).toContain("Nothing yet.");
    expect(container.textContent).toContain("live");
  });

  it("renders events and selects the spark on name click", async () => {
    fetchMock.mockResolvedValue([ev({}), ev({ id: 2, severity: "success", message: "other", sparkName: null, sparkId: null })]);
    const onSelect = vi.fn();
    const { container } = render(<ActivityFeed limit={5} onSelectSpark={onSelect} />);
    await flush();
    expect(container.textContent).toContain("started thermal throttling (84°C)");
    expect(container.textContent).toContain("2m");
    container.querySelector("button")!.click();
    expect(onSelect).toHaveBeenCalledWith("s3");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });
});
