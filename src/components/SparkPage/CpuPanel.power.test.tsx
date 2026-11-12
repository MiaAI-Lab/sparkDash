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

function macCpu(over: Partial<CpuMetrics> = {}): CpuMetrics {
  return {
    usage: 4, usageAvailable: true, temperature: 30, draw: 0.4, tdp: 0, unavailable: [], ...over,
  };
}

const NOT_REPORTED = "cpu.power is not reported by this platform";

it("shows a Mac CPU power of zero as the zero it measured", async () => {
  // powermetrics reports 0 mW for an idle rail, and the GPU tile next to this
  // one already prints 0 W. Claiming the platform cannot report it contradicts
  // the collector, which only answers null when a rail really did not reply.
  const { container } = render(
    <CpuPanel cpu={macCpu({ draw: 0 })} sparkId="mac-cpu-zero" temperatureUnit="celsius" mac />
  );
  await flush();
  expect(container.textContent).toContain("0W");
  expect(container.querySelector(`[title="${NOT_REPORTED}"]`)).toBeNull();
});

it("falls back to unavailable when the collector had no CPU power at all", async () => {
  const { container } = render(
    <CpuPanel cpu={macCpu({ draw: null })} sparkId="mac-cpu-null" temperatureUnit="celsius" mac />
  );
  await flush();
  expect(container.textContent).toContain("unavailable");
  expect(container.querySelector(`[title="${NOT_REPORTED}"]`)).not.toBeNull();
});

it("prefers the reason the node gave for the gap", async () => {
  const { container } = render(
    <CpuPanel
      cpu={macCpu({ draw: null, unavailable: null })}
      sparkId="mac-cpu-gap"
      temperatureUnit="celsius"
      mac
      unavailable={[{ metric: "cpu.power", reason: "powermetrics requires root" }]}
    />
  );
  await flush();
  expect(container.querySelector("[title='powermetrics requires root']")).not.toBeNull();
});
