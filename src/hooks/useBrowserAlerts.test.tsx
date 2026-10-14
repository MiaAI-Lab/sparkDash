import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BADGE_COLORS, useBrowserAlerts, writeBrowserAlertPrefs } from "./useBrowserAlerts";
import { BROWSER_ALERT_HOLD_MS, emptyDebounce, stepDebounce } from "./alertDebounce";
import { useFleetAlerts } from "./useFleetAlerts";
import * as strip from "../components/OverviewPage/FleetAlertStrip";
import type { FleetAlert } from "../components/OverviewPage/FleetAlertStrip";
import { BrowserAlertsSettings } from "../components/BrowserAlertsSettings";
import { makeSpark } from "../testing/fixtures";
import { flush, render } from "../testing/render";
import type { AlertInstance, SparkSnapshot } from "../api/types";

const TITLE = "sparkDash — Multi-DGX Spark Monitoring Dashboard";
const ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M13 2L3 14h9'/></svg>";
const PREFS_KEY = "sparkdashBrowserAlerts";

const row = (key: string, severity: FleetAlert["severity"] = "warning"): FleetAlert => ({
  key,
  unitId: key,
  unitName: `Unit ${key}`,
  label: `${key} is unhappy`,
  severity,
  startsAt: null,
});

function Harness({ rows, ready = true, source = "server" }: { rows: FleetAlert[]; ready?: boolean; source?: "server" | "browser" }) {
  useBrowserAlerts(rows, ready, source);
  return null;
}

function mount(rows: FleetAlert[], ready = true, source: "server" | "browser" = "server") {
  const { root } = render(<Harness rows={rows} ready={ready} source={source} />);
  return (next: FleetAlert[], nextReady = true, nextSource: "server" | "browser" = source) =>
    act(() => root.render(<Harness rows={next} ready={nextReady} source={nextSource} />));
}

const icon = () => document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')!;

/** Image that "loads" on the next tick; canvas that records the dot colours. */
const fills: string[] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

async function settleDraw() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: Array<{ title: string; body?: string; tag?: string }> = [];
  onclick: (() => void) | null = null;
  constructor(title: string, opts?: NotificationOptions) {
    FakeNotification.shown.push({ title, body: opts?.body, tag: opts?.tag });
  }
  close() {}
}

function setSecure(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
}

