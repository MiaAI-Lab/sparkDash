import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";
import { activeLocale, i18next, setLocale } from "../i18n";
import { detectLocale, LOCALE_STORAGE_KEY } from "../i18n/detect";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("../api/client", () => ({ fetchSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n")>();
  return { ...actual, setLocale: vi.fn(actual.setLocale) };
});

const settings: Settings = {
  pollIntervalMs: 2000, defaultLlmPort: 8888, autoHideOffline: false,
  hideWorkers: false, temperatureUnit: "celsius", benchDebugTraces: false,
  density: "compact", showFleetEnergy: false, showFleetExceptions: false,
  showOverviewSearch: false, showLlmTokenTotals: false, benchShareImage: false,
  energyPricePerKwh: null, energyCurrency: "$", showVramBreakdown: true,
  prometheusExport: false, timeZone: "",
};

const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  .find((el) => el.textContent?.trim() === label)!;

beforeEach(async () => {
  await setLocale("en", { persist: false });
  localStorage.clear();
  vi.mocked(fetchSettings).mockResolvedValue({ ...settings });
});

afterEach(async () => {
  cleanupRenders();
  await setLocale("en", { persist: false });
  localStorage.clear();
});

describe("Settings language buttons", () => {
  it("switches both ways immediately and remembers the choice without saving server settings", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} onSaved={onSaved} />);
    await flush();
    expect(button("English").getAttribute("aria-checked")).toBe("true");
    await act(async () => button("简体中文").click());
    await vi.waitFor(() => expect(document.querySelector("#settings-title")?.textContent).toBe("设置"));
    expect(button("简体中文").getAttribute("aria-checked")).toBe("true");
    expect(activeLocale()).toBe("zh-Hans");
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(detectLocale()).toBe("zh-Hans");
    expect(button("保存").disabled).toBe(true);

    // Simulate a new page's detection using the saved browser preference.
    cleanupRenders();
    await act(async () => { await i18next.changeLanguage("en"); });
    await act(async () => { await setLocale(detectLocale(), { persist: false }); });
    render(<SettingsDialog open onClose={onClose} onSaved={onSaved} />);
    await flush();
    expect(button("简体中文").getAttribute("aria-checked")).toBe("true");

    await act(async () => button("English").click());
    expect(document.querySelector("#settings-title")?.textContent).toBe("Settings");
    expect(button("English").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the language buttons usable when the settings API fails", async () => {
    vi.mocked(fetchSettings).mockRejectedValueOnce(new Error("Authentication required"));
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    expect(document.body.textContent).toContain("Authentication required");
    await act(async () => button("简体中文").click());
    await vi.waitFor(() => expect(activeLocale()).toBe("zh-Hans"));
    expect(document.querySelector("#settings-title")?.textContent).toBe("设置");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("disables the buttons while loading, shows a failure, and allows retry", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(setLocale).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<SettingsDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await flush();
    act(() => button("简体中文").click());
    expect(button("简体中文").disabled).toBe(true);
    expect(button("English").disabled).toBe(true);
    await act(async () => reject(new Error("offline")));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not load the language");
    expect(button("English").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    await act(async () => button("简体中文").click());
    await vi.waitFor(() => expect(activeLocale()).toBe("zh-Hans"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
