import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../api/types";
import { render } from "../testing/render";
import {
  CHANGELOG_URL,
  UPGRADE_COMMAND,
  UpdateAvailableDialog,
  readDismissedVersion,
  rememberDismissedVersion,
  shouldOfferUpdate,
} from "./UpdateAvailableDialog";

const status: UpdateStatus = {
  enabled: true,
  currentVersion: "2.75.4",
  latestVersion: "2.76.0",
  updateAvailable: true,
  notes: "## Unreleased\n\n### Added\n- **Faster popup** and a full changelog.",
  checkedAt: 1_000_000,
};

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const button = (label: string) =>
  Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === label)!;

afterEach(() => {
  localStorage.clear();
});

describe("UpdateAvailableDialog", () => {
  it("names both versions and the manual upgrade command", () => {
    render(<UpdateAvailableDialog status={status} open onClose={() => {}} />);
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("v2.76.0");
    expect(text).toContain("v2.75.4");
    expect(text).toContain(UPGRADE_COMMAND);
    expect(text).toContain("sparkDash never updates itself");
    expect(text).toContain("Faster popup");
    expect(dialog()!.querySelector<HTMLAnchorElement>("a")!.href).toBe(CHANGELOG_URL);
  });

  it("falls back to a link when upstream has no notes", () => {
    render(<UpdateAvailableDialog status={{ ...status, notes: null }} open onClose={() => {}} />);
    expect(dialog()!.textContent).toContain("Release notes are in the changelog");
  });

  it("closes from Not now and from the close button", () => {
    const onClose = vi.fn();
    render(<UpdateAvailableDialog status={status} open onClose={onClose} />);
    act(() => button("Not now").click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays unrendered while closed", () => {
    render(<UpdateAvailableDialog status={status} open={false} onClose={() => {}} />);
    expect(dialog()).toBeNull();
  });

  it("only takes Escape while it owns focus", () => {
    const onClose = vi.fn();
    render(
      <div>
        <UpdateAvailableDialog status={status} open onClose={onClose} />
        <button type="button">Above</button>
      </div>,
    );
    const above = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Above")!;
    act(() => {
      above.focus();
      above.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const inside = dialog()!.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      inside.focus();
      inside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("shouldOfferUpdate", () => {
  it("offers only a definite newer version", () => {
    expect(shouldOfferUpdate(status, null)).toBe(true);
    expect(shouldOfferUpdate({ ...status, updateAvailable: false }, null)).toBe(false);
    expect(shouldOfferUpdate({ ...status, updateAvailable: null }, null)).toBe(false);
    expect(shouldOfferUpdate({ ...status, latestVersion: null }, null)).toBe(false);
    expect(shouldOfferUpdate(null, null)).toBe(false);
  });

  it("does not offer a version this browser already dismissed", () => {
    rememberDismissedVersion("2.76.0");
    expect(readDismissedVersion()).toBe("2.76.0");
    expect(shouldOfferUpdate(status, readDismissedVersion())).toBe(false);
    // A later upstream version is a new decision, not a repeat.
    expect(shouldOfferUpdate({ ...status, latestVersion: "2.76.1" }, readDismissedVersion())).toBe(true);
  });
});
