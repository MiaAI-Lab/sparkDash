import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { setLlmApiKey, updateLlmPort, updateLlmPorts } from "../../api/client";
import type { LlmBenchTarget, LlmMetrics } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { LlmPanel } from "./LlmPanel";

vi.mock("../../api/client", () => ({ setLlmApiKey: vi.fn(), updateLlmPort: vi.fn(), updateLlmPorts: vi.fn() }));
// Charts/totals and benchmark dialogs are separate localization batches.
vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));
vi.mock("./BenchmarkDialog", () => ({
  BenchmarkDialog: ({ open, remoteTarget }: { open: boolean; remoteTarget: LlmBenchTarget | null }) =>
    open ? <div data-bench-target={JSON.stringify(remoteTarget)} /> : null,
}));
vi.mock("./PrefillBenchDialog", () => ({ PrefillBenchDialog: () => null }));
vi.mock("./QualityBenchDialog", () => ({ QualityBenchDialog: () => null }));

const llm = (overrides: Partial<LlmMetrics> = {}): LlmMetrics => ({
  ...makeSpark().metrics.llm[0], contextLength: 262144, totalOutputTokens: 12345,
  modelId: "Raw/model <v1>", modelPath: "/models/raw.gguf", ...overrides,
});
const button = (container: HTMLElement, label: string) => {
  const result = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
};
const fill = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const paths = (container: HTMLElement) => [...container.querySelectorAll(".sp-metric path[stroke]")].map(p => p.getAttribute("d"));
const noWrites = () => {
  expect(updateLlmPort).not.toHaveBeenCalled();
  expect(updateLlmPorts).not.toHaveBeenCalled();
  expect(setLlmApiKey).not.toHaveBeenCalled();
};

beforeEach(async () => {
  _resetStore();
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(updateLlmPort).mockReset().mockResolvedValue({ success: true, llmPort: 8888, llmPorts: [8888] });
  vi.mocked(updateLlmPorts).mockReset().mockResolvedValue({ success: true, llmPorts: [8888] });
  vi.mocked(setLlmApiKey).mockReset().mockResolvedValue({ success: true, hasApiKey: true, llmApiKeyPorts: [8888] });
  await act(() => setLocale("en"));
});
afterEach(async () => {
  await act(() => setLocale("en"));
  vi.restoreAllMocks();
});

it("updates live metrics and open help without changing readings, curves or raw metadata", async () => {
  const spark = makeSpark("llm-locale");
  spark.llmPorts = [8888];
  spark.metrics.llm = [llm({
    backend: "freetoken", engineVersion: "raw-0.9", via: "ssh-tunnel",
    kvCacheUsage: 0.85, kvCacheTokensAvailable: 1500, kvCacheTokens: 10000, kvCacheMemoryBytes: 1024 ** 3,
    requestsRunning: 3, requestsWaiting: 2, ttftSeconds: 0.125, ttftP95Seconds: 0.4,
    slotsActive: 3, slotsTotal: 8, cachedPrefillTps: 20, uncachedPrefillTps: 180,
    posture: { level: "warn", auth: "open", scope: "lan", label: "RAW posture", detail: "RAW diagnostic / 401" },
  })];
  for (let i = 0; i < 4; i++) {
    spark.metrics.llm[0].generationTps = 20 + i;
    ingestSnapshots([spark], 1000 + i * 2000);
  }
  const { container } = render(<LlmPanel llm={spark.metrics.llm[0]} sparkId={spark.id} llmPort={8888} />);
  const info = container.querySelector<HTMLButtonElement>('[aria-label="TTFT mean info"]')!;
  act(() => info.click());
  const original = container.textContent;
  const beforePaths = paths(container);
  expect(beforePaths.length).toBeGreaterThan(0);
  expect(original).toContain("a mean, not a percentile");

  await act(() => setLocale("zh-CN"));
  expect(container.querySelector("h3")?.textContent).toBe("LLM 服务");
  expect(container.textContent).toContain("均值，并非百分位数");
  expect(info.getAttribute("aria-label")).toBe("TTFT 均值说明");
  expect(container.textContent).toContain("125 ms");
  expect(container.textContent).toContain("400 ms");
  expect(container.textContent).toContain("23.0tok/s");
  expect(container.textContent).toContain("85%");
  expect(container.textContent).toContain("1.5k 可用 · 10k 池容量 · 1 GB");
  expect(container.textContent).toContain("3 / 8");
  expect(container.textContent).toContain("Raw/model <v1>");
  expect(container.textContent).toContain("/models/raw.gguf");
  expect(container.textContent).toContain("FreeToken · :8888 · vraw-0.9");
  expect(container.querySelector('[title="RAW diagnostic / 401"]')?.textContent).toBe("RAW posture");
  expect(paths(container)).toEqual(beforePaths);
  noWrites();
  await act(() => setLocale("en"));
  expect(container.textContent).toBe(original);
});

