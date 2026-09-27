import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";
import { ErrorBanner } from "./ErrorBanner";
import { render } from "../../testing/render";

describe("operator status banners", () => {
  it("keeps last-known data explicitly disconnected and announces once without age chatter", () => {
    const { container } = render(
      <ConnectionBanner connected={false} lastValidSnapshotAt={10_000} snapshotError={null} now={25_000} stale={false} />
    );
    expect(container.textContent).toContain("Showing data from 15s ago");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Live telemetry is disconnected.");
  });

  it("distinguishes stale and malformed telemetry", () => {
    const stale = render(
      <ConnectionBanner connected lastValidSnapshotAt={10_000} snapshotError={null} now={21_000} stale />
    ).container;
    expect(stale.textContent).toContain("Telemetry is stale");
    const malformed = render(
      <ConnectionBanner connected={false} lastValidSnapshotAt={10_000} snapshotError="Malformed telemetry" now={21_000} stale />
    ).container;
    expect(malformed.textContent).toContain("Malformed telemetry");
    expect(malformed.querySelector('[role="status"]')?.textContent).toBe("Telemetry data error.");
  });

  it("renders a dismissible action error as an alert", () => {
    const dismiss = vi.fn();
    const { container } = render(<ErrorBanner message="Could not save order" onDismiss={dismiss} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save order");
    act(() => (container.querySelector('button[aria-label="Dismiss error"]') as HTMLButtonElement).click());
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
