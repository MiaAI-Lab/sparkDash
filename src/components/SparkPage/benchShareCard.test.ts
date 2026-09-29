import { describe, expect, it, vi } from "vitest";
import boltSvg from "../../../assets/bolt.svg?raw";
import type { DecodeBenchJob, PrefillBenchJob } from "../../api/types";
import {
  BOLT_POINTS,
  SHARE_CARD_MIN_HEIGHT,
  SHARE_CARD_WIDTH,
  buildDecodeShareCard,
  buildPrefillShareCard,
  paintShareCard,
  shareCardDate,
  shareCardFileName,
  shareCardHeight,
  shareCardStatus,
  shareCardSubtitle,
  type ShareCardContext,
  type ShareCardModel,
} from "./benchShareCard";
import { copyCardImage, copyTextOnly, renderShareCardPng } from "./shareImage";

/** Minimal decode result factory — only the fields the card reads. */
function decodeResult(over: Partial<DecodeBenchJob["results"][number]> = {}) {
  return {
    concurrency: 1,
    streamsOk: 1,
    streamsFailed: 0,
    meanDecodeTps: 37.04,
    medianDecodeTps: 37,
    minDecodeTps: 36,
    maxDecodeTps: 38,
    meanTtftMs: 261,
    medianTtftMs: 260,
    aggregateDecodeTps: 37.04,
    meanPrefillTps: 900,
    medianPrefillTps: 900,
    aggregatePrefillTps: 900,
    totalPrefillTokens: 7,
    totalDecodeTokens: 400,
    totalCompletionTokens: 407,
    durationMs: 11000,
    error: null,
    streams: [],
    model: "DeepSeek-v4.1-Flash-EXL3",
    ...over,
  };
}

function decodeJob(over: Partial<DecodeBenchJob> = {}): DecodeBenchJob {
  return {
    benchId: "b1",
    sparkId: "spark-38bd",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: { port: 8888, modelId: "DeepSeek-v4.1-Flash-EXL3", concurrencies: [1, 2], maxTokens: 400, promptType: "prose" },
    progress: { currentConcurrency: null, completedLevels: 2, totalLevels: 2, message: "" },
    results: [decodeResult({ concurrency: 2, meanDecodeTps: 28.6, aggregateDecodeTps: 56.83, meanTtftMs: 399, streamsOk: 2 })],
    error: null,
    durationMs: 27800,
    ...over,
  } as DecodeBenchJob;
}

function prefillJob(over: Partial<PrefillBenchJob> = {}): PrefillBenchJob {
  return {
    benchId: "p1",
    sparkId: "spark-38bd",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    config: { port: 8888, modelId: "DeepSeek-v4.1-Flash-EXL3", contextSizes: [1000, 32000] },
    progress: { currentContext: null, completedLevels: 2, totalLevels: 2, message: "" },
    results: [
      {
        targetTokens: 32000,
        promptTokens: 31998,
        promptChars: 128000,
        prefillTps: 4820.5,
        ttftMs: 6638,
        ttftContentMs: null,
        completionTokens: 8,
        durationMs: 7000,
        model: "DeepSeek-v4.1-Flash-EXL3",
        error: null,
      },
    ],
    error: null,
    durationMs: 40000,
    ...over,
  } as PrefillBenchJob;
}

