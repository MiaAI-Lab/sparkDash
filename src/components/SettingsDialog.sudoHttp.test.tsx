import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";
import { setLocale } from "../i18n";
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
const save = (label = "Save") => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

async function open(initial: Partial<Settings>) {
  vi.mocked(fetchSettings).mockResolvedValue({ ...base, ...initial });
  vi.mocked(updateSettings).mockImplementation(async (s) => s as Settings);
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();
}

describe("SettingsDialog: Allow sudo password over plain http", () => {
  beforeEach(async () => {
    await setLocale("en");
    vi.mocked(reloadPage).mockClear();
  });

  afterEach(async () => {
    await act(() => setLocale("en"));
  });

  it("translates the security explanation and preserves the pending choice across language changes", async () => {
    await open({ allowPlainSudoPassword: false });
    expect(byLabel("Allow sudo password over plain http").getAttribute("aria-checked")).toBe("false");

    await act(() => setLocale("zh-CN"));
    const toggle = byLabel("允许通过明文 HTTP 输入 sudo 密码");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("密码会在网络中以未加密形式传输，因此仅应在可信网络中开启。");
    expect(document.body.textContent).toContain("默认关闭；关闭时，只有通过 HTTPS 或从 Spark 本机访问时才接受密码。");
    expect(document.body.textContent).toContain("保存此设置后，页面会重新加载。");
    expect(document.body.textContent).not.toContain("Lets you type a sudo password");
    act(() => toggle.click());

    await act(() => setLocale("en"));
    expect(byLabel("Allow sudo password over plain http").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("The password then crosses your network unencrypted");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();

    await act(() => setLocale("zh-CN"));
    expect(byLabel("允许通过明文 HTTP 输入 sudo 密码").getAttribute("aria-checked")).toBe("true");
    await act(async () => save("保存").click());
    await flush();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ ...base, allowPlainSudoPassword: true });
    expect(reloadPage).toHaveBeenCalledTimes(1);
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
