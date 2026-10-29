import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A plain stub, not vi.fn(): vi.fn tracks a rejected promise it returns and
// reports it as unhandled even when the caller catches it.
const telemetry = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (() => Promise.resolve({ points: [] })) as (...a: unknown[]) => Promise<unknown>,
}));
import type { LlmMetrics, LlmTelemetryPoint } from "../../api/types";
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
  slotsActive: 0,
  slotsTotal: 0,
  generationTps: 77,
  prefillTps: null,
  requestsRunning: 4,
  requestsWaiting: 1,
} as unknown as LlmMetrics;

function hourOf(points: Partial<LlmTelemetryPoint>[]) {
  const now = Date.now();
  return {
    points: points.map((p, i) => ({ t: now - (points.length - i) * 10_000, available: true, backend: "vllm", generationTps: null, prefillTps: null, ...p })),
  };
}

describe("OverviewLlmFooter", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    telemetry.calls = [];
    telemetry.impl = () => Promise.resolve({ points: [] });
  });

  it("reads the hour for the card's own port and shows medians, live load and peak", async () => {
    const hour = hourOf([
        { generationTps: 0, requestsRunning: 0 },
        { generationTps: 50, prefillTps: 400, requestsRunning: 6 },
        { generationTps: 60, prefillTps: 500, requestsRunning: 3 },
        { generationTps: 40, prefillTps: 450, requestsRunning: 2 },
      ]);
    telemetry.impl = () => Promise.resolve(hour);
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    await flush();
    expect(telemetry.calls).toEqual([["john", 8888, 1]]);
    const text = container.textContent ?? "";
    expect(text).toContain("77 tok/s");
    expect(text).toContain("p50 50");
    expect(text).toContain("p50 450");
    expect(text).toContain("4 running · 1 queued · peak 6");
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("reports no decode observations without claiming the hour was idle", async () => {
    const idle = hourOf([{ generationTps: 0 }, { generationTps: 0 }]);
    telemetry.impl = () => Promise.resolve(idle);
    const { container } = render(
      <OverviewLlmFooter sparkId="mama" port={30000} llm={{ ...llm, generationTps: 0, requestsRunning: 0, requestsWaiting: 0 }} />
    );
    await flush();
    expect(container.textContent).toContain("no decode observed");
    expect(container.textContent).toContain("p50 —");
    expect(container.querySelector("svg path")).toBeNull();
  });

  it("says there is no data, not idle, for an engine that never answered this hour", async () => {
    const down = hourOf([{ available: false }, { available: false }]);
    telemetry.impl = () => Promise.resolve(down);
    const { container } = render(
      <OverviewLlmFooter sparkId="mbp" port={8200} llm={{ ...llm, measurementValid: false, generationTps: 0, requestsRunning: null, requestsWaiting: null }} />
    );
    await flush();
    expect(container.textContent).toContain("p50 — · no data");
    expect(container.textContent).not.toContain("idle all hour");
  });

  it("shows unknown history, not zero, when the telemetry read fails", async () => {
    telemetry.impl = () => Promise.reject(new Error("offline"));
    const { container } = render(<OverviewLlmFooter sparkId="john" port={8888} llm={llm} />);
    await flush();
    expect(container.textContent).toContain("p50 — · 60m —");
  });

  it("shows unknown live rates, not zeros, when the engine's stats could not be read", async () => {
    const { container } = render(
      <OverviewLlmFooter sparkId="john" port={8888} llm={{ ...llm, generationTps: 0, prefillTps: 0, measurementValid: false }} />
    );
    await flush();
    expect(container.textContent).toContain("— tok/s");
    expect(container.textContent).toContain("prefill — ·");
  });

  it("says a prompt is prefilling when the engine reports no live prefill rate", async () => {
    const { container } = render(
      <OverviewLlmFooter sparkId="john" port={8888} llm={{ ...llm, prefillTps: 0, prefillActive: true }} />
    );
    await flush();
    expect(container.textContent).toContain("prefill prefilling");
  });

  it("skips the history read when the card has no port", async () => {
    render(<OverviewLlmFooter sparkId="john" port={null} llm={llm} />);
    await flush();
    expect(telemetry.calls).toEqual([]);
  });
});

it("labels prefill-only and missing history without claiming idle", async () => {
  telemetry.impl = () => Promise.resolve(hourOf([{ generationTps: 0, prefillTps: 1000 }]));
  const { container, root } = render(<OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />);
  await flush();
  expect(container.textContent).toContain("no decode observed");
  expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("no decode observed");
  act(() => root.render(<OverviewLlmFooter sparkId="fixture" port={null} llm={llm} />));
  await flush();
  expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("no decode data");
});

it("reports samples rather than invented minutes and renders sparse observations", async () => {
  const now = Date.now();
  telemetry.impl = () => Promise.resolve(hourOf(Array.from({ length: 60 }, (_, i) => ({ t: now - (60 - i) * 60000, generationTps: 50 }))));
  const { container } = render(<OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />);
  await flush();
  expect(container.textContent).toContain("60 busy samples");
  expect(container.textContent).not.toContain("m busy");
  // The oldest point may age out between creating the response and rendering.
  expect(container.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(59);
});

it.each(["resolve", "reject"])("a superseded %s cannot overwrite a newer history response", async (outcome) => {
  vi.useFakeTimers();
  try {
    const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
    telemetry.impl = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const { container } = render(<OverviewLlmFooter sparkId="fixture" port={8888} llm={llm} />);
    act(() => { vi.advanceTimersByTime(30000); });
    pending[1].resolve(hourOf([{ generationTps: 30 }]));
    await flush();
    expect(container.textContent).toContain("p50 30");
    if (outcome === "resolve") pending[0].resolve(hourOf([{ generationTps: 999 }]));
    else pending[0].reject(new Error("superseded failure"));
    await flush();
    expect(container.textContent).toContain("p50 30");
    expect(container.textContent).not.toContain("999");
  } finally { vi.useRealTimers(); }
});
