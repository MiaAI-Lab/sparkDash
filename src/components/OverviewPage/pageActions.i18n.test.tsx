import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { OverviewPage } from "./OverviewPage";

const spark = {
  id: "spark-1", name: "Spark 1", kind: "spark", online: true, uptime: 1, disabledDevices: [], disabledInterfaces: [], llmPort: 30000, llmPorts: [30000],
  metrics: { storage: [], llm: [], gpu: { vram: { used: 1, total: 2 } } },
} as unknown as SparkSnapshot;

beforeEach(async () => {
  await setLocale("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLocale("en"));
});

it("keeps overview filters and the fleet shutdown guard intact while the locale changes", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<OverviewPage sparks={[spark]} showOverviewSearch kpis={{ decode: false, power: false, memory: false, tokens: false }} showFleetEnergy={false} showLlmTokenTotals={false} showActivityFeed={false} />);

  const query = document.querySelector<HTMLInputElement>('input[aria-label="Search units by name"]')!;
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter units by status"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() => {
    setter.call(query, "Spark");
    query.dispatchEvent(new Event("input", { bubbles: true }));
    select.value = "online";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Shut down all")!.click());
  await flush();
  const phrase = document.querySelector<HTMLInputElement>(".field-input--mono")!;
  await act(() => {
    setter.call(phrase, "poweroff");
    phrase.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  const requestsBeforeLocaleChange = fetchMock.mock.calls.length;

  await act(() => setLocale("zh-CN"));

  expect(document.querySelector("h1")?.textContent).toBe("总览");
  expect(query.value).toBe("Spark");
  expect(select.value).toBe("online");
  expect(phrase.value).toBe("poweroff");
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeLocaleChange);
  await act(() => setLocale("en"));
  expect(document.querySelector("h1")?.textContent).toBe("Overview");
  expect(query.value).toBe("Spark");
  expect(select.value).toBe("online");
  expect(phrase.value).toBe("poweroff");
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('.modal-sheet__footer .btn--danger')?.disabled).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeLocaleChange);
});
