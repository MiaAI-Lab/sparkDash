import { describe, expect, it } from "vitest";
import { backendLabel } from "./llmBackends.js";
import {
  HEADROOM_THRESHOLDS_MB,
  computeVramBreakdown,
  headroomMiniStatTone,
  headroomTone,
  isLlmServing,
  legendItems,
  memoryModelFor,
  servingEndpoint,
  verdict,
  vramContextFor,
  type ServingUnitLike,
} from "./vramBreakdown";

/** spark-1 as observed live: TensorFold's python3 holds 98.6 GB of the unified pool. */
const SPARK1_UM = {
  total: 124_610,
  gpuUsed: 101_008,
  cpuUsed: 16_190,
  used: 117_198,
  available: 7_412,
  percentage: 94,
  oomRisk: "high" as const,
};
const SPARK1_VRAM = { used: 101_008, total: 124_610, available: 7_412 };
const SPARK1_PROCS = [{ pid: 92_271, name: "python3", vramMB: 101_008 }];

/** RTX PRO 6000 host as observed live: sglang::scheduler 93932 MB + python 550 MB. */
const RTX_VRAM = { used: 94_612, total: 97_887, available: 3_275 };
const RTX_PROCS = [
  { pid: 4009, name: "sglang::scheduler", vramMB: 93_932 },
  { pid: 3824, name: "python", vramMB: 550 },
];
const SGLANG_EP = {
  available: true,
  backend: "sglang" as const,
  kvCacheUsage: 0.05,
  kvCacheGb: 10.729,
  weightsGb: 71.066,
};

describe("headroomTone", () => {
  it("judges a unified pool: amber under 8 GB, red under 4 GB", () => {
    expect(HEADROOM_THRESHOLDS_MB.unified).toEqual({ low: 8192, critical: 4096 });
    expect(headroomTone(16_384, "unified")).toBe("ok");
    expect(headroomTone(8192, "unified")).toBe("ok");
    expect(headroomTone(8191, "unified")).toBe("low");
    expect(headroomTone(7_412, "unified")).toBe("low"); // spark-1
    expect(headroomTone(4096, "unified")).toBe("low");
    expect(headroomTone(4095, "unified")).toBe("critical");
    expect(headroomTone(0, "unified")).toBe("critical");
  });

  it("judges a discrete card: amber under 2 GB, red under 1 GB", () => {
    expect(HEADROOM_THRESHOLDS_MB.discrete).toEqual({ low: 2048, critical: 1024 });
    expect(headroomTone(3_275, "discrete")).toBe("ok"); // RTX PRO 6000
    expect(headroomTone(2048, "discrete")).toBe("ok");
    expect(headroomTone(2047, "discrete")).toBe("low");
    expect(headroomTone(1024, "discrete")).toBe("low");
    expect(headroomTone(1023, "discrete")).toBe("critical");
  });

  it("treats an unknown figure as no headroom", () => {
    expect(headroomTone(Number.NaN, "discrete")).toBe("critical");
  });

  it("maps to the Overview mini-stat tones", () => {
    expect(headroomMiniStatTone("ok")).toBe("default");
    expect(headroomMiniStatTone("low")).toBe("warning");
    expect(headroomMiniStatTone("critical")).toBe("danger");
  });

  it("a host is discrete, a Spark (or unknown kind) unified", () => {
    expect(memoryModelFor("host")).toBe("discrete");
    expect(memoryModelFor("spark")).toBe("unified");
    expect(memoryModelFor(undefined)).toBe("unified");
  });
});

describe("isLlmServing / servingEndpoint", () => {
  const head = (online: boolean, available: boolean): ServingUnitLike => ({
    id: "spark-1",
    online,
    role: "head",
    metrics: { llm: [{ available, backend: "tensorfold", kvCacheUsage: 0.0549 }] },
  });
  const worker = (workerHeadId: string | null = "spark-1"): ServingUnitLike => ({
    id: "spark-2",
    online: true,
    role: "worker",
    workerHeadId,
    metrics: { llm: [] },
  });

  it("a standalone or head serves when one of its own endpoints is available", () => {
    const standalone = (llm: Array<{ available: boolean }>): ServingUnitLike => ({
      id: "rtx",
      role: "standalone",
      metrics: { llm },
    });
    expect(isLlmServing(standalone([{ available: false }, { available: true }]), [])).toBe(true);
    expect(isLlmServing(head(true, true), undefined)).toBe(true);
    expect(isLlmServing(standalone([]), [])).toBe(false);
    expect(isLlmServing(standalone([{ available: false }]), [])).toBe(false);
    expect(isLlmServing({ id: "rtx", metrics: null }, [])).toBe(false);
  });

  it("a worker serves when its head is online with an available endpoint", () => {
    const w = worker();
    expect(isLlmServing(w, [head(true, true), w])).toBe(true);
    // legacy workerNode flag resolves to the same role
    expect(
      isLlmServing({ id: "w", workerNode: true, workerHeadId: "spark-1", metrics: { llm: [] } }, [
        head(true, true),
      ]),
    ).toBe(true);
    // ...and quotes the head's engine
    expect(servingEndpoint(w, [head(true, true)])?.kvCacheUsage).toBe(0.0549);
  });

  it("a worker whose head is offline, not serving, or unknown does not serve", () => {
    expect(isLlmServing(worker(), [head(false, true)])).toBe(false);
    expect(isLlmServing(worker(), [head(true, false)])).toBe(false);
    expect(isLlmServing(worker("spark-9"), [head(true, true)])).toBe(false);
    expect(isLlmServing(worker(null), [head(true, true)])).toBe(false);
    expect(isLlmServing(worker(), undefined)).toBe(false);
  });

  it("names no endpoint when two engines are up on one unit", () => {
    const two: ServingUnitLike = {
      id: "rtx",
      metrics: { llm: [{ available: true }, { available: true }] },
    };
    expect(isLlmServing(two, [])).toBe(true);
    expect(servingEndpoint(two, [])).toBeNull();
  });
});

