import { act } from "react";
import { setLocale } from "../../i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { cleanupRenders, flush, render } from "../../testing/render";
import { KioskPage } from "./KioskPage";

let sparks: SparkSnapshot[] = [];
let lastValidSnapshotAt: number | null = Date.now();
let serverAlerts: AlertInstance[] | null = null;
let alertsEnabled = false;

vi.mock("../../hooks/useSnapshot", () => ({
  useSnapshot: () => ({ sparks, connected: true, lastValidSnapshotAt, refreshInterval: 2_000, serverAlerts }),
}));

vi.mock("../../api/client", () => ({
  fetchSettings: () => Promise.resolve({ temperatureUnit: "celsius", alertsEnabled, hideWorkers: false, timeZone: null }),
  fetchFleetEnergy: () => Promise.resolve({ estimated: true, energy24hKwh: 7.86, outputTokens24h: 951_451 }),
  getUnitHistory: () => Promise.resolve({ enabled: false }),
}));

describe("KioskPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/kiosk");
    lastValidSnapshotAt = Date.now();
    serverAlerts = null;
    alertsEnabled = false;
  });
  afterEach(() => {
    cleanupRenders();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  it("switches memory legends and role badges while preserving raw names", async () => {
    const a = makeSpark("legend"); a.role = "head";
    a.metrics.llm[0].modelId = "raw/<tag>-model";
    sparks = [a];
    await setLocale("en");
    const { container } = render(<KioskPage />); await flush();
    expect(container.querySelector(".kiosk-mem__legend")?.textContent).toContain("Model");
    expect(container.querySelector(".kiosk-card__role")?.textContent).toBe("head");
    await act(async () => setLocale("zh-CN"));
    expect(container.querySelector(".kiosk-mem__legend")?.textContent).toContain("模型");
    expect(container.querySelector(".kiosk-card__role")?.textContent).toBe("主节点");
    expect(container.textContent).toContain("raw/<tag>-model");
    await act(async () => setLocale("en"));
    expect(container.querySelector(".kiosk-mem__legend")?.textContent).toContain("Model");
  });

  it("shows a card per unit, the fleet totals and the 24-hour energy", async () => {
    const a = makeSpark("a");
    const b = makeSpark("b");
    sparks = [a, b];
    const { container } = render(<KioskPage />);
    await flush();
    const cards = [...container.querySelectorAll(".kiosk-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Spark a");
    expect(cards[1].textContent).toContain("Spark b");
    const head = container.querySelector(".kiosk-head")!.textContent!;
    expect(head).toContain("40.0"); // 20 tok/s on each unit
    expect(head).toContain("7.9kWh");
    expect(head).toContain("24 h · est.");
    expect(head).toContain("2/2");
  });

  it("shows the fleet's GPU power, and a dash rather than 0 W when no unit reports power", async () => {
    sparks = [makeSpark("a"), makeSpark("b")];
    const { container } = render(<KioskPage />);
    await flush();
    const power = () => [...container.querySelectorAll(".kiosk-kpi")].find((k) => k.textContent!.includes("GPU power"))!;
    expect(power().querySelector(".kiosk-kpi__value")!.textContent).toBe("100W");
    cleanupRenders();

    const unmeasured = [makeSpark("a"), makeSpark("b")];
    for (const s of unmeasured) s.metrics.gpu!.metricAvailability = { powerDraw: false } as never;
    sparks = unmeasured;
    const second = render(<KioskPage />);
    await flush();
    const value = [...second.container.querySelectorAll(".kiosk-kpi")].find((k) => k.textContent!.includes("GPU power"))!.querySelector(".kiosk-kpi__value")!;
    expect(value.textContent).toBe("—");
  });

  it("shows an offline unit with its reason and lists the alert for it", async () => {
    const off = makeSpark("down", false);
    off.offlineReason = "SSH timed out";
    sparks = [makeSpark("a"), off];
    const { container } = render(<KioskPage />);
    await flush();
    const card = container.querySelector(".kiosk-card.is-offline")!;
    expect(card.textContent).toContain("offline");
    expect(card.textContent).toContain("SSH timed out");
    expect(card.querySelector(".kiosk-card__trace")).toBeNull();
    expect(container.querySelector(".kiosk-alerts")?.textContent).toContain("Spark down");
  });

  it("localizes known live server alerts while preserving raw unknown server labels", async () => {
    const a = makeSpark("a");
    a.metrics.llm[0].available = false;
    sparks = [a];
    alertsEnabled = true;
    serverAlerts = [
      { key: "a:llm", ruleId: "llm", ruleName: "LLM", unitId: "a", unitName: "Spark a", severity: "warning", state: "firing", label: "LLM is unavailable", summary: "LLM is unavailable", startsAt: Date.now(), firingAt: Date.now() },
      { key: "a:server-only", ruleId: "server-only", ruleName: "Server only", unitId: "a", unitName: "Spark a", severity: "warning", state: "firing", label: "Raw server finding <keep>", summary: "Raw server finding <keep>", startsAt: Date.now(), firingAt: Date.now() },
    ];
    await setLocale("zh-CN");
    const { container } = render(<KioskPage />);
    await flush();
    const text = container.querySelector(".kiosk-alerts")!.textContent!;
    expect(text).toContain("Spark a");
    expect(text).toContain("LLM 不可用");
    expect(text).toContain("Raw server finding <keep>");
    await act(async () => setLocale("en"));
  });

  it("shows the served model with its rates", async () => {
    sparks = [makeSpark("a")];
    const { container } = render(<KioskPage />);
    await flush();
    expect(container.querySelector(".kiosk-card__model")!.textContent).toContain("fixture-model");
    expect(container.querySelector(".kiosk-stat__value.is-live")!.textContent).toBe("20.0tok/s");
  });

  it("fits up to six units on one screen and scrolls by rows beyond that", async () => {
    sparks = Array.from({ length: 6 }, (_, i) => makeSpark(`u${i}`));
    const six = render(<KioskPage />);
    await flush();
    expect(six.container.querySelector(".kiosk-frame")!.className).toBe("kiosk-frame is-fit");
    sparks = Array.from({ length: 7 }, (_, i) => makeSpark(`u${i}`));
    const seven = render(<KioskPage />);
    await flush();
    expect(seven.container.querySelector(".kiosk-frame")!.className).toBe("kiosk-frame is-fit is-scrolling");
    expect(seven.container.querySelectorAll(".kiosk-card")).toHaveLength(7);
  });

  it("holds the last frame when telemetry stops, and says how old it is", async () => {
    sparks = [makeSpark("a")];
    lastValidSnapshotAt = Date.now() - 60_000;
    const { container } = render(<KioskPage />);
    await flush();
    expect(container.querySelector(".kiosk-card__name")!.textContent).toBe("Spark a");
    expect(container.querySelector(".kiosk-clock__stale")!.textContent).toMatch(/^stale · /);
  });

  it("applies ?theme= for this screen only", async () => {
    window.history.replaceState(null, "", "/kiosk?theme=oled");
    sparks = [makeSpark("a")];
    render(<KioskPage />);
    await flush();
    expect(document.documentElement.getAttribute("data-theme")).toBe("oled");
    expect(localStorage.getItem("sparkdash-theme")).not.toBe("oled");
  });
});
