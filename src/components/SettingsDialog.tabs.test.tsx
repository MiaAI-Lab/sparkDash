import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")!;
const panel = (id: string) => document.getElementById(`settings-panel-${id}`)!;
const visiblePanels = () => [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id);
const click = (el: Element) => act(() => (el as HTMLElement).click());
const key = (k: string) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("SettingsDialog tabs", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.mocked(fetchSettings).mockReset().mockResolvedValue(settings);
    vi.mocked(updateSettings).mockReset();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("groups settings into six labelled tabs, General first", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(document.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Settings sections");
    expect(tabs().map((t) => t.textContent)).toEqual(["General", "Overview", "Sparks & LLM", "Power & energy", "Alerts & integrations", "Security"]);
    expect(selected().textContent).toBe("General");
    expect(visiblePanels()).toEqual(["settings-panel-general"]);
    for (const tab of tabs()) {
      const p = document.getElementById(tab.getAttribute("aria-controls")!)!;
      expect(p.getAttribute("role")).toBe("tabpanel");
      expect(p.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(tab.tabIndex).toBe(tab === selected() ? 0 : -1);
    }
    // Each setting lives on one tab.
    expect(panel("general").textContent).toContain("Time zone");
    expect(panel("energy").textContent).toContain("Electricity price");
    expect(panel("energy").textContent).toContain("Show Fleet Energy");
    expect(panel("integrations").textContent).toContain("MQTT");
    expect(panel("security").textContent).toContain("Access token");
    expect(panel("general").textContent).not.toContain("Electricity price");
  });

  it("switches by click and keeps the open tab in the address", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    click(tabs()[3]);
    expect(selected().textContent).toBe("Power & energy");
    expect(visiblePanels()).toEqual(["settings-panel-energy"]);
    expect(window.location.hash).toBe("#settings/energy");
  });

  it("moves with the arrow keys, Home and End, wrapping round", async () => {
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    act(() => selected().focus());
    key("ArrowRight");
    expect(selected().textContent).toBe("Overview");
    expect(document.activeElement).toBe(selected());
    key("ArrowLeft");
    key("ArrowLeft");
    expect(selected().textContent).toBe("Security");
    key("Home");
    expect(selected().textContent).toBe("General");
    key("End");
    expect(selected().textContent).toBe("Security");
    expect(window.location.hash).toBe("#settings/security");
  });

  it("opens on the tab a link names, with the price focused for energy", async () => {
    render(<SettingsDialog open section="energy" onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(selected().textContent).toBe("Power & energy");
    expect(document.activeElement?.id).toBe("settings-energy-price");
  });

  it("shows the tab of a setting that cannot be saved", async () => {
    vi.mocked(fetchSettings).mockResolvedValue({
      ...settings,
      energyPriceMode: "tou",
      energyPricePeriods: [
        { from: 1, to: 5, price: 0.1, days: "all" },
        { from: 4, to: 6, price: 0.2, days: "all" },
      ],
    });
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    // Make the dialog dirty from another tab, then save.
    click(tabs()[1]);
    click(panel("overview").querySelector('[role="switch"]')!);
    click([...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!);
    await flush();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(selected().textContent).toBe("Power & energy");
  });

  it("goes to Security when settings cannot be loaded, where the access token is", async () => {
    vi.mocked(fetchSettings).mockRejectedValue(new Error("Unauthorized"));
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(selected().textContent).toBe("Security");
    expect(panel("security").textContent).toContain("Access token");
  });
});