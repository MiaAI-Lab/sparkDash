import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flush, render } from "../../testing/render";
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PORT,
  LLM_PREVIEW_SPARK_ID,
  makeDeepSeekActive,
  makeDeepSeekIdle,
  makeDeepSeekUnavailable,
  makeLlmDailyDays,
  makeLlmTokenSeries,
  makeSessionRows,
  seedLlmHistory,
} from "../../testing/llmFixtures";
import { _resetStore, getMetricHistorySamples } from "../../hooks/metricsStore";
import { LlmPanel } from "./LlmPanel";

const NOW = Date.now();
const SPARK = LLM_PREVIEW_SPARK_ID;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** Deterministic daily and token responses; records every call for write checks. */
function mockApi() {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/llm/daily")) {
      return jsonResponse({ sparkId: SPARK, port: DEEPSEEK_PORT, days: makeLlmDailyDays() });
    }
    if (url.startsWith("/api/llm-token-totals")) {
      return jsonResponse({ range: "all", series: makeLlmTokenSeries(SPARK, NOW) });
    }
    if (url.includes("/llm/bench")) {
      return jsonResponse({
        active: null,
        last: null,
        history: [],
        defaults: {
          allowedConcurrencies: [1],
          defaultMaxTokens: 128,
          minMaxTokens: 16,
          maxMaxTokens: 512,
          promptTypes: ["prose"],
          defaultPromptType: "prose",
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return calls;
}

async function renderPanel(props: Partial<ComponentProps<typeof LlmPanel>> = {}) {
  const rendered = render(
    <LlmPanel
      llm={makeDeepSeekActive(NOW)}
      sparkId={SPARK}
      sparkName="Preview unit"
      llmPort={DEEPSEEK_PORT}
      conversations={[]}
      llmPorts={[DEEPSEEK_PORT, 8000]}
      {...props}
    />,
  );
  await flush();
  return rendered;
}

describe("LlmPanel layout", () => {
  it("keeps missing native main rates unavailable rather than zero", async () => {
    mockApi();
    const rendered = await renderPanel({ llm: { ...makeDeepSeekActive(NOW), backend: "mlx-serve",
      generationTps: null, prefillTps: null, prefillActive: false,
      cachedPrefillTps: null, uncachedPrefillTps: null } });
    expect(rendered.container.querySelector("[data-llm-idle]")).toBeNull();
    for (const label of ["Decode", "Prefill"]) {
      const tile = screen.getByText(label, { selector: ".eyebrow" }).closest(".sp-metric");
      expect(tile).toHaveTextContent("—");
      expect(tile).not.toHaveTextContent("0.0");
    }
  });

  it("does not invent cached throughput when only computed prefill is measured", async () => {
    mockApi();
    await renderPanel({ llm: { ...makeDeepSeekActive(NOW), backend: "mlx-serve",
      prefillTps: 1000, uncachedPrefillTps: 1000, cachedPrefillTps: null } });
    expect(screen.getByText("Uncached prefill")).toBeInTheDocument();
    expect(screen.queryByText("Cached prefill")).not.toBeInTheDocument();
  });

  it("identifies native mlx-serve and exposes its request telemetry", async () => {
    mockApi();
    await renderPanel({ llm: { ...makeDeepSeekActive(NOW), backend: "mlx-serve",
      requestsRunning: 2, requestsWaiting: 1, prefixCacheHitRate: 0.75,
      generationTps: 80, prefillTps: null, cachedPrefillTps: null, uncachedPrefillTps: null } });
    expect(screen.getByText("mlx-serve").closest(".llm-badge")).not.toBeNull();
    expect(screen.getByText("2 / 1")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  beforeEach(() => {
    _resetStore();
  });

  it("compacts billion-scale engine counters so a tile never splits a number, keeping the exact value", async () => {
    mockApi();
    await renderPanel({ llm: { ...makeDeepSeekActive(NOW), totalPromptTokens: 1_248_218_233,
      totalOutputTokens: 4_208_139, completedRequestsTotal: 6_371 } });
    const prompt = screen.getByText("Process prompt").closest(".sp-tile")!;
    expect(within(prompt as HTMLElement).getByText("1.25B")).toBeInTheDocument();
    expect(prompt.getAttribute("title")).toBe("1,248,218,233 tokens");
    const completed = screen.getByText("Completed requests").closest(".sp-tile")!;
    expect(completed.getAttribute("title")).toBe("6,371 requests");
  });

  it("keeps a long model name as a readable heading apart from badges and port", async () => {
    mockApi();
    const longName =
      "DeepSeek-V4.1-Flash-oQ2.5e-mtp-quantized-checkpoint-with-a-deliberately-long-name-for-regression-coverage";
    await renderPanel({ llm: { ...makeDeepSeekActive(NOW), modelId: longName } });

    const heading = screen.getByRole("heading", { level: 3, name: longName });
    const port = screen.getByText(":8010");
    const backend = screen.getByText("oMLX");
    expect(heading.contains(port)).toBe(false);
    expect(heading.contains(backend)).toBe(false);
    expect(port.closest(".llm-badge")).toBeNull();
    expect(backend.closest(".llm-badge")).not.toBeNull();
  });

  it("shows the active metrics, trend, daily peaks, and token totals", async () => {
    mockApi();
    _resetStore();
    seedLlmHistory(SPARK, NOW);
    await renderPanel();

    expect(screen.getByRole("heading", { level: 3, name: DEEPSEEK_MODEL_ID })).toBeInTheDocument();
    expect(screen.getByText("Decode", { selector: "span.eyebrow" })).toBeInTheDocument();
    expect(screen.getByText("60.3")).toBeInTheDocument();
    expect(screen.getByText("Prefill", { selector: "span.eyebrow" })).toBeInTheDocument();
    expect(screen.getByText("Last observation just now")).toBeInTheDocument();
    const trend = screen.getByRole("img", {
      name: /Generation and prefill tokens per second over the last 30 minutes/,
    });
    const drawn = trend.querySelector("polyline")?.getAttribute("points")?.trim().split(/\s+/) ?? [];
    expect(drawn.length).toBeGreaterThan(2);
    expect(
      await screen.findByRole("group", { name: /Daily peak decode and prefill tokens per second/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Total tokens by model")).toBeInTheDocument();
    expect(
      document.querySelector('[title^="745,000 prompt · 680,000 cached"]'),
    ).not.toBeNull();
  });

  it("does not warn about a missing observation while the telemetry is active", async () => {
    mockApi();
    await renderPanel();

    expect(screen.queryByText(/Telemetry has not produced a fresh observation/)).toBeNull();
  });

  it("labels the history series and discloses that each is scaled to its own peak", async () => {
    mockApi();
    _resetStore();
    seedLlmHistory(SPARK, NOW);
    await renderPanel();

    // Colour swatches alone cannot say which line is which; the legend names both.
    expect(screen.getAllByText(/Gen avg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Prefill avg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/peak \d/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Each series is scaled to its own peak/),
    ).toBeInTheDocument();
  });

  it("shows the cached share of prefill work instead of leaving it to arithmetic", async () => {
    mockApi();
    _resetStore();
    seedLlmHistory(SPARK, NOW);
    await renderPanel();

    expect(screen.getAllByText(/cached \(avg\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/uncached \(avg\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^\d+%$/).length).toBeGreaterThan(0);
  });

  it("totals each model's tokens and shows the composition bar", async () => {
    mockApi();
    _resetStore();
    seedLlmHistory(SPARK, NOW);
    await renderPanel();

    // 745,000 prompt + 6,911 generated = 751,911 tokens.
    expect(await screen.findByText("752k")).toBeInTheDocument();
    const bar = document.querySelector(".llm-token-bar");
    expect(bar).not.toBeNull();
    expect(bar?.querySelectorAll("span").length).toBe(3);
  });

  it("keys the seeded history by LLM port", () => {
    seedLlmHistory(SPARK, NOW);

    expect(getMetricHistorySamples(SPARK, "llm:8010.tps").length).toBeGreaterThan(0);
    expect(getMetricHistorySamples(SPARK, "llm:8000.tps").length).toBeGreaterThan(0);
  });

  it("folds an unavailable LLM to its identity and reveals the history on demand", async () => {
    mockApi();
    await renderPanel({ llm: makeDeepSeekUnavailable(NOW) });

    expect(screen.getByRole("heading", { level: 3, name: DEEPSEEK_MODEL_ID })).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Telemetry source did not answer in the last 15 minutes."),
    ).toBeInTheDocument();
    // Folded: no live rates and no fake zero, but the history is one click away.
    expect(screen.queryByText("Decode", { selector: "span.eyebrow" })).toBeNull();
    expect(screen.queryByText("0.0")).toBeNull();
    expect(
      screen.queryByRole("group", { name: /Daily peak decode and prefill tokens per second/ }),
    ).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Expand LLM details" }));

    expect(
      await screen.findByRole("group", { name: /Daily peak decode and prefill tokens per second/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Total tokens by model")).toBeInTheDocument();
  });

  it("folds an idle LLM but keeps an active one open", async () => {
    mockApi();
    await renderPanel({ llm: makeDeepSeekIdle(NOW) });

    expect(screen.getByRole("button", { name: "Expand LLM details" })).toBeInTheDocument();
    expect(screen.queryByText("Decode", { selector: "span.eyebrow" })).toBeNull();
  });

  it("keeps an active LLM expanded and offers to fold it", async () => {
    mockApi();
    await renderPanel({ llm: makeDeepSeekActive(NOW) });

    expect(screen.getByText("Decode", { selector: "span.eyebrow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse LLM details" })).toBeInTheDocument();
  });

  it.each(["stale", "unknown"] as const)("keeps the %s model heading and reason readable", async (status) => {
    mockApi();
    await renderPanel({
      llm: { ...makeDeepSeekActive(NOW), status, statusReason: "Telemetry older than two minutes." },
    });

    expect(screen.getByRole("heading", { level: 3, name: DEEPSEEK_MODEL_ID })).toBeInTheDocument();
    expect(screen.getAllByText(status).length).toBeGreaterThan(0);
    expect(screen.getByText("Telemetry older than two minutes.")).toBeInTheDocument();
  });

  it("offers the harness action for an empty session list without dropping the copy", async () => {
    mockApi();
    const user = userEvent.setup();
    const onOpenHarnessWizard = vi.fn();
    await renderPanel({ conversations: [], onOpenHarnessWizard });

    expect(screen.getByText(/No sessions on this LLM/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Harness" }));
    expect(onOpenHarnessWizard).toHaveBeenCalledTimes(1);
  });

  it("lists populated sessions with long handles and keeps the add action reachable", async () => {
    mockApi();
    const user = userEvent.setup();
    const onOpenHarnessWizard = vi.fn();
    await renderPanel({ conversations: makeSessionRows(NOW), onOpenHarnessWizard });

    const list = screen.getByLabelText("Harness sessions on this LLM");
    expect(within(list).getByText("main")).toBeInTheDocument();
    expect(
      within(list).getByText("research-thread-with-a-deliberately-long-handle-for-overflow-checks"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add harness" }));
    expect(onOpenHarnessWizard).toHaveBeenCalledTimes(1);
  });

  it("returns to the model display after settings are cancelled", async () => {
    mockApi();
    const user = userEvent.setup();
    await renderPanel();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: DEEPSEEK_MODEL_ID })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { level: 3, name: DEEPSEEK_MODEL_ID })).toBeInTheDocument();
    expect(screen.getByText("Decode", { selector: "span.eyebrow" })).toBeInTheDocument();
  });

  it("navigates to the dedicated Decode bench page instead of opening a dialog, and starts no run", async () => {
    // Local benches now open their own full page (dispatched via a navigate event) rather
    // than an inline dialog; the dialog stays reserved for remote targets.
    const calls = mockApi();
    const user = userEvent.setup();
    await renderPanel();
    const navigateSpy = vi.fn();
    window.addEventListener("sparkdash:navigate", navigateSpy);

    await user.click(screen.getByRole("button", { name: "Decode" }));

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    window.removeEventListener("sparkdash:navigate", navigateSpy);
  });
});
