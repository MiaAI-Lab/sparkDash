import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SparkSnapshot, ToolEvalRun, ToolEvalSpec } from "../../../api/types";
import { i18next, setLocale } from "../../../i18n";
import { cleanupRenders, render } from "../../../testing/render";
import { localizeToolEvalSpec } from "./localizeSpec";
import { localizeToolEvalError } from "./localizeError";
import { localizeBenchText } from "./benchText";
import { PRESETS, simpleTemplates } from "./presets";
import { emptyState, mapServerErrors, presetsFor } from "./options";
import { toolNotes } from "./format";
import { normalizeToolResult } from "./normalize";
import { SimpleConfig } from "./SimpleConfig";
import { ToolResult } from "./ToolResult";
import { SideBySide } from "./SideBySide";
import { History } from "./History";
import { LiveRun } from "./LiveRun";
import type { Followed } from "./hooks";
import { CopyButton } from "./parts";

let spec: ToolEvalSpec;
beforeAll(async () => {
  // The same server-owned schema used by GET /api/tool-eval/spec.
  const schemaPath = "../../../../server/tooleval/spec.js";
  const schema = await import(/* @vite-ignore */ schemaPath);
  spec = { ...schema.publicSpec(), types: {}, install: { extras: [] } };
});
afterEach(async () => {
  cleanupRenders();
  await setLocale("en", { persist: false });
});

const run: ToolEvalRun = {
  id: "run-1", sparkId: "spark-1", type: "tool-eval", typeLabel: "Tool Eval Bench",
  status: "completed", startedAt: 1700000000000, finishedAt: 1700000005000,
  exitCode: 0, label: "", port: 8888, model: "raw-model-name", baseUrl: "http://host/v1",
  command: "tool-eval-bench --seed 42", options: { seed: 42 }, summary: null, resultCached: true,
};
const rawResult = {
  final_score: 95, rating: "★★★★★ Excellent", total_scenarios: 1,
  scores: { category_scores: { A: 100 }, scenario_results: [{ id: "TC-01", title: "Raw scenario title", status: "pass", category: "A", reasoning: "Raw model reasoning" }] },
};

