import { describe, expect, it } from "vitest";
import type { ToolEvalSpec } from "../../../api/types";
import { compareGeneric, compareToolResults, configCaveats } from "./compare";
import { estimateRemaining, explainErrorCode, fmtDuration, scoreTier, toolNotes } from "./format";
import { collectTables, normalizeToolResult, suggestCharts, topMetrics } from "./normalize";
import { advancedFields, applyPreset, buildRequest, emptyState, groupFields, mapServerErrors, persistable, presetsFor, stateFromRun, typeConfig, validateState } from "./options";

const arg = (name: string, kind: string, group: string, extra: object = {}) => ({ name, flag: `--${name}`, kind, group, label: name[0].toUpperCase() + name.slice(1), help: "", ...extra });
const SPEC = {
  groups: [],
  args: [
    arg("base-url", "url", "connection"),
    arg("api-key", "secret", "connection"),
    arg("header", "repeat", "connection", { secret: true, itemPattern: "^[A-Za-z0-9-]+=.+$" }),
    arg("short", "bool", "scenarios"),
    arg("scenarios", "list", "scenarios", { itemPattern: "^[A-Za-z0-9-]+$" }),
    arg("categories", "list", "scenarios", { choices: ["A", "B"] }),
    arg("temperature", "float", "sampling", { min: 0, max: 5 }),
    arg("seed", "int", "sampling", { min: 0, max: 100 }),
    arg("timeout", "float", "run", { min: 1 }),
    arg("system-prompt", "text", "run", { maxBytes: 10 }),
    arg("system-prompt-file", "path", "run"),
    arg("perf", "bool", "throughput"),
    arg("perf-only", "bool", "throughput"),
    arg("depth", "csv", "throughput", { pattern: "^[0-9,]+$" }),
    arg("gsm8k", "bool", "gsm8k"),
    arg("gsm8k-only", "bool", "gsm8k"),
    arg("gsm8k-limit", "int", "gsm8k", { min: 0 }),
    arg("context-pressure", "float", "pressure", { min: 0, max: 1 }),
    arg("backend-kwargs", "json", "sampling"),
  ],
  backends: [],
  categories: [],
  types: {},
  install: { extras: [] },
} as unknown as ToolEvalSpec;