it("keeps unknown, active, idle and engine-state semantics across languages", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const props = { sparkId: "states", llmPort: 8888 };
  const { container, root } = render(<LlmPanel {...props} llm={llm({ backend: "strata", generationTps: 0, prefillTps: 0, decodeActive: true, prefillActive: true })} />);
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("正在解码");
  expect(container.textContent).toContain("正在预填充");
  expect(container.querySelector("[data-llm-idle]")).toBeNull();
  expect(container.textContent).toContain("活跃");
  act(() => root.render(<LlmPanel {...props} llm={llm({ generationTps: 0, prefillTps: 0, lastActiveAt: 880_000, gpuMemoryUtilization: 0 })} />));
  expect(container.querySelector("[data-llm-idle]")?.textContent).toBe("空闲 · 上次服务于 2m 前");
  expect(container.textContent).toContain("休眠");
  act(() => root.render(<LlmPanel {...props} llm={llm({ backend: "tensorfold", measurementValid: false, measurementError: "RAW upstream / timeout", gpuMemoryUtilization: null })} />));
  expect([...container.querySelectorAll(".sp-decode .big-num")].map(e => e.textContent)).toEqual(["—", "—"]);
  expect(container.textContent).toContain("未测得：RAW upstream / timeout");
  expect(container.textContent).toContain("未报告");
  expect(container.querySelector('[title="此后端不报告引擎休眠状态"]')).not.toBeNull();
  act(() => root.render(<LlmPanel {...props} llm={null} />));
  expect(container.textContent).toContain(":8888 未加载模型");
  expect(container.querySelector(".sp-decode")).toBeNull();
  noWrites();
});

it("retains settings drafts, duplicate-port feedback and pending saves with identical payloads", async () => {
  const { container } = render(<LlmPanel llm={llm()} sparkId="drafts" llmPort={8888} llmPorts={[8888, 9000]} hasApiKey />);
  act(() => button(container, "Settings").click());
  const port = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  fill(port, "9000");
  fill(key, " raw-test-key ");
  await act(() => button(container, "Save").click());
  expect(container.textContent).toContain("Port 9000 is already configured");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("端口 9000 已配置");
  expect(port.value).toBe("9000");
  expect(key.value).toBe(" raw-test-key ");
  noWrites();
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("Port 9000 is already configured");
  fill(port, "9001");
  let finish!: (value: Awaited<ReturnType<typeof updateLlmPorts>>) => void;
  vi.mocked(updateLlmPorts).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => button(container, "Save").click());
  await act(() => setLocale("zh-CN"));
  expect(button(container, "保存中…").disabled).toBe(true);
  expect(port.value).toBe("9001");
  expect(key.value).toBe(" raw-test-key ");
  expect(updateLlmPorts).toHaveBeenCalledExactlyOnceWith("drafts", [9001, 9000]);
  await act(async () => finish({ success: true, llmPorts: [9001, 9000] }));
  await flush();
  expect(setLlmApiKey).toHaveBeenCalledExactlyOnceWith("drafts", 9001, "raw-test-key");
  expect(updateLlmPort).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("translates local validation and fallback errors while preserving raw save errors and clear-key intent", async () => {
  const { container } = render(<LlmPanel llm={null} sparkId="errors" llmPort={8888} hasApiKey />);
  act(() => button(container, "Settings").click());
  const port = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  const clear = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  fill(port, "70000");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("请输入 1 到 65535 之间的整数");
  expect(button(container, "保存").disabled).toBe(true);
  fill(port, "8888");
  act(() => clear.click());
  await act(() => setLocale("en"));
  expect(clear.checked).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBe(true);
  noWrites();
  vi.mocked(setLlmApiKey).mockRejectedValueOnce(new Error("RAW 403 / denied"));
  await act(() => button(container, "Save").click());
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("RAW 403 / denied");
  expect(setLlmApiKey).toHaveBeenLastCalledWith("errors", 8888, "");
  vi.mocked(setLlmApiKey).mockRejectedValueOnce(null);
  await act(() => button(container, "保存").click());
  expect(container.textContent).toContain("保存 LLM 设置失败");
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("Failed to save LLM settings");
});

it("preserves remote drafts, target serialization and local navigation while translating validation", async () => {
  const navigate = vi.fn();
  window.addEventListener("sparkdash:navigate", navigate);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    const { container } = render(<LlmPanel llm={llm()} sparkId="unit/raw" llmPort={8888} />);
    act(() => button(container, "Remote").click());
    const remote = container.querySelector<HTMLElement>(".sp-remote")!;
    const host = remote.querySelector<HTMLInputElement>('input[type="text"]')!;
    const port = remote.querySelector<HTMLInputElement>('input[type="number"]')!;
    const tls = remote.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => button(remote, "Decode").click());
    expect(container.textContent).toContain("Enter a host");
    await act(() => setLocale("zh-CN"));
    expect(container.textContent).toContain("请输入主机");
    fill(host, "https://[");
    act(() => button(remote, "解码").click());
    expect(container.textContent).toContain("URL 无效");
    fill(host, "raw.internal");
    fill(port, "9443");
    await act(() => setLocale("en"));
    expect(host.value).toBe("raw.internal");
    expect(port.value).toBe("9443");
    expect(tls.checked).toBe(true);
    expect(localStorage.getItem("sparkdash.remote-bench-target")).toBeNull();
    noWrites();
    act(() => button(remote, "Decode").click());
    const target = { host: "raw.internal", port: 9443, tls: true };
    expect(JSON.parse(container.querySelector('[data-bench-target]')!.getAttribute('data-bench-target')!)).toEqual(target);
    expect(JSON.parse(localStorage.getItem("sparkdash.remote-bench-target")!)).toEqual(target);
    await act(() => setLocale("zh-CN"));
    act(() => button(container.querySelector<HTMLElement>(".sp-launchers > .sp-btns")!, "解码").click());
    expect(navigate.mock.calls[0][0].detail).toEqual({ id: "__bench__:decode", spark: "unit/raw" });
    act(() => button(container, "演示").click());
    expect(open).toHaveBeenCalledWith("/showcase/unit%2Fraw?port=8888&model=Raw%2Fmodel+%3Cv1%3E", "_blank", "noopener,noreferrer");
  } finally {
    window.removeEventListener("sparkdash:navigate", navigate);
  }
});
