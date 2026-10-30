import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/llmTokenClient", () => ({ fetchLlmTokenTotals: () => new Promise(() => {}) }));

import { FleetKpis, _resetFleetKpiTrends } from "./FleetKpis";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("FleetKpis trend samples", () => {
  beforeEach(() => _resetFleetKpiTrends());

  it("adds a sample per snapshot, not per filtered re-render", () => {
    const snap1 = [makeSpark("a"), makeSpark("b")];
    const { container, root } = render(<FleetKpis sparks={snap1} snapshotKey={snap1} />);
    // One sample so far: nothing to draw.
    expect(container.querySelectorAll("svg").length).toBe(0);
    // Same snapshot, new filtered array (typing in the search box): still one sample.
    act(() => root.render(<FleetKpis sparks={[snap1[0]]} snapshotKey={snap1} />));
    act(() => root.render(<FleetKpis sparks={[snap1[1]]} snapshotKey={snap1} />));
    expect(container.querySelectorAll("svg").length).toBe(0);
    // A new snapshot arrives: second sample, the trends draw.
    const snap2 = [makeSpark("a"), makeSpark("b")];
    act(() => root.render(<FleetKpis sparks={snap2} snapshotKey={snap2} />));
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });
});

describe("FleetKpis power", () => {
  beforeEach(() => _resetFleetKpiTrends());

  it("reads a dash, not 0 W, when no unit reports power", () => {
    const unmeasured = [makeSpark("a"), makeSpark("b")];
    for (const s of unmeasured) s.metrics.gpu!.metricAvailability = { powerDraw: false } as never;
    const { container } = render(<FleetKpis sparks={unmeasured} snapshotKey={unmeasured} show={{ decode: false, memory: false, tokens: false }} />);
    expect(container.querySelector(".big-num")!.textContent).toBe("—W");
  });
});