describe("options", () => {
  it("builds typed payloads and drops blanks", () => {
    const st = emptyState("tool-eval");
    st.values = { short: true, seed: "42", temperature: "0", "base-url": "  ", scenarios: "TC-01, TC-02", categories: ["A"], header: ["X=1", ""], timeout: "" };
    const r = buildRequest(SPEC, "tool-eval", st, "sk-1");
    expect(r.options).toEqual({ short: true, seed: 42, temperature: 0, scenarios: ["TC-01", "TC-02"], categories: ["A"], header: ["X=1"] }); // blank base URL: the typed key is not sent
    st.values["base-url"] = "http://h/v1";
    expect(buildRequest(SPEC, "tool-eval", st, "sk-1").options["api-key"]).toBe("sk-1");
  });
  it("forces the page's flags", () => {
    expect(buildRequest(SPEC, "throughput", emptyState("throughput")).options).toEqual({ "perf-only": true });
    const acc = emptyState("accuracy");
    acc.suites = ["gsm8k"];
    expect(buildRequest(SPEC, "accuracy", acc).options).toEqual({ "gsm8k-only": true });
  });
  it("keeps every option reachable (main form + advanced + managed)", () => {
    for (const type of Object.keys({ "tool-eval": 1, throughput: 1, "spec-decode": 1, "context-pressure": 1, accuracy: 1, needle: 1, decision: 1 })) {
      const shown = new Set<string>();
      typeConfig(type).groups.forEach((g) => groupFields(SPEC, type, g).forEach((f) => shown.add(f.name)));
      advancedFields(SPEC, type).forEach((f) => shown.add(f.name));
      const missing = SPEC.args.filter((a) => a.kind !== "secret" && !shown.has(a.name)).map((a) => a.name);
      const allowed = ["perf-only", "gsm8k-only"];
      expect(missing.every((m) => allowed.includes(m))).toBe(true);
    }
  });
  it("validates ranges, formats and cross rules", () => {
    const st = emptyState("tool-eval");
    st.values = { temperature: "9", seed: "1.5", depth: "a,b", "backend-kwargs": "[1]", "system-prompt": "x".repeat(20), short: true, scenarios: "TC-01" };
    const v = validateState(SPEC, "tool-eval", st);
    expect(Object.keys(v.fields).sort()).toEqual(["backend-kwargs", "depth", "seed", "system-prompt", "temperature"]);
    expect(v.form.join()).toMatch(/short run/);
  });
  it("requires a suite and a pressure setting", () => {
    const acc = emptyState("accuracy");
    acc.suites = [];
    expect(validateState(SPEC, "accuracy", acc).form).toHaveLength(1);
    expect(validateState(SPEC, "context-pressure", emptyState("context-pressure")).form).toHaveLength(1);
  });
  it("maps server errors onto fields", () => {
    const m = mapServerErrors(SPEC, ["Seed must be at most 100", "Something general"]);
    expect(m.fields.seed).toMatch(/Seed/);
    expect(m.form).toEqual(["Something general"]);
  });
  it("applies presets on top of an empty form", () => {
    const quick = presetsFor("tool-eval").find((p) => p.id === "quick")!;
    expect(applyPreset("tool-eval", quick).values).toEqual({ short: true });
    expect(applyPreset("accuracy", presetsFor("accuracy")[0]).suites).toEqual(["gsm8k", "mmlu", "ifeval"]);
  });
  it("round-trips a stored run into the form, skipping secrets", () => {
    const st = stateFromRun(SPEC, "accuracy", { port: 8000, options: { "gsm8k-only": true, "gsm8k-limit": 50, "api-key": "(saved key)", header: "(hidden)", extra: ["--foo", "1"] } });
    expect(st.suites).toEqual(["gsm8k"]);
    expect(st.values).toEqual({ "gsm8k-limit": "50" });
    expect(st.extraArgs).toBe("--foo 1");
    expect(st.port).toBe(8000);
  });
  it("never persists secrets", () => {
    const st = emptyState("tool-eval");
    st.values = { header: ["A=b"], "api-key": "x", seed: "1" };
    expect(persistable(SPEC, st).values).toEqual({ seed: "1" });
  });
});

describe("format", () => {
  it("formats durations, tiers, eta", () => {
    expect(fmtDuration(75)).toBe("1m 15s");
    expect(fmtDuration(3700)).toBe("1h 01m");
    expect(fmtDuration(null)).toBe("–");
    expect(scoreTier(90)?.label).toBe("Excellent");
    expect(scoreTier(74)?.label).toBe("Adequate");
    expect(scoreTier(10)?.stars).toBe(1);
    expect(estimateRemaining(30, 3, 9)).toBe(60);
    expect(estimateRemaining(30, 0, 9)).toBeNull();
    expect(explainErrorCode("no_server")).toMatch(/No model server/);
  });
});

const toolResult = (statuses: Record<string, string>, score = 50) => ({
  final_score: score,
  rating: "★★★ Adequate",
  safety_warnings: [],
  config: { model: "m" },
  scores: {
    category_scores: [{ category: "A", percent: score }, { category: "B", percent: 20, name: "Params" }],
    scenario_results: Object.entries(statuses).map(([id, status]) => ({ scenario_id: id, status, category: "A" })),
  },
});

