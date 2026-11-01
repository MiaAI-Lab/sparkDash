/**
 * The kiosk spark-card trace must be self-describing: each line prints its latest value,
 * and the tok/s lines (which share no scale with the % lines) name their auto peaks (#337).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { cleanupRenders, flush, render } from "../../testing/render";
import { KioskPage } from "./KioskPage";
import type { KioskTraces } from "./kioskModel";

let sparks: SparkSnapshot[] = [];
let traces: Record<string, KioskTraces> = {};

vi.mock("../../hooks/useSnapshot", () => ({
  useSnapshot: () => ({
    sparks,
    connected: true,
    lastValidSnapshotAt: Date.now(),
    refreshInterval: 2_000,
    serverAlerts: null,
  }),
}));

vi.mock("./useKioskTraces", () => ({
  useKioskTraces: () => traces,
}));

vi.mock("../../api/client", () => ({
  fetchSettings: () =>
    Promise.resolve({ temperatureUnit: "celsius", alertsEnabled: false, hideWorkers: false, timeZone: null }),
  fetchFleetEnergy: () => Promise.resolve({ estimated: true, energy24hKwh: 0, outputTokens24h: 0 }),
  getUnitHistory: () => Promise.resolve({ enabled: false }),
}));

describe("kiosk trace readouts", () => {
  afterEach(() => {
    cleanupRenders();
    window.history.replaceState(null, "", "/kiosk");
  });

  it("prints each line's latest value and names the tok/s auto peaks", async () => {
    sparks = [makeSpark("a")];
    traces = {
      a: { gpu: [80, 87], cpu: [40, 41], gen: [100, 139], prefill: [0, 0] },
    };
    window.history.replaceState(null, "", "/kiosk");
    const { container } = render(<KioskPage />);
    await flush();

    const legend = container.querySelector(".kiosk-card .kiosk-trace__legend")!;
    expect(legend.textContent).toContain("GPU87%");
    expect(legend.textContent).toContain("CPU41%");
    expect(legend.textContent).toContain("gen tok/s139");
    expect(legend.textContent).toContain("prefill tok/s0");

    // gen's own peak is 200, prefill's floor is 100 — the caption names both.
    const scale = container.querySelector(".kiosk-card .kiosk-trace__scale")!;
    expect(scale.textContent).toBe("tok/s auto peak · gen ≤200 · prefill ≤100");
  });

  it("omits the rate caption when the card has only % lines", async () => {
    sparks = [makeSpark("a")];
    traces = { a: { gpu: [10, 20], cpu: [30, 40], gen: [null, null], prefill: [null, null] } };
    window.history.replaceState(null, "", "/kiosk");
    const { container } = render(<KioskPage />);
    await flush();

    const legend = container.querySelector(".kiosk-card .kiosk-trace__legend")!;
    expect(legend.textContent).toContain("GPU20%");
    expect(container.querySelector(".kiosk-card .kiosk-trace__scale")).toBeNull();
  });
});
