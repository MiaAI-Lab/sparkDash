import { i18n, setLocale } from "../../i18n";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchLaunchers = vi.fn();
const runLauncher = vi.fn();
const reorderLaunchers = vi.fn();
const fetchRuntimeControl = vi.fn();
vi.mock("../../api/client", () => ({
  fetchRuntimeControl: (...a: unknown[]) => fetchRuntimeControl(...a),
  startMacRuntime: vi.fn(),
  stopMacRuntime: vi.fn(),
  fetchLaunchers: (...a: unknown[]) => fetchLaunchers(...a),
  runLauncher: (...a: unknown[]) => runLauncher(...a),
  reorderLaunchers: (...a: unknown[]) => reorderLaunchers(...a),
  removeLauncher: vi.fn(),
  addLauncher: vi.fn(),
  updateLauncher: vi.fn(),
  readLauncherJob: vi.fn(() => new Promise(() => {})),
  cancelLauncherJob: vi.fn(),
  // The Add-a-model dialog scans on open; keep it pending so the validation alert is the only one.
  discoverModels: vi.fn(() => new Promise(() => {})),
}));

import type { LauncherJob } from "../../api/types";
import { _resetLauncherCache } from "../../hooks/launcherCache";
import { appendLines } from "../../hooks/useLauncherJob";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { terminalText } from "../ui/LiveTerminal";
import { LlmLauncherDialog, validateLauncherForm } from "./LlmLauncherDialog";
import { addLauncher } from "../../api/client";
import { formatElapsed, jobHeadline as localizedJobHeadline, jobTone, LlmModelsPanel } from "./LlmModelsPanel";

const jobHeadline = (job: LauncherJob) => localizedJobHeadline(job, i18n.getFixedT("en", "hardware"));

