import { describe, expect, it } from "vitest";
import { headFor, makeHeadResolver, usableHead } from "./sparkHead";
import { isLlmServing } from "./vramBreakdown";

const u = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "standalone", online: true, ...extra });

describe("headFor", () => {
  it("returns the configured head, even when it is not a head by role", () => {
    const fleet = [u("a", { role: "head" }), u("b", { role: "standalone" }), u("w", { role: "worker", workerHeadId: "b" })];
    expect(headFor(fleet[2], fleet)?.id).toBe("b");
  });

  it("returns null for a configured head that is not in the fleet", () => {
    const fleet = [u("a", { role: "head" }), u("w", { role: "worker", workerHeadId: "gone" })];
    expect(headFor(fleet[1], fleet)).toBeNull();
  });

  it("falls back to the only head, and to null when that is ambiguous", () => {
    const one = [u("a", { role: "head" }), u("w", { role: "worker" })];
    expect(headFor(one[1], one)?.id).toBe("a");
    const two = [u("a", { role: "head" }), u("b", { role: "head" }), u("w", { role: "worker" })];
    expect(headFor(two[2], two)).toBeNull();
    expect(headFor(one[1], null)).toBeNull();
  });

  it("makeHeadResolver answers every unit from one index", () => {
    const fleet = [u("a", { role: "head" }), u("w1", { role: "worker" }), u("w2", { role: "worker", workerHeadId: "a" })];
    const resolve = makeHeadResolver(fleet);
    expect(resolve(fleet[1])?.id).toBe("a");
    expect(resolve(fleet[2])?.id).toBe("a");
  });
});

describe("usableHead", () => {
  it("drops an offline head but keeps one with unknown reachability", () => {
    expect(usableHead(u("a", { online: false }))).toBeNull();
    expect(usableHead(u("a", { online: undefined }))?.id).toBe("a");
    expect(usableHead(null)).toBeNull();
  });
});

describe("serving uses the shared head resolution", () => {
  const llm = { metrics: { llm: [{ available: true }] } };
  it("a worker serves through its online head only", () => {
    const worker = u("w", { role: "worker", workerHeadId: "h" });
    expect(isLlmServing(worker, [u("h", { role: "head", ...llm }), worker])).toBe(true);
    expect(isLlmServing(worker, [u("h", { role: "head", online: false, ...llm }), worker])).toBe(false);
  });
});
