import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchLaunchers = vi.fn();
const runLauncher = vi.fn();
vi.mock("../../api/client", () => ({
  fetchLaunchers: (...a: unknown[]) => fetchLaunchers(...a),
  runLauncher: (...a: unknown[]) => runLauncher(...a),
  addLauncher: vi.fn(),
  updateLauncher: vi.fn(),
}));

import { ModelLauncher } from "./ModelLauncher";
import { _resetLauncherCache } from "../../hooks/launcherCache";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";

const launcher = (id: string, name = id) => ({ id, name, dir: "/m", startScript: "start.sh", stopScript: "stop.sh", port: 8000, notes: "" });
const list = (statuses: Record<string, string>) => ({ launchers: [launcher("a", "Alpha"), launcher("b", "Beta")], job: null, statuses });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("ModelLauncher", () => {
  beforeEach(() => {
    _resetLauncherCache();
    fetchLaunchers.mockReset();
    runLauncher.mockReset();
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it("lists models to start, and shows the loading guard for one that is running", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    const { container } = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    expect(container.textContent).toContain("Alpha");
    expect(container.querySelectorAll("button.btn--primary").length).toBe(2);

    fetchLaunchers.mockResolvedValue(list({ a: "running", b: "stopped" }));
    _resetLauncherCache();
    const second = render(<ModelLauncher spark={makeSpark("s2")} />);
    await flush();
    expect(second.container.textContent).toContain("Loading Alpha");
  });

  it("keeps the loading guard when a later probe fails and reports everything unknown", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "running", b: "stopped" }));
    const { container } = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    expect(container.textContent).toContain("Loading Alpha");
    fetchLaunchers.mockResolvedValue(list({ a: "unknown", b: "unknown" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchLaunchers).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Loading Alpha");
  });

  it("does not stop key events, so Ctrl+K and Escape still reach the window", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    const { container } = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey);
    const btn = container.querySelector("button")!;
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    window.removeEventListener("keydown", onKey);
    expect(seen).toEqual(["k", "Escape"]);
  });

  it("does not poll while the tab is hidden and shares one request across cards", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    render(
      <>
        <ModelLauncher spark={makeSpark("s1")} />
        <ModelLauncher spark={makeSpark("s1")} />
      </>
    );
    await flush();
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);
    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchLaunchers).toHaveBeenCalledTimes(2);
  });

  it("starts a model, marks it running and refreshes after 2.5 s; clears timers on unmount", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    runLauncher.mockResolvedValue({ job: {} });
    const { container, root } = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    const start = container.querySelector<HTMLButtonElement>("button.btn--primary")!;
    await act(async () => {
      start.click();
    });
    expect(runLauncher).toHaveBeenCalledWith("s1", "a", "start");
    expect(container.textContent).toContain("Loading Alpha");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(fetchLaunchers).toHaveBeenCalledTimes(2);

    // A second Start whose refresh is still pending when the card goes away must not fetch.
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    act(() => root.unmount());
    const calls = fetchLaunchers.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchLaunchers.mock.calls.length).toBe(calls);
  });

  it("shows a start error and clears it on the next successful refresh", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    runLauncher.mockRejectedValue(new Error("Another job is running"));
    const { container } = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button.btn--primary")!.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Another job");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("paints from the shared cache at once when the card remounts", async () => {
    fetchLaunchers.mockResolvedValue(list({ a: "stopped", b: "stopped" }));
    const first = render(<ModelLauncher spark={makeSpark("s1")} />);
    await flush();
    act(() => first.root.unmount());
    fetchLaunchers.mockClear();
    const { container } = render(<ModelLauncher spark={makeSpark("s1")} />);
    expect(container.textContent).toContain("Alpha");
    await flush();
    expect(fetchLaunchers).not.toHaveBeenCalled();
  });
});
