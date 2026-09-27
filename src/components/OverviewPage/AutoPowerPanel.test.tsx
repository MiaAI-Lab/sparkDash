import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { AutoPowerPanel } from "./AutoPowerPanel";
import type { AutoPowerStatus } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchAutoPower: vi.fn(),
  updateAutoPowerConfig: vi.fn(),
}));

import { fetchAutoPower } from "../../api/client";

const fetchMock = vi.mocked(fetchAutoPower);

function statusWith(patch: Partial<AutoPowerStatus>): AutoPowerStatus {
  return {
    config: {
      enabled: false,
      tz: "Europe/Prague",
      idleTimeoutMin: 30,
      watch: { weekday: [], weekend: [] },
      wake: { weekday: null, weekend: null },
    },
    dayType: "weekday",
    clock: "22:00",
    watching: false,
    window: null,
    targets: [],
    sources: null,
    idleSince: null,
    idleMin: null,
    shutdownInMs: null,
    lastBusyAt: null,
    lastBusyReason: null,
    lastShutdownAt: null,
    nextWakeAt: null,
    lastAction: null,
    lastDecision: null,
    ...patch,
  };
}

afterEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

describe("AutoPower feature switch (AUTOPOWER_FEATURE)", () => {
  it("hides the panel and stops polling when the server reports feature:false", async () => {
    fetchMock.mockResolvedValue(statusWith({ feature: false }));
    const { container } = render(<AutoPowerPanel />);
    await flush();
    // Nothing renders — the card is gone from the dashboard…
    expect(container.textContent).toBe("");
    // …and the status poll that learned feature:false was the LAST one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders the Spark AutoPower card while the feature is on", async () => {
    fetchMock.mockResolvedValue(statusWith({ feature: true }));
    const { container } = render(<AutoPowerPanel />);
    await flush();
    expect(container.textContent).toContain("Spark AutoPower");
  });
});
