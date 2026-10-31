import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";
import { makeSpark } from "./testing/fixtures";
import { render, flush } from "./testing/render";
import App from "./App";

const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  navigate: vi.fn(), replace: vi.fn(), fetchSettings: vi.fn(), fetchHealth: vi.fn(),
  fetchSparks: vi.fn(), reorderSparks: vi.fn(),
}));
vi.mock("./hooks/useSnapshot", () => ({ useSnapshot: () => mocks.snapshot }));
vi.mock("./hooks/useRoute", () => ({ useAppRoute: () => ({ mode: "dashboard" }), useRoute: () => ({ navigate: mocks.navigate, replace: mocks.replace }) }));
vi.mock("./hooks/useFleetAlerts", () => ({ useFleetAlerts: () => ({ rows: [], ready: false }) }));
vi.mock("./hooks/useBrowserAlerts", () => ({ useBrowserAlerts: () => {} }));
vi.mock("./hooks/useSmoothWheel", () => ({ useSmoothWheel: () => {} }));
vi.mock("./api/client", () => ({ fetchSettings: mocks.fetchSettings, fetchHealth: mocks.fetchHealth, fetchSparks: mocks.fetchSparks, reorderSparks: mocks.reorderSparks }));
vi.mock("./components/OverviewPage/OverviewPage", () => ({ OverviewPage: () => null }));
vi.mock("./components/SparkPage/SparkPage", () => ({ SparkPage: () => null }));
vi.mock("./components/TokensPage/TokensPage", () => ({ TokensPage: () => null }));
vi.mock("./components/CostPage/CostPage", () => ({ CostPage: () => null }));
vi.mock("./components/EnergyPage/EnergyPage", () => ({ EnergyPage: () => null }));
vi.mock("./components/TempsPage/TempsPage", () => ({ TempsPage: () => null }));
vi.mock("./components/ActivityPage/ActivityPage", () => ({ ActivityPage: () => null }));
vi.mock("./components/ShowcasePage/ShowcaseView", () => ({ ShowcaseView: () => null }));
vi.mock("./components/ShowcasePage/ShowcasePage", () => ({ ShowcasePage: () => null }));
vi.mock("./components/KioskPage/KioskPage", () => ({ KioskPage: () => null }));
vi.mock("./components/bench/BenchPage", () => ({ BenchPage: () => null }));
vi.mock("./components/SparkPage/HermesUpdateDialog", () => ({ HermesUpdateDialog: () => null }));
vi.mock("./components/AddSparkDialog", () => ({ AddSparkDialog: () => null }));
vi.mock("./components/EditSparkDialog", () => ({ EditSparkDialog: () => null }));
vi.mock("./components/SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("./components/HarnessWizard", () => ({ HarnessWizard: () => null }));
vi.mock("./components/AccessTokenDialog", () => ({ AccessTokenPrompt: () => null }));

function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  await setLocale("en");
  mocks.snapshot = { sparks: [makeSpark("alpha")], activeId: "__overview__", activeSpark: null, connected: true, lastValidSnapshotAt: Date.now(), snapshotError: null, refreshInterval: 2000, setActiveId: vi.fn(), serverAlerts: [] };
  mocks.fetchSettings.mockResolvedValue({});
  mocks.fetchHealth.mockResolvedValue({ authMode: "token", version: "test" });
});

afterEach(async () => {
  await act(async () => setLocale("en"));
  localStorage.clear();
});

describe("application shell localization", () => {
  it("updates generated commands, keeps English aliases and query, and navigates by the original IDs", async () => {
    render(<App />);
    await flush();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    const input = search("Decode");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Decode benchmark");
    await act(async () => setLocale("zh-CN"));
    expect(input.value).toBe("Decode");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("解码基准测试");
    search("Spark alpha");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Spark alpha");
    search("Activity");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("活动");
    await act(async () => setLocale("en"));
    expect(input.value).toBe("Activity");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Activity");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mocks.navigate).toHaveBeenCalledWith("__activity__");
    expect(mocks.fetchSettings).toHaveBeenCalledOnce();
    expect(mocks.fetchHealth).toHaveBeenCalledOnce();
    expect(mocks.reorderSparks).not.toHaveBeenCalled();
  });

  it("relocalizes an existing request error without fetching again or changing its diagnostic", async () => {
    mocks.fetchSettings.mockRejectedValue(new Error("HTTP 503: original <detail>"));
    render(<App />);
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not load settings: HTTP 503: original <detail>. Reload to retry.");
    await act(async () => setLocale("zh-CN"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法加载设置：HTTP 503: original <detail>。请重新加载以重试。");
    expect(mocks.fetchSettings).toHaveBeenCalledOnce();
    expect(mocks.reorderSparks).not.toHaveBeenCalled();
  });
});
