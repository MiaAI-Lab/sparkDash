import { describe, expect, it } from "vitest";
import { makeSpark } from "../../testing/fixtures";
import type { SparkSnapshot } from "../../api/types";
import { vramContextFor } from "../../shared/vramBreakdown";
import { kioskCard, kioskColumns, kioskFleetStats, parseKioskOptions, smoothPath, tracesFromHistory } from "./kioskModel";

describe("parseKioskOptions", () => {
  it("defaults to one screen, automatic columns and the browser's theme", () => {
    expect(parseKioskOptions("")).toEqual({ fit: "shrink", cols: 0, theme: null });
  });

  it("reads fit, cols and theme, and ignores values it does not know", () => {
    expect(parseKioskOptions("?fit=scroll&cols=4&theme=oled")).toEqual({ fit: "scroll", cols: 4, theme: "oled" });
    expect(parseKioskOptions("?fit=zoom&cols=0&theme=neon")).toEqual({ fit: "shrink", cols: 0, theme: null });
    expect(parseKioskOptions("?cols=2.5").cols).toBe(0);
    expect(parseKioskOptions("?cols=9").cols).toBe(0);
  });
});

describe("kioskColumns", () => {
  it("lays six units out 3 × 2 on a 16:9 wall", () => {
    expect(kioskColumns(6, 1920, 900)).toBe(3);
    expect(kioskColumns(6, 3840, 1800)).toBe(3);
  });

  it("keeps at least two rows, even on a very wide strip", () => {
    expect(kioskColumns(6, 3840, 400)).toBe(3);
    expect(kioskColumns(4, 3840, 400)).toBe(2);
  });

  it("uses one column for one unit and stacks on a portrait screen", () => {
    expect(kioskColumns(1, 1920, 1080)).toBe(1);
    expect(kioskColumns(4, 1080, 1920)).toBe(1);
  });
});

describe("kioskCard", () => {
  const unified = (s: SparkSnapshot) => {
    s.kind = "spark";
    s.metrics.ram = { used: 98_000, total: 124_544, percentage: 79 };
    s.metrics.gpu!.vram = { used: 42_000, total: 124_544, percentage: 34, available: 26_000 };
    s.metrics.gpu!.processes = [{ pid: 1, name: "python3", vramMB: 41_000 }];
    s.metrics.unifiedMemory = { total: 124_544, gpuUsed: 42_000, cpuUsed: 56_000, used: 98_000, available: 26_500, percentage: 79, oomRisk: "medium", bandwidth: { current: 0, peak: 400 } };
    return s;
  };

  it("splits unified memory into model and system, as the Overview does", () => {
    const s = unified(makeSpark("a"));
    const c = kioskCard(s, null, vramContextFor(s, [s]));
    expect(c.memory?.label).toBe("Unified memory");
    expect(c.memory?.free).toBe("25.9 GB free");
    expect(c.memory?.legend.map((x) => x.label)).toEqual(["Model", "System", "Other"]);
    expect(c.memory?.ram).toBeNull();
  });

  it("adds system RAM on a host with a discrete card", () => {
    const s = makeSpark("h");
    s.kind = "host";
    s.metrics.ram = { used: 46_080, total: 126_157, percentage: 37 };
    s.metrics.gpu!.vram = { used: 30_600, total: 32_607, percentage: 94, available: 2_000 };
    const c = kioskCard(s, null, vramContextFor(s, [s]));
    expect(c.memory?.label).toBe("VRAM");
    expect(c.memory?.ram).toBe("45.0 / 123.2 GB");
  });

  it("treats a Mac host's memory as one unified pool, with the system's available memory as headroom", () => {
    const s = makeSpark("mac");
    s.kind = "host";
    s.platform = "darwin";
    s.metrics.ram = { used: 130_700, total: 262_144, percentage: 50 };
    s.metrics.gpu!.vram = { used: 130_700, total: 262_144, percentage: 50, available: 131_400 };
    s.metrics.unifiedMemory = { total: 262_144, gpuUsed: 0, cpuUsed: 130_700, used: 130_700, available: 131_400, percentage: 50, oomRisk: "low", bandwidth: { current: 0, peak: 0 } };
    const c = kioskCard(s, null, vramContextFor(s, [s]));
    expect(c.memory?.label).toBe("Unified memory");
    expect(c.memory?.free).toBe("128.3 GB free");
    expect(c.memory?.ram).toBeNull();
    // The collector cannot split a Mac's pool: its "GPU" figure is everything in use.
    expect(c.memory?.legend).toEqual([{ key: "gpu", label: "In use", gb: "127.6" }]);
  });

  it("shows an unmeasured rate as unknown, not as 0", () => {
    const s = makeSpark("a");
    s.metrics.llm[0].measurementValid = false;
    expect(kioskCard(s, null, null).rates).toEqual({ decode: "—", prefill: "—", decodeLive: false });
  });

  it("gives a worker its live head's model, and says why when the head has none", () => {
    const head = { ...makeSpark("h"), role: "head" } as SparkSnapshot;
    head.metrics.llm[0].modelId = "DeepSeek-V4";
    head.metrics.llm[0].contextLength = 131_072;
    const worker = { ...makeSpark("w"), role: "worker", workerHeadId: "h" } as SparkSnapshot;
    const c = kioskCard(worker, head, null);
    expect(c.rates).toBeNull();
    expect(c.workerOf).toEqual({ name: "Spark h" });
    expect(c.model).toEqual({ text: "DeepSeek-V4", ctx: "128k ctx", muted: false });
    const offlineHead = { ...head, online: false } as SparkSnapshot;
    expect(kioskCard(worker, offlineHead, null).model).toEqual({ text: "Head offline", ctx: null, muted: true });
    // No head and no label: no pill repeating the role badge.
    const lone = { ...makeSpark("x"), role: "worker" } as SparkSnapshot;
    expect(kioskCard(lone, null, null).model).toBeNull();
    expect(kioskCard({ ...lone, workerLabel: "GLM" } as SparkSnapshot, null, null).model).toEqual({ text: "GLM", ctx: null, muted: false });
  });

  it("does not claim no model is loaded while the GPU is busy and no endpoint answers", () => {
    const s = makeSpark("m");
    s.metrics.llm = [];
    s.metrics.gpu!.usage = 100;
    s.metrics.gpu!.vram = { used: 130_000, total: 262_144, percentage: 50, available: 132_000 };
    expect(kioskCard(s, null, null).model?.text).toBe("No LLM answering · GPU in use");
  });

  it("reports the root disk's free space and the IP", () => {
    const s = makeSpark("a");
    s.lanIp = "10.0.0.5";
    s.metrics.storage = [
      { label: "/data", device: "sdb1", total: 9e6, used: 1, available: 8e6, percentage: 1, readSpeed: 0, writeSpeed: 0 },
      { label: "/", device: "nvme0n1p2", total: 3e6, used: 2e6, available: 1e6, percentage: 66, readSpeed: 0, writeSpeed: 0 },
    ];
    const c = kioskCard(s, null, null);
    expect(c.diskFreeMb).toBe(1e6);
    expect(c.ip).toBe("10.0.0.5");
  });
});

