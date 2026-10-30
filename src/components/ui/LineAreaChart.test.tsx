import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { LineAreaChart, type LinePoint } from "./LineAreaChart";
import { render } from "../../testing/render";

vi.mock("./useElementWidth", () => ({ useElementWidth: () => [() => undefined, 400] }));

const points: LinePoint[] = [0, 1, 2].map((i) => ({ key: String(i), label: `${i}:00`, title: `Hour ${i}`, value: [100, 120, null][i] }));

describe("LineAreaChart overlays", () => {
  it("draws no extra lines without overlays", () => {
    const { container } = render(<LineAreaChart points={points} format={(v) => String(v)} ariaLabel="power" />);
    // One run of two points: an area path and its line.
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });

  it("draws each overlay as a line with gaps, scales to it and lists it on hover", () => {
    const { container } = render(
      <LineAreaChart
        points={points}
        format={(v) => String(Math.round(v))}
        unit="W"
        ariaLabel="power"
        overlays={[
          { id: "gpu", label: "GPU", color: "red", values: [40, 60, 300] },
          { id: "cpu", label: "CPU", color: "grey", values: [80, null, 90] },
        ]}
      />
    );
    const paths = [...container.querySelectorAll("path")];
    expect(paths.filter((p) => p.getAttribute("stroke") === "red")).toHaveLength(1);
    // The CPU line has a gap in the middle: two lone points, no path.
    expect(paths.filter((p) => p.getAttribute("stroke") === "grey")).toHaveLength(0);
    expect(container.querySelectorAll('circle[fill="grey"]')).toHaveLength(2);
    // The axis grows to fit the 300 W overlay point.
    const ticks = [...container.querySelectorAll(".chart__tick")].map((t) => Number(t.textContent)).filter(Number.isFinite);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(300);

    const target = container.querySelector('rect[aria-label="Hour 1: 120"]')!;
    act(() => {
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tip = container.querySelector(".chart__tip")!;
    expect(tip.textContent).toContain("GPU: 60 W");
    expect(tip.textContent).toContain("CPU: —");
  });
});
