/**
 * Honest-visuals acceptance suite — Phase 7 (AT-3, AT-4, AT-7, AT-8, AT-15).
 *
 * Widget-level tests with exact-count/exact-string assertions. Idle behaviour
 * uses vitest fake timers (SpeedGauge's rAF loop is timer-driven under them).
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMetrics } from "../../api/types";
import { SpeedGauge } from "./SpeedGauge";
import { Sparkline } from "./Sparkline";
import { ServingLanes } from "../SparkPage/ServingLanes";
import { DISPLAY, displayNodeName, fmtSeconds } from "../../config/display.js";
import { render } from "../../testing/render";

function makeLlm(overrides: Partial<LlmMetrics> = {}): LlmMetrics {
  return {
    available: true,
    backend: "vllm",
    modelId: "fixture-model",
    modelPath: null,
    contextLength: null,
    gpuMemoryUtilization: null,
    slotsActive: 0,
    slotsTotal: 0,
    generationTps: 20,
    prefillTps: 200,
    totalOutputTokens: 0,
    error: null,
    ttftP95Seconds: null,
    kvCacheUsage: null,
    requestsRunning: null,
    requestsWaiting: null,
    prefixCacheHitRate: null,
    ...overrides,
  };
}

describe("AT-3 zero is a value, not a state (Addendum E)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("value 0 renders at full opacity — no idle dimming, no 'idle' overlay, zero coloured zones", () => {
    vi.useFakeTimers();
    const { container, root } = render(<SpeedGauge label="Generation" value={0} max={500} />);

    // Before any rAF frame…
    expect(container.textContent).not.toContain("idle");
    let wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toContain("opacity-40");

    // …and after any amount of idle time: full opacity (Operator decision,
    // Addendum E — the needle at 0 is the signal, greying out hid it).
    act(() => {
      vi.advanceTimersByTime(DISPLAY.IDLE_AFTER_S * 1000 + 1000);
    });
    expect(container.textContent).not.toContain("idle");
    wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).not.toContain("opacity-40");

    // No coloured zone arcs anywhere on the dial (segments are neutral).
    expect(
      container.querySelectorAll(
        'path[fill="var(--color-success)"], path[fill="var(--color-danger)"], path[fill="var(--color-warning)"]'
      )
    ).toHaveLength(0);

    act(() => root.unmount());
  });
});

describe("AT-4 fixed sparkline domains (I-1)", () => {
  // Mirror of Sparkline's internal yFor — the fixed-domain mapping under test.
  const yFor = (v: number, lo: number, hi: number, height: number, pad: number) => {
    const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
    return height - pad - frac * (height - pad * 2);
  };
  const expectedPoints = (data: number[], domain: readonly [number, number]) => {
    const [lo, hi] = domain;
    const width = 84;
    const height = 24;
    const pad = 1.5;
    return data
      .map((v, i) => `${(i / (data.length - 1)) * width},${yFor(v, lo, hi, height, pad)}`)
      .join(" ");
  };

  it("maps data through the FIXED domain — geometry is data-independent-normalised", () => {
    const domain = DISPLAY.TEMP_DOMAIN_C; // [20, 95]
    expect(domain).toEqual([20, 95]);

    const low = render(<Sparkline data={[30, 31]} domain={domain} />);
    const high = render(<Sparkline data={[94, 95]} domain={domain} />);
    const lowLine = low.container.querySelector("polyline");
    const highLine = high.container.querySelector("polyline");
    expect(lowLine?.getAttribute("points")).toBe(expectedPoints([30, 31], domain));
    expect(highLine?.getAttribute("points")).toBe(expectedPoints([94, 95], domain));

    // The decisive assertion: an auto-scaling sparkline would render these two
    // datasets with IDENTICAL normalised geometry; a fixed domain must not.
    expect(lowLine?.getAttribute("points")).not.toBe(highLine?.getAttribute("points"));
  });

  it("clamps out-of-domain values at the domain edges", () => {
    const domain: readonly [number, number] = [20, 95];
    const { container } = render(<Sparkline data={[10, 100]} domain={domain} />);
    // 10 °C clamps to the lo edge (y = 22.5), 100 °C to the hi edge (y = 1.5).
    expect(container.querySelector("polyline")?.getAttribute("points")).toBe(
      expectedPoints([10, 100], domain)
    );
    const pts = container.querySelector("polyline")!.getAttribute("points")!;
    const [, yLo] = pts.split(" ")[0].split(",").map(Number);
    const [, yHi] = pts.split(" ")[1].split(",").map(Number);
    expect(yLo).toBe(22.5);
    expect(yHi).toBe(1.5);
  });
});

describe("AT-7 aggregate windows are labelled (§5.5)", () => {
  it("TTFT p95 carries its '· 15m' window; a null window renders '—'", () => {
    const { container } = render(
      <ServingLanes llm={makeLlm({ ttftP95Seconds: 0.42 })} maxNumSeqs={4} />
    );
    const label = [...container.querySelectorAll("div")].find(
      (d) => d.textContent === `TTFT p95 · ${DISPLAY.AGG_WINDOW_S / 60}m`
    );
    expect(label).toBeDefined();
    expect(DISPLAY.AGG_WINDOW_S / 60).toBe(15);
    // Sub-second TTFT renders in ms (0.42 s → "420ms").
    expect(label?.parentElement?.children[1].textContent).toBe("420ms");

    const empty = render(<ServingLanes llm={makeLlm({ ttftP95Seconds: null })} maxNumSeqs={4} />);
    const emptyLabel = [...empty.container.querySelectorAll("div")].find(
      (d) => d.textContent === "TTFT p95 · 15m"
    );
    expect(emptyLabel?.parentElement?.children[1].textContent).toBe("—");
  });
});

describe("C.7 Est. Wait chrome (I-3/I-4)", () => {
  it("warning tint only when a real estimate renders; '—' is neutral chrome", () => {
    const live = render(
      <ServingLanes
        llm={makeLlm({ requestsRunning: 4, requestsWaiting: 2, avgDecodeSeconds: 3 })}
        maxNumSeqs={6}
      />
    );
    const liveLabel = [...live.container.querySelectorAll("span")].find(
      (s) => s.textContent === "Est. Wait"
    );
    const liveRow = liveLabel?.parentElement as HTMLElement;
    expect(liveRow.className).toContain("border-warning/20");
    expect(liveRow.className).toContain("bg-warning/5");
    expect(liveRow.textContent).toContain("~6.0s"); // 2 waiting × 3 s decode
    expect(liveRow.title).toContain("queue depth × mean decode of completed requests, last 15 m");

    const dead = render(
      <ServingLanes
        llm={makeLlm({ requestsRunning: 4, requestsWaiting: 0, avgDecodeSeconds: null })}
        maxNumSeqs={6}
      />
    );
    const deadLabel = [...dead.container.querySelectorAll("span")].find(
      (s) => s.textContent === "Est. Wait"
    );
    const deadRow = deadLabel?.parentElement as HTMLElement;
    expect(deadRow.className).not.toContain("border-warning");
    expect(deadRow.className).not.toContain("bg-warning");
    expect(deadRow.className).toContain("border-border");
    expect(deadRow.textContent).toContain("—");
  });
});

describe("AT-8 precision (§5.7)", () => {
  it("latency aggregates render at 1 decimal — never 2+", () => {
    // ServingLanes renders seconds ≥ 1 through the same 1-decimal rule.
    const { container } = render(
      <ServingLanes llm={makeLlm({ ttftP95Seconds: 1.382 })} maxNumSeqs={4} />
    );
    const label = [...container.querySelectorAll("div")].find(
      (d) => d.textContent === "TTFT p95 · 15m"
    );
    const value = label?.parentElement?.children[1].textContent ?? "";
    expect(value).toMatch(/^\d+\.\ds$/); // "1.4s"

    // Whole-container scan: any number with ≥2 decimals is a violation.
    const twoPlus = container.textContent?.match(/\d+\.\d{2,}/g);
    expect(twoPlus ?? []).toHaveLength(0);

    // Sub-second via the shared formatter: 0.382 → "0.4s" (1 decimal).
    expect(fmtSeconds(0.382)).toBe("0.4s");
    expect(fmtSeconds(0.382)).toMatch(/^\d+\.\ds$/);
  });
});

describe("AT-15 node-name display convention (§5.4)", () => {
  it("normalises the gxN pattern and passes everything else through", () => {
    expect(displayNodeName("gx10")).toBe("GX10");
    expect(displayNodeName("gx-12")).toBe("GX12");
    expect(displayNodeName("GX_3")).toBe("GX3");
    expect(displayNodeName("Spark 1")).toBe("Spark 1");
    expect(displayNodeName("rack-b-node-2")).toBe("rack-b-node-2");
  });
});