describe("kioskFleetStats", () => {
  it("takes the hottest GPU and sums queues over online, measured endpoints only", () => {
    const a = makeSpark("a");
    a.metrics.llm[0].requestsWaiting = 2;
    a.metrics.llm[0].requestsRunning = 3;
    const b = makeSpark("b");
    b.metrics.gpu!.temperature = 71;
    b.metrics.llm[0].measurementValid = false;
    b.metrics.llm[0].requestsWaiting = 50;
    const off = makeSpark("c", false);
    expect(kioskFleetStats([a, b, off])).toEqual({ online: 2, total: 3, gpuTempMaxC: 71, queued: 2, running: 3 });
  });

  it("reports an unknown queue as null, not 0", () => {
    expect(kioskFleetStats([makeSpark("a")]).queued).toBeNull();
  });
});

describe("tracesFromHistory", () => {
  const step = 60_000;
  const now = 100 * step + 30_000;

  it("aligns buckets to the minute holding now, leaves unreported minutes as gaps and sums endpoints", () => {
    const points = [
      { t: 100 * step, gpuUtil: { avg: 40, max: 90 }, cpuUtil: { avg: 5, max: 9 } },
      { t: 98 * step, gpuUtil: { avg: 10, max: 10 } },
      { t: 50 * step, gpuUtil: { avg: 99, max: 99 } },
    ];
    const llm = [
      { points: [{ t: 100 * step, genTps: { avg: 12, max: 30 }, prefillTps: { avg: 500, max: 900 } }] },
      { points: [{ t: 100 * step, genTps: { avg: 8, max: 8 } }] },
    ];
    const t = tracesFromHistory(points, llm, step, now, 5);
    expect(t.gpu).toEqual([null, null, 10, null, 40]);
    expect(t.cpu).toEqual([null, null, null, null, 5]);
    expect(t.gen).toEqual([null, null, null, null, 20]);
    expect(t.prefill).toEqual([null, null, null, null, 500]);
  });
});

describe("smoothPath", () => {
  /** Every coordinate in a path, as numbers. */
  const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

  it("draws curves through the samples and breaks the line at a gap", () => {
    const d = smoothPath([[0, 10], [10, 20], [20, 15], null, [40, 5], [50, 5]]);
    expect(d.startsWith("M0.0 10.0C")).toBe(true);
    expect(d).toContain("M40.0 5.0C");
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("never overshoots: control points stay within the samples' range", () => {
    // A spike from a flat line: a plain spline would dip below the floor beside it.
    const ys = nums(smoothPath([[0, 90], [10, 90], [20, 10], [30, 90], [40, 90]])).filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(90);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
  });

  it("keeps a lone sample as a point to start from", () => {
    expect(smoothPath([null, [5, 5], null])).toBe("M5.0 5.0");
  });
});