describe("computeVramBreakdown", () => {
  it("splits spark-1's unified pool into engine, system and free", () => {
    const b = computeVramBreakdown(SPARK1_VRAM, SPARK1_PROCS, {
      model: "unified",
      unified: SPARK1_UM,
      serving: true,
      endpoint: { available: true, backend: "tensorfold", kvCacheUsage: 0.0549 },
    })!;
    expect(b.totalMB).toBe(124_610);
    expect(b.usedMB).toBe(117_198);
    expect(b.segments).toEqual([
      { key: "engine", mb: 101_008 },
      { key: "system", mb: 16_190 },
    ]);
    expect(b.engine).toEqual({ name: "python3", pid: 92_271, mb: 101_008 });
    expect(b.systemMB).toBe(16_190);
    expect(b.otherMB).toBe(0);
    expect(b.freeMB).toBe(7_412);
    expect(b.tone).toBe("low");
    expect(b.kv).toEqual({ usage: 0.0549, poolGb: null, weightsGb: null, backend: "TensorFold" });
    expect(legendItems(b).map((i) => `${i.label} ${i.gb}`)).toEqual([
      "Engine 98.6",
      "System 15.8",
      "Free 7.2",
    ]);
    expect(verdict(b)).toBe("Low headroom: CPU-side growth could trigger the OOM killer");
  });

  it("shows one GPU segment when the unit is not serving", () => {
    const b = computeVramBreakdown(SPARK1_VRAM, SPARK1_PROCS, {
      model: "unified",
      unified: SPARK1_UM,
      serving: false,
    })!;
    expect(b.engine).toBeNull();
    expect(b.kv).toBeNull();
    expect(b.segments).toEqual([
      { key: "system", mb: 16_190 },
      { key: "gpu", mb: 101_008 },
    ]);
    expect(b.tone).toBe("low"); // headroom does not depend on who holds the memory
  });

  it("splits the RTX PRO 6000 into engine, other and free with discrete thresholds", () => {
    const b = computeVramBreakdown(RTX_VRAM, RTX_PROCS, {
      model: "discrete",
      unified: SPARK1_UM, // ignored for a discrete card
      serving: true,
      endpoint: SGLANG_EP,
    })!;
    expect(b.totalMB).toBe(97_887);
    expect(b.segments).toEqual([
      { key: "engine", mb: 93_932 },
      { key: "other", mb: 680 },
    ]);
    expect(b.systemMB).toBeNull();
    expect(b.freeMB).toBe(3_275);
    expect(b.tone).toBe("ok");
    expect(b.kv).toEqual({ usage: 0.05, poolGb: 10.729, weightsGb: 71.066, backend: backendLabel("sglang") });
    expect(legendItems(b).map((i) => `${i.label} ${i.gb}`)).toEqual([
      "Engine 91.7",
      "Other 0.7",
      "Free 3.2",
    ]);
    expect(verdict(b)).toBe("Plenty of headroom");
  });

  it("takes discrete headroom as total − used, not the collector's system-RAM fallback", () => {
    // The host collector leaves MemAvailable in vram.available while no GPU process runs.
    const b = computeVramBreakdown(
      { used: 0, total: 97_887, available: 250_000 },
      [],
      { model: "discrete", unified: null, serving: false },
    )!;
    expect(b.freeMB).toBe(97_887);
    expect(b.segments).toEqual([]);
  });

  it("flags a nearly full KV pool and a critical discrete card in the verdict", () => {
    const full = computeVramBreakdown(RTX_VRAM, RTX_PROCS, {
      model: "discrete",
      unified: null,
      serving: true,
      endpoint: { ...SGLANG_EP, kvCacheUsage: 0.9 },
    })!;
    expect(verdict(full)).toBe("Engine KV pool nearly full: new requests queue or get preempted");
    const tight = computeVramBreakdown({ used: 97_000, total: 97_887, available: 887 }, RTX_PROCS, {
      model: "discrete",
      unified: null,
      serving: true,
    })!;
    expect(tight.tone).toBe("critical");
    expect(verdict(tight)).toBe(
      "Very low headroom: a new GPU allocation could fail with out of memory",
    );
  });

  it("falls back to gpu.vram on a Spark without unifiedMemory", () => {
    const b = computeVramBreakdown(SPARK1_VRAM, SPARK1_PROCS, {
      model: "unified",
      unified: null,
      serving: true,
    })!;
    expect(b.systemMB).toBeNull();
    expect(b.freeMB).toBe(7_412);
    expect(b.segments).toEqual([{ key: "engine", mb: 101_008 }]);
  });

  it("never gives the engine more than is in use, and needs a total", () => {
    const b = computeVramBreakdown({ used: 4_000, total: 8_000, available: 4_000 }, [
      { pid: 1, name: "x", vramMB: 6_000 },
    ], { model: "discrete", unified: null, serving: true })!;
    expect(b.engine?.mb).toBe(4_000);
    expect(computeVramBreakdown({ used: 1, total: 0, available: 0 }, [], {
      model: "discrete",
      unified: null,
      serving: false,
    })).toBeNull();
  });

  it("vramContextFor wires kind, unified memory, serving and the endpoint", () => {
    const ctx = vramContextFor(
      {
        id: "rtx",
        kind: "host",
        role: "standalone",
        metrics: { llm: [SGLANG_EP], unifiedMemory: SPARK1_UM },
      },
      [],
    );
    expect(ctx).toEqual({ model: "discrete", unified: null, serving: true, endpoint: SGLANG_EP });
  });
});