/** Recording 2D context: enough surface for the painter, no canvas backend. */
function fakeContext(
  charWidth = 10
): ShareCardContext & {
  texts: string[];
  fillRects: number[][];
  strokes: Array<{ points: Array<[number, number]>; color: string }>;
} {
  const texts: string[] = [];
  const fillRects: number[][] = [];
  const strokes: Array<{ points: Array<[number, number]>; color: string }> = [];
  let current: Array<[number, number]> = [];
  const ctx = {
    texts,
    fillRects,
    strokes,
    fillStyle: "" as string | CanvasGradient,
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: () => {
      current = [];
    },
    closePath: () => {
      if (current.length) current = [...current, current[0]];
    },
    moveTo: (x: number, y: number) => {
      current = [[x, y]];
    },
    lineTo: (x: number, y: number) => {
      current = [...current, [x, y]];
    },
    fill: vi.fn(),
    stroke(this: { strokeStyle: string }) {
      if (current.length > 2) strokes.push({ points: current, color: String(this.strokeStyle) });
    },
    roundRect: vi.fn(),
    scale: vi.fn(),
    fillRect: (x: number, y: number, w: number, h: number) => fillRects.push([x, y, w, h]),
    fillText: (text: string) => texts.push(String(text)),
    measureText: (text: string) => ({ width: String(text).length * charWidth }),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
  };
  return ctx as unknown as ShareCardContext & {
    texts: string[];
    fillRects: number[][];
    strokes: Array<{ points: Array<[number, number]>; color: string }>;
  };
}

describe("share card model", () => {
  it("mirrors the decode table: sorted rows, aggregate + stream tok/s, TTFT and streams", () => {
    const job = decodeJob({ results: [decodeResult({ concurrency: 2, streamsOk: 1, streamsFailed: 1, aggregateDecodeTps: 56.83, meanDecodeTps: 28.6, meanTtftMs: 399 })] });
    const card = buildDecodeShareCard(job, { llmPort: 8888, modelId: "DeepSeek-v4.1-Flash-EXL3", sparkName: "spark-38bd" }, Date.UTC(2026, 8, 17));

    expect(card.title).toBe("Decode benchmark");
    expect(card.host).toBe("spark-38bd");
    expect(card.subtitle).toBe("Port 8888 · DeepSeek-v4.1-Flash-EXL3");
    expect(card.status).toEqual({ label: "COMPLETED", tone: "ok" });
    expect(card.meta).toBe("Prose · 400 tok · 1, 2 conc · 27.8 s");
    expect(card.columns).toEqual({ load: "Load", primary: "Aggregate", secondary: "Stream" });
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0]).toMatchObject({
      load: "×2",
      detail: "TTFT 399ms · 1/2 streams",
      primary: "56.8",
      secondary: "28.6",
      primaryUnit: "tok/s",
      tone: "ok",
    });
  });

  it("sorts decode rows by concurrency regardless of arrival order", () => {
    const job = decodeJob({
      results: [decodeResult({ concurrency: 8 }), decodeResult({ concurrency: 1 }), decodeResult({ concurrency: 4 })],
    });
    const card = buildDecodeShareCard(job, { llmPort: 8888, modelId: null });
    expect(card.rows.map((r) => r.load)).toEqual(["×1", "×4", "×8"]);
  });

  it("marks a failed decode level without inventing numbers", () => {
    const job = decodeJob({
      results: [decodeResult({ concurrency: 32, totalDecodeTokens: 0, totalCompletionTokens: 0, streamsOk: 0, streamsFailed: 32, error: "429 from the LLM" })],
    });
    const card = buildDecodeShareCard(job, { llmPort: 8888, modelId: null });
    expect(card.rows[0]).toMatchObject({ load: "×32", detail: "429 from the LLM", primary: "—", secondary: "—", tone: "bad" });
  });

  it("uses prefill context labels and the measured prompt size", () => {
    const card = buildPrefillShareCard(prefillJob(), { llmPort: 8888, modelId: "DeepSeek-v4.1-Flash-EXL3" }, Date.UTC(2026, 8, 17));
    expect(card.title).toBe("Prefill benchmark");
    expect(card.columns).toEqual({ load: "Context", primary: "Prefill", secondary: "TTFT" });
    expect(card.meta).toBe("1k, 32k ctx · 40.0 s");
    expect(card.rows[0]).toMatchObject({
      load: "32k",
      detail: "TTFT 6.64s · 31,998 tokens",
      primary: "4820.5",
      secondary: "6.64s",
      secondaryUnit: "",
    });
  });

  it("falls back to the port alone when the model is unknown, and to the remote host when used", () => {
    expect(shareCardSubtitle({ llmPort: 8888, modelId: null })).toBe("Port 8888");
    expect(shareCardSubtitle({ llmPort: 8888, modelId: "m", remoteHost: "spark.tailnet.ts.net" })).toBe(
      "spark.tailnet.ts.net · m"
    );
  });

  it("labels every job status", () => {
    expect(shareCardStatus("completed")).toEqual({ label: "COMPLETED", tone: "ok" });
    expect(shareCardStatus("running")).toEqual({ label: "RUNNING", tone: "warn" });
    expect(shareCardStatus("failed")).toEqual({ label: "FAILED", tone: "bad" });
    expect(shareCardStatus("cancelled")).toEqual({ label: "CANCELLED", tone: "muted" });
  });

  it("builds a file name from the unit name and the local date", () => {
    const card = buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: null, sparkName: "Spark 38bd" });
    const name = shareCardFileName(card, "decode");
    expect(name).toMatch(/^sparkdash-decode-spark-38bd-\d{4}-\d{2}-\d{2}\.png$/);
    expect(shareCardFileName(buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: null }), "prefill")).toMatch(
      /^sparkdash-prefill-spark-\d{4}-\d{2}-\d{2}\.png$/
    );
  });

  it("formats the date in local time", () => {
    expect(shareCardDate(new Date(2026, 8, 17, 23, 30).getTime())).toBe("2026-09-17");
  });

  it("grows the card with the number of rows but never under 16:9", () => {
    const short = shareCardHeight(buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: null }));
    expect(short).toBe(SHARE_CARD_MIN_HEIGHT);
    const many = buildDecodeShareCard(decodeJob({ results: Array.from({ length: 12 }, (_, i) => decodeResult({ concurrency: i + 1 })) }), {
      llmPort: 8888,
      modelId: null,
    });
    expect(shareCardHeight(many)).toBeGreaterThan(SHARE_CARD_MIN_HEIGHT);
  });
});

