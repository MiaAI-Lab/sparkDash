/**
 * Honest-visuals acceptance suite — Phase 7 (AT-1, AT-9, AT-11, AT-12, AT-16, AT-17).
 *
 * These tests assert EXACT counts/strings, never mere existence. Rendering uses
 * the project's plain createRoot helper (src/testing/render) — no Testing
 * Library, matching the existing suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { OverviewPage } from "./OverviewPage";
import { ShareModeProvider, useShareMode } from "../../hooks/shareMode";
import { FALLBACK_SCALE, MODEL_SCALES, scaleForModel } from "../../config/display.js";

vi.mock("../../api/client", () => ({
  shutdownAllSparks: vi.fn(),
  updateAllHermes: vi.fn(),
  wakeAllSparks: vi.fn(),
}));

const GAUGE_VIEWBOX = '-10 0 140 96';

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
    ...overrides,
  };
}

/** Clone the shared fixture and override top-level + metrics fields. */
function makeNode(
  id: string,
  overrides: Partial<SparkSnapshot> = {},
  llm: LlmMetrics[] | null = null
): SparkSnapshot {
  const spark = makeSpark(id, true);
  if (llm) spark.metrics.llm = llm;
  return { ...spark, ...overrides } as SparkSnapshot;
}

function cards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".overview-card")];
}

/** SpeedGauge dials inside a card. NB: jsdom's selector engine lowercases
 * attribute names in [attr=...] selectors, which never matches the
 * case-sensitive SVG `viewBox` — filter by getAttribute instead. */
function gaugeSvgs(el: HTMLElement): SVGSVGElement[] {
  return [...el.querySelectorAll("svg")].filter(
    (s) => s.getAttribute("viewBox") === GAUGE_VIEWBOX
  ) as SVGSVGElement[];
}

/** Scale-number texts printed on a SpeedGauge dial (excludes the tok/s readout). */
function gaugeScaleTexts(card: HTMLElement): string[] {
  return gaugeSvgs(card)
    .flatMap((svg) => [...svg.querySelectorAll("text")])
    .filter((t) => !t.classList.contains("font-tabular"))
    .map((t) => t.textContent ?? "");
}

/** Mirror of SpeedGauge's internal `fmt` — the dial's scale-number formatter. */
function fmtScale(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "");
}

/** Expected scale labels for both gauges of a model, derived from MODEL_SCALES.
 *  DOM order: the Prefill dial renders left of the Generation dial. */
function expectedGaugeScaleTexts(modelId: string): string[] {
  const scale = scaleForModel(modelId);
  const labels = (max: number) => [0, 0.25, 0.5, 0.75, 1].map((f) => fmtScale(f * max));
  return [...labels(scale.prefill), ...labels(scale.gen)];
}

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("AT-1 skeleton/empty states (I-4)", () => {
  it("keeps the workload section as an explicit placeholder, hardware blocks intact", () => {
    // (a) llmMonitoring=false, no available LLM telemetry.
    const monitoredOff = makeSpark("at1-a", true);
    monitoredOff.llmMonitoring = false;
    monitoredOff.metrics.llm = [];
    // (b) GPU metrics present, VRAM in use, but no available LLM.
    const vramOnly = makeSpark("at1-b", true);
    vramOnly.metrics.llm = [];
    vramOnly.metrics.gpu!.vram = { used: 2048, total: 4096, available: 2048, percentage: 50 };

    const { container } = render(<OverviewPage sparks={[monitoredOff, vramOnly]} />);
    const rendered = cards(container);
    expect(rendered).toHaveLength(2);

    // Exact placeholder strings — the workload section never disappears.
    expect(rendered[0].textContent).toContain("NO WORKLOAD MONITORED");
    expect(rendered[1].textContent).toContain("VRAM allocated — no monitored workload");
    // ...and the exporter-not-reporting placeholder must NOT leak in here.
    expect(container.textContent).not.toContain("NO DATA — exporter not reporting");

    // Hardware blocks still render on both cards (VRAM MetricBar label).
    for (const card of rendered) {
      expect(card.textContent).toContain("VRAM");
    }
  });
});