describe("Mac Models profiles", () => {
  it("uses the authenticated profile catalog instead of script registration on agent Macs", async () => {
    fetchRuntimeControl.mockResolvedValue({ state: "ready", serving: [], targets: [] });
    fetchLaunchers.mockClear();
    const spark = { ...makeSpark("mac"), kind: "mac" as const, macTransport: "agent" as const };
    const { container } = render(<LlmModelsPanel spark={spark} />);
    await flush();
    expect(container.querySelector(".panel-title")?.textContent).toBe("Models");
    expect(container.querySelector('[data-testid="runtime-launcher"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Add your first model");
    expect(fetchLaunchers).not.toHaveBeenCalled();
    expect(fetchRuntimeControl).toHaveBeenCalledWith("mac");
  });
});

const job = (over: Partial<LauncherJob>): LauncherJob => ({
  id: "j1",
  sparkId: "s1",
  launcherId: "glm",
  launcherName: "GLM",
  action: "start",
  status: "running",
  exitCode: null,
  startedAt: 0,
  finishedAt: null,
  error: null,
  ...over,
});

describe("launcher job text", () => {
  it("describes a running start as a script that is running, not as starting forever", () => {
    expect(jobHeadline(job({}))).toBe("GLM: start script running");
    expect(jobHeadline(job({ action: "stop" }))).toBe("Stopping GLM");
    expect(jobHeadline(job({ action: "attach" }))).toBe("Output of GLM");
  });

  it("reports outcomes with the exit code on failure", () => {
    expect(jobHeadline(job({ status: "completed", exitCode: 0 }))).toBe("GLM: start script finished");
    expect(jobHeadline(job({ status: "failed", exitCode: 3 }))).toBe("GLM: start script failed (exit 3)");
    expect(jobHeadline(job({ action: "stop", status: "failed", exitCode: 1 }))).toBe("GLM: stop script failed (exit 1)");
    expect(jobHeadline(job({ status: "cancelled" }))).toBe("GLM: stopped watching");
  });

  it("maps status to a tone", () => {
    expect(jobTone(job({ status: "completed" }))).toBe("good");
    expect(jobTone(job({ status: "failed" }))).toBe("bad");
    expect(jobTone(job({ status: "running" }))).toBe("info");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("terminal buffer", () => {
  it("appends only new lines and keeps the newest when over the cap", () => {
    const a = [{ seq: 1, text: "a" }, { seq: 2, text: "b" }];
    expect(appendLines(a, [{ seq: 2, text: "b" }, { seq: 3, text: "c" }]).map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(appendLines(a, [])).toBe(a);
    expect(appendLines(a, [{ seq: 3, text: "c" }, { seq: 4, text: "d" }], 3).map((l) => l.seq)).toEqual([2, 3, 4]);
  });

  it("joins lines and the unfinished line for display and copy", () => {
    expect(terminalText([{ text: "one" }, { text: "two" }], "partial")).toBe("one\ntwo\npartial");
    expect(terminalText([], "partial")).toBe("partial");
    expect(terminalText([{ text: "one" }])).toBe("one");
  });
});

describe("add model form validation", () => {
  it("translates validation while retaining draft input and an in-flight save", async () => {
    const initialLocale = i18n.language;
    await setLocale("en");
    vi.mocked(addLauncher).mockClear();
    vi.mocked(addLauncher).mockImplementation(() => new Promise(() => {}));
    try {
      render(<LlmLauncherDialog open sparkId="s1" sparkName="Raw host" onClose={vi.fn()} onSaved={vi.fn()} />);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input")];
      const set = (input: HTMLInputElement, value: string) => act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      set(inputs[0], "Raw model");
      set(inputs[1], "relative/path");
      act(() => dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("must start with");
      await act(async () => { await setLocale("zh-CN"); });
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("目录必须以");
      expect(inputs[0].value).toBe("Raw model");
      expect(inputs[1].value).toBe("relative/path");
      expect(addLauncher).not.toHaveBeenCalled();
      set(inputs[1], "/models/raw");
      act(() => dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
      expect(addLauncher).toHaveBeenCalledTimes(1);
      await act(async () => { await setLocale("en"); });
      expect(addLauncher).toHaveBeenCalledTimes(1);
      expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
      expect(inputs[0].value).toBe("Raw model");
    } finally {
      await act(async () => { await i18n.changeLanguage(initialLocale); });
    }
  });

  it("accepts a normal form and flags the common mistakes", () => {
    expect(validateLauncherForm({ name: "GLM", dir: "/home/me/glm", port: "8888" })).toBeNull();
    expect(validateLauncherForm({ name: "GLM", dir: "~/glm", port: "" })).toBeNull();
    expect(validateLauncherForm({ name: " ", dir: "/x", port: "" })).toBe("name");
    expect(validateLauncherForm({ name: "a", dir: "", port: "" })).toBe("directory");
    expect(validateLauncherForm({ name: "a", dir: "relative/x", port: "" })).toBe("absolute");
    expect(validateLauncherForm({ name: "a", dir: "/with space", port: "" })).toBe("spaces");
    expect(validateLauncherForm({ name: "a", dir: "/x", port: "99999" })).toBe("port");
  });
});

describe("starting a model while another one runs", () => {
  const launcher = (id: string, name: string) => ({ id, name, dir: "/m", startScript: "start.sh", stopScript: "stop.sh", port: 8000, notes: "" });
  const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  beforeEach(() => {
    _resetLauncherCache();
    fetchLaunchers.mockResolvedValue({
      launchers: [launcher("a", "Alpha"), launcher("b", "Beta")],
      job: null,
      statuses: { a: "running", b: "stopped" },
    });
    runLauncher.mockImplementation(async (_spark: string, id: string, action: string) => ({ job: job({ id: `j-${id}`, launcherId: id, action: action as LauncherJob["action"] }) }));
  });

  async function askToStartBeta() {
    const { container } = render(<LlmModelsPanel spark={makeSpark("s1")} />);
    await flush();
    act(() => button(container, "Start")!.click());
    return container;
  }

  it("asks whether to stop the running one first or to run both", async () => {
    const container = await askToStartBeta();
    expect(container.textContent).toContain("Alpha is running. Stop it first, or run both?");
    expect(button(container, "Stop it, then start")).toBeTruthy();
    expect(button(container, "Run both")).toBeTruthy();
    expect(runLauncher).not.toHaveBeenCalled();
  });

  it("Run both starts the new model and leaves the running one alone", async () => {
    const container = await askToStartBeta();
    await act(async () => button(container, "Run both")!.click());
    await flush();
    expect(runLauncher).toHaveBeenCalledTimes(1);
    expect(runLauncher).toHaveBeenCalledWith("s1", "b", "start");
  });

  it("Stop it, then start still stops the running one first", async () => {
    const container = await askToStartBeta();
    await act(async () => button(container, "Stop it, then start")!.click());
    await flush();
    expect(runLauncher).toHaveBeenCalledTimes(1);
    expect(runLauncher).toHaveBeenCalledWith("s1", "a", "stop");
  });
});

describe("reordering the model list", () => {
  const launcher = (id: string, name: string) => ({ id, name, dir: "/m", startScript: "start.sh", stopScript: "stop.sh", port: 8000, notes: "" });
  const list = [launcher("a", "Alpha"), launcher("b", "Beta"), launcher("c", "Gamma")];
  const names = (root: HTMLElement) => [...root.querySelectorAll(".sp-launch__title b")].map((b) => b.textContent);
  const grips = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button.sp-launch__grip")];

  const rowSlot = (row: HTMLElement) => [...(row.parentElement?.querySelectorAll(".sp-launch") ?? [])].indexOf(row);

  beforeEach(() => {
    _resetLauncherCache();
    reorderLaunchers.mockReset();
    fetchLaunchers.mockResolvedValue({ launchers: list, job: null, statuses: { a: "stopped", b: "stopped", c: "stopped" } });
    // jsdom has no layout; give each row its own vertical slot so dnd-kit can tell which row is next.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("sp-launch") ? new DOMRect(0, rowSlot(this) * 60, 400, 56) : new DOMRect(0, 0, 0, 0);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const press = (target: Element, code: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true }));
    });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  /** Pick a row up by its grip, move it one place down, drop it. */
  async function moveDown(grip: HTMLElement) {
    press(grip, "Space");
    await tick();
    press(document.body, "ArrowDown");
    await tick();
    press(document.body, "Space");
    await tick();
  }

  async function open() {
    const view = render(<LlmModelsPanel spark={makeSpark("s1")} />);
    await flush();
    return view.container;
  }

  it("gives each row a labelled handle when there is something to reorder", async () => {
    const container = await open();
    expect(names(container)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(grips(container).map((g) => g.getAttribute("aria-label"))).toEqual(["Reorder Alpha", "Reorder Beta", "Reorder Gamma"]);
    await act(async () => { await setLocale("zh-CN"); });
    expect(grips(container).map((g) => g.getAttribute("aria-label"))).toEqual(["重新排序 Alpha", "重新排序 Beta", "重新排序 Gamma"]);
    await act(async () => { await setLocale("en"); });
  });

  it("shows no handle for a single model", async () => {
    fetchLaunchers.mockResolvedValue({ launchers: [list[0]], job: null, statuses: { a: "stopped" } });
    const container = await open();
    expect(names(container)).toEqual(["Alpha"]);
    expect(grips(container)).toHaveLength(0);
  });

  it("saves the full new order and shows the list the server returns", async () => {
    reorderLaunchers.mockImplementation(async (_spark: string, ids: string[]) => ({ launchers: ids.map((id) => list.find((l) => l.id === id)) }));
    const container = await open();
    await moveDown(grips(container)[0]);
    await flush();
    expect(reorderLaunchers).toHaveBeenCalledTimes(1);
    expect(reorderLaunchers).toHaveBeenCalledWith("s1", ["b", "a", "c"]);
    expect(names(container)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("puts the old order back and says so when the save fails", async () => {
    reorderLaunchers.mockRejectedValue(new Error("Disk full"));
    const container = await open();
    await moveDown(grips(container)[0]);
    await flush();
    expect(names(container)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Disk full");
  });

  it("does not save when a row is dropped where it started", async () => {
    const container = await open();
    const grip = grips(container)[1];
    press(grip, "Space");
    await tick();
    press(document.body, "Space");
    await tick();
    expect(reorderLaunchers).not.toHaveBeenCalled();
    expect(names(container)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
