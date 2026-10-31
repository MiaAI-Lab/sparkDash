import { i18n, setLocale } from "../../i18n";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLaunchers = vi.fn();
const runLauncher = vi.fn();
vi.mock("../../api/client", () => ({
  fetchLaunchers: (...a: unknown[]) => fetchLaunchers(...a),
  runLauncher: (...a: unknown[]) => runLauncher(...a),
  removeLauncher: vi.fn(),
  addLauncher: vi.fn(),
  updateLauncher: vi.fn(),
  readLauncherJob: vi.fn(() => new Promise(() => {})),
  cancelLauncherJob: vi.fn(),
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
