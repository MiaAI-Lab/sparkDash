import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGpuClock,
  fetchSettings,
  fetchSparks,
  resetFleetGpuClock,
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
  mqttEnabled: false,
  mqttUrl: "",
  mqttUsername: "",
  mqttTopicPrefix: "sparkdash",
  occupancyMaxAgeMs: 12 * 60 * 60 * 1000,
  healthTempWarnC: 85,
  healthTempCriticalC: 90,
};

const READY: GpuClockStatus = {
  supported: true,
  hwMaxMHz: 3003,
  capMHz: 2100,
  sudo: "yes",
  persistKind: "unit",
  service: { installed: false, clocks: null, enabled: null, active: null },
  cron: { installed: false, clocks: null, failed: false },
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
      applied: 0,
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
    // Still open with the pick in place, so Save can be pressed again.
    expect(save.disabled).toBe(false);

    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: true,
      applied: 2,
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

  it("keeps Save open to retry when the read after a refused boot hook finds the cap already on", async () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsDialog open onClose={onClose} onSaved={vi.fn()} />);
    await settle();
    const save = container.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement;

    byText(container, "1800 MHz").click();
    await settle();
    // The cap lands everywhere but the boot hook is refused: the units now report 1800 MHz.
    const refusal =
      "keeping the cap after reboot needs passwordless sudo for the system service (NOPASSWD: ALL) or a running cron service for a @reboot job, and this unit offers neither";
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...READY, capMHz: 1800 });
    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: false,
      applied: 0,
      results: [
        { id: "spark1", ok: false, error: refusal },
        { id: "spark2", ok: false, error: refusal },
      ],
    });
    save.click();
    await settle();

    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain("Now: capped at 1800 MHz on 2 units");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The matching read does not count as the Save having taken.
    expect(save.disabled).toBe(false);

    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: true,
      applied: 2,
      results: [
        { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
        { id: "spark2", ok: true, capMHz: 1800, persistKind: "unit" },
      ],
    });
    save.click();
    await settle();

    // The retry runs the cap again with the tick it was asked with, then saves.
    expect(setFleetGpuClock).toHaveBeenCalledTimes(2);
    expect(setFleetGpuClock).toHaveBeenLastCalledWith(1800, true);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps a same-frequency persistence change retryable before saving settings", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...READY,
      service: { installed: true, clocks: "0,2100", enabled: "enabled", active: "active" },
    });
    const onClose = vi.fn();
    const { container } = render(<SettingsDialog open onClose={onClose} onSaved={vi.fn()} />);
    await settle();
    const save = container.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    (container.querySelector('.set-fleetcap input[type="checkbox"]') as HTMLInputElement).click();
    await settle();
    expect(save.disabled).toBe(false);
    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: false, applied: 0,
      results: [{ id: "spark1", ok: false, error: "could not remove the boot service" }],
    });
    save.click();
    await settle();
    expect(setFleetGpuClock).toHaveBeenCalledWith(2100, false);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);

    vi.mocked(fetchGpuClock).mockResolvedValue(READY);
    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: true, applied: 2,
      results: [
        { id: "spark1", ok: true, capMHz: 2100, persistKind: "none" },
        { id: "spark2", ok: true, capMHz: 2100, persistKind: "none" },
      ],
    });
    save.click();
    await settle();
    expect(setFleetGpuClock).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("retries a failed settings write after a GPU-only change without applying the GPU again", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("settings unavailable")).mockResolvedValue(SETTINGS);
    vi.mocked(setFleetGpuClock).mockResolvedValue({
      success: true, applied: 2,
      results: [
        { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
        { id: "spark2", ok: true, capMHz: 1800, persistKind: "unit" },
      ],
    });
    const { container } = render(<SettingsDialog open onClose={onClose} onSaved={onSaved} />);
    await settle();
    byText(container, "1800 MHz").click();
    await settle();
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...READY, capMHz: 1800,
      service: { installed: true, clocks: "0,1800", enabled: "enabled", active: "active" },
    });
    const save = container.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement;
    save.click();
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(save.disabled).toBe(false);

    save.click();
    await settle();
    expect(setFleetGpuClock).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledWith(SETTINGS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resets installed boot hooks when Full capacity is selected on already-unlocked GPUs", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...READY,
      capMHz: null,
      cron: { installed: true, clocks: "0,1800", failed: true },
    });
    vi.mocked(resetFleetGpuClock).mockReset().mockResolvedValue({
      success: true,
      applied: 2,
      results: [
        { id: "spark1", ok: true, capMHz: null, persistKind: "none" },
        { id: "spark2", ok: true, capMHz: null, persistKind: "none" },
      ],
    });
    const { container } = render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await settle();
    byText(container, "Full capacity").click();
    await settle();
    const save = container.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    await settle();
    expect(resetFleetGpuClock).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
