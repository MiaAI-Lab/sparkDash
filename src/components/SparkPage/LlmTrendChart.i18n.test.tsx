import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { LlmTrendChart } from "./LlmTrendChart";

beforeEach(async () => {
  _resetStore();
  await act(() => setLocale("en"));
});
afterEach(async () => { await act(() => setLocale("en")); });

const geometry = (container: HTMLElement) => [...container.querySelectorAll("svg polyline, svg path")]
  .map(node => node.getAttribute("points") ?? node.getAttribute("d"));

it("localizes history labels while preserving per-port curves, gaps and busy-sample averages", async () => {
  const spark = makeSpark("history-locale");
  spark.llmPorts = [8888, 9000];
  const first = spark.metrics.llm[0];
  spark.metrics.llm = [first, { ...first, generationTps: 9999, prefillTps: 99999, ttftSeconds: 9 }];
  const times = [1000, 3000, 33000, 35000];
  times.forEach((time, i) => {
    first.generationTps = i * 20;
    first.prefillTps = i * 200;
    first.ttftSeconds = i === 1 ? 0.1 : i === 3 ? 0.3 : null;
    ingestSnapshots([spark], time);
  });
  const { container } = render(<LlmTrendChart sparkId={spark.id} llmPort={8888} />);
  const original = container.textContent;
  const before = geometry(container);
  expect(container.querySelectorAll("polyline")).toHaveLength(4);
  expect(original).toContain("last 30m");
  expect(original).toContain("Gen avg 40.0");
  expect(original).toContain("Prefill avg 400");
  expect(original).toContain("TTFT avg 0.200s");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("最近 30 分钟");
  expect(container.textContent).toContain("生成均值 40.0");
  expect(container.textContent).toContain("预填充均值 400");
  expect(container.textContent).toContain("TTFT 均值 0.200s");
  expect(container.textContent).toContain("仅对忙碌时的采样求均值");
  expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("最近 30 分钟每秒生成和预填充的 Token 数");
  expect(geometry(container)).toEqual(before);
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
  expect(geometry(container)).toEqual(before);
});

it("distinguishes no samples from measured idle samples without inventing a busy average", async () => {
  const { container } = render(<LlmTrendChart sparkId="idle-history" llmPort={8888} />);
  expect(container.textContent).toContain("No samples yet.");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("暂无采样。");
  expect(container.querySelector("svg")).toBeNull();
  const spark = makeSpark("idle-history");
  spark.llmPorts = [8888];
  spark.metrics.llm[0].generationTps = 0;
  spark.metrics.llm[0].prefillTps = 0;
  act(() => {
    ingestSnapshots([spark], 1000);
    ingestSnapshots([spark], 3000);
  });
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.textContent).not.toContain("暂无采样。");
  expect([...container.querySelectorAll(".sp-trend-foot .mono")].map(e => e.textContent)).toEqual(["—", "—", "—"]);
});