describe("useBrowserAlerts", () => {
  beforeEach(() => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = ICON;
    document.head.replaceChildren(link);
    document.title = TITLE;
    localStorage.removeItem(PREFS_KEY);
    fills.length = 0;
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
      const ctx = {
        fillStyle: "",
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill() {
          fills.push(ctx.fillStyle);
        },
      };
      return ctx as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,BADGED");
    FakeNotification.shown = [];
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
    setSecure(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.removeItem(PREFS_KEY);
  });

  it("does nothing while the tab badge is off (the default)", async () => {
    mount([row("a", "critical"), row("b")]);
    await settleDraw();
    expect(document.title).toBe(TITLE);
    expect(icon().getAttribute("href")).toBe(ICON);
  });

  it("reads the prefs a browser already stored under sparkdashBrowserAlerts", () => {
    // The key the first version of this PR shipped with; renaming it silently turned the badge off.
    localStorage.setItem("sparkdashBrowserAlerts", JSON.stringify({ tabBadge: true, desktop: false }));
    mount([row("a", "critical")]);
    expect(document.title).toBe(`(1) ${TITLE}`);
  });

  it("puts the count in the title and restores it when clear", () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    const update = mount([row("a"), row("b")]);
    expect(document.title).toBe(`(2) ${TITLE}`);
    update([row("a")]);
    expect(document.title).toBe(`(1) ${TITLE}`);
    update([]);
    expect(document.title).toBe(TITLE);
  });

  it("draws a red dot for any critical, amber otherwise, and restores the icon", async () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    const update = mount([row("a"), row("b", "critical")]);
    await settleDraw();
    expect(icon().getAttribute("href")).toBe("data:image/png;base64,BADGED");
    expect(icon().getAttribute("type")).toBe("image/png");
    expect(fills.at(-1)).toBe(BADGE_COLORS.critical);
    update([row("a")]);
    await settleDraw();
    expect(fills.at(-1)).toBe(BADGE_COLORS.warning);
    update([]);
    await settleDraw();
    expect(icon().getAttribute("href")).toBe(ICON);
    expect(icon().getAttribute("type")).toBe("image/svg+xml");
  });

  it("a draw that finishes after the alerts cleared does not stick", async () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    const update = mount([row("a", "critical")]);
    update([]); // before the image has loaded
    await settleDraw();
    expect(icon().getAttribute("href")).toBe(ICON);
  });

  it("not ready (still connecting): no badge even with rows", () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    mount([row("a")], false);
    expect(document.title).toBe(TITLE);
  });

  it("server alerts: notifies only for alerts that start firing after the page is ready", () => {
    writeBrowserAlertPrefs({ tabBadge: false, desktop: true });
    const update = mount([row("a")], false);
    update([row("a")]); // first ready state = baseline
    expect(FakeNotification.shown).toEqual([]);
    update([row("a"), row("b", "critical")]);
    expect(FakeNotification.shown).toEqual([{ title: "Critical · Unit b", body: "b is unhappy", tag: "b" }]);
    update([row("a"), row("b", "critical")]);
    expect(FakeNotification.shown).toHaveLength(1);
    // Switching between server and browser alerts re-baselines.
    update([row("c")], true, "browser");
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it("browser-derived: a condition must hold 30 s before it badges or notifies", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    writeBrowserAlertPrefs({ tabBadge: true, desktop: true });
    const update = mount([], true, "browser");
    update([row("a", "critical")]);
    expect(document.title).toBe(TITLE);
    act(() => vi.advanceTimersByTime(BROWSER_ALERT_HOLD_MS - 1_000));
    expect(FakeNotification.shown).toEqual([]);
    act(() => vi.advanceTimersByTime(1_000));
    expect(document.title).toBe(`(1) ${TITLE}`);
    expect(FakeNotification.shown.map((n) => n.tag)).toEqual(["a"]);
  });

  it("browser-derived: a flapping condition notifies once, and clears only after 30 s clear", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    writeBrowserAlertPrefs({ tabBadge: true, desktop: true });
    const update = mount([], true, "browser");
    update([row("a")]);
    act(() => vi.advanceTimersByTime(BROWSER_ALERT_HOLD_MS));
    expect(FakeNotification.shown).toHaveLength(1);
    // Flap every 5 s for two minutes.
    for (let i = 0; i < 12; i++) {
      update([]);
      act(() => vi.advanceTimersByTime(5_000));
      update([row("a")]);
      act(() => vi.advanceTimersByTime(5_000));
    }
    expect(FakeNotification.shown).toHaveLength(1);
    expect(document.title).toBe(`(1) ${TITLE}`);
    update([]);
    act(() => vi.advanceTimersByTime(BROWSER_ALERT_HOLD_MS - 1_000));
    expect(document.title).toBe(`(1) ${TITLE}`);
    act(() => vi.advanceTimersByTime(1_000));
    expect(document.title).toBe(TITLE);
    // A brief blip after clearing is not news either.
    update([row("a")]);
    act(() => vi.advanceTimersByTime(10_000));
    update([]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeNotification.shown).toHaveLength(1);
  });

  it("browser-derived: what is already wrong when the page opens counts at once and is the baseline", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    writeBrowserAlertPrefs({ tabBadge: true, desktop: true });
    mount([row("a"), row("b")], true, "browser");
    expect(document.title).toBe(`(2) ${TITLE}`);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("no notifications without permission, without the pref, or in an insecure context", () => {
    const update = mount([], true);
    update([row("a")]);
    expect(FakeNotification.shown).toEqual([]); // pref off
    act(() => writeBrowserAlertPrefs({ tabBadge: false, desktop: true }));
    FakeNotification.permission = "denied";
    update([row("a"), row("b")]);
    expect(FakeNotification.shown).toEqual([]);
    FakeNotification.permission = "granted";
    setSecure(false);
    update([row("a"), row("b"), row("c")]);
    expect(FakeNotification.shown).toEqual([]);
  });
});

describe("stepDebounce", () => {
  it("holds before showing, holds before clearing, and says when to look again", () => {
    const s = emptyDebounce();
    expect(stepDebounce(s, [row("a")], 0, 1000)).toEqual({ visible: [], nextCheckAt: 1000 });
    expect(stepDebounce(s, [row("a")], 1000, 1000).visible.map((r) => r.key)).toEqual(["a"]);
    expect(stepDebounce(s, [], 1500, 1000)).toMatchObject({ nextCheckAt: 2500 });
    expect(stepDebounce(s, [], 2499, 1000).visible).toHaveLength(1);
    expect(stepDebounce(s, [], 2500, 1000)).toEqual({ visible: [], nextCheckAt: null });
  });
});