describe("benchmark language projection", () => {
  it("covers every server schema label/help while preserving all CLI and validation data", async () => {
    const before = structuredClone(spec);
    await setLocale("zh-Hans", { persist: false });
    const translated = localizeToolEvalSpec(spec, i18next.t);
    expect(translated.args).toHaveLength(83);
    expect(translated.groups).toHaveLength(15);
    for (let i = 0; i < spec.args.length; i++) {
      const { label, help, ...rest } = translated.args[i];
      const { label: _label, help: _help, ...original } = spec.args[i];
      expect(rest).toEqual(original);
      expect(label).not.toContain("bench.");
      expect(help, spec.args[i].name).toMatch(/[\u4e00-\u9fff]/);
    }
    for (const group of translated.groups) expect(group.help, group.id).toMatch(/[\u4e00-\u9fff]/);
    expect(spec).toEqual(before);
    await setLocale("en", { persist: false });
    expect(localizeToolEvalSpec(spec, i18next.t)).toEqual(spec);
  });

  it("translates every preset separately despite repeated quick/standard IDs", async () => {
    await setLocale("zh-Hans", { persist: false });
    for (const [type, presets] of Object.entries(PRESETS)) {
      const translated = presetsFor(type);
      expect(translated.map((p) => p.values)).toEqual(presets.map((p) => p.values));
      for (const preset of translated) {
        expect(preset.label).toMatch(/[\u4e00-\u9fff]/);
        expect(preset.help).toMatch(/[\u4e00-\u9fff]/);
      }
    }
    expect(presetsFor("throughput")[0].help).not.toBe(presetsFor("needle")[0].help);
    for (const template of simpleTemplates("tool-eval")) {
      expect(template.size).toContain("个场景");
      expect(template.time).toContain("分钟");
    }
  });

  it("localizes server validation without changing option IDs or diagnostics", async () => {
    await setLocale("zh-Hans", { persist: false });
    expect(mapServerErrors(spec, ["Temperature must be at most 5"]).fields.temperature).toBe("温度不能大于 5");
    expect(localizeToolEvalError('Unknown option "future-option"', spec)).toBe("未知选项“future-option”");
    expect(localizeToolEvalError("--json is controlled by sparkDash (or looks like it) and cannot be set here", spec)).toContain("--json 由 sparkDash 控制");
    expect(toolNotes([{ text: "tool_choice not supported" }, { text: "Excluding TC-45 from scoring" }])[0].text).toContain("TC-45");
    expect(toolNotes([{ text: "tool_choice not supported" }])[0].text).not.toContain("This model server");
    expect(localizeBenchText("Unknown model-generated title")).toBe("Unknown model-generated title");
  });

  it("translates every comparison metric label while preserving row identity", async () => {
    await setLocale("en", { persist: false });
    const data = normalizeToolResult(rawResult)!;
    const { container } = render(<SideBySide a={data} b={data} runA={run} runB={run} onSwap={() => {}} />);
    const rows = () => Array.from(container.querySelectorAll(".te-sbs__metrics .te-sbs__row"));
    const labels = () => Array.from(container.querySelectorAll(".te-sbs__metrics .te-sbs__label"), (node) => node.firstChild?.textContent?.trim());
    const english = ["Deployability", "Responsiveness", "Passed", "Failed", "Safety warnings"];
    expect(labels()).toEqual(english);
    const originalRows = rows();
    await act(async () => { await setLocale("zh-Hans", { persist: false }); });
    expect(labels()).toEqual(["可部署性", "响应能力", "通过", "失败", "安全警告"]);
    rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
    await act(async () => { await setLocale("en", { persist: false }); });
    expect(labels()).toEqual(english);
    rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
  });

  it("updates templates, result tiers, status, categories and comparisons without remounting", async () => {
    await setLocale("en", { persist: false });
    const data = normalizeToolResult(rawResult)!;
    const spark = { id: "spark-1", name: "test-spark", metrics: {} } as SparkSnapshot;
    const followed: Followed = {
      run, job: null, progress: null, events: [], partial: "", noLive: false,
      lines: [{ seq: 1, text: "tool_choice not supported" }, { seq: 2, text: "Excluding TC-45 from scoring" }],
    };
    render(<>
      <SimpleConfig type="tool-eval" spark={spark} state={emptyState("tool-eval")} onChange={() => {}} ports={[8888]} port={8888} onAdvanced={() => {}} apiKey="" onApiKey={() => {}} useUrl={false} onUseUrl={() => {}} />
      <ToolResult data={data} raw={rawResult} />
      <SideBySide a={data} b={data} runA={run} runB={run} onSwap={() => {}} />
      <History sparkId="spark-1" sparkName="test-spark" runs={[run]} error={null} followedId={null} viewedId={null} onReload={() => {}} onOpen={() => {}} onRerun={() => {}} onDelete={async () => true} onRefresh={async () => true} onAttach={() => {}} />
      <LiveRun followed={followed} polling={false} pollError={null} actionError={null} scenarioMode onStop={() => {}} onStopWatching={() => {}} onAttach={() => {}} onRefresh={() => {}} onDismiss={() => {}} onViewResult={() => {}} />
      <CopyButton text="raw command" />
    </>);
    expect(document.body.textContent).toContain("Regular run");
    expect(document.body.textContent).toContain("Excellent");
    expect(document.body.textContent).toContain("This model server does not support forced tool calls");
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Raw scenario");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await setLocale("zh-Hans", { persist: false }); });
    const text = document.body.textContent;
    expect(text).toContain("标准测试");
    expect(text).toContain("优秀");
    expect(text).toContain("已完成");
    expect(text).toContain("工具选择");
    expect(text).toContain("可部署性");
    expect(text).toContain("复制");
    expect(text).toContain("此模型服务不支持强制工具调用");
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')).toBe(search);
    expect(search.value).toBe("Raw scenario");
    expect(search.placeholder).toContain("搜索");
    expect(text).toContain("Raw scenario title");
    expect(text).toContain("raw-model-name");
    expect(text).not.toContain("Regular run");
    expect(text).not.toContain("Excellent");
    await act(async () => { await setLocale("en", { persist: false }); });
    expect(document.body.textContent).toContain("Regular run");
    expect(document.body.textContent).toContain("Excellent");
  });
});
