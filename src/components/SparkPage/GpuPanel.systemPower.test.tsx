import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import type { GpuMetrics } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { GpuPanel } from "./GpuPanel";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(() => Promise.resolve({ t: [], u: [], c: [], p: [] })),
}));

beforeEach(async () => {
  localStorage.clear();
  await act(() => setLocale("en"));
});
afterEach(async () => { await act(() => setLocale("en")); });

const ESTIMATE_HELP = "Adds Apple's published idle draw";

function macGpu(power: GpuMetrics["power"]): GpuMetrics {
  return { ...makeSpark().metrics.gpu!, temperature: 30, power };
}

it("names the published idle figure inside a Mac desktop's system total", async () => {
  // powermetrics answers for three rails, so anything above them is modelled.
  const { container } = render(
    <GpuPanel
      gpu={macGpu({ draw: 0, limit: 0, systemDraw: 7.2, systemPowerSource: "apple-idle" })}
      sparkId="gpu-system-estimate"
      temperatureUnit="celsius"
      chip="Apple M5 Max"
    />
  );
  await flush();
  expect(container.textContent).toContain("System ≈ 7.2 W");
  expect(container.querySelector(`[title^="${ESTIMATE_HELP}"]`)).not.toBeNull();

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector("[title*='待机功耗']")).not.toBeNull();
  await act(() => setLocale("en"));
});

it("claims no estimate for a total the rails measured themselves", async () => {
  const { container } = render(
    <GpuPanel
      gpu={macGpu({ draw: 60, limit: 0, systemDraw: 81, systemPowerSource: "powermetrics" })}
      sparkId="gpu-system-measured"
      temperatureUnit="celsius"
      chip="Apple M5 Max"
    />
  );
  await flush();
  expect(container.textContent).toContain("System ≈ 81 W");
  expect(container.querySelector(`[title^="${ESTIMATE_HELP}"]`)).toBeNull();
});