describe("normalize + compare", () => {
  it("reads scenario results and categories, arrays or maps", () => {
    const n = normalizeToolResult(toolResult({ "TC-01": "pass", "TC-02": "partial", "TC-03": "FAILED" }))!;
    expect(n.counts).toEqual({ pass: 1, partial: 1, fail: 1, other: 0 });
    expect(n.categories.map((c) => c.id)).toEqual(["A", "B"]);
    const m = normalizeToolResult({ final_score: 1, scores: { category_scores: { A: 80, B: 0.5 }, scenario_results: { x: { status: true } } } })!;
    expect(m.categories[0].percent).toBe(80);
    expect(m.scenarios[0].status).toBe("pass");
    expect(normalizeToolResult("nope")).toBeNull();
  });
  it("diffs scenarios and categories", () => {
    const a = normalizeToolResult(toolResult({ "TC-01": "pass", "TC-02": "fail", "TC-03": "pass" }, 60))!;
    const b = normalizeToolResult(toolResult({ "TC-01": "fail", "TC-02": "pass", "TC-04": "pass" }, 70))!;
    const c = compareToolResults(a, b);
    expect(c.headline[0].delta).toBe(10);
    expect(c.changes.map((x) => `${x.id}:${x.kind}`)).toEqual(["TC-01:regression", "TC-02:improvement", "TC-03:only-a", "TC-04:only-b"]);
    expect(c.categories[0].delta).toBe(10);
  });
  it("diffs generic metrics", () => {
    const r = compareGeneric({ a: { tps: 100 }, rows: [{ id: "x", v: 1 }] }, { a: { tps: 110 }, rows: [{ id: "x", v: 1 }] });
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].pct).toBeCloseTo(10);
    expect(r.same).toBe(1);
  });
  it("flags config differences", () => {
    const base = { type: "tool-eval", model: "a", baseUrl: "u", options: { short: true, label: "x" } };
    expect(configCaveats(base, { ...base, options: { short: true, label: "y" } })).toEqual([]);
    expect(configCaveats(base, { ...base, model: "b", options: { seed: 1 } })).toHaveLength(2);
  });
  it("finds tables, tiles and charts in an unknown result", () => {
    const res = { summary: { best_tps: 120 }, results: [{ depth: 0, concurrency: 1, tg_tps: 50 }, { depth: 4096, concurrency: 1, tg_tps: 40 }, { depth: 0, concurrency: 2, tg_tps: 80 }, { depth: 4096, concurrency: 2, tg_tps: 60 }] };
    expect(topMetrics(res)[0]).toMatchObject({ label: "Summary best tps", value: 120 });
    const tables = collectTables(res);
    expect(tables[0].rows).toHaveLength(4);
    const charts = suggestCharts(tables[0]);
    expect(charts.length).toBeGreaterThan(0);
    expect(charts[0].points.map((p) => p.x)).toEqual([0, 4096]);
  });
});