describe("AT-16/AT-17 model-keyed gauge scales (I-2′)", () => {
  it("same modelId → identical scale maxima; different modelIds → different maxima", () => {
    const deepseek = "deepseek-v4-flash-vision-exp";
    const ornith = "ornith-1.5-35b";
    expect(MODEL_SCALES[deepseek]).toBeDefined();
    expect(MODEL_SCALES[ornith]).toBeDefined();

    const sparks = [
      makeNode("at16-a", {}, [makeLlm({ modelId: deepseek })]),
      makeNode("at16-b", {}, [makeLlm({ modelId: deepseek })]),
      makeNode("at16-c", {}, [makeLlm({ modelId: ornith })]),
    ];
    const { container } = render(<OverviewPage sparks={sparks} variant="gauges" />);
    const rendered = cards(container);
    expect(rendered).toHaveLength(3);

    const scaleA = gaugeScaleTexts(rendered[0]);
    const scaleB = gaugeScaleTexts(rendered[1]);
    const scaleC = gaugeScaleTexts(rendered[2]);

    // Same modelId → byte-identical printed scales (10 numbers per card:
    // 5 ticks on the Generation dial + 5 on the Prefill dial).
    expect(scaleA).toEqual(scaleB);
    expect(scaleA).toHaveLength(10);
    // Scales come from the real MODEL_SCALES entries, not from the data.
    expect(scaleA).toEqual(expectedGaugeScaleTexts(deepseek));
    // Different modelIds → different maxima.
    expect(scaleC).not.toEqual(scaleA);
    expect(scaleC).toEqual(expectedGaugeScaleTexts(ornith));
  });

  it("unknown modelId renders at FALLBACK_SCALE with a single Default Scale badge", () => {
    const unknown = makeNode("at17-a", {}, [makeLlm({ modelId: "not-in-scales-7b" })]);
    const { container } = render(<OverviewPage sparks={[unknown]} variant="gauges" />);
    const card = cards(container)[0];

    const badges = [...card.querySelectorAll("span")].filter(
      (s) => s.textContent === "Default Scale"
    );
    expect(badges).toHaveLength(1); // one card-level badge (side-by-side dials)

    const scale = scaleForModel("not-in-scales-7b");
    expect(scale.isFallback).toBe(true);
    expect(scale.gen).toBe(FALLBACK_SCALE.gen);
    expect(scale.prefill).toBe(FALLBACK_SCALE.prefill);
    expect(gaugeScaleTexts(card)).toEqual(expectedGaugeScaleTexts("not-in-scales-7b"));
  });

  it("manual per-Spark override wins over the model scale and drops the badge (Addendum E)", () => {
    const unknown = makeNode("at17-b", {}, [makeLlm({ modelId: "not-in-scales-7b" })]);
    const { container } = render(
      <OverviewPage
        sparks={[unknown]}
        variant="gauges"
        gaugeScales={{ "at17-b": { gen: 800, prefill: 4000 } }}
      />
    );
    const card = cards(container)[0];

    // Override maxima printed on the dials — not the fallback, not the model scale.
    expect(gaugeScaleTexts(card)).toEqual([
      ...[0, 0.25, 0.5, 0.75, 1].map((f) => fmtScale(f * 4000)), // Prefill (left dial)
      ...[0, 0.25, 0.5, 0.75, 1].map((f) => fmtScale(f * 800)), // Generation (right dial)
    ]);
    // No fallback badge when every dial has an explicit value.
    expect(card.textContent).not.toContain("Default Scale");
    // The settings gear is present (capability) outside share mode.
    expect(
      [...card.querySelectorAll("button")].some((b) => b.getAttribute("title") === "Gauge scale settings")
    ).toBe(true);
  });

  it("the settings gear is absent from the DOM in share mode (I-8)", () => {
    window.history.pushState({}, "", "/?share=1");
    const unknown = makeNode("at17-c", {}, [makeLlm({ modelId: "not-in-scales-7b" })]);
    const { container } = render(
      <ShareModeProvider>
        <OverviewPage sparks={[unknown]} variant="gauges" />
      </ShareModeProvider>
    );
    const card = cards(container)[0];
    expect(
      [...card.querySelectorAll("button")].some((b) => b.getAttribute("title") === "Gauge scale settings")
    ).toBe(false);
    window.history.pushState({}, "", "/");
  });
});

describe("AT-9 share mode (I-8, T2)", () => {
  // The banner markup itself lives in App.tsx:357-364; this stub drives the
  // SAME useShareMode() hook App uses, to assert the provider initialises
  // from ?share=1 (the banner's data source). The static banner string is
  // asserted in the runbook's manual checklist.
  function ShareBannerStub() {
    const shareMode = useShareMode();
    return shareMode ? <div role="status">Share mode — identifiers redacted</div> : null;
  }

  it("redacts identifiers, drops destructive controls, shows the banner", () => {
    window.history.pushState({}, "", "/?share=1");
    const deepseek = "deepseek-v4-flash-vision-exp";
    const sparks = [
      makeNode("share-x1", { name: "gx10" }, [makeLlm({ modelId: deepseek })]),
      makeNode("share-x2", { name: "gx12" }, [makeLlm({ modelId: deepseek })]),
    ];
    const { container } = render(
      <ShareModeProvider>
        <ShareBannerStub />
        <OverviewPage sparks={sparks} />
      </ShareModeProvider>
    );

    const text = container.textContent ?? "";
    // Real identifiers never enter the DOM — names OR normalised variants.
    for (const leaked of ["gx10", "gx12", "GX10", "GX12", deepseek]) {
      expect(text).not.toContain(leaked);
    }
    // Aliases render instead (assignment order is render-order dependent —
    // assert the shape, not a specific letter).
    expect(text).toMatch(/Node [A-Z]/);
    expect(text).toMatch(/model-[a-z]/);

    // Wake All / Shutdown All are REMOVED, not disabled.
    const destructive = [...container.querySelectorAll("button")].filter((b) =>
      /Wake All|Shutdown All/.test(b.textContent ?? "")
    );
    expect(destructive).toHaveLength(0);

    // The App banner data source is live.
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Share mode — identifiers redacted"
    );
  });

  it("contrast: without ?share=1 identifiers show and controls are present", () => {
    const sparks = [
      makeNode("share-y1", { name: "gx10" }, [makeLlm({ modelId: "deepseek-v4-flash-vision-exp" })]),
    ];
    const { container } = render(
      <ShareModeProvider>
        <OverviewPage sparks={sparks} />
      </ShareModeProvider>
    );
    const text = container.textContent ?? "";
    expect(text).toContain("GX10"); // displayNodeName convention (AT-15)
    expect(text).toContain("deepseek-v4-flash-vision-exp");
    const wake = [...container.querySelectorAll("button")].filter(
      (b) => (b.textContent ?? "").includes("Wake All")
    );
    const shutdown = [...container.querySelectorAll("button")].filter(
      (b) => (b.textContent ?? "").includes("Shutdown All")
    );
    expect(wake).toHaveLength(1);
    expect(shutdown).toHaveLength(1);
  });
});

