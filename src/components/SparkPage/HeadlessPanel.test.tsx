import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { HeadlessPanel } from "./HeadlessPanel";
import { flush, render } from "../../testing/render";
import type { HeadlessActionResult, HeadlessMetrics, HeadlessUnit } from "../../api/types";
import { fetchHeadlessFlags, makeHeadless, refreshSparkMetric, restoreDesktop } from "../../api/client";

vi.mock("../../api/client", () => ({
  fetchHeadlessFlags: vi.fn(),
  makeHeadless: vi.fn(),
  restoreDesktop: vi.fn(),
  refreshSparkMetric: vi.fn(),
}));

const flags = vi.mocked(fetchHeadlessFlags);
const make = vi.mocked(makeHeadless);
const restore = vi.mocked(restoreDesktop);
const refresh = vi.mocked(refreshSparkMetric);

const unit = (
  name: string,
  present: boolean | null,
  active: boolean | null,
  enabled: boolean | null,
  state: string | null
): HeadlessUnit => ({ unit: name, present, active, enabled, state });

const DM_RUNNING = unit("display-manager.service", true, true, null, "active");
const DM_STOPPED = unit("display-manager.service", true, false, null, "inactive");

function metrics(over: Partial<HeadlessMetrics> = {}): HeadlessMetrics {
  return {
    available: true,
    state: "desktop",
    defaultTarget: "graphical.target",
    displayManager: DM_RUNNING,
    desktop: {
      processes: [
        { name: "gnome-shell", rssMib: 106, swapMib: 0 },
        { name: "Xorg", rssMib: 12.5, swapMib: 0 },
      ],
      rssMib: 118.5,
      swapMib: 0,
    },
    units: [
      unit("cups.service", true, true, true, "active"),
      unit("cups.socket", true, false, true, "inactive"),
      unit("bluetooth.service", true, false, false, "inactive"),
      unit("kerneloops.service", false, false, false, "not installed"),
      unit("colord.service", null, null, null, null),
    ],
    error: null,
    ...over,
  };
}

const RESULT: HeadlessActionResult = {
  mode: null,
  memBeforeKib: 4620288,
  memAfterKib: 5242880,
  defaultBefore: "graphical.target",
  defaultAfter: "multi-user.target",
  stoppedDisplayManager: true,
  startedDisplayManager: false,
  disabled: ["cups.service"],
  restored: [],
  failed: [],
  stateFile: "/var/lib/sparkdash-headless/state",
};

function read(container: HTMLElement) {
  const tags = Array.from(container.querySelectorAll<HTMLElement>(".tag")).map((el) => ({
    text: el.textContent,
    tone: el.className,
  }));
  const rows = Object.fromEntries(
    Array.from(container.querySelectorAll(".sp-list-row")).map((row) => [
      row.children[0]?.textContent ?? "",
      row.children[1]?.textContent ?? "",
    ])
  );
  const callouts = Array.from(container.querySelectorAll(".sp-callout")).map((el) => ({
    text: el.textContent ?? "",
    bad: el.classList.contains("sp-callout--bad"),
  }));
  return { text: container.textContent ?? "", tags, rows, callouts };
}

function view(headless: HeadlessMetrics | null) {
  return read(render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={headless} />).container);
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function checkbox(container: HTMLElement, label: string): HTMLInputElement {
  const found = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
    (el) => el.closest("label")?.textContent === label
  );
  if (!found) throw new Error(`no checkbox labelled ${label}`);
  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  flags.mockResolvedValue({ passwordAllowed: true, plainPasswordAllowed: false });
  refresh.mockResolvedValue({ success: true, domain: "headless" });
});

afterEach(async () => {
  await act(() => setLocale("en"));
  vi.restoreAllMocks();
});

