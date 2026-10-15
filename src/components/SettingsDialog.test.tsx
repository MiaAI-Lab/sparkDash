import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGpuClock,
  fetchSettings,
  fetchSparks,
  setFleetGpuClock,
  updateSettings,
} from "../api/client";
import type { GpuClockStatus, Settings, SparkConfig } from "../api/types";
import { SettingsDialog } from "./SettingsDialog";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchSparks: vi.fn(),
  fetchGpuClock: vi.fn(),
  setFleetGpuClock: vi.fn(),
  resetFleetGpuClock: vi.fn(),
}));

const SETTINGS: Settings = {
  pollIntervalMs: 2000,
  defaultLlmPort: 8000,
  autoHideOffline: false,
  hideWorkers: false,
  temperatureUnit: "celsius",
  benchDebugTraces: false,
  density: "compact",
  showFleetEnergy: false,
  showFleetExceptions: false,
  showOverviewSearch: false,
  showLlmTokenTotals: false,
  benchShareImage: true,
  timeZone: "",
  energyPricePerKwh: null,
  energyCurrency: "$",
  showVramBreakdown: true,
  prometheusExport: false,
  intelVramSudo: false,
  vulnhuntEnabled: false,
  reaEnabled: false,
};

const READY: GpuClockStatus = {
  supported: true,
  hwMaxMHz: 3003,
  capMHz: 2100,
  sudo: "yes",
  persistKind: "unit",
  service: { installed: false, clocks: null, enabled: null, active: null },
  cron: { installed: false, clocks: null },
};

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};

const byText = (c: HTMLElement, text: string) => {
  const button = [...c.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`no button matching ${text}`);
  return button;
};

describe("SettingsDialog fleet GPU clock and Save", () => {
  beforeEach(() => {
    vi.mocked(fetchSettings).mockReset().mockResolvedValue(SETTINGS);
    vi.mocked(updateSettings).mockReset().mockResolvedValue(SETTINGS);
    vi.mocked(fetchSparks).mockReset().mockResolvedValue({
      sparks: [
        { id: "spark1", kind: "spark" },
        { id: "spark2", kind: "spark" },
      ] as SparkConfig[],
    });
    vi.mocked(fetchGpuClock).mockReset().mockResolvedValue(READY);
    vi.mocked(setFleetGpuClock).mockReset();
  });
  afterEach(() => cleanupRenders());

  it("enables Save for a cap pick alone, and saves nothing while the fleet refuses it", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { container } = render(<SettingsDialog open onClose={onClose} onSaved={onSaved} />);
    await settle();
    const save = container.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement;
    expect(save.textContent).toBe("Save");
    expect(save.disabled).toBe(true);

    byText(container, "1800 MHz").click();
    await settle();
    // Nothing else changed: the pick is the unsaved work.
    expect(save.disabled).toBe(false);

    const refusal = "passwordless sudo is required for the user that runs the change";
    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: false,
      results: [
        { id: "spark1", ok: false, error: refusal },
        { id: "spark2", ok: false, error: refusal },
      ],
    });
    save.click();
    await settle();

    expect(setFleetGpuClock).toHaveBeenCalledWith(1800, true);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".set-fleetcap__msg")!.textContent).toContain("Nothing changed — 0 of 2 units capped");
    // Still open with the pick in place, so Save can be pressed again.
    expect(save.disabled).toBe(false);

    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: true,
      results: [
        { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
        { id: "spark2", ok: true, capMHz: 1800, persistKind: "unit" },
      ],
    });
    save.click();
    await settle();

    expect(setFleetGpuClock).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(SETTINGS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
