import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";
import { reloadPage } from "../shared/reloadPage";
import { flush, render } from "../testing/render";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../shared/reloadPage", () => ({ reloadPage: vi.fn() }));

const base = { allowPlainSudoPassword: false, timeZone: "" } as unknown as Settings;
const byLabel = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const save = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Save") as HTMLButtonElement;

async function open(initial: Partial<Settings>) {
  vi.mocked(fetchSettings).mockResolvedValue({ ...base, ...initial });
  vi.mocked(updateSettings).mockImplementation(async (s) => s as Settings);
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();
}

describe("SettingsDialog: Allow sudo password over plain http", () => {
  beforeEach(() => {
    vi.mocked(reloadPage).mockClear();
  });

  it("reloads the page after saving when it was turned on", async () => {
    await open({ allowPlainSudoPassword: false });
    act(() => byLabel("Allow sudo password over plain http").click());
    await act(async () => save().click());
    await flush();
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ allowPlainSudoPassword: true }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("reloads after it was turned off too, so no page keeps offering a password box", async () => {
    await open({ allowPlainSudoPassword: true });
    act(() => byLabel("Allow sudo password over plain http").click());
    await act(async () => save().click());
    await flush();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("does not reload when it was left alone, or when the save fails", async () => {
    await open({ allowPlainSudoPassword: false });
    act(() => byLabel("Detailed VRAM breakdown").click());
    await act(async () => save().click());
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();

    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("nope"));
    document.body.replaceChildren();
    await open({ allowPlainSudoPassword: false });
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("nope"));
    act(() => byLabel("Allow sudo password over plain http").click());
    await act(async () => save().click());
    await flush();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});