describe("AT-11 accessibility (I-6)", () => {
  it("gauges are aria-hidden with a numeric text readout as the semantic source", () => {
    const spark = makeNode("at11-a", {}, [makeLlm({ modelId: "deepseek-v4-flash-vision-exp" })]);
    const { container } = render(<OverviewPage sparks={[spark]} variant="gauges" />);
    const card = cards(container)[0];

    const gauges = gaugeSvgs(card);
    expect(gauges).toHaveLength(2); // Generation + Prefill
    expect(gauges.every((g) => g.getAttribute("aria-hidden") === "true")).toBe(true);

    let readouts = 0;
    gauges.forEach((svg) => {
      const readout = [...svg.querySelectorAll("text.font-tabular")].find((t) =>
        (t.textContent ?? "").includes("tok/s")
      );
      expect(readout).toBeDefined();
      expect(readout?.textContent).toMatch(/\d+.*tok\/s/);
      readouts += 1;
    });
    expect(readouts).toBe(2);
  });
});

describe("AT-18 topology honesty (Addendum D.2/D.3)", () => {
  it("a configured TP worker renders CLUSTER WORKER — never NO WORKLOAD MONITORED", () => {
    const head = makeNode("at18-head", { role: "head", name: "gx10" }, [
      makeLlm({ modelId: "deepseek-v4-flash-vision-exp" }),
    ]);
    const worker = makeNode(
      "at18-worker",
      { role: "worker", workerHeadId: "at18-head", name: "gx11" } as Partial<SparkSnapshot>,
      []
    );
    const standalone = makeNode("at18-solo", { role: "standalone", name: "gx12" }, [
      makeLlm({ modelId: "ornith-1.5-35b" }),
    ]);

    const { container } = render(
      <OverviewPage sparks={[head, worker, standalone]} variant="gauges" />
    );
    const rendered = cards(container);
    expect(rendered).toHaveLength(3);

    const headCard = rendered[0];
    const workerCard = rendered[1];
    const soloCard = rendered[2];

    // Role badges match the configured topology (3/3) — never two
    // standalones for a TP pair (defect 12).
    expect(headCard.textContent).toContain("Head");
    expect(workerCard.textContent).toContain("Worker");
    expect(soloCard.textContent).toContain("Standalone");

    // The worker's workload block is the distinct CLUSTER WORKER state…
    expect(workerCard.textContent).toContain("CLUSTER WORKER — metrics served by");
    expect(workerCard.textContent).toContain("(head)");
    // …never the "no workload" lie, and never a NO DATA placeholder.
    expect(workerCard.textContent).not.toContain("NO WORKLOAD MONITORED");
    expect(workerCard.textContent).not.toContain("NO DATA — exporter not reporting");
    // Head name normalised to the Operator's convention (AT-15).
    expect(workerCard.textContent).toContain("GX10");

    // Exactly one CLUSTER WORKER card in the fleet; the head still carries
    // its own gauges (the cluster is not double-counted as a workload).
    const clusterWorkers = rendered.filter((c) =>
      (c.textContent ?? "").includes("CLUSTER WORKER")
    );
    expect(clusterWorkers).toHaveLength(1);
    expect(gaugeSvgs(headCard)).toHaveLength(2);
  });
});

describe("AT-12 injection (T2, display half)", () => {
  it("a hostile modelId renders as inert text — no img node, no script execution", () => {
    const payload = "<img src=x onerror=window.__pwned=1>";
    const spark = makeNode("at12-a", {}, [makeLlm({ modelId: payload })]);
    const { container } = render(<OverviewPage sparks={[spark]} />);

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain(payload); // literal, escaped text
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
