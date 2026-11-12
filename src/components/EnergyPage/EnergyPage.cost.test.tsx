import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyPage } from "./EnergyPage";
import { flush, render } from "../../testing/render";
import type { EnergyHistory, EnergyHistoryRow, FleetEnergy, Settings, SparkSnapshot } from "../../api/types";
import { resetPowerMeterStatusCache } from "../../hooks/usePowerMeters";

vi.mock("../../api/client", () => ({
  fetchFleetEnergy: vi.fn(),
  fetchEnergyHistory: vi.fn(),
  fetchMonthlyEnergy: vi.fn(),
  clearFleetEnergy: vi.fn(),
  fetchRestartAvailable: vi.fn().mockResolvedValue({ available: false }),
  restartServer: vi.fn(),
}));
vi.mock("../../api/powerMeters", () => ({ fetchPowerMeterStatus: vi.fn() }));
vi.mock("../ui/useElementWidth", () => ({ useElementWidth: () => [() => undefined, 600] }));

import { fetchEnergyHistory, fetchFleetEnergy, fetchMonthlyEnergy } from "../../api/client";
import { fetchPowerMeterStatus } from "../../api/powerMeters";

const HOUR = 3_600_000;
const now = Date.now();
const lastHour = Math.floor(now / HOUR) * HOUR - HOUR;
const sparks = [{ id: "spark-a", name: "Dan", online: true, metrics: {} }] as unknown as SparkSnapshot[];

const row = (t: number, wh: number): EnergyHistoryRow => ({
  t,
  nodeWh: { "spark-a": wh },
  nodeCoverageMs: { "spark-a": HOUR },
  avgWatts: wh,
  fleetEnergyWh: wh,
  fleetCoverageMs: HOUR,
  outputTokens: 0,
  coveredOutputTokens: 0,
});

const history: EnergyHistory = {
  estimated: true,
  membershipChanged: false,
  generatedAt: now,
  retentionMs: 31 * 24 * HOUR,
  nodeIds: ["spark-a"],
  // 1 kWh three days ago, 0.1 kWh in the last hour.
  hourly: [row(lastHour - 72 * HOUR, 1000), row(lastHour, 100)],
};

const live = {
  estimated: true,
  membershipChanged: false,
  restartRequired: false,
  trackedNodeIds: ["spark-a"],
  currentNodeIds: ["spark-a"],
  freshNodeCount: 1,
  currentWatts30s: 100,
  energy24hKwh: 0.1,
  energy31dKwh: 1.1,
  whPerOutputToken24h: null,
  outputTokens24h: 0,
  coverage24hMs: HOUR,
  coverage24hWindowMs: 24 * HOUR,
  coverage31dMs: 2 * HOUR,
  coverage31dWindowMs: 31 * 24 * HOUR,
  nodeCoverage24hMs: {},
  nodeCoverage31dMs: {},
  hourlyWatts24h: Array(24).fill(100),
} as FleetEnergy;

const priced = { energyPricePerKwh: 0.5, energyCurrency: "$", energyPriceMode: "flat", energyPricePeriods: [] } as unknown as Settings;

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}
const costTile = (c: HTMLElement) => [...c.querySelectorAll(".en-tile")].find((x) => x.querySelector(".eyebrow")?.textContent === "Estimated cost")!;
const energyChart = (c: HTMLElement) => c.querySelector('[aria-labelledby="en-h-energy"]')!;
const pick = (c: HTMLElement, label: string) =>
  act(() => [...c.querySelectorAll('.seg[aria-label="Time range"] button')].find((b) => b.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

beforeEach(() => {
  resetPowerMeterStatusCache();
  vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "absent" });
  vi.mocked(fetchFleetEnergy).mockResolvedValue(live);
  vi.mocked(fetchEnergyHistory).mockResolvedValue(history);
  vi.mocked(fetchMonthlyEnergy).mockResolvedValue({ estimated: true, generatedAt: now, foldedThroughMs: now, months: [] });
});

describe("Energy page cost", () => {
  it("asks for a price and draws no cost line without one", async () => {
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(costTile(container).textContent).toContain("Set an electricity price in Settings");
    expect(energyChart(container).querySelector("path")).toBeNull();
  });

  it("follows the time range and overlays cost on its own axis", async () => {
    const { container } = render(<EnergyPage sparks={sparks} settings={priced} />);
    await settle();
    expect(costTile(container).querySelector(".big-num")!.textContent).toBe("$0.05");
    expect(energyChart(container).textContent).toContain("Cost ($, right axis)");
    // One priced hour so far: a lone point on the line.
    expect(energyChart(container).querySelector("circle")).not.toBeNull();
    pick(container, "7 d");
    await settle();
    expect(costTile(container).querySelector(".big-num")!.textContent).toBe("$0.55");
    // Two days with use, days apart: two points, no line across the empty days.
    expect(energyChart(container).querySelectorAll("circle")).toHaveLength(2);
    expect(energyChart(container).querySelector("path")).toBeNull();
  });

  it("prices hours by time of use", async () => {
    const tou = { ...priced, energyPriceMode: "tou", energyPricePeriods: [{ from: 0, to: 24, price: 1, days: "all" }] } as Settings;
    const { container } = render(<EnergyPage sparks={sparks} settings={tou} />);
    await settle();
    pick(container, "7 d");
    await settle();
    expect(costTile(container).querySelector(".big-num")!.textContent).toBe("$1.10");
    expect(costTile(container).textContent).toContain("time of use");
  });
});