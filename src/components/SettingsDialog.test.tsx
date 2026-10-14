import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchClockCap: vi.fn(),
  setClockCap: vi.fn(),
}));
vi.mock("../api/authToken", () => ({
  getToken: vi.fn().mockReturnValue(""),
  onTokenChange: vi.fn().mockReturnValue(() => {}),
  requestTokenPrompt: vi.fn(),
  clearToken: vi.fn(),
}));

import { fetchSettings, fetchClockCap, setClockCap } from "../api/client";
import type { Settings, SparkSnapshot } from "../api/types";
import { SettingsDialog } from "./SettingsDialog";
import { flush, render } from "../testing/render";

const fetchSettingsMock = vi.mocked(fetchSettings);
const fetchClockCapMock = vi.mocked(fetchClockCap);
const setClockCapMock = vi.mocked(setClockCap);

const DEFAULT_SETTINGS: Settings = {
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  hideWorkers: false,
  temperatureUnit: "celsius",
  energyCurrency: "$",
  energyPricePerKwh: null,
  showFleetEnergy: true,
  showFleetExceptions: false,
  showOverviewSearch: false,
  showLlmTokenTotals: true,
  showVramBreakdown: true,
  benchShareImage: false,
  benchDebugTraces: false,
  prometheusExport: false,
} as Settings;

function okStatus(id: string, overrides = {}) {
  return { id, name: id.toUpperCase(), ok: true, mhz: null, stale: false, graphicsClockMHz: null, ...overrides };
}

function spark(id: string): SparkSnapshot {
  return { id, name: id.toUpperCase(), online: true, metrics: { gpu: null } } as SparkSnapshot;
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
}

/** The confirm sheet FleetClockCap portals to document.body (narrow modal-sheet). */
function confirmSheet(): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].find((d) =>
    d.classList.contains("modal-sheet--narrow")
  );
  if (!el) throw new Error("confirm sheet not open");
  return el;
}

function button(label: string, scope: HTMLElement = dialog()): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`button not found: ${label}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  fetchSettingsMock.mockResolvedValue(DEFAULT_SETTINGS);
  fetchClockCapMock.mockResolvedValue({ success: true, sparks: [okStatus("s1"), okStatus("s2", { mhz: 2000 })] });
  setClockCapMock.mockReset();
});

describe("SettingsDialog fleet clock control", () => {
  it("hosts the fleet-wide clock cap panel with presets and Unlocked", async () => {
    const { container } = render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1"), spark("s2")]} />);
    await flush();

    // The panel is present, with the full preset range and Unlocked.
    expect(container.textContent).toContain("GPU clock cap");
    const presetGroup = container.querySelector('[aria-label="Fleet clock cap preset"]')!;
    for (const mhz of [1800, 1900, 2000, 2100, 2200, 2300, 2400]) {
      expect(presetGroup.textContent).toContain(String(mhz));
    }
    expect(presetGroup.textContent).not.toContain("1700");
    expect(presetGroup.textContent).toContain("Unlocked");
  });

  it("applies a preset fleet-wide from Settings after confirm", async () => {
    setClockCapMock.mockResolvedValue({
      success: true,
      mhz: 1800,
      results: [{ id: "s1", name: "s1", ok: true, mhz: 1800, graphicsClockMHz: 1799 }],
    });
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1"), spark("s2")]} />);
    await flush();

    act(() => button("1800").click());
    await flush();
    // Confirm dialog names the whole fleet before anything is applied.
    expect(setClockCapMock).not.toHaveBeenCalled();
    await act(async () => button("Set 1800 MHz", confirmSheet()).click());
    await flush();

    expect(setClockCapMock).toHaveBeenCalledWith("all", 1800);
  });

  it("unlocks every Spark from Settings", async () => {
    setClockCapMock.mockResolvedValue({
      success: true,
      mhz: null,
      results: [{ id: "s1", name: "s1", ok: true, mhz: null }],
    });
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} sparks={[spark("s1")]} />);
    await flush();

    act(() => button("Unlocked").click());
    await flush();
    await act(async () => button("Unlocked — confirm", confirmSheet()).click());
    await flush();

    expect(setClockCapMock).toHaveBeenCalledWith("all", null);
  });
});
