/**
 * Why this file exists: the settings dialog is the only way to change a model's
 * declared settings without editing files on the Spark. A wrong value type, a
 * save that drops a key, or a restart prompt that never appears leaves the model
 * running with values the user thinks they changed, so the typed round trip and
 * the restart prompt are pinned here.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import {
  LlmLauncherSettingsDialog,
  fromFormValues,
  memoryWarning,
  toFormValues,
  validateSettingsForm,
} from "./LlmLauncherSettingsDialog";
import { fetchLauncherSettings, saveLauncherSettings } from "../../api/client";
import type { LauncherManifest, LauncherSetting, LauncherSettingsResponse, LlmLauncher } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchLauncherSettings: vi.fn(),
  saveLauncherSettings: vi.fn(),
}));

const manifest: LauncherManifest = {
  version: 1,
  settings: [
    {
      key: "PROMPT_CACHE_GIB",
      label: "Prompt cache",
      type: "integer",
      default: 4,
      min: 1,
      max: 16,
      step: 1,
      options: null,
      unit: "GiB",
      help: "Server prompt cache",
      restart: true,
      memory: "GiB",
    },
    {
      key: "ENABLE_PREFIX_CACHE",
      label: "Prefix cache",
      type: "boolean",
      default: true,
      min: null,
      max: null,
      step: null,
      options: null,
      unit: null,
      help: null,
      restart: false,
      memory: null,
    },
    {
      key: "ATTENTION_BACKEND",
      label: "Attention",
      type: "enum",
      default: "flashinfer",
      min: null,
      max: null,
      step: null,
      options: ["flashinfer", "triton"],
      unit: null,
      help: null,
      restart: true,
      memory: null,
    },
  ],
};

const launcher: LlmLauncher = {
  id: "cache-model-abc123",
  name: "Cache model",
  dir: "/home/spark/llm/cache",
  startScript: "start.sh",
  stopScript: "stop.sh",
  port: 8888,
  notes: "",
};

const response = (over: Partial<LauncherSettingsResponse> = {}): LauncherSettingsResponse => ({
  manifest,
  values: { PROMPT_CACHE_GIB: 4, ENABLE_PREFIX_CACHE: true, ATTENTION_BACKEND: "flashinfer" },
  invalid: [],
  envFile: "launcher.env",
  ...over,
});

const props = {
  open: true,
  sparkId: "spark-a",
  sparkName: "Spark A",
  launcher,
  runState: "running" as "running" | "stopped" | "unknown",
  availableMemoryMb: 3072,
  onClose: vi.fn(),
  onRestart: vi.fn(),
};

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const setInput = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (el: Element) => act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

beforeEach(() => {
  vi.mocked(fetchLauncherSettings).mockReset();
  vi.mocked(saveLauncherSettings).mockReset();
});

describe("settings form helpers", () => {
  it("round-trips typed values through form state", () => {
    const form = toFormValues(manifest, { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false, ATTENTION_BACKEND: "triton" });
    expect(form).toEqual({ PROMPT_CACHE_GIB: "8", ENABLE_PREFIX_CACHE: false, ATTENTION_BACKEND: "triton" });
    expect(fromFormValues(manifest, form)).toEqual({ PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false, ATTENTION_BACKEND: "triton" });
  });

  it("falls back to the manifest default for a key the values omit", () => {
    expect(toFormValues(manifest, {})).toEqual({ PROMPT_CACHE_GIB: "4", ENABLE_PREFIX_CACHE: true, ATTENTION_BACKEND: "flashinfer" });
  });

  it("sends string values trimmed, so what the client checked is what the server receives", () => {
    const stringManifest: LauncherManifest = {
      version: 1,
      settings: [
        { key: "SERVED_NAME", label: "Served name", type: "string", default: "model", min: null, max: null, step: null, options: null, unit: null, help: null, restart: true, memory: null },
      ],
    };
    expect(fromFormValues(stringManifest, { SERVED_NAME: "  my-model  " })).toEqual({ SERVED_NAME: "my-model" });
  });

  it("flags a non-integer, an out-of-range value and an unknown option", () => {
    const base = toFormValues(manifest, {});
    expect(validateSettingsForm(manifest, { ...base, PROMPT_CACHE_GIB: "1.5" })).toEqual({ PROMPT_CACHE_GIB: "integer" });
    expect(validateSettingsForm(manifest, { ...base, PROMPT_CACHE_GIB: "99" })).toEqual({ PROMPT_CACHE_GIB: "max" });
    expect(validateSettingsForm(manifest, { ...base, PROMPT_CACHE_GIB: "0" })).toEqual({ PROMPT_CACHE_GIB: "min" });
    expect(validateSettingsForm(manifest, { ...base, PROMPT_CACHE_GIB: "" })).toEqual({ PROMPT_CACHE_GIB: "integer" });
    expect(validateSettingsForm(manifest, { ...base, ATTENTION_BACKEND: "cuda" })).toEqual({ ATTENTION_BACKEND: "option" });
    expect(validateSettingsForm(manifest, base)).toEqual({});
  });

  it("warns only when a memory setting rises past what the unit has free", () => {
    const cache = manifest.settings[0];
    // 3072 MB available, 1 GiB margin: a rise of 2 GiB fits, 3 GiB does not.
    expect(memoryWarning(cache, "6", "4", 3072)).toBeNull();
    expect(memoryWarning(cache, "8", "4", 3072)).toEqual({ delta: 4, availableGiB: 3, marginGiB: 1 });
    expect(memoryWarning(cache, "4", "4", 3072)).toBeNull();
    expect(memoryWarning(cache, "2", "4", 3072)).toBeNull();
    expect(memoryWarning(cache, "8", "4", null)).toBeNull();
    const noMemory: LauncherSetting = { ...cache, memory: null };
    expect(memoryWarning(noMemory, "8", "4", 3072)).toBeNull();
  });
});

describe("LlmLauncherSettingsDialog", () => {
  it("renders the manifest's fields with their current values and saves typed values", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockResolvedValue({
      values: { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: false, ATTENTION_BACKEND: "triton" },
      restartRequired: true,
    });
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();

    expect(fetchLauncherSettings).toHaveBeenCalledWith("spark-a", "cache-model-abc123");
    expect(dialog().textContent).toContain("Settings for Cache model");
    expect(dialog().textContent).toContain("Server prompt cache");
    expect(dialog().textContent).toContain("1 to 16");
    expect(dialog().textContent).toContain("Default 4");

    const number = dialog().querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(number.value).toBe("4");
    expect(number.min).toBe("1");
    expect(number.max).toBe("16");
    const checkbox = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    const select = dialog().querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("flashinfer");

    setInput(number, "8");
    await click(checkbox);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "triton");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Save")!);
    await flush();

    expect(saveLauncherSettings).toHaveBeenCalledWith("spark-a", "cache-model-abc123", {
      PROMPT_CACHE_GIB: 8,
      ENABLE_PREFIX_CACHE: false,
      ATTENTION_BACKEND: "triton",
    });
    expect(dialog().textContent).toContain("Saved to launcher.env.");
  });

  it("asks for a restart when a restart setting changed and the model is running", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockResolvedValue({
      values: { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: true, ATTENTION_BACKEND: "flashinfer" },
      restartRequired: true,
    });
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();
    setInput(dialog().querySelector<HTMLInputElement>('input[type="number"]')!, "8");
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("Restart Cache model to apply?");
    await click(button("Restart Cache model")!);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
  });

  it("says the new values apply at the next start when the model is stopped", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockResolvedValue({
      values: { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: true, ATTENTION_BACKEND: "flashinfer" },
      restartRequired: true,
    });
    render(<LlmLauncherSettingsDialog {...props} runState="stopped" />);
    await flush();
    setInput(dialog().querySelector<HTMLInputElement>('input[type="number"]')!, "8");
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("Cache model is not running");
    expect(button("Restart Cache model")).toBeUndefined();
  });

  it("offers a restart, without claiming the model is stopped, when its run state could not be read", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockResolvedValue({
      values: { PROMPT_CACHE_GIB: 8, ENABLE_PREFIX_CACHE: true, ATTENTION_BACKEND: "flashinfer" },
      restartRequired: true,
    });
    render(<LlmLauncherSettingsDialog {...props} runState="unknown" />);
    await flush();
    setInput(dialog().querySelector<HTMLInputElement>('input[type="number"]')!, "8");
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("Could not check whether Cache model is running");
    expect(dialog().textContent).not.toContain("is not running");
    await click(button("Restart Cache model")!);
    expect(props.onRestart).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a restart when nothing that needs one changed", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockResolvedValue({
      values: { PROMPT_CACHE_GIB: 4, ENABLE_PREFIX_CACHE: false, ATTENTION_BACKEND: "flashinfer" },
      restartRequired: false,
    });
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();
    await click(dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("Saved to launcher.env.");
    expect(dialog().textContent).not.toContain("Restart Cache model to apply?");
  });

  it("blocks a save with a bad value and shows the problem without calling the API", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();
    setInput(dialog().querySelector<HTMLInputElement>('input[type="number"]')!, "99");
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("Prompt cache must be at most 16");
    expect(saveLauncherSettings).not.toHaveBeenCalled();
  });

  it("warns when a memory setting rises past the free memory on the unit", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    render(<LlmLauncherSettingsDialog {...props} availableMemoryMb={3072} />);
    await flush();
    setInput(dialog().querySelector<HTMLInputElement>('input[type="number"]')!, "8");
    await flush();
    expect(dialog().textContent).toContain("leaves less than 1 GiB free on Spark A");
  });

  it("explains a launcher with no manifest instead of showing an empty form", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response({ manifest: null, values: {} }));
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();

    expect(dialog().textContent).toContain("This model has no settings.");
    expect(dialog().textContent).toContain("/home/spark/llm/cache");
    expect(dialog().querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  });

  it("shows the server's refusal when a save fails", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(response());
    vi.mocked(saveLauncherSettings).mockRejectedValue(new Error("PROMPT_CACHE_GIB must be at most 16"));
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();
    await click(button("Save")!);
    await flush();

    expect(dialog().textContent).toContain("PROMPT_CACHE_GIB must be at most 16");
  });

  it("reports a value the env file holds that the manifest rejects", async () => {
    vi.mocked(fetchLauncherSettings).mockResolvedValue(
      response({ invalid: [{ key: "PROMPT_CACHE_GIB", raw: "99" }] })
    );
    render(<LlmLauncherSettingsDialog {...props} />);
    await flush();
    expect(dialog().textContent).toContain("launcher.env holds a value sparkDash cannot use for PROMPT_CACHE_GIB");
  });
});