describe("share card painter", () => {
  it("draws the header, one line per row, the legend and the footer", () => {
    const card = buildDecodeShareCard(
      decodeJob({ results: [decodeResult({ concurrency: 1 }), decodeResult({ concurrency: 2 })] }),
      { llmPort: 8888, modelId: "DeepSeek-v4.1-Flash-EXL3", sparkName: "spark-38bd" }
    );
    const ctx = fakeContext();
    paintShareCard(ctx, card);

    expect(ctx.texts).toContain("sparkDash");
    expect(ctx.texts).toContain("spark-38bd");
    expect(ctx.texts).toContain("Decode benchmark");
    expect(ctx.texts).toContain("Port 8888 · DeepSeek-v4.1-Flash-EXL3");
    expect(ctx.texts).toContain("COMPLETED");
    expect(ctx.texts).toContain("LOAD");
    expect(ctx.texts).toContain("AGGREGATE");
    expect(ctx.texts).toContain("STREAM");
    expect(ctx.texts).toContain("×1");
    expect(ctx.texts).toContain("×2");
    expect(ctx.texts.filter((t) => t === "tok/s")).toHaveLength(4); // two rows × agg + stream
    expect(ctx.texts).toContain(card.legend);
    expect(ctx.texts).toContain("github.com/MiaAI-Lab/sparkDash");
    // Background covers the whole card.
    expect(ctx.fillRects[0]).toEqual([0, 0, SHARE_CARD_WIDTH, shareCardHeight(card)]);
  });

  it("strokes the repo's brand mark next to the wordmark", () => {
    const ctx = fakeContext();
    paintShareCard(ctx, buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: null }));
    const bolt = ctx.strokes.find((s) => s.color.startsWith("#e8a830"));
    expect(bolt).toBeDefined();
    // Start point, the five interior vertices, and the closing repeat.
    expect(bolt!.points).toHaveLength(BOLT_POINTS.length + 1);
    expect(bolt!.points[0]).toEqual(bolt!.points[bolt!.points.length - 1]);
  });

  it("keeps the brand mark in step with assets/bolt.svg", () => {
    const d = boltSvg.match(/\sd="([^"]+)"/)?.[1];
    expect(d, "assets/bolt.svg should still carry a path").toBeTruthy();
    // The polygon in benchShareCard.ts is these same vertices, so a redrawn mark
    // has to update BOLT_POINTS (and this test) rather than drift silently.
    expect(d).toBe("M13 2L3 14h9l-1 8 10-12h-9l1-8z");
    expect(BOLT_POINTS.flat()).toEqual([13, 2, 3, 14, 12, 14, 11, 22, 21, 10, 12, 10]);
  });

  it("survives a job with no results yet", () => {
    const ctx = fakeContext();
    expect(() => paintShareCard(ctx, buildDecodeShareCard(decodeJob({ results: [] }), { llmPort: 8888, modelId: null }))).not.toThrow();
  });

  it("truncates text that cannot fit the fixed width", () => {
    const card = buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: "x".repeat(400) });
    const ctx = fakeContext(30); // wide glyphs so everything overflows
    paintShareCard(ctx, card);
    expect(ctx.texts.some((t) => t.endsWith("…"))).toBe(true);
  });
});

