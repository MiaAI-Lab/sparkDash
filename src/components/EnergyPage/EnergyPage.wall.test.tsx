import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyPage } from "./EnergyPage";
import { MonthlyEnergy } from "./MonthlyEnergy";
import { FleetEnergyCard } from "../OverviewPage/FleetEnergyCard";
import { flush, render } from "../../testing/render";
import type { EnergyHistory, EnergyHistoryRow, FleetEnergy, FleetWallEnergy, MonthlyEnergy as MonthlyEnergyData, SparkSnapshot } from "../../api/types";
import type { PowerMeterStatus } from "../../api/powerMeters";
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

import { fetchEnergyHistory, fetchFleetEnergy, fetchMonthlyEnergy } from "../../api/client";
import { fetchPowerMeterStatus } from "../../api/powerMeters";

const HOUR = 3_600_000;
const now = Date.now();
const lastHour = Math.floor(now / HOUR) * HOUR - HOUR;
const sparks = [
  { id: "spark-a", name: "Dan", online: true, metrics: { gpu: { power: { draw: 12 } }, cpu: { draw: 6 } } },
  { id: "spark-b", name: "Stepan", online: true, metrics: { gpu: { power: { draw: 11 } }, cpu: { draw: 5 } } },
] as unknown as SparkSnapshot[];

function live(wall?: FleetWallEnergy): FleetEnergy {
  return {
    estimated: true,
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: ["spark-a", "spark-b"],
    currentNodeIds: ["spark-a", "spark-b"],
    freshNodeCount: 2,
    currentWatts30s: 80,
    energy24hKwh: 1.9,
    energy31dKwh: 30,
    whPerOutputToken24h: null,
    outputTokens24h: 0,
    coverage24hMs: 86_400_000,
    coverage24hWindowMs: 86_400_000,
    coverage31dMs: 0,
    coverage31dWindowMs: 86_400_000 * 31,
    nodeCoverage24hMs: {},
    nodeCoverage31dMs: {},
    hourlyWatts24h: Array(24).fill(80),
    ...(wall ? { wall } : {}),
  };
}

const wall: FleetWallEnergy = {
  nodeIds: ["spark-a"],
  freshNodeIds: ["spark-a"],
  filledNodeIds: ["spark-b"],
  staleNodeIds: [],
  ratios: { "spark-a": 1.4, "spark-b": 1.41 },
  ownRatios: { "spark-a": 1.4 },
  fleetRatio: 1.41,
  currentWatts30s: 111,
  currentFilled: true,
  energy24hKwh: 2.9,
  filledEnergy24hKwh: 1.3,
  energy31dKwh: 80,
  whPerOutputToken24h: null,
  coverage24hMs: 86_400_000,
  coverage24hWindowMs: 86_400_000,
  coverage31dMs: 0,
  coverage31dWindowMs: 86_400_000 * 31,
  nodeCoverage24hMs: {},
  nodeCoverage31dMs: {},
  hourlyWatts24h: Array(24).fill(111),
};

const baseRow: EnergyHistoryRow = {
  t: lastHour,
  nodeWh: { "spark-a": 40, "spark-b": 40 },
  nodeCoverageMs: { "spark-a": HOUR, "spark-b": HOUR },
  avgWatts: 80,
  fleetEnergyWh: 80,
  fleetCoverageMs: HOUR,
  outputTokens: 0,
  coveredOutputTokens: 0,
};

