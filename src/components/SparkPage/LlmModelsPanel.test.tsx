import { describe, expect, it } from "vitest";
import type { LauncherJob } from "../../api/types";
import { appendLines } from "../../hooks/useLauncherJob";
import { terminalText } from "../ui/LiveTerminal";
import { validateLauncherForm } from "./LlmLauncherDialog";
import { formatElapsed, jobHeadline, jobTone } from "./LlmModelsPanel";

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
  it("accepts a normal form and flags the common mistakes", () => {
    expect(validateLauncherForm({ name: "GLM", dir: "/home/me/glm", port: "8888" })).toBeNull();
    expect(validateLauncherForm({ name: "GLM", dir: "~/glm", port: "" })).toBeNull();
    expect(validateLauncherForm({ name: " ", dir: "/x", port: "" })).toMatch(/name/i);
    expect(validateLauncherForm({ name: "a", dir: "", port: "" })).toMatch(/directory/i);
    expect(validateLauncherForm({ name: "a", dir: "relative/x", port: "" })).toMatch(/start with/);
    expect(validateLauncherForm({ name: "a", dir: "/with space", port: "" })).toMatch(/Spaces/);
    expect(validateLauncherForm({ name: "a", dir: "/x", port: "99999" })).toMatch(/Port/);
  });
});
