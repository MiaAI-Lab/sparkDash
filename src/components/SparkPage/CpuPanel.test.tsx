import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import type { CpuMetrics } from "../../api/types";
import { flush, render } from "../../testing/render";
import { CpuPanel } from "./CpuPanel";

beforeEach(async () => {
  localStorage.clear();
  await act(() => setLocale("en"));
});
afterEach(async () => { await act(() => setLocale("en")); });

const SMC_TITLE = "Reading from the AppleSMC key smc, not a CPU die sensor";

function macCpu(over: Partial<CpuMetrics> = {}): CpuMetrics {
  return {
    usage: 12, usageAvailable: true, temperature: 61.5, temperatureSource: "smc",
    draw: 6.5, tdp: 0, unavailable: [], ...over,
  };
}

it("names the AppleSMC key a Mac CPU temperature came from, in both locales", async () => {
  const { container } = render(
    <CpuPanel cpu={macCpu()} sparkId="mac-cpu-smc" temperatureUnit="celsius" mac />
  );
  await flush();
  expect(container.textContent).toContain("61.5");
  expect(container.querySelector(`[title="${SMC_TITLE}"]`)).not.toBeNull();

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector('[title*="AppleSMC 键 smc"]')).not.toBeNull();
  await act(() => setLocale("en"));
});

it("still calls a board thermal zone what it is", async () => {
  const { container } = render(
    <CpuPanel cpu={macCpu({ temperatureSource: "acpitz", temperatureLabel: "ACPI" })} sparkId="mac-cpu-board" temperatureUnit="celsius" />
  );
  await flush();
  expect(container.querySelector('[title*="ACPI/board thermal zone"]')).not.toBeNull();
  expect(container.querySelector(`[title="${SMC_TITLE}"]`)).toBeNull();
});

it("claims no sensor for a temperature that was never read", async () => {
  const { container } = render(
    <CpuPanel
      cpu={macCpu({ temperature: null, temperatureSource: null })}
      sparkId="mac-cpu-none"
      temperatureUnit="celsius"
      mac
      unavailable={[{ metric: "cpu.temperature", reason: "requires root for powermetrics" }]}
    />
  );
  await flush();
  expect(container.querySelector("[title*='AppleSMC']")).toBeNull();
});
