import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { i18n, LOCALE_STORAGE_KEY, setLocale } from "../i18n";
import { flush, render } from "../testing/render";

const defaults = { pollIntervalMs: 2000, temperatureUnit: "celsius", defaultLlmPort: 8888, autoHideOffline: false, timeZone: "" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
const title = () => document.querySelector("#settings-title")?.textContent?.trim();
const setInput = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

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
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => json(defaults));
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
  // The dialog may read other status endpoints (e.g. the GPU clock); switching language must never write.
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
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

it("retranslates invalid and credential MQTT validation without leaking credentials or writing", async () => {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => json(defaults));
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();

  const mqttUrl = document.querySelector<HTMLInputElement>("#settings-mqtt-url")!;
  setInput(mqttUrl, "https://not-a-broker.example");
  await act(async () => button("Save").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("not a broker URL");
  await act(async () => button("简体中文").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("不是 MQTT 服务器地址");
  setInput(mqttUrl, "mqtt://alice:secret@broker.example:1883");
  await act(async () => button("保存").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("请移除服务器地址中的用户名和密码");
  expect(document.querySelector(".modal-sheet__error")?.textContent).not.toContain("secret");
  await act(async () => button("English").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("Remove the user name and password");
  // Even an unsupported scheme must not echo the credentials in the URL error.
  setInput(mqttUrl, "https://alice:secret@broker.example");
  await act(async () => button("Save").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("Remove the user name and password");
  expect(document.querySelector(".modal-sheet__error")?.textContent).not.toContain("secret");
  await act(async () => button("简体中文").click());
  expect(document.querySelector(".modal-sheet__error")?.textContent).toContain("请移除服务器地址中的用户名和密码");
  expect(document.querySelector(".modal-sheet__error")?.textContent).not.toContain("secret");
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("keeps pending MQTT and GPU choices through a round trip and saves their original payload once", async () => {
  const initial = {
    ...defaults,
    mqttEnabled: true,
    mqttUrl: "mqtt://broker.example:1883",
    mqttUsername: "alice",
    mqttTopicPrefix: "lab/sparkdash",
  };
  const writes: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/gpu-clock-all")) {
      return json({ success: true, applied: 1, results: [{ id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" }] });
    }
    if (url.includes("/gpu-clock")) {
      return json({ supported: true, hwMaxMHz: 3003, capMHz: 2100, sudo: "yes", persistKind: "unit", service: { installed: false, clocks: null, enabled: null, active: null }, cron: { installed: false, clocks: null, failed: false } });
    }
    if (url.endsWith("/api/sparks")) return json({ sparks: [{ id: "spark1", kind: "spark" }] });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return json(body);
    }
    return json(initial);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  for (let i = 0; i < 6; i += 1) await flush();

  setInput(document.querySelector<HTMLInputElement>("#settings-mqtt-prefix")!, "lab/changed");
  await act(async () => button("1800 MHz").click());
  const persistence = document.querySelector<HTMLInputElement>(".gpu-clock__check input")!;
  await act(async () => persistence.click());
  const callsBeforeLocale = fetchMock.mock.calls.length;
  await act(async () => button("简体中文").click());
  expect(document.querySelector('label[for="settings-mqtt-url"]')?.textContent).toBe("MQTT 服务器地址");
  expect(document.querySelector<HTMLInputElement>("#settings-mqtt-username")!.placeholder).toBe("留空");
  expect(document.querySelector<HTMLInputElement>("#settings-mqtt-prefix")!.value).toBe("lab/changed");
  expect(button("1800 MHz").className).toContain("is-picked");
  expect(persistence.checked).toBe(false);
  await act(async () => button("English").click());
  expect(fetchMock).toHaveBeenCalledTimes(callsBeforeLocale);
  await act(async () => button("Save").click());

  expect(writes).toEqual([{ ...initial, mqttTopicPrefix: "lab/changed" }]);
  const clockWrites = fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/gpu-clock-all") && init?.method === "POST");
  expect(clockWrites).toHaveLength(1);
  expect(JSON.parse(String(clockWrites[0][1]?.body))).toEqual({ maxMHz: 1800, persist: false });
});
