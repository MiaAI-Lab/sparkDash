import { describe, expect, it, vi } from "vitest";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { flush, render } from "../../testing/render";
import type { FleetEnergy } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchFleetEnergy: vi.fn(),
}));

import { fetchFleetEnergy } from "../../api/client";

const fetchEnergy = vi.mocked(fetchFleetEnergy);

function energy(overrides: Partial<FleetEnergy> = {}): FleetEnergy {
  return {
    estimated: true,
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: ["a", "b"],
    currentNodeIds: ["a", "b"],
    freshNodeCount: 2,
    currentWatts30s: 240,
    energy24hKwh: 1.5,
    energy31dKwh: 40,
    whPerOutputToken24h: 0.0123,
    outputTokens24h: 100,
    coverage24hMs: 86_400_000 * 2,
    coverage31dMs: 0,
    nodeCoverage24hMs: {},
    nodeCoverage31dMs: {},
    hourlyWatts24h: Array.from({ length: 24 }, (_, hour) => (hour % 4 === 0 ? null : 100 + hour)),
    ...overrides,
  };
}

describe("FleetEnergyCard states", () => {
  it("labels estimated values and keeps hourly gaps empty", async () => {
    fetchEnergy.mockResolvedValue(energy());
    const { container } = render(<FleetEnergyCard nodeCount={2} />);
    await flush();
    expect(container.textContent).toContain("Estimated, not wall-metered");
    expect(container.textContent).toContain("240 W");
    expect(container.textContent).toContain("0.0123 Wh/token");
    const bars = [...container.querySelectorAll("[aria-label] span")];
    expect(bars.filter((bar) => (bar as HTMLElement).style.height === "0px" || (bar as HTMLElement).style.height === "0")).toHaveLength(6);
  });

  it("explains empty, partial, membership-changed, and fetch-error states", async () => {
    fetchEnergy.mockResolvedValue(energy({ energy24hKwh: null, currentWatts30s: null }));
    const warming = render(<FleetEnergyCard nodeCount={2} />);
    await flush();
    expect(warming.container.textContent).toContain("Warming up");

    fetchEnergy.mockResolvedValue(energy({ freshNodeCount: 1 }));
    const partial = render(<FleetEnergyCard nodeCount={2} />);
    await flush();
    expect(partial.container.textContent).toContain("Partial coverage: 1/2");

    fetchEnergy.mockResolvedValue(energy({ membershipChanged: true, restartRequired: true }));
    const membership = render(<FleetEnergyCard nodeCount={2} />);
    await flush();
    expect(membership.container.textContent).toContain("Restart sparkDash");

    fetchEnergy.mockRejectedValue(new Error("disk write failed"));
    const failed = render(<FleetEnergyCard nodeCount={2} />);
    await flush();
    expect(failed.container.textContent).toContain("Energy telemetry unavailable: disk write failed");
  });
});
