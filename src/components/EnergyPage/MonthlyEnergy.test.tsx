import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { MonthlyEnergy } from "./MonthlyEnergy";
import { flush, render } from "../../testing/render";
import type { MonthlyEnergy as MonthlyEnergyData, MonthlyEnergyMonth } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchMonthlyEnergy: vi.fn(),
}));

import { fetchMonthlyEnergy } from "../../api/client";

const fetchMonthly = vi.mocked(fetchMonthlyEnergy);

function month(key: string, nodes: Record<string, number>, over: Partial<MonthlyEnergyMonth> = {}): MonthlyEnergyMonth {
  const [y, m] = key.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, 1);
  const endMs = Date.UTC(y, m, 1);
  return {
    month: key,
    startMs,
    endMs,
    closed: true,
    nodeIds: Object.keys(nodes).sort(),
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, wh]) => [id, { wh, coverageMs: (endMs - startMs) / 2 }])),
    totalWh: Object.values(nodes).reduce((s, v) => s + v, 0),
    fleetWh: 0,
    fleetCoverageMs: (endMs - startMs) / 2,
    outputTokens: 0,
    coveredOutputTokens: 0,
    whPerOutputToken: null,
    ...over,
  };
}

function data(months: MonthlyEnergyMonth[]): MonthlyEnergyData {
  return { estimated: true, generatedAt: Date.UTC(2026, 9, 16, 12), foldedThroughMs: 0, months };
}

const nameOf = (id: string) => `Spark ${id.toUpperCase()}`;

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("MonthlyEnergy", () => {
  it("shows the newest month with per-node figures, including a node that left the fleet", async () => {
    fetchMonthly.mockResolvedValue(
      data([
        month("2026-09", { a: 4000, old: 1000 }),
        month("2026-10", { a: 2000, b: 2000 }, { closed: false, whPerOutputToken: 0.0123 }),
      ])
    );
    const { container } = render(<MonthlyEnergy nameOf={nameOf} price={0.5} currency="$" />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Monthly history");
    expect(text).toContain("will not match a local-time electricity bill");
    expect(text).toContain("Open, still counting");
    expect(text).toContain("4.00 kWh");
    expect(text).toContain("$2.00");
    expect(text).toContain("12.3 Wh / 1k tok");
    expect(text).toContain("Spark B");
    expect(text).not.toContain("Spark OLD");

    choose(container.querySelector('select[aria-label="Month"]')!, "2026-09");
    const september = container.textContent ?? "";
    expect(september).toContain("Spark OLD");
    expect(september).toContain("Closed");
    expect(september).toContain("5.00 kWh");
  });

  it("switches to a year of twelve monthly bars", async () => {
    fetchMonthly.mockResolvedValue(data([month("2026-01", { a: 3000 }), month("2026-10", { a: 1000 })]));
    const { container } = render(<MonthlyEnergy nameOf={nameOf} price={null} currency="$" />);
    await flush();
    const yearButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Year")!;
    act(() => yearButton.click());
    expect(container.textContent).toContain("4.00 kWh in 2026");
    const chart = container.querySelector('svg[aria-label="Energy in kWh per month, 2026"]')!;
    expect(chart).toBeTruthy();
    expect(chart.querySelectorAll("rect[tabindex]")).toHaveLength(12);
    expect(container.querySelector('select[aria-label="Year"]')).toBeTruthy();
  });

  it("explains an empty archive and a failed load", async () => {
    fetchMonthly.mockResolvedValueOnce(data([]));
    const empty = render(<MonthlyEnergy nameOf={nameOf} price={null} currency="$" />);
    await flush();
    expect(empty.container.textContent).toContain("Nothing archived yet");

    fetchMonthly.mockRejectedValueOnce(new Error("boom"));
    const failed = render(<MonthlyEnergy nameOf={nameOf} price={null} currency="$" />);
    await flush();
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toContain("boom");
  });

  it("refetches when the reload token changes, without a new poll", async () => {
    fetchMonthly.mockResolvedValue(data([month("2026-10", { a: 1000 })]));
    const { container, root } = render(<MonthlyEnergy nameOf={nameOf} price={null} currency="$" reloadToken={0} />);
    await flush();
    const calls = fetchMonthly.mock.calls.length;
    fetchMonthly.mockResolvedValue(data([month("2026-10", { a: 9000 })]));
    act(() => root.render(<MonthlyEnergy nameOf={nameOf} price={null} currency="$" reloadToken={1} />));
    await flush();
    expect(fetchMonthly.mock.calls.length).toBe(calls + 1);
    expect(container.textContent).toContain("9.00 kWh");
  });
});
