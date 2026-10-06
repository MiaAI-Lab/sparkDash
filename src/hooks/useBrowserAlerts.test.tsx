import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BADGE_COLORS, useBrowserAlerts, writeBrowserAlertPrefs } from "./useBrowserAlerts";
import { deriveFleetAlerts, type FleetAlertRow, useFleetAlerts } from "./useFleetAlerts";
import { BrowserAlertsSettings } from "../components/BrowserAlertsSettings";
import { makeSpark } from "../testing/fixtures";
import { flush, render } from "../testing/render";
import type { AlertInstance } from "../api/types";

const TITLE = "sparkDash — Multi-DGX Spark Monitoring Dashboard";
const ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M13 2L3 14h9'/></svg>";

const row = (key: string, severity: FleetAlertRow["severity"] = "warning"): FleetAlertRow => ({
  key,
  unitId: key,
  unitName: `Unit ${key}`,
  label: `${key} is unhappy`,
  severity,
  startsAt: null,
});

function Harness({ rows, ready = true, source }: { rows: FleetAlertRow[]; ready?: boolean; source?: string }) {
  useBrowserAlerts(rows, ready, source);
  return null;
}

function mount(rows: FleetAlertRow[], ready = true) {
  const { root } = render(<Harness rows={rows} ready={ready} />);
  return (next: FleetAlertRow[], nextReady = true, source?: string) =>
    act(() => root.render(<Harness rows={next} ready={nextReady} source={source} />));
}

function icon() {
  return document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')!;
}

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
    localStorage.removeItem("sparkdashBrowserAlerts");
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
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashBrowserAlerts");
  });

  it("does nothing while the tab badge is off (the default)", async () => {
    mount([row("a", "critical"), row("b")]);
    await settleDraw();
    expect(document.title).toBe(TITLE);
    expect(icon().getAttribute("href")).toBe(ICON);
  });

  it("puts the count in the title and restores it when clear", async () => {
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

  it("turning the badge off live restores the title and icon", async () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    mount([row("a")]);
    await settleDraw();
    act(() => writeBrowserAlertPrefs({ tabBadge: false, desktop: false }));
    await settleDraw();
    expect(document.title).toBe(TITLE);
    expect(icon().getAttribute("href")).toBe(ICON);
  });

  it("not ready (still connecting): no badge even with rows", () => {
    writeBrowserAlertPrefs({ tabBadge: true, desktop: false });
    mount([row("a")], false);
    expect(document.title).toBe(TITLE);
  });

  it("notifies only for alerts that start firing after the page is ready", () => {
    writeBrowserAlertPrefs({ tabBadge: false, desktop: true });
    const update = mount([row("a")], false);
    update([row("a")]); // first ready state = baseline
    expect(FakeNotification.shown).toEqual([]);
    update([row("a"), row("b", "critical")]);
    expect(FakeNotification.shown).toEqual([{ title: "Critical · Unit b", body: "b is unhappy", tag: "b" }]);
    update([row("a"), row("b", "critical")]);
    expect(FakeNotification.shown).toHaveLength(1);
    update([row("b", "critical")]);
    update([row("a"), row("b", "critical")]);
    expect(FakeNotification.shown.map((n) => n.tag)).toEqual(["b", "a"]);
    // Switching between server and browser alerts re-baselines.
    update([row("unit_offline:a")], true, "server");
    expect(FakeNotification.shown).toHaveLength(2);
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

describe("BrowserAlertsSettings", () => {
  beforeEach(() => {
    localStorage.removeItem("sparkdashBrowserAlerts");
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSecure(true);
    localStorage.removeItem("sparkdashBrowserAlerts");
  });

  const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
  const stored = () => JSON.parse(localStorage.getItem("sparkdashBrowserAlerts") || "null");

  it("both toggles start off; the tab badge saves to this browser on click", () => {
    setSecure(true);
    render(<BrowserAlertsSettings />);
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

  it("on plain HTTP the desktop toggle is disabled with a note instead", () => {
    setSecure(false);
    render(<BrowserAlertsSettings />);
    expect(toggle("Desktop notifications").disabled).toBe(true);
    const note = document.querySelector('[data-testid="browser-alerts"] [role="note"]')!;
    expect(note.textContent).toContain("HTTPS or localhost");
    act(() => toggle("Desktop notifications").click());
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("useFleetAlerts", () => {
  function Probe(props: { sparks: Parameters<typeof useFleetAlerts>[0]; on: boolean; server: AlertInstance[] | null }) {
    const r = useFleetAlerts(props.sparks, props.on, props.server);
    return <pre data-testid="fa">{JSON.stringify({ keys: r.rows.map((x) => x.key), ready: r.ready, source: r.source })}</pre>;
  }
  const read = () => JSON.parse(document.querySelector('[data-testid="fa"]')!.textContent!);

  it("derives in the browser when server alerts are off, and uses the server's set when on", () => {
    expect(deriveFleetAlerts([makeSpark("a", false)]).map((r) => r.key)).toEqual(["a:offline"]);
    const { root } = render(<Probe sparks={[]} on={false} server={null} />);
    expect(read()).toEqual({ keys: [], ready: false, source: "browser" });
    act(() => root.render(<Probe sparks={[makeSpark("a", false)]} on={false} server={null} />));
    expect(read()).toEqual({ keys: ["a:offline"], ready: true, source: "browser" });
    act(() => root.render(<Probe sparks={[makeSpark("a", false)]} on server={null} />));
    expect(read()).toEqual({ keys: [], ready: false, source: "server" });
    const alert = { key: "unit_offline:a", unitId: "a", unitName: "A", ruleName: "Unit offline", summary: "x", severity: "critical", startsAt: 1 } as AlertInstance;
    act(() => root.render(<Probe sparks={[makeSpark("a", false)]} on server={[alert]} />));
    expect(read()).toEqual({ keys: ["unit_offline:a"], ready: true, source: "server" });
  });
});
