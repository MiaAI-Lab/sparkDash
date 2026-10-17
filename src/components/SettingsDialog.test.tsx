import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { i18n, LOCALE_STORAGE_KEY, setLocale } from "../i18n";
import { flush, render } from "../testing/render";

const defaults = { pollIntervalMs: 2000, temperatureUnit: "celsius", defaultLlmPort: 8888, autoHideOffline: false, timeZone: "" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
const title = () => document.querySelector("#settings-title")?.textContent?.trim();

beforeEach(async () => {
  localStorage.clear();
  await setLocale("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLocale("en"));
  localStorage.clear();
});

it("switches the mounted Settings page both ways without saving server settings", async () => {
  const fetchMock = vi.fn(async () => json(defaults));
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn();
  render(<SettingsDialog open onClose={() => {}} onSaved={onSaved} />);
  await flush();
  expect(title()).toBe("Settings");
  expect(button("Save").disabled).toBe(true);
  await act(async () => button("简体中文").click());
  expect(title()).toBe("设置");
  expect(document.querySelector('[aria-label="主题"]')).not.toBeNull();
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  expect(button("保存").disabled).toBe(true);
  await act(async () => button("English").click());
  expect(title()).toBe("Settings");
  expect(document.querySelector('[aria-label="Theme"]')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.length).toBe(1);
});

it("preserves pending settings changes while switching and sends only the original settings fields", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return json(body);
    }
    return json(defaults);
  }));
  const onSaved = vi.fn();
  render(<SettingsDialog open onClose={() => {}} onSaved={onSaved} />);
  await flush();
  act(() => button("5s").click());
  await act(async () => button("简体中文").click());
  expect(button("保存").disabled).toBe(false);
  await act(async () => button("保存").click());
  expect(writes).toEqual([{ ...defaults, pollIntervalMs: 5000 }]);
  expect(onSaved).toHaveBeenCalledWith({ ...defaults, pollIntervalMs: 5000 });
});

it("keeps complete external diagnostics while local validation follows the current language", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...defaults, timeZone: "not/a-zone" })));
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();
  const input = document.querySelector<HTMLInputElement>("#settings-time-zone")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, "still/invalid"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("Save").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain('"still/invalid" is not a known time zone');
  await act(async () => button("简体中文").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("still/invalid");
  expect(document.querySelector(".modal-sheet__error")?.textContent).not.toContain("is not a known time zone");
  await act(() => setLocale("en"));
  expect(i18n.resolvedLanguage).toBe("en");
});

it("retains raw server errors when the language changes", async () => {
  const diagnostic = "upstream connection failed\noriginal detail <raw>";
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: diagnostic }, 503)));
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();
  await act(async () => button("简体中文").click());
  expect(title()).toBe("设置");
  expect(document.querySelector(".modal-sheet__error")?.textContent).toBe(diagnostic);
  expect(document.querySelector(".modal-sheet__error raw")).toBeNull();
});
