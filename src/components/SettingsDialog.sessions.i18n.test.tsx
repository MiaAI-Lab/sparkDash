import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { flush, render } from "../testing/render";
import { SettingsDialog } from "./SettingsDialog";

const defaults = { pollIntervalMs: 2000, temperatureUnit: "celsius", defaultLlmPort: 8888, autoHideOffline: false, timeZone: "" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((element) => element.textContent?.trim() === text)!;
const ageOptions = (label: string) => [...document.querySelectorAll(`[role="radiogroup"][aria-label="${label}"] [role="radio"]`)]
  .map((element) => element.textContent?.trim());

function mockSettings(settings = defaults) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/sparks")) return json({ sparks: [] });
    if (url.endsWith("/api/settings")) return json(init?.method === "PUT" ? JSON.parse(String(init.body)) : settings);
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  localStorage.clear();
  await setLocale("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLocale("en"));
  localStorage.clear();
});

it("translates all session-age options and opens the same harness setup without saving", async () => {
  const fetchMock = mockSettings();
  const onOpenHarness = vi.fn();
  const onSaved = vi.fn();
  const { container } = render(<SettingsDialog open onClose={() => {}} onSaved={onSaved} onOpenHarness={onOpenHarness} />);
  for (let i = 0; i < 6; i += 1) await flush();
  expect(ageOptions("Session age")).toEqual(["1h", "6h", "12h", "24h", "3d", "7d", "14d"]);
  expect(button("12h").getAttribute("aria-checked")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  const reads = fetchMock.mock.calls.length;

  await act(async () => button("简体中文").click());
  expect(ageOptions("会话时间范围")).toEqual(["1小时", "6小时", "12小时", "24小时", "3天", "7天", "14天"]);
  expect(button("12小时").getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("最长可选 14 天，不提供无限制选项。");
  expect(container.textContent).toContain("Harness 会话");
  expect(container.textContent).toContain("OpenClaw、OpenCode、oh-my-pi、Hermes 和 DeepSeek Harness");
  expect(container.textContent).toContain("仪表盘仅保存辅助服务的地址和令牌。");
  expect(onOpenHarness).not.toHaveBeenCalled();
  await act(async () => button("配置").click());
  expect(onOpenHarness).toHaveBeenCalledTimes(1);
  expect(button("保存").disabled).toBe(true);

  await act(async () => button("English").click());
  expect(ageOptions("Session age")).toEqual(["1h", "6h", "12h", "24h", "3d", "7d", "14d"]);
  expect(container.textContent).toContain("The oldest choice is 14 days. There is no unlimited value.");
  await act(async () => button("Set up").click());
  expect(onOpenHarness).toHaveBeenCalledTimes(2);
  expect(button("Save").disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(reads);
  expect(onSaved).not.toHaveBeenCalled();
});

it("retains a pending session age across languages and saves the millisecond setting once", async () => {
  const initial = { ...defaults, occupancyMaxAgeMs: 6 * 60 * 60 * 1000 };
  const fetchMock = mockSettings(initial);
  const onSaved = vi.fn();
  render(<SettingsDialog open onClose={() => {}} onSaved={onSaved} />);
  for (let i = 0; i < 6; i += 1) await flush();
  expect(button("6h").getAttribute("aria-checked")).toBe("true");
  await act(async () => button("5s").click());
  await act(async () => button("简体中文").click());
  await act(async () => button("14天").click());
  const reads = fetchMock.mock.calls.length;
  await act(async () => button("English").click());
  expect(button("14d").getAttribute("aria-checked")).toBe("true");
  expect(button("5s").getAttribute("aria-checked")).toBe("true");
  expect(fetchMock).toHaveBeenCalledTimes(reads);
  await act(async () => button("Save").click());

  const expected = { ...initial, pollIntervalMs: 5000, occupancyMaxAgeMs: 14 * 24 * 60 * 60 * 1000 };
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toMatch(/\/api\/settings$/);
  expect(writes[0][1]?.method).toBe("PUT");
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual(expected);
  expect(onSaved).toHaveBeenCalledExactlyOnceWith(expected);
});