describe("simple view templates", () => {
  const blank = { values: {}, extraArgs: "", suites: [] as string[] };

  it("Tool Eval offers the four basics", async () => {
    const { simpleTemplates } = await import("./presets");
    const t = simpleTemplates("tool-eval");
    expect(t.map((x) => x.id)).toEqual(["regular", "regular-hard", "short", "hard"]);
    expect(t[0].values).toEqual({ seed: "42" });
    expect(t[1].values).toEqual({ hardmode: true, seed: "42" });
    expect(t[2].values).toEqual({ short: true, seed: "42" });
    expect(t[3].values).toEqual({ "hardmode-only": true, seed: "42" });
    expect(t.every((x) => x.size && x.time && x.help)).toBe(true);
  });

  it("other pages offer their ready presets as templates", async () => {
    const { simpleTemplates, PRESETS } = await import("./presets");
    for (const type of ["throughput", "spec-decode", "context-pressure", "accuracy", "needle", "decision"]) {
      expect(simpleTemplates(type).map((x) => x.id)).toEqual(PRESETS[type].map((x) => x.id));
    }
    expect(simpleTemplates("nope")).toEqual([]);
  });

  it("recognises which template the form currently holds, and nothing else", async () => {
    const { simpleTemplates, matchesTemplate } = await import("./presets");
    const [regular, regularHard, short, hard] = simpleTemplates("tool-eval");
    const v = (values: Record<string, unknown>, extraArgs = "") => ({ ...blank, values, extraArgs });
    expect(matchesTemplate(v({ seed: "42" }), regular)).toBe(true);
    expect(matchesTemplate(v({ seed: "42" }), short)).toBe(false);
    expect(matchesTemplate(v({ hardmode: true, seed: "42" }), regularHard)).toBe(true);
    expect(matchesTemplate(v({ short: true, seed: "42" }), short)).toBe(true);
    expect(matchesTemplate(v({ short: true, seed: "42" }), regular)).toBe(false);
    expect(matchesTemplate(v({ "hardmode-only": true, seed: "42" }), hard)).toBe(true);
    // Blank-ish values count as unset, so a cleared field does not break the match.
    expect(matchesTemplate(v({ short: true, seed: "42", "no-think": false, model: "" }), short)).toBe(true);
    // A different seed, other tweaks or extra arguments mean "custom".
    expect(matchesTemplate(v({ short: true, seed: "7" }), short)).toBe(false);
    expect(matchesTemplate(v({ short: true }), short)).toBe(false);
    expect(matchesTemplate(v({ short: true, seed: "42", temperature: "0.5" }), short)).toBe(false);
    expect(matchesTemplate(v({ short: true, seed: "42" }, "--foo"), short)).toBe(false);
  });

  it("a custom URL or model is a target, not a tweak: templates still match", async () => {
    const { simpleTemplates, matchesTemplate } = await import("./presets");
    const short = simpleTemplates("tool-eval")[2];
    const v = { ...blank, values: { short: true, seed: "42", "base-url": "https://x.example/v1", model: "m" } };
    expect(matchesTemplate(v, short)).toBe(true);
    expect(matchesTemplate({ ...v, values: { ...v.values, temperature: "0.5" } }, short)).toBe(false);
  });

  it("matches accuracy templates by their suites too", async () => {
    const { simpleTemplates, matchesTemplate } = await import("./presets");
    const quick = simpleTemplates("accuracy")[0];
    const state = { values: { ...quick.values }, extraArgs: "", suites: [...(quick.suites ?? [])] };
    expect(matchesTemplate(state, quick)).toBe(true);
    expect(matchesTemplate({ ...state, suites: ["gsm8k"] }, quick)).toBe(false);
  });
});

describe("toolNotes", () => {
  const L = (...t: string[]) => t.map((text) => ({ text }));

  it("explains an excluded scenario in plain words, once, without the HTTP 400 jargon", () => {
    const notes = toolNotes(
      L(
        "Server returned 400 for http://***:8888/v1/chat/completions: tool_choice required not supported",
        "Endpoint rejected tool_choice=required with HTTP 400; treating as unsupported",
        "Excluding TC-45 from scoring: the endpoint does not enforce tool_choice='required'.",
        "Excluding TC-45 from scoring: the endpoint does not enforce tool_choice='required'."
      )
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/forced tool calls/);
    expect(notes[0].text).toContain("TC-45");
    expect(notes[0].text).not.toMatch(/400|rejected/);
  });

  it("lists several excluded scenarios and handles an exclusion with another reason", () => {
    expect(toolNotes(L("tool_choice not supported", "Excluding TC-45 from scoring: x", "Excluding TC-46 from scoring: x"))[0].text).toContain("TC-45, TC-46");
    expect(toolNotes(L("Excluding TC-07 from scoring: no network"))[0].text).toMatch(/TC-07 was left out/);
  });

  it("says nothing about ordinary output", () => {
    expect(toolNotes(L("TC-01 pass", "done"))).toEqual([]);
    expect(toolNotes([])).toEqual([]);
  });
});
