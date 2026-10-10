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

  it("labels incomplete rates and omits their aggregate trend", () => {
    const unknown = makeSpark("ollama");
    Object.assign(unknown.metrics.llm[0], { backend: "ollama", liveRatesAvailable: false, generationTps: 0 });
    const { container, root } = render(<FleetKpis sparks={[unknown]} snapshotKey={1} />);
    const decode = () => container.querySelector(".ov-kpi")!;
    expect(decode().querySelector(".big-num")?.textContent).toBe("—tok/s");
    expect(decode().textContent).toContain("Live token rates unavailable");
    expect(decode().querySelector("svg")).toBeNull();
    const measured = makeSpark("vllm");
    act(() => root.render(<FleetKpis sparks={[unknown, measured]} snapshotKey={2} />));
    expect(decode().querySelector(".big-num")?.textContent).toBe("20.0tok/s");
    expect(decode().textContent).toContain("Partial total");
    expect(decode().querySelector("svg")).toBeNull();
    // Complete coverage starts a fresh trend rather than bridging unknown periods.
    act(() => root.render(<FleetKpis sparks={[measured]} snapshotKey={3} />));
    expect(decode().textContent).not.toContain("Partial total");
    expect(decode().textContent).not.toContain("unavailable");
    expect(decode().querySelector("svg")).toBeNull();
    act(() => root.render(<FleetKpis sparks={[measured]} snapshotKey={4} />));
    expect(decode().querySelector("svg")).not.toBeNull();
    act(() => root.render(<FleetKpis sparks={[unknown, measured]} snapshotKey={5} />));
    expect(decode().querySelector("svg")).toBeNull();
  });
});
