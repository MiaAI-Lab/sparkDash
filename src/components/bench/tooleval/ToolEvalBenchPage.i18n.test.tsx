import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolEvalSpec } from "../../../api/types";
import { setLocale } from "../../../i18n";
import { makeSpark } from "../../../testing/fixtures";
import { flush, render } from "../../../testing/render";

const fetchToolEvalSpec = vi.fn();
const fetchToolEvalStatus = vi.fn();
const fetchToolEvalRuns = vi.fn();
const previewToolEval = vi.fn();

vi.mock("../../../api/client", () => ({
  attachToolEvalRun: vi.fn(),
  cancelToolEvalWatch: vi.fn(),
  deleteToolEvalRun: vi.fn(),
  fetchToolEvalResult: vi.fn(),
  fetchToolEvalRun: vi.fn(),
  fetchToolEvalRuns: (...args: unknown[]) => fetchToolEvalRuns(...args),
  fetchToolEvalSpec: (...args: unknown[]) => fetchToolEvalSpec(...args),
  fetchToolEvalStatus: (...args: unknown[]) => fetchToolEvalStatus(...args),
  fetchToolEvalUpdateCheck: vi.fn(),
  fetchToolEvalInstallCommand: vi.fn().mockResolvedValue({ command: "uv tool install tool-eval-bench" }),
  previewToolEval: (...args: unknown[]) => previewToolEval(...args),
  readToolEvalInstall: vi.fn().mockResolvedValue({ job: { status: "completed" }, lines: [], nextLine: 0, partial: "" }),
  readToolEvalRun: vi.fn(),
  refreshToolEvalRun: vi.fn(),
  startToolEvalInstall: vi.fn(),
  startToolEvalRun: vi.fn(),
  stopToolEvalRun: vi.fn(),
}));

import { ToolEvalBenchPage } from "./ToolEvalBenchPage";

const spec: ToolEvalSpec = {
  groups: [{ id: "connection", label: "Connection", help: "" }],
  args: [
    { name: "base-url", flag: "--base-url", kind: "url", group: "connection", label: "Base URL", help: "" },
    { name: "model", flag: "--model", kind: "text", group: "connection", label: "Model", help: "" },
    { name: "api-key", flag: "--api-key", kind: "secret", group: "connection", label: "API key", help: "" },
  ],
  backends: [],
  categories: [],
  types: {},
  install: { extras: [] },
};

const setInput = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(async () => {
  localStorage.clear();
  vi.useFakeTimers();
  fetchToolEvalSpec.mockResolvedValue(spec);
  fetchToolEvalStatus.mockResolvedValue({ installed: true, version: "1", path: "/tool-eval", uv: "uv", python: "python", pythonVersion: "3.12", workDir: "/tmp", error: null });
  fetchToolEvalRuns.mockResolvedValue({ runs: [], active: null });
  previewToolEval.mockResolvedValue({ ok: true, command: "tool-eval-bench --raw", usesSavedKey: false });
  await act(() => setLocale("en"));
});

afterEach(async () => {
  vi.useRealTimers();
  await act(() => setLocale("en"));
});

it("keeps a custom target draft and its raw preview request through a locale round-trip without re-previewing", async () => {
  const { container } = render(<ToolEvalBenchPage type="tool-eval" spark={makeSpark("raw-spark")} />);
  await flush();

  const customUrl = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === "Custom URL")!;
  act(() => customUrl.click());
  const baseUrl = container.querySelector<HTMLInputElement>('[aria-label="Custom base URL"]')!;
  const model = container.querySelector<HTMLInputElement>('[aria-label="Model name"]')!;
  const apiKey = container.querySelector<HTMLInputElement>('[aria-label="API key"]')!;
  setInput(baseUrl, "https://raw.example/v1");
  setInput(model, "raw/model:7b");
  setInput(apiKey, "sk-raw-key");

  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  await flush();
  const rawRequest = { type: "tool-eval", options: { "base-url": "https://raw.example/v1", model: "raw/model:7b" }, extraArgs: "", useSavedKey: false };
  expect(previewToolEval).toHaveBeenLastCalledWith("raw-spark", rawRequest);
  const previewCount = previewToolEval.mock.calls.length;

  await act(() => setLocale("zh-CN"));
  await flush();
  expect(baseUrl.value).toBe("https://raw.example/v1");
  expect(model.value).toBe("raw/model:7b");
  expect(apiKey.value).toBe("sk-raw-key");
  expect(previewToolEval).toHaveBeenCalledTimes(previewCount);

  await act(() => setLocale("en"));
  await flush();
  expect(baseUrl.value).toBe("https://raw.example/v1");
  expect(model.value).toBe("raw/model:7b");
  expect(apiKey.value).toBe("sk-raw-key");
  expect(previewToolEval).toHaveBeenCalledTimes(previewCount);
  expect(previewToolEval).toHaveBeenLastCalledWith("raw-spark", rawRequest);
});