function history(metered: boolean): EnergyHistory {
  return {
    estimated: true,
    membershipChanged: false,
    generatedAt: now,
    retentionMs: 31 * 24 * HOUR,
    nodeIds: ["spark-a", "spark-b"],
    ...(metered ? { wallNodeIds: ["spark-a"], wallRatios: { "spark-a": 1.4, "spark-b": 1.41 } } : {}),
    hourly: [
      metered
        ? {
            ...baseRow,
            nodeGpuWh: { "spark-a": 12, "spark-b": 11 },
            nodeCpuWh: { "spark-a": 6, "spark-b": 5 },
            nodePartsCoverageMs: { "spark-a": HOUR, "spark-b": HOUR },
            nodeWallWh: { "spark-a": 56, "spark-b": 0 },
            nodeWallCoverageMs: { "spark-a": HOUR, "spark-b": 0 },
            nodeWallMeteredMs: { "spark-a": HOUR, "spark-b": 0 },
            nodeWallFilledWh: { "spark-a": 0, "spark-b": 56.4 },
            nodeWallFilledMs: { "spark-a": 0, "spark-b": HOUR },
            avgWallWatts: 112.4,
            fleetWallWh: 112.4,
            fleetWallFilledWh: 56.4,
            fleetWallCoverageMs: HOUR,
            wallCoveredOutputTokens: 0,
          }
        : baseRow,
    ],
  };
}

const status: PowerMeterStatus = {
  enabled: true,
  state: "ok",
  configPath: "/etc/sparkdash/power-meters.json",
  pollIntervalMs: 10_000,
  staleAfterMs: 30_000,
  history: { enabled: true, backfillDays: 400 },
  meters: [
    {
      id: "ha",
      type: "homeassistant",
      label: "Home Assistant",
      target: "https://homeassistant.lan",
      health: "ok",
      ok: true,
      error: null,
      lastOkAt: now,
      history: { state: "ok", lastOkAt: now, lastError: null, backfill: null },
    },
  ],
  units: [
    { id: "spark-a", name: "Dan", known: true, recorded: true, meter: "ha", channel: "sensor.p3", sinceMs: null, watts: 55.4, atMs: now, fresh: true, error: null, polledAtMs: now, reconciledThroughMs: lastHour + HOUR },
  ],
};

const monthly = (months: MonthlyEnergyData["months"]): MonthlyEnergyData => ({ estimated: true, generatedAt: now, foldedThroughMs: now, months });

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}

beforeEach(() => {
  resetPowerMeterStatusCache();
  vi.mocked(fetchMonthlyEnergy).mockResolvedValue(monthly([]));
});

