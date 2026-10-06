import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { flush, render } from "../testing/render";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function stubServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/settings") return json({ pollIntervalMs: 2000, defaultLlmPort: 8888, alertsEnabled: true });
      if (url === "/api/alerts/config") return json({ enabled: true, repeatIntervalMin: 0, rules: [], channels: [] });
      if (url === "/api/alerts") return json({ enabled: true, active: [], pending: [], recent: [] });
      return json({});
    }),
  );
}

const panel = () => document.querySelector<HTMLElement>("[data-settings-panel]")!;
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;
const escape = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

describe("SettingsDialog → Alerts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hides the Settings panel while Alerts is open and brings it back after", async () => {
    stubServer();
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} onSaved={() => {}} />);
    await flush();
    await flush();
    expect(panel().className).not.toContain("invisible");

    act(() => buttonByText("Alerts…").click());
    await flush();
    await flush();
    // Replaced, not stacked: the panel is hidden and out of the accessibility tree.
    expect(panel().className).toContain("invisible");
    expect(panel().getAttribute("aria-hidden")).toBe("true");

    // Escape closes Alerts only; Settings stays open and reappears.
    escape();
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(panel().className).not.toContain("invisible");
    expect(panel().getAttribute("aria-hidden")).toBeNull();
  });
});