describe("HeadlessPanel", () => {
  it("waits for the first poll without claiming a state", () => {
    const v = view(null);
    expect(v.tags.map((t) => t.text)).toEqual(["unknown"]);
    expect(v.text).toContain("Waiting for first poll");
    expect(v.rows).toEqual({});
    expect(v.callouts).toEqual([]);
  });

  it("shows a running desktop, what it holds in memory and the optional services", () => {
    const v = view(metrics());
    expect(v.tags).toEqual([{ text: "desktop", tone: expect.not.stringContaining("tag--") }]);
    expect(v.rows).toEqual({
      "Boot default": "graphical.target",
      "Display manager": "running",
      "Desktop memory": "118.5 MiB resident, 0 MiB swap",
      "gnome-shell": "106 MiB",
      Xorg: "12.5 MiB",
      "cups.service": "running, enabled",
      "cups.socket": "stopped, enabled",
      "bluetooth.service": "stopped, disabled",
    });
    expect(v.callouts).toEqual([]);
  });

  it("shows a headless unit with no desktop memory", () => {
    const v = view(
      metrics({
        state: "headless",
        defaultTarget: "multi-user.target",
        displayManager: DM_STOPPED,
        desktop: { processes: [], rssMib: null, swapMib: null },
      })
    );
    expect(v.tags).toEqual([{ text: "headless", tone: expect.stringContaining("tag--good") }]);
    expect(v.rows["Boot default"]).toBe("multi-user.target");
    expect(v.rows["Display manager"]).toBe("stopped");
    expect(v.rows["Desktop memory"]).toBeUndefined();
  });

  it("explains a mixed unit: the desktop still runs until the next boot", () => {
    const v = view(metrics({ state: "mixed", defaultTarget: "multi-user.target" }));
    expect(v.tags).toEqual([{ text: "mixed", tone: expect.stringContaining("tag--warn") }]);
    expect(v.callouts).toEqual([
      {
        text: "The boot default is multi-user.target, but the desktop still runs. It stops at the next boot, or now with Make headless.",
        bad: false,
      },
    ]);
  });

  it("keeps an unreadable swap total unknown rather than zero", () => {
    const v = view(
      metrics({
        desktop: {
          processes: [{ name: "gnome-shell", rssMib: 106, swapMib: null }],
          rssMib: 106,
          swapMib: null,
        },
      })
    );
    expect(v.rows["Desktop memory"]).toBe("106 MiB resident, swap unknown");
    expect(v.rows["gnome-shell"]).toBe("106 MiB");
  });

  it("shows a failed probe as unknown, with its error", () => {
    const v = view(
      metrics({
        available: false,
        state: "unknown",
        defaultTarget: null,
        displayManager: unit("display-manager.service", null, null, null, null),
        desktop: { processes: [], rssMib: null, swapMib: null },
        units: [],
        error: "SSH to 192.0.2.8:22 failed: No route to host",
      })
    );
    expect(v.tags.map((t) => t.text)).toEqual(["unknown"]);
    expect(v.callouts).toEqual([{ text: "SSH to 192.0.2.8:22 failed: No route to host", bad: false }]);
    expect(v.rows).toEqual({});
    expect(v.text).not.toContain("Waiting for first poll");
  });

  it("makes the unit headless with the ticked services and reports the memory freed", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    make.mockResolvedValue({ success: true, result: RESULT });
    const { container } = render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics()} />);
    await flush();
    act(() => checkbox(container, "cups.service").click());
    type(container.querySelector<HTMLInputElement>('input[type="password"]')!, "hunter2");
    await act(async () => {
      button(container, "Make headless").click();
    });
    await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("spark-a"));
    expect(make).toHaveBeenCalledWith("s1", ["cups.service"], "hunter2");
    expect(refresh).toHaveBeenCalledWith("s1", "headless");
    const v = read(container);
    expect(v.callouts).toHaveLength(1);
    expect(v.callouts[0].bad).toBe(false);
    expect(v.callouts[0].text).toContain("Desktop stopped. MemAvailable 4,512 MiB → 5,120 MiB.");
    expect(v.callouts[0].text).toContain("Disabled: cups.service");
  });

  it("does nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics()} />);
    await flush();
    await act(async () => {
      button(container, "Make headless").click();
    });
    expect(make).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores the desktop and says when there was no record to restore from", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restore.mockResolvedValue({
      success: true,
      result: { ...RESULT, mode: "default-only", disabled: [], stoppedDisplayManager: false, defaultAfter: "graphical.target" },
    });
    const { container } = render(
      <HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics({ state: "headless", displayManager: DM_STOPPED })} />
    );
    await flush();
    await act(async () => {
      button(container, "Restore desktop").click();
    });
    await flush();
    expect(restore).toHaveBeenCalledWith("s1", undefined);
    expect(read(container).callouts).toEqual([
      {
        text: "No record of a previous state, so only the boot default went back to graphical.target.",
        bad: false,
      },
    ]);
  });

  it("shows a failed change as an error", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restore.mockRejectedValue(new Error("sudo password was rejected"));
    const { container } = render(
      <HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics({ state: "headless", displayManager: DM_STOPPED })} />
    );
    await flush();
    await act(async () => {
      button(container, "Restore desktop").click();
    });
    await flush();
    expect(read(container).callouts).toEqual([
      { text: "The change failed: sudo password was rejected", bad: true },
    ]);
  });

  it("hides the password field when the server would refuse it", async () => {
    flags.mockResolvedValue({ passwordAllowed: false, plainPasswordAllowed: false });
    const { container } = render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics()} />);
    await flush();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain("open sparkDash over HTTPS");
  });

  it("does not report a restore as done when a step failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restore.mockResolvedValue({
      success: true,
      result: {
        ...RESULT,
        mode: "recorded",
        disabled: [],
        defaultAfter: "graphical.target",
        startedDisplayManager: false,
        failed: ["display-manager.service"],
      },
    });
    const { container } = render(
      <HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics({ state: "headless", displayManager: DM_STOPPED })} />
    );
    await flush();
    await act(async () => {
      button(container, "Restore desktop").click();
    });
    await flush();
    const v = read(container);
    expect(v.callouts).toHaveLength(1);
    expect(v.callouts[0].bad).toBe(true);
    expect(v.callouts[0].text).toContain("The desktop was not fully restored.");
    expect(v.callouts[0].text).toContain("Failed: display-manager.service");
    expect(v.callouts[0].text).not.toContain("Desktop restored");
  });

  it("says the desktop will not start at boot when the default is still multi-user", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restore.mockResolvedValue({
      success: true,
      result: { ...RESULT, mode: "recorded", disabled: [], defaultAfter: "multi-user.target", failed: [] },
    });
    const { container } = render(
      <HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics({ state: "headless", displayManager: DM_STOPPED })} />
    );
    await flush();
    await act(async () => {
      button(container, "Restore desktop").click();
    });
    await flush();
    const v = read(container);
    expect(v.callouts[0].bad).toBe(true);
    expect(v.callouts[0].text).toContain("The boot default is still multi-user.target");
  });

  it("offers only the action that applies to the current state", async () => {
    const desktop = render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics()} />).container;
    await flush();
    expect(button(desktop, "Make headless").disabled).toBe(false);
    expect(button(desktop, "Restore desktop").disabled).toBe(true);
    const headless = render(
      <HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics({ state: "headless", displayManager: DM_STOPPED })} />
    ).container;
    await flush();
    expect(button(headless, "Make headless").disabled).toBe(true);
    expect(button(headless, "Restore desktop").disabled).toBe(false);
  });

  it("renders two processes with the same name without duplicate keys", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <HeadlessPanel
        sparkId="s1"
        sparkName="spark-a"
        headless={metrics({
          desktop: {
            processes: [
              { name: "gnome-shell", rssMib: 90, swapMib: 0 },
              { name: "gnome-shell", rssMib: 106, swapMib: 0 },
            ],
            rssMib: 196,
            swapMib: 0,
          },
        })}
      />
    );
    await flush();
    expect(container.textContent).toContain("gnome-shell");
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  });

  it("switches to Simplified Chinese without changing the numbers", async () => {
    const { container } = render(<HeadlessPanel sparkId="s1" sparkName="spark-a" headless={metrics()} />);
    await act(() => setLocale("zh-CN"));
    const v = read(container);
    expect(v.tags.map((t) => t.text)).toEqual(["桌面"]);
    expect(v.rows["默认启动目标"]).toBe("graphical.target");
    expect(v.rows["桌面内存"]).toBe("常驻 118.5 MiB，交换 0 MiB");
    expect(container.querySelector(".panel-title")?.textContent).toContain("无桌面模式");
  });
});
