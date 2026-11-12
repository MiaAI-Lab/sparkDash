import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSettingsHash, parseSettingsHash, settingsHref, useSettingsHash } from "./settingsLink";
import { render } from "../testing/render";

function Probe({ open }: { open: (section: string | null) => void }) {
  useSettingsHash(open);
  return null;
}

describe("settings links", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("writes and reads #settings and #settings/<section>", () => {
    expect(settingsHref()).toBe("#settings");
    expect(settingsHref("energy")).toBe("#settings/energy");
    expect(parseSettingsHash("#settings")).toBeNull();
    expect(parseSettingsHash("#settings/energy")).toBe("energy");
    expect(parseSettingsHash("#other")).toBeUndefined();
    expect(parseSettingsHash("")).toBeUndefined();
    expect(parseSettingsHash("#settings/<x>")).toBeUndefined();
  });

  it("opens on load and on every hash change, and clearing leaves the path alone", () => {
    window.history.replaceState(null, "", "/energy#settings/energy");
    const open = vi.fn();
    render(<Probe open={open} />);
    expect(open).toHaveBeenLastCalledWith("energy");
    clearSettingsHash();
    expect(window.location.pathname + window.location.hash).toBe("/energy");
    const go = (hash: string) =>
      act(() => {
        window.history.replaceState(null, "", hash);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
    go("#settings");
    expect(open).toHaveBeenLastCalledWith(null);
    go("#elsewhere");
    expect(open).toHaveBeenCalledTimes(2);
  });
});