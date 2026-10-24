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
  occupancyMaxAgeMs: 12 * 60 * 60 * 1000,
  healthTempWarnC: 85,
  healthTempCriticalC: 90,
  mqttEnabled: false,
  mqttUrl: "",
  mqttUsername: "",
  mqttTopicPrefix: "sparkdash",
} satisfies Settings;

/** Type into a React-controlled number input. */
function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const saveButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save");

describe("SettingsDialog GPU temperature limits", () => {
  beforeEach(() => {
    vi.mocked(updateSettings).mockReset();
    vi.mocked(fetchSettings).mockResolvedValue(settings);
    vi.mocked(updateSettings).mockImplementation(async (next) => ({ ...settings, ...next }) as Settings);
  });

  it("shows the current limits and saves edited ones", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect((document.getElementById("settings-health-temp-warn") as HTMLInputElement).value).toBe("85");
    expect((document.getElementById("settings-health-temp-critical") as HTMLInputElement).value).toBe("90");
    type("settings-health-temp-warn", "78");
    type("settings-health-temp-critical", "88");
    await act(async () => saveButton()?.click());
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ healthTempWarnC: 78, healthTempCriticalC: 88 }));
  });

  it("refuses to save a warning that is not below critical", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    type("settings-health-temp-warn", "92");
    await act(async () => saveButton()?.click());
    expect(updateSettings).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("must be lower than the critical temperature");
  });

  it("refuses to save an empty or out-of-range limit", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    type("settings-health-temp-critical", "");
    await act(async () => saveButton()?.click());
    expect(updateSettings).not.toHaveBeenCalled();
    type("settings-health-temp-critical", "150");
    await act(async () => saveButton()?.click());
    expect(updateSettings).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("between 40 and 110");
  });
});
