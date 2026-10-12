import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsDialog } from "./AlertsDialog";
import { SettingsDialog } from "./SettingsDialog";
import type { AlertsConfig } from "../api/types";
import { flush, render } from "../testing/render";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function config(enabled: boolean): AlertsConfig {
  return {
    enabled,
    repeatIntervalMin: 0,
    rules: [
      { id: "offline", source: "strip", name: "Unit offline", description: "d", defaults: { enabled: true, forSec: 60 }, overrides: {} },
      { id: "thermal", source: "health", name: "GPU temperature", description: "d", defaults: { enabled: true, forSec: 60 }, overrides: {} },
      { id: "concurrency", source: "health", name: "Several models loaded", description: "d", defaults: { enabled: false, forSec: 300 }, overrides: {} },
    ],
    channels: [
      { id: "ch_1", name: "Phone", type: "ntfy", url: "http://ntfy.lan…opic", hasUrl: true, enabled: true, minSeverity: "warning", status: { lastSentAt: null, lastError: "HTTP 403", lastErrorAt: 1 } },
    ],
  };
}

function stubServer(initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/settings" && method === "PUT") {
      enabled = Boolean((body as { alertsEnabled?: boolean }).alertsEnabled);
      return json({ alertsEnabled: enabled });
    }
    if (url === "/api/settings") return json({ alertsEnabled: enabled, pollIntervalMs: 2000, temperatureUnit: "celsius", defaultLlmPort: 8888 });
    if (url === "/api/alerts/config" && method === "PUT") return json(config(enabled));
    if (url === "/api/alerts/config") return json(config(enabled));
    if (url === "/api/alerts/test") return json({ ok: false, error: "HTTP 500" });
    if (url === "/api/alerts") return json({ enabled, active: [], pending: [], recent: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.textContent?.includes("Send notifications"))!;
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const settle = async () => {
  await flush();
  await flush();
  await flush();
};

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AlertsDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("off: the switch saves the setting at once; rules and channels stay locked until it is on", async () => {
    const calls = stubServer(false);
    const onSettingsSaved = vi.fn();
    render(<AlertsDialog open onClose={() => {}} onSettingsSaved={onSettingsSaved} />);
    await settle();
    const d = dialog();
    const master = d.querySelector<HTMLButtonElement>('[aria-label="Send notifications"]')!;
    expect(master.getAttribute("aria-checked")).toBe("false");
    expect(d.querySelector("fieldset")!.disabled).toBe(true);
    expect(button(d, "Save").disabled).toBe(true);

    act(() => master.click());
    await settle();
    expect(calls.find((c) => c.url === "/api/settings" && c.method === "PUT")?.body).toEqual({ alertsEnabled: true });
    expect(onSettingsSaved).toHaveBeenCalledWith({ alertsEnabled: true });
    expect(master.getAttribute("aria-checked")).toBe("true");
    expect(d.querySelector("fieldset")!.disabled).toBe(false);
  });

  it("2.0 layout: rules as setting rows grouped by source, with on/off and a wait only", async () => {
    stubServer(true);
    render(<AlertsDialog open onClose={() => {}} onSettingsSaved={() => {}} />);
    await settle();
    const d = dialog();
    const strip = d.querySelector('[aria-label="Overview exceptions"]')!;
    const health = d.querySelector('[aria-label="Health findings"]')!;
    expect(strip.querySelectorAll(".set-row").length).toBe(1);
    expect(health.querySelectorAll(".set-row").length).toBe(2);
    expect(health.querySelector('[aria-label="Several models loaded notifications"]')!.getAttribute("aria-checked")).toBe("false");
    expect(d.querySelectorAll('input[type="number"]').length).toBe(3);
    expect(d.textContent).not.toMatch(/°C/);
    // A stored failure is a status code, shown as such.
    expect(d.textContent).toContain("Last send failed: HTTP 403");
  });

  it("save sends only changed rule values and keeps the masked URL", async () => {
    const calls = stubServer(true);
    render(<AlertsDialog open onClose={() => {}} onSettingsSaved={() => {}} />);
    await settle();
    const d = dialog();
    typeInto(d.querySelector<HTMLInputElement>('[aria-label="GPU temperature wait (seconds)"]')!, "120");
    act(() => d.querySelector<HTMLButtonElement>('[aria-label="Unit offline notifications"]')!.click());
    act(() => button(d, "Save").click());
    await settle();
    const put = calls.find((c) => c.url === "/api/alerts/config" && c.method === "PUT")!.body as { rules: unknown; channels: Array<{ url: string; status?: unknown; hasUrl?: unknown }> };
    expect(put.rules).toEqual({ thermal: { forSec: 120 }, offline: { enabled: false } });
    expect(put.channels[0].url).toBe("http://ntfy.lan…opic");
    expect(put.channels[0]).not.toHaveProperty("status");
    expect(put.channels[0]).not.toHaveProperty("hasUrl");
  });

  it("Send test shows the server's result: a status code, nothing more", async () => {
    const calls = stubServer(true);
    render(<AlertsDialog open onClose={() => {}} onSettingsSaved={() => {}} />);
    await settle();
    const d = dialog();
    act(() => button(d, "Send test").click());
    await settle();
    expect(calls.find((c) => c.url === "/api/alerts/test")!.body).toMatchObject({ channelId: "ch_1" });
    expect(d.querySelector('[role="status"].field-hint')!.textContent).toBe("HTTP 500");
  });
});

describe("Settings → Alert notifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the state, opens the dialog, and Escape closes only the dialog", async () => {
    stubServer(false);
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} onSaved={() => {}} />);
    await settle();
    expect(document.querySelector('[data-testid="alerts-state"]')!.textContent).toBe("Off");
    const configure = [...document.querySelectorAll("button")].find((b) => b.textContent === "Configure…")!;
    act(() => configure.click());
    await settle();
    expect(dialog()).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
  });
});