describe("Energy page", () => {
  it("is unchanged without power meters", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "absent" });
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live());
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(false));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Estimated, not metered.");
    expect(container.textContent).toContain("Not wall-metered.");
    expect(container.querySelector(".en-meters")).toBeNull();
    expect(container.querySelector('[aria-label="Energy source"]')).toBeNull();
    expect(container.textContent).not.toContain("GPU (measured)");
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).not.toContain("GPU");
  });

  it("shows wall power with GPU and CPU beside it, drops the raw estimate, and says the meter works", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(status);
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("Measured at the wall by Home Assistant.");
    // One dashboard: no source switch, no explanatory banner, no warning.
    expect(container.querySelector('[aria-label="Energy source"]')).toBeNull();
    expect(container.querySelector(".en-banner")).toBeNull();
    // HA is configured and working: a green chip, details on hover.
    const chip = container.querySelector(".en-meter-chip")!;
    expect(chip.textContent).toBe("Home Assistant");
    expect(chip.className).toContain("tag--good");
    expect(chip.getAttribute("title")).toMatch(/^https:\/\/homeassistant\.lan · every 10 s · record through .+ · Dan 55 W$/);
    // Headline is wall: 111 W now, live GPU and CPU on one line under it; the raw
    // estimate (80 W, below the wall) is not shown once the wall is measured.
    expect(text).toContain("Current draw");
    expect(text).toContain("111W");
    expect(text).toContain("GPU 23 · CPU 11 W");
    expect(text).not.toContain("80 W");
    expect(text).toContain("50% filled");
    // The power chart draws GPU and CPU over wall power, and no estimate line.
    const legend = [...container.querySelectorAll('[aria-label="Lines"] span')].map((x) => x.textContent);
    expect(legend).toEqual(["Wall", "GPU", "CPU"]);
    // The table adds GPU and CPU per node, not the estimate.
    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(["GPU", "CPU"]));
    expect(headers).not.toContain("Estimate");
    expect(text).toContain("Dan 140%, Stepan 141%");
  });

  it("names meters the way their provider does", async () => {
    const other = { ...status, meters: [{ ...(status.enabled ? status.meters[0] : ({} as never)), type: "shelly", label: "Shelly Pro 4PM" }] } as PowerMeterStatus;
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(other);
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Measured at the wall by Shelly Pro 4PM.");
    expect(container.querySelector(".en-meter-chip")?.textContent).toBe("Shelly Pro 4PM");
    expect(container.textContent).not.toContain("Home Assistant");
  });

  it("falls back to the meter type when an older server sends no label", async () => {
    const older = { ...status, meters: [{ ...(status.enabled ? status.meters[0] : ({} as never)), label: undefined }] } as unknown as PowerMeterStatus;
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(older);
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Measured at the wall by homeassistant.");
    expect(container.querySelector(".en-meter-chip")?.textContent).toBe("homeassistant");
  });

  it("warns, and turns the chip red, when the meter stops reading", async () => {
    const broken: PowerMeterStatus = {
      ...status,
      meters: [{ ...(status.enabled ? status.meters[0] : ({} as never)), health: "error", ok: false, error: "spark-a: entity is unavailable" }],
    } as PowerMeterStatus;
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue(broken);
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(true));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.querySelector(".en-meter-chip")?.textContent).toBe("Home Assistant · not reading");
    expect(container.querySelector(".en-meter-chip")?.className).toContain("tag--bad");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Home Assistant: spark-a: entity is unavailable. Missing readings are filled from the estimate."
    );
  });

  it("reports a broken config instead of silently showing the estimate", async () => {
    vi.mocked(fetchPowerMeterStatus).mockResolvedValue({ enabled: false, state: "invalid", error: "units.spark-a.channel: must be a Home Assistant entity id" });
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live());
    vi.mocked(fetchEnergyHistory).mockResolvedValue(history(false));
    const { container } = render(<EnergyPage sparks={sparks} settings={null} />);
    await settle();
    expect(container.textContent).toContain("Power meters off:");
    expect(container.textContent).toContain("must be a Home Assistant entity id");
  });
});

describe("Monthly history with wall power", () => {
  it("shows a metered month at the wall, with its filled share and no raw estimate", async () => {
    const start = Date.UTC(2026, 9, 1);
    vi.mocked(fetchMonthlyEnergy).mockResolvedValue(
      monthly([
        {
          month: "2026-10",
          startMs: start,
          endMs: Date.UTC(2026, 10, 1),
          closed: false,
          nodeIds: ["spark-a"],
          nodes: { "spark-a": { wh: 40_000, coverageMs: HOUR, wallWh: 45_000, wallCoverageMs: HOUR, wallFilledWh: 5_000, wallFilledMs: HOUR } },
          totalWh: 40_000,
          fleetWh: 40_000,
          fleetCoverageMs: HOUR,
          outputTokens: 0,
          coveredOutputTokens: 0,
          whPerOutputToken: null,
          totalWallWh: 50_000,
          totalWallFilledWh: 5_000,
          fleetWallWh: 50_000,
          fleetWallCoverageMs: HOUR,
        },
      ])
    );
    const { container } = render(<MonthlyEnergy nameOf={(id) => id} price={null} currency="$" />);
    await settle();
    expect(container.textContent).toContain("50.0 kWh");
    expect(container.textContent).not.toContain("Estimate");
    expect(container.textContent).toContain("Measured at the wall, 10.0% filled from the estimate.");
  });
});

describe("Overview energy card with wall power", () => {
  it("shows wall figures only", async () => {
    vi.mocked(fetchFleetEnergy).mockResolvedValue(live(wall));
    const { container } = render(<FleetEnergyCard nodeCount={2} />);
    await settle();
    expect(container.textContent).toContain("2.90kWh / 24 h");
    expect(container.textContent).toContain("Wall-metered · 24h coverage 100.0%");
    expect(container.textContent).not.toContain("1.90");
    expect(container.textContent).toContain("111 W");
    expect(container.textContent).toContain("2/2 fresh");
  });
});
