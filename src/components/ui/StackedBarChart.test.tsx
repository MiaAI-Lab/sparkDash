import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { StackedBarChart, type BarBucket } from "./StackedBarChart";
import { render } from "../../testing/render";

vi.mock("./useElementWidth", () => ({ useElementWidth: () => [() => undefined, 400] }));

const buckets: BarBucket[] = [0, 1, 2].map((i) => ({ key: String(i), label: `${i}:00`, title: `Hour ${i}`, values: { a: [1, 2, 1.5][i] } }));
const series = [{ id: "a", label: "A", color: "red" }];

describe("StackedBarChart line", () => {
  it("draws no line or right axis without one", () => {
    const { container } = render(<StackedBarChart buckets={buckets} series={series} format={String} ariaLabel="energy" />);
    expect(container.querySelectorAll("path")).toHaveLength(0);
    expect([...container.querySelectorAll("text")].some((t) => t.textContent?.startsWith("$"))).toBe(false);
  });

  it("draws the line on its own right-hand axis, with a gap for a missing value, and lists it on hover", () => {
    const { container } = render(
      <StackedBarChart
        buckets={buckets}
        series={series}
        format={String}
        unit="kWh"
        ariaLabel="energy"
        line={{ label: "Cost", color: "gold", values: [0.3, 0.6, null], format: (v) => `$${v.toFixed(2)}`, detail: (i) => `Price ${i}` }}
      />
    );
    expect(container.querySelectorAll("path")).toHaveLength(1);
    const rightTicks = [...container.querySelectorAll("text")].filter((t) => t.getAttribute("text-anchor") === "start");
    expect(rightTicks.length).toBeGreaterThan(1);
    expect(rightTicks.every((t) => t.textContent?.startsWith("$"))).toBe(true);
    const hit = container.querySelectorAll("rect[tabindex]")[1] as SVGRectElement;
    act(() => hit.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    const tip = container.querySelector(".chart__tip")!;
    expect(tip.textContent).toContain("Cost$0.60");
    expect(tip.textContent).toContain("Price 1");
  });
});