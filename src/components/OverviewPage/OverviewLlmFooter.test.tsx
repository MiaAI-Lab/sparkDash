import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A plain stub, not vi.fn(): vi.fn tracks a rejected promise it returns and
// reports it as unhandled even when the caller catches it.
const telemetry = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (() => Promise.resolve({ points: [] })) as (...a: unknown[]) => Promise<unknown>,
}));
import type { LlmMetrics, LlmTelemetryPoint, LlmTelemetryResponse } from "../../api/types";
import { flush, render } from "../../testing/render";

vi.mock("../../api/llmTelemetryClient", () => ({
  fetchLlmTelemetry: (...a: unknown[]) => {
    telemetry.calls.push(a);
    return telemetry.impl(...a);
  },
}));

import { OverviewLlmFooter } from "./OverviewLlmFooter";

const llm = {
  backend: "vllm",
  status: "active",
  available: true,
  modelId: "model-a",
  slotsActive: 0,
  slotsTotal: 0,
  generationTps: 77,
  prefillTps: null,
  requestsRunning: 4,
  requestsWaiting: 1,
} as unknown as LlmMetrics;

/** Buckets old enough that the newest one has closed, whatever `Date.now()` says. */
function hourOf(points: Partial<LlmTelemetryPoint>[], over: Partial<LlmTelemetryResponse> = {}) {
  const now = Date.now();
  const series = points.map((p, i) => ({
    t: now - (points.length - i + 1) * 10_000,
    available: true,
    backend: "vllm",
    generationTps: null,
    prefillTps: null,
    ...p,
  }));
  return {
    sparkId: "john",
    port: 8888,
    modelId: "model-a",
    bucketSeconds: 10,
    retentionHours: 168,
    since: null,
    nextSince: series.length ? series[series.length - 1].t : null,
    points: series,
    ...over,
  };
}

describe("OverviewLlmFooter", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    telemetry.calls = [];
    telemetry.impl = () => Promise.resolve(hourOf([]));
  });

  it("reads the hour for the card's own port and model, then shows medians, live load and peak", async () => {
    telemetry.impl = () =>
      Promise.resolve(
        hourOf([
          { generationTps: 0, requestsRunning: 0 },
          { generationTps: 50, prefillTps: 400, requestsRunning: 6 },
          { generationTps: 60, prefillTps: 500, requestsRunning: 3 },
          { generationTps: 40, prefillTps: 450, requestsRunning: 2 },
        ])
      );
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    await flush();
    // The read names the served model, so an earlier model's points never mix in.
    expect(telemetry.calls).toEqual([["john", 8888, 1, { modelId: "model-a", since: null }]]);
    const text = container.textContent ?? "";
    expect(text).toContain("77.0tok/s");
    expect(text).toContain("1h decode 50 tok/s");
    expect(text).toContain("prefill 450 tok/s");
    expect(text).toContain("4 running");
    expect(text).toContain("1 queued");
    expect(text).toContain("peak 6");
    expect(text).toContain("3 busy samples");
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("leaves the still-open newest bucket out of the medians and the peak", async () => {
    const now = Date.now();
    telemetry.impl = () =>
      Promise.resolve(
        hourOf([
          { t: now - 30_000, generationTps: 40, requestsRunning: 2 },
          { t: now - 20_000, generationTps: 60, requestsRunning: 3 },
          // Open: its rate covers only part of the bucket.
          { t: now - 2_000, generationTps: 900, requestsRunning: 90 },
        ])
      );
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("1h decode 50 tok/s");
    expect(text).toContain("peak 3");
    expect(text).not.toContain("900");
    expect(text).not.toContain("peak 90");
    // The sparkline still draws the open bucket, so the shape is current.
    expect(container.querySelectorAll("svg circle")).toHaveLength(3);
  });

  it("continues from the cursor on the next poll instead of refetching the hour", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = hourOf([{ t: now - 30_000, generationTps: 40 }, { t: now - 20_000, generationTps: 60 }]);
    telemetry.impl = () => Promise.resolve(first);
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    await flush();
    expect(container.textContent).toContain("1h decode 50 tok/s");

    const nextAt = first.points[first.points.length - 1].t + 10_000;
    telemetry.impl = () =>
      Promise.resolve(hourOf([{ t: nextAt, generationTps: 100, prefillTps: 200 }], { since: first.nextSince }));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(telemetry.calls[1]).toEqual([
      "john",
      8888,
      1,
      { modelId: "model-a", since: first.nextSince },
    ]);
    // Two points plus the one new bucket.
    expect(container.textContent).toContain("1h decode 60 tok/s");
    expect(container.textContent).toContain("prefill 200 tok/s");
    expect(container.textContent).toContain("3 busy samples");
  });

  it("reports no decode observations without claiming the hour was idle", async () => {
    telemetry.impl = () => Promise.resolve(hourOf([{ generationTps: 0 }, { generationTps: 0 }]));
    const { container } = render(
      <OverviewLlmFooter
        sparkId="mama"
        port={30000}
        llm={{ ...llm, generationTps: 0, requestsRunning: 0, requestsWaiting: 0 }}
      />
    );
    await flush();
    expect(container.textContent).toContain("no decode in the last hour");
    expect(container.textContent).toContain("1h decode — tok/s");
    expect(container.querySelector("svg path")).toBeNull();
  });

  it("says there is no data, not idle, for an engine that never answered this hour", async () => {
    telemetry.impl = () =>
      Promise.resolve(hourOf([{ available: false }, { available: false }]));
    const { container } = render(
      <OverviewLlmFooter
        sparkId="mbp"
        port={8200}
        llm={{
          ...llm,
          measurementValid: false,
          generationTps: 0,
          requestsRunning: null,
          requestsWaiting: null,
        }}
      />
    );
    await flush();
    expect(container.textContent).toContain("1h decode — tok/s");
    expect(container.textContent).toContain("engine did not answer this hour");
    expect(container.textContent).not.toContain("idle");
  });

  it("shows unknown history, not zero, when the telemetry read fails or is pending", async () => {
    telemetry.impl = () => Promise.reject(new Error("offline"));
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    expect(container.textContent).toContain("reading the last hour…");
    await flush();
    expect(container.textContent).toContain("1h decode — tok/s");
    expect(container.textContent).toContain("prefill — tok/s");
    expect(container.textContent).toContain("reading the last hour…");
  });

  it("shows unknown live rates, not zeros, when the engine's stats could not be read", async () => {
    const { container } = render(
      <OverviewLlmFooter
        sparkId="john"
        port={8888}
        llm={{ ...llm, generationTps: 0, prefillTps: 0, measurementValid: false }}
      />
    );
    await flush();
    expect(container.textContent).toMatch(/Decode—/);
    expect(container.textContent).toMatch(/Prefill—/);
  });

  it("says a prompt is prefilling when the engine reports no live prefill rate", async () => {
    const { container } = render(
      <OverviewLlmFooter
        sparkId="john"
        port={8888}
        llm={{ ...llm, prefillTps: 0, prefillActive: true }}
      />
    );
    await flush();
    expect(container.textContent).toContain("prefilling");
  });

  it("reports requests unknown instead of zero for an engine that counts nothing", async () => {
    telemetry.impl = () => Promise.resolve(hourOf([]));
    const { container } = render(
      <OverviewLlmFooter
        sparkId="john"
        port={8888}
        llm={{ ...llm, requestsRunning: null, requestsWaiting: null, slotsTotal: 0, slotsActive: 0 }}
      />
    );
    await flush();
    expect(container.textContent).toContain("Requests—");
  });

  it("skips the history read when the card has no port", async () => {
    render(<OverviewLlmFooter sparkId="john" port={null} llm={llm} />);
    await flush();
    expect(telemetry.calls).toEqual([]);
  });

  it("labels prefill-only and missing history without claiming idle", async () => {
    telemetry.impl = () => Promise.resolve(hourOf([{ generationTps: 0, prefillTps: 1000 }]));
    const { container, root } = render(
      <OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />
    );
    await flush();
    expect(container.textContent).toContain("no decode in the last hour");
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("no decode");
    act(() =>
      root.render(<OverviewLlmFooter sparkId="fixture" port={null} llm={llm} />)
    );
    await flush();
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("no samples");
  });

  it("reports closed samples rather than invented minutes and renders sparse observations", async () => {    const now = Date.now();
    telemetry.impl = () =>
      Promise.resolve(
        hourOf(
          // Every sample closed and inside the hour, so all sixty count.
          Array.from({ length: 60 }, (_, i) => ({
            t: now - 60 * 60_000 + 10_000 + i * 60_000,
            generationTps: 50,
          }))
        )
      );
    const { container } = render(<OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />);
    await flush();
    expect(container.textContent).toContain("60 busy samples");
    expect(container.textContent).not.toContain("m busy");
    expect(container.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(59);
  });

  it.each(["resolve", "reject"])(
    "a superseded %s cannot overwrite a newer history response",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
        telemetry.impl = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
        const { container } = render(
          <OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />
        );
        act(() => {
          vi.advanceTimersByTime(30_000);
        });
        pending[1].resolve(hourOf([{ generationTps: 30 }]));
        await flush();
        expect(container.textContent).toContain("1h decode 30 tok/s");
        if (outcome === "resolve") pending[0].resolve(hourOf([{ generationTps: 999 }]));
        else pending[0].reject(new Error("superseded failure"));
        await flush();
        expect(container.textContent).toContain("1h decode 30 tok/s");
        expect(container.textContent).not.toContain("999");
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
