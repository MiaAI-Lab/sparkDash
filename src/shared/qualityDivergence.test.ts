import { describe, expect, it } from "vitest";
import { commonPrefixChars, compareDivergence, detectLoop, divergenceRates, editDistanceNorm } from "./qualityDivergence.js";

const row = (id: string, kind: string, reply: string, extra: Record<string, unknown> = {}) => ({
  id, category: "divergence", kind, ok: true, reply, hash: `h-${reply}`, error: null, terminated: true, loop: { loop: false, cycle: null, tailShare: 0 }, chars: reply.length, completionTokens: Math.ceil(reply.length / 4), ...extra,
});

describe("WP3 divergence helpers", () => {
  it("detectLoop finds a repeating tail and ignores short or varied text", () => {
    expect(detectLoop("one two three four five six seven eight nine ten eleven twelve").loop).toBe(false);
    const looping = `A fine start to the story about a bridge. ${"the river ran and ran, ".repeat(30)}`;
    const d = detectLoop(looping);
    expect(d.loop).toBe(true);
    expect(d.cycle).toBe(5);
    expect(d.tailShare).toBeGreaterThan(0.9);
    const varied = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    expect(detectLoop(varied).loop).toBe(false);
    // a short repeat at the end of a long varied text is not a loop
    expect(detectLoop(`${varied} again again again`).loop).toBe(false);
  });

  it("commonPrefixChars and editDistanceNorm", () => {
    expect(commonPrefixChars("abcdef", "abcxyz")).toBe(3);
    expect(commonPrefixChars("", "a")).toBe(0);
    expect(editDistanceNorm("kitten", "sitting")).toBeCloseTo(3 / 7, 4);
    expect(editDistanceNorm("same", "same")).toBe(0);
    expect(editDistanceNorm("", "abc")).toBe(1);
    expect(editDistanceNorm("x".repeat(5000), "x".repeat(5000))).toBe(0);
  });

  it("divergenceRates and compareDivergence", () => {
    const longA = `${"Heading\n".repeat(1)}${"alpha beta gamma delta ".repeat(500)}`; // 11.5k chars
    const longB = `${longA.slice(0, 5000)}DIFFERENT${longA.slice(5009)}`;
    const a = { results: { items: [
      row("div-prose-01", "prose", "the same reply"),
      row("div-prose-02", "prose", "hello world, this is run A"),
      row("div-json-01", "json", '{"a":1}', { json: { valid: true, schema: true } }),
      row("div-tool-01", "tool", "", { tool: { called: true, nameOk: true, argsOk: false } }),
      row("div-long-01", "long", longA),
      row("div-code-01", "code", "x", { error: "timeout" }),
    ] } };
    const b = { results: { items: [
      row("div-prose-01", "prose", "the same reply"),
      row("div-prose-02", "prose", "hello world, this is run B and longer", { loop: { loop: true, cycle: 2, tailShare: 0.5 }, terminated: false }),
      row("div-json-01", "json", '{"a":1}', { json: { valid: true, schema: true } }),
      row("div-tool-01", "tool", "", { tool: { called: true, nameOk: true, argsOk: true } }),
      row("div-long-01", "long", longB),
      row("div-code-01", "code", "y"),
    ] } };
    const ra = divergenceRates(a.results.items);
    expect(ra.rows).toBe(5);
    expect(ra.jsonValidPct).toBe(100);
    expect(ra.toolOkPct).toBe(0);
    expect(ra.terminatedPct).toBe(100);
    const c = compareDivergence(a, b)!;
    expect(c.paired).toBe(5);
    // prose-01, json-01 and the tool row (both replies empty; the server's hash also covers the tool calls)
    expect(c.identical).toBe(3);
    expect(c.identicalPct).toBe(60);
    const p2 = c.pairs.find((p) => p.id === "div-prose-02")!;
    expect(p2.identical).toBe(false);
    expect(p2.firstDivergence).toBe("hello world, this is run ".length);
    expect(p2.loopB).toBe(true);
    expect(p2.terminatedB).toBe(false);
    expect(p2.lenRatio).toBeLessThan(1);
    expect(c.loopsB).toBe(1);
    expect(c.terminatedB).toBe(4);
    // long drift: identical through 1,024 and 4,096 chars, not through 8,192
    expect(c.drift.map((d) => d.identicalPct)).toEqual([100, 100, 0]);
    expect(c.kinds.prose.paired).toBe(2);
    expect(c.kinds.prose.identicalPct).toBe(50);
    expect(c.medianFirstDivergence).toBeGreaterThan(0);
    expect(compareDivergence(a, { results: { items: [] } })).toBeNull();
  });
});