describe("copy formats", () => {
  function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
    const ctx = fakeContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx as unknown as CanvasRenderingContext2D,
      toBlob: (cb: (b: Blob | null) => void) => cb(blob),
    } as unknown as HTMLCanvasElement;
    return { canvas, ctx };
  }

  const model: ShareCardModel = buildDecodeShareCard(decodeJob(), { llmPort: 8888, modelId: null });

  it("sizes the canvas at 2× the card", async () => {
    const { canvas } = fakeCanvas();
    await renderShareCardPng(model, { createCanvas: () => canvas });
    expect(canvas.width).toBe(SHARE_CARD_WIDTH * 2);
    expect(canvas.height).toBe(shareCardHeight(model) * 2);
  });

  it("copies text through the async clipboard", async () => {
    const writeText = vi.fn(async () => {});
    await copyTextOnly("summary text", { writeText });
    expect(writeText).toHaveBeenCalledWith("summary text");
  });

  it("copies the card as a PNG", async () => {
    const writeClipboard = vi.fn(async (_blob: Blob) => {});
    const outcome = await copyCardImage(model, "card.png", {
      createCanvas: () => fakeCanvas().canvas,
      writeClipboard,
    });
    expect(outcome).toBe("copied");
    expect(writeClipboard.mock.calls[0][0].size).toBeGreaterThan(0);
  });

  it("downloads the card when the clipboard refuses it", async () => {
    const download = vi.fn();
    const outcome = await copyCardImage(model, "card.png", {
      createCanvas: () => fakeCanvas().canvas,
      writeClipboard: async () => {
        throw new Error("NotAllowedError");
      },
      download,
    });
    expect(outcome).toBe("downloaded");
    expect(download.mock.calls[0][1]).toBe("card.png");
  });

  it("downloads when there is no clipboard image support at all", async () => {
    const download = vi.fn();
    const outcome = await copyCardImage(model, "card.png", {
      createCanvas: () => fakeCanvas().canvas,
      writeClipboard: null,
      download,
    });
    expect(outcome).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("reports failure when the card cannot be painted", async () => {
    const download = vi.fn();
    const outcome = await copyCardImage(model, "card.png", {
      createCanvas: () => {
        throw new Error("no canvas backend");
      },
      writeClipboard: null,
      download,
    });
    expect(outcome).toBe("failed");
    expect(download).not.toHaveBeenCalled();
  });
});
