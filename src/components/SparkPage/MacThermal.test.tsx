import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { CpuPanel } from "./CpuPanel";
import { GpuPanel } from "./GpuPanel";

const reason = "requires root for powermetrics";
const unavailable = ["cpu.temperature", "gpu.temperature"].map(metric => ({ metric, reason }));

describe("Mac thermal reporting", () => {
  for (const unit of ["celsius", "fahrenheit"] as const) {
    for (const value of [null, undefined, 0]) {
      it(`shows a reason rather than a temperature for legacy/missing ${value} in ${unit}`, () => {
        const base = makeSpark("mac", true).metrics;
        const { container } = render(<>
          <CpuPanel cpu={{ ...base.cpu!, temperature: value } as never} mac sparkId="mac" temperatureUnit={unit} unavailable={unavailable} />
          <GpuPanel gpu={{ ...base.gpu!, temperature: value, thermalPressure: "slow", thermal: { pressureState: "slow", lastRecordedEvents: ["Thermal Warning Level = 100"], source: "pmset -g therm" } } as never} mac sparkId="mac" temperatureUnit={unit} unavailable={unavailable} />
        </>);
        expect(container.textContent?.match(/unavailable: requires root for powermetrics/g)).toHaveLength(2);
        expect(container.textContent).not.toMatch(/0°C|32°F/);
        expect(container.textContent).toContain("slow");
        expect(container.querySelector('[title="Thermal Warning Level = 100"]')).not.toBeNull();
      });
    }
  }
  it("does not invent a missing legacy-agent temperature even without declared gaps", () => {
    const { container } = render(<CpuPanel cpu={null} mac sparkId="mac" temperatureUnit="celsius" />);
    expect(container.textContent).toContain("unavailable: cpu.temperature is not reported by this platform");
    expect(container.textContent).not.toContain("0°C");
  });
  it("shows a privileged Mac temperature instead of the unavailable reason", () => {
    const base = makeSpark("mac", true).metrics;
    const { container } = render(<><CpuPanel cpu={{ ...base.cpu!, temperature: 46.2 }} mac sparkId="mac" temperatureUnit="celsius" unavailable={[]} />
      <GpuPanel gpu={{ ...base.gpu!, temperature: 42.1, thermalPressure: "nominal", thermal: { pressureState: "nominal", lastRecordedEvents: [], source: "pmset -g therm" } }} mac sparkId="mac" temperatureUnit="celsius" unavailable={[]} />
    </>);
    expect(container.textContent).toContain("46.2°C");
    expect(container.textContent).toContain("42.1°C");
    expect(container.textContent).not.toContain("requires root for powermetrics");
    expect(container.textContent).toContain("nominal");
  });
  it("preserves measured DGX temperatures", () => {
    const base = makeSpark("dgx", true).metrics;
    const { container } = render(<>
      <CpuPanel cpu={base.cpu} sparkId="dgx" temperatureUnit="celsius" />
      <GpuPanel gpu={base.gpu} sparkId="dgx" temperatureUnit="celsius" />
    </>);
    expect(container.textContent).toContain("45°C");
    expect(container.textContent).toContain("55°C");
    expect(container.textContent).not.toContain("unavailable");
  });
});

it("keeps unavailable non-Mac GPU readings unknown and retains measured partial fields", () => {
  const gpu = makeSpark("fixture").metrics.gpu!;
  const flags = { temperature: false, usage: false, powerDraw: false, powerLimit: false, vramUsed: false, vramTotal: false };
  const { container } = render(<GpuPanel gpu={{ ...gpu, temperature: 0, usage: 0, power: { draw: 0, limit: 0 }, metricAvailability: flags }} sparkId="fixture" temperatureUnit="celsius" />);
  expect(container.textContent).not.toContain("0°C");
  expect(container.textContent).not.toContain("Normal");
  expect(container.textContent).not.toContain("0%");
  const partial = render(<GpuPanel gpu={{ ...gpu, metricAvailability: { ...flags, powerDraw: true } }} sparkId="partial" temperatureUnit="celsius" />);
  expect(partial.container.textContent).toContain("50W");
  expect(partial.container.textContent).not.toContain("100 W");
});

it("uses each fresh sensor sample's availability instead of older runtime-poll gaps", () => {
  const base = makeSpark("fixture").metrics;
  const old = [{ metric: "gpu.temperature", reason: "old gap" }, { metric: "cpu.temperature", reason: "old gap" }];
  const { container } = render(<>
    <GpuPanel gpu={{ ...base.gpu!, temperature: 42.1, unavailable: [] }} mac sparkId="fixture" temperatureUnit="celsius" unavailable={old} />
    <CpuPanel cpu={{ ...base.cpu!, temperature: 46.2, unavailable: [] }} mac sparkId="fixture" temperatureUnit="celsius" unavailable={old} />
  </>);
  expect(container.textContent).toContain("42.1°C");
  expect(container.textContent).toContain("46.2°C");
  expect(container.textContent).not.toContain("old gap");
});