describe("BrowserAlertsSettings", () => {
  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSecure(true);
    localStorage.removeItem(PREFS_KEY);
  });

  const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
  const stored = () => JSON.parse(localStorage.getItem(PREFS_KEY) || "null");

  it("2.0 rows: both switches start off; the tab badge saves to this browser on click", () => {
    setSecure(true);
    render(<BrowserAlertsSettings />);
    expect(toggle("Tab badge").closest(".set-row")).not.toBeNull();
    expect(toggle("Tab badge").getAttribute("aria-checked")).toBe("false");
    expect(toggle("Desktop notifications").getAttribute("aria-checked")).toBe("false");
    act(() => toggle("Tab badge").click());
    expect(stored()).toEqual({ tabBadge: true, desktop: false });
    expect(toggle("Tab badge").getAttribute("aria-checked")).toBe("true");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("asks for permission only on the click, and enables on grant", async () => {
    setSecure(true);
    FakeNotification.requestPermission.mockImplementationOnce(async () => "granted");
    render(<BrowserAlertsSettings />);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await act(async () => toggle("Desktop notifications").click());
    await flush();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({ tabBadge: false, desktop: true });
  });

  it("a denied permission stays off and says why", async () => {
    setSecure(true);
    FakeNotification.requestPermission.mockImplementationOnce(async () => "denied");
    render(<BrowserAlertsSettings />);
    await act(async () => toggle("Desktop notifications").click());
    await flush();
    expect(stored()).toBeNull();
    expect(document.body.textContent).toContain("Notifications are blocked for this site");
  });

  it("on plain HTTP the desktop switch is disabled with a note instead", () => {
    setSecure(false);
    render(<BrowserAlertsSettings />);
    expect(toggle("Desktop notifications").disabled).toBe(true);
    expect(document.querySelector('[role="note"]')!.textContent).toContain("HTTPS or localhost");
    act(() => toggle("Desktop notifications").click());
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("useFleetAlerts", () => {
  type Props = Parameters<typeof useFleetAlerts>[0];
  function Probe(props: Props) {
    const r = useFleetAlerts(props);
    return <pre data-testid="fa">{JSON.stringify({ keys: r.rows.map((x) => x.key), ready: r.ready, source: r.source })}</pre>;
  }
  const read = () => JSON.parse(document.querySelector('[data-testid="fa"]')!.textContent!);
  const base = { alertsEnabled: false, serverAlerts: null, temperatureUnit: "celsius" as const };

  function thermal(id: string): SparkSnapshot {
    const s = makeSpark(id);
    s.metrics.gpu = { ...s.metrics.gpu!, temperature: 88, throttle: { active: true, reason: "thermal", thermal: true, hwSlowdown: false, powerCap: false, detail: "HW thermal slowdown", smClockMHz: null, smClockPct: null } } as SparkSnapshot["metrics"]["gpu"];
    return s;
  }

  it("is the strip's own list: reuses deriveAlerts with the temperature unit, every alert whatever the strip shows", () => {
    const spy = vi.spyOn(strip, "stripAlerts");
    const { root } = render(<Probe {...base} sparks={[]} />);
    expect(read()).toEqual({ keys: [], ready: false, source: "browser" });
    const sparks = [makeSpark("a", false), thermal("b")];
    act(() => root.render(<Probe {...base} sparks={sparks} />));
    expect(read()).toEqual({ keys: ["a:offline", "b:throttle"], ready: true, source: "browser" });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ showExceptions: true, temperatureUnit: "celsius" }));
    // The strip shows throttling alone while "Show active fleet exceptions" is off (the default); the
    // badge and notifications still count the offline unit.
    expect(strip.stripAlerts({ sparks, showExceptions: false }).map((a) => a.key)).toEqual(["b:throttle"]);
    act(() => root.render(<Probe {...base} sparks={sparks} temperatureUnit="fahrenheit" />));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ temperatureUnit: "fahrenheit" }));
    expect(strip.deriveAlerts(sparks, "fahrenheit")[1].detail).toContain("190°F");
    spy.mockRestore();
  });

  it("uses the server's set while notifications are on, and is not ready until it arrives", () => {
    const { root } = render(<Probe {...base} sparks={[makeSpark("a", false)]} alertsEnabled />);
    expect(read()).toEqual({ keys: ["a:offline"], ready: false, source: "browser" });
    const alert = { key: "a:offline", ruleId: "offline", unitId: "a", unitName: "A", ruleName: "Unit offline", label: "Host unreachable", summary: "x", severity: "critical", state: "firing", startsAt: 1, firingAt: 1 } as AlertInstance;
    act(() => root.render(<Probe {...base} sparks={[makeSpark("a", false)]} alertsEnabled serverAlerts={[alert]} />));
    expect(read()).toEqual({ keys: ["a:offline"], ready: true, source: "server" });
  });
});
