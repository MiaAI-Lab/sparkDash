import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../testing/render";
import { SettingsDialog } from "./SettingsDialog";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const settings = {
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  hideWorkers: false,
  temperatureUnit: "celsius",
  benchDebugTraces: false,
  density: "compact",
  showFleetEnergy: true,
  showFleetExceptions: false,
  showOverviewSearch: false,
  showLlmTokenTotals: true,
  showKpiDecode: true,
  showKpiPower: true,
  showKpiMemory: true,
  showKpiTokens: true,
  showActivityFeed: true,
  benchShareImage: true,
  timeZone: "",
  energyPricePerKwh: null,
  energyCurrency: "$",
  showVramBreakdown: true,
  prometheusExport: false,
  intelVramSudo: false,
  vulnhuntEnabled: false,
  reaEnabled: false,
  occupancyMaxAgeMs: 12 * 60 * 60 * 1000,
} satisfies Settings;

describe("SettingsDialog session age", () => {
  beforeEach(() => {
    vi.mocked(fetchSettings).mockResolvedValue(settings);
    vi.mocked(updateSettings).mockImplementation(async (next) => ({ ...settings, ...next }) as Settings);
  });

  it("saves a finite session age and can open the harness wizard", async () => {
    const onOpen = vi.fn();
    const onSaved = vi.fn();
    render(<SettingsDialog open onClose={vi.fn()} onSaved={onSaved} onOpenHarness={onOpen} />);
    await flush();
    const hour = [...document.querySelectorAll("button")].find((item) => item.textContent === "1h");
    act(() => hour?.click());
    const save = [...document.querySelectorAll("button")].find((item) => item.textContent === "Save");
    await act(async () => save?.click());
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ occupancyMaxAgeMs: 60 * 60 * 1000 }));
    const setup = [...document.querySelectorAll("button")].find((item) => item.textContent === "Set up");
    act(() => setup?.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});