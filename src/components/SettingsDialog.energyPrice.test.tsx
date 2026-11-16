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
  mqttDiscovery: false,
  mqttDiscoveryPrefix: "homeassistant",
} satisfies Settings;

const buttonByText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const click = (el: Element) => act(() => (el as HTMLElement).click());

/** Change a React-controlled input or select. */
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const byLabel = <T extends Element>(label: string) => document.querySelector(`[aria-label="${label}"]`) as T;

describe("SettingsDialog electricity price", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(updateSettings).mockReset();
    vi.mocked(fetchSettings).mockResolvedValue(settings);
    vi.mocked(updateSettings).mockImplementation(async (next) => ({ ...settings, ...next }) as Settings);
  });

  it("offers periods only under time of use, and saves them with the base price", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(document.querySelector(".set-tariff__period")).toBeNull();
    click(buttonByText("Time of use"));
    change(document.getElementById("settings-energy-price") as HTMLInputElement, "0.2");
    click(buttonByText("Add period"));
    change(byLabel<HTMLSelectElement>("Period 1 days"), "weekdays");
    change(byLabel<HTMLInputElement>("Period 1 price per kWh"), "0.42");
    click(buttonByText("Save"));
    await flush();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        energyPriceMode: "tou",
        energyPricePerKwh: 0.2,
        energyPricePeriods: [{ from: 14, to: 19, price: 0.42, days: "weekdays" }],
      })
    );
  });

  it("opened at the energy section, shows and focuses the price", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<SettingsDialog open section="energy" onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(document.getElementById("settings-section-energy")?.textContent).toContain("Electricity price");
    expect(document.activeElement?.id).toBe("settings-energy-price");
  });

  it("says which periods overlap and does not save", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({ ...settings, energyPriceMode: "tou", energyPricePeriods: [{ from: 22, to: 6, price: 0.1, days: "all" }] });
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    click(buttonByText("Add period"));
    change(byLabel<HTMLSelectElement>("Period 2 starts"), "5");
    change(byLabel<HTMLSelectElement>("Period 2 ends"), "8");
    expect(document.querySelector(".set-tariff .field-hint")?.textContent).toContain("period 2 shares hours with period 1");
    click(buttonByText("Save"));
    await flush();
    expect(updateSettings).not.toHaveBeenCalled();
    click(byLabel("Remove period 2"));
    expect(document.querySelector(".set-tariff .field-hint")).toBeNull();
  });
});