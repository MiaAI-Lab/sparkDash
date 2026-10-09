// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolEvalSpec } from "../../../api/types";
import { rovingNext } from "./a11y";
import { compareToolResults, deltaDigits } from "./compare";
import { mergeLines } from "./hooks";
import { normalizeCategories, normalizeToolResult } from "./normalize";
import { apiKeyFor, buildRequest, emptyState, loadState, validateField } from "./options";
import { keptValues } from "./presets";
import { clampTrials, trialsOf, withTrials } from "./TrialsRow";

const arg = (name: string, kind: string, extra: object = {}) => ({ name, flag: `--${name}`, kind, group: "g", label: name[0].toUpperCase() + name.slice(1), help: "", ...extra });
const SPEC = { groups: [], args: [arg("base-url", "url"), arg("api-key", "secret"), arg("seed", "int"), arg("temperature", "float"), arg("system-prompt-file", "path"), arg("note", "string")], backends: [], categories: [], types: {}, install: { extras: [] } } as unknown as ToolEvalSpec;

describe("mergeLines", () => {
  it("appends only lines newer than the buffer", () => {
    const prev = [{ seq: 1 }, { seq: 2 }];
    expect(mergeLines(prev, [{ seq: 2 }, { seq: 3 }])).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    expect(mergeLines(prev, [{ seq: 1 }])).toBe(prev);
    expect(mergeLines(prev, [])).toBe(prev);
  });
  it("starts from an empty buffer and trims to the cap", () => {
    expect(mergeLines([], [{ seq: 5 }])).toEqual([{ seq: 5 }]);
    const many = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1 }));
    expect(mergeLines([], many, 4).map((l) => l.seq)).toEqual([7, 8, 9, 10]);
  });
});

describe("trials", () => {
  it("clamps to 1..50 and treats junk as 1", () => {
    expect([clampTrials(0), clampTrials(-3), clampTrials(7.4), clampTrials(99), clampTrials(NaN)]).toEqual([1, 1, 7, 50, 1]);
  });
  it("reads trialsOf from the form, 1 when unset or invalid", () => {
    const st = emptyState("tool-eval");
    expect(trialsOf(st)).toBe(1);
    st.values.trials = "12";
    expect(trialsOf(st)).toBe(12);
    st.values.trials = "abc";
    expect(trialsOf(st)).toBe(1);
  });
  it("withTrials sets, clamps and drops the option at 1", () => {
    const st = emptyState("tool-eval");
    st.values.seed = "42";
    expect(withTrials(st, 5).values).toEqual({ seed: "42", trials: "5" });
    expect(withTrials(st, 500).values.trials).toBe("50");
    expect(withTrials(withTrials(st, 5), 1).values).toEqual({ seed: "42" });
  });
});

describe("loadState", () => {
  beforeEach(() => localStorage.clear());
  const put = (v: string) => localStorage.setItem("sparkdash.tooleval.options.tool-eval", v);
  it("returns null for malformed JSON, arrays and wrong shapes", () => {
    expect(loadState("tool-eval")).toBeNull();
    put("{not json");
    expect(loadState("tool-eval")).toBeNull();
    put("null");
    expect(loadState("tool-eval")).toBeNull();
    put(JSON.stringify({ values: ["a", "b"] }));
    expect(loadState("tool-eval")).toBeNull();
    put(JSON.stringify({ values: "x" }));
    expect(loadState("tool-eval")).toBeNull();
  });
  it("restores a valid state and defaults bad fields", () => {
    put(JSON.stringify({ values: { seed: "1" }, extraArgs: 5, port: "x", suites: ["a", 3] }));
    expect(loadState("tool-eval")).toEqual({ values: { seed: "1" }, extraArgs: "", port: null, suites: ["a"] });
  });
});

describe("api key and target", () => {
  it("never sends a typed key without a base URL", () => {
    const st = emptyState("tool-eval");
    expect(buildRequest(SPEC, "tool-eval", st, "sk-1").options).toEqual({});
    st.values["base-url"] = "   ";
    expect(buildRequest(SPEC, "tool-eval", st, "sk-1").options["api-key"]).toBeUndefined();
    expect(apiKeyFor(st, "sk-1")).toBe("");
    st.values["base-url"] = "http://h:1/v1";
    expect(buildRequest(SPEC, "tool-eval", st, "sk-1").options["api-key"]).toBe("sk-1");
    expect(apiKeyFor(st, "sk-1")).toBe("sk-1");
  });
  it("keeps the target and trials across presets", () => {
    expect(keptValues({ "base-url": "http://h", model: " ", trials: "3", seed: "42" })).toEqual({ "base-url": "http://h", trials: "3" });
  });
});

describe("validateField vs toApiValue on whitespace", () => {
  it("whitespace-only values are neither an error nor sent", () => {
    for (const name of ["seed", "temperature", "system-prompt-file", "note", "base-url"]) {
      const a = SPEC.args.find((x) => x.name === name)!;
      expect(validateField(a, "   ")).toBeNull();
      const st = emptyState("tool-eval");
      st.values[name] = "   ";
      expect(buildRequest(SPEC, "tool-eval", st).options[name]).toBeUndefined();
    }
  });
  it("still flags real junk", () => {
    expect(validateField(SPEC.args.find((x) => x.name === "seed")!, "abc")).toBe("Seed must be a number");
  });
});

describe("normalizeCategories shapes", () => {
  const pct = (r: unknown) => normalizeCategories({ category_scores: r }).map((c) => c.percent);
  it("prefers points / max_points over a score key", () => {
    expect(pct({ A: { score: 0.4, points: 3, max_points: 4 } })).toEqual([75]);
  });
  it("scales a ratio key and reads percent keys as is", () => {
    expect(pct({ A: { ratio: 0.5 }, B: { percent: 1 }, C: { pct: 80 } })).toEqual([50, 1, 80]);
  });
  it("scales bare 0..1 numbers only when all are ratios and one is fractional", () => {
    expect(pct({ A: 0.82, B: 0.5, C: 1 })).toEqual([82, 50, 100]);
    expect(pct({ A: 1, B: 0 })).toEqual([1, 0]); // a real 1% stays 1%
    expect(pct({ A: 0.5, B: 80 })).toEqual([0.5, 80]); // mixed scale: percent
  });
  it("applies the same rule to score keys, without needing a ratio key", () => {
    expect(pct({ A: { score: 0.9 }, B: { score: 0.4 } })).toEqual([90, 40]);
    expect(pct({ A: { score: 90 }, B: { score: 0.4 } })).toEqual([90, 0.4]);
  });
  it("handles arrays of category objects and missing data", () => {
    expect(normalizeCategories({ categories: [{ category: "B", points: 1, max_points: 2 }, { category: "A", percent: 10 }] }).map((c) => [c.id, c.percent])).toEqual([["A", 10], ["B", 50]]);
    expect(normalizeCategories({})).toEqual([]);
    expect(normalizeCategories(null)).toEqual([]);
  });
});

describe("compareToolResults rows", () => {
  const res = (scenarios: Record<string, string>, extra: object = {}) =>
    normalizeToolResult({ final_score: 80, scores: { category_scores: { A: 50 }, scenario_results: Object.entries(scenarios).map(([id, status]) => ({ scenario_id: id, status })) }, ...extra })!;
  it("returns every row with its kind, worst changes first", () => {
    const c = compareToolResults(res({ "TC-1": "pass", "TC-2": "fail", "TC-3": "pass" }), res({ "TC-1": "fail", "TC-2": "pass", "TC-3": "pass", "TC-4": "pass" }));
    expect(c.rows.map((r) => `${r.id}:${r.kind}`)).toEqual(["TC-1:regression", "TC-2:improvement", "TC-3:same", "TC-4:only-b"]);
    expect(c.changes.map((r) => r.id)).toEqual(["TC-1", "TC-2", "TC-4"]);
    expect(c.unchanged).toBe(1);
  });
  it("shows no counts for a side without scenarios", () => {
    const c = compareToolResults(res({}), res({ "TC-1": "pass" }));
    expect(c.hasScenarios).toEqual({ a: false, b: true });
    const passed = c.headline.find((h) => h.label === "Passed")!;
    expect(passed.a).toBeNull();
    expect(passed.delta).toBeNull();
    const none = compareToolResults(res({}), res({}));
    expect(none.rows).toEqual([]);
    expect(none.hasScenarios).toEqual({ a: false, b: false });
  });
  it("picks digits from the value scale so small ratio changes stay visible", () => {
    expect(deltaDigits(0.91, 0.93)).toBe(3);
    expect(deltaDigits(80, 81)).toBe(1);
    expect(deltaDigits(1, 2, true)).toBe(0);
    const c = compareToolResults(res({}, { deployability: 0.91 }), res({}, { deployability: 0.93 }));
    expect(c.headline.find((h) => h.label === "Deployability")!.digits).toBe(3);
  });
});

describe("rovingNext", () => {
  it("wraps with arrows and jumps with Home/End", () => {
    expect(rovingNext("ArrowRight", 2, 3)).toBe(0);
    expect(rovingNext("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingNext("Home", 2, 3)).toBe(0);
    expect(rovingNext("End", 0, 3)).toBe(2);
    expect(rovingNext("ArrowDown", 0, 3, "horizontal")).toBeNull();
    expect(rovingNext("ArrowDown", 0, 3)).toBe(1);
    expect(rovingNext("a", 0, 3)).toBeNull();
  });
});
