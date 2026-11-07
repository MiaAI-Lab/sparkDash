import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { ApiKeysPage } from "./ApiKeysPage";
import { fmtBudget, fmtDate, fmtUsd } from "./apiKeysFormat";
import * as client from "../../api/apiKeysClient";
import { setLocale } from "../../i18n";

const ID = "a".repeat(64);
const base = {
  state: "active" as const, blocked: false, maxBudget: null, budgetDuration: null, budgetResetAt: null, expires: null,
  createdAt: null, lastActive: null, rpmLimit: 60, tpmLimit: null, maxParallelRequests: null, models: [],
};

vi.mock("../../api/apiKeysClient", () => ({
  fetchApiKeysStatus: vi.fn(async () => ({ configured: true, bridge: "ok", upstream: "unknown", error: null, retryAfterSec: 3 })),
  fetchApiKeys: vi.fn(async () => ({ keys: [] })),
  fetchApiKey: vi.fn(async () => ({ key: null })),
}));

beforeEach(() => {
  vi.mocked(client.fetchApiKeys).mockResolvedValue({
    keys: [
      { ...base, id: ID, alias: "team-a", spend: 1.5 },
      { ...base, id: "b".repeat(64), alias: "no-usage", spend: null },
    ],
  });
});

afterEach(async () => {
  await act(async () => setLocale("en"));
});

it("formats unknown spend as unknown, never as zero", () => {
  expect(fmtUsd(null)).toBe("unknown");
  expect(fmtUsd(0)).toBe("$0.0000");
  expect(fmtBudget(null, null)).toBe("no limit");
  expect(fmtDate("not-a-date")).toBe("unknown");
});

it("lists keys read-only and shows unreadable spend as unknown", async () => {
  const { container } = render(<ApiKeysPage />);
  await flush();
  const rows = container.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("$1.50");
  expect(rows[1].textContent).toContain("unknown");
  expect(rows[1].textContent).not.toContain("$0");
  // No write actions in this page.
  const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
  expect(labels.some((l) => /delete|kill|block|create|budget/i.test(l))).toBe(false);
});

it("retranslates complete details while preserving raw aliases, models, durations, IDs, and dates", async () => {
  const detail = {
    ...base,
    id: ID,
    alias: "team-a <raw>",
    spend: null,
    maxBudget: 2.5,
    budgetDuration: "30d",
    budgetResetAt: "2026-11-07T10:30:00Z",
    createdAt: "2026-01-02T03:04:00Z",
    maxParallelRequests: 0,
    models: ["model/raw"],
  };
  vi.mocked(client.fetchApiKey).mockResolvedValue({ key: detail });
  const { container } = render(<ApiKeysPage />);
  await flush();
  await act(async () => {
    (container.querySelector(".ak-link") as HTMLButtonElement).click();
  });
  await flush();
  expect(client.fetchApiKey).toHaveBeenCalledWith(ID);
  expect(Array.from(container.querySelectorAll(".ak-detail dt")).map((node) => node.textContent)).toEqual([
    "Spend", "Budget", "Budget resets", "Parallel requests", "Created", "Models",
  ]);
  expect(container.querySelector(".ak-detail")?.textContent).toContain("$2.50 / 30d");
  expect(container.querySelector(".ak-detail")?.textContent).toContain("2026-11-07 10:30");
  expect(container.querySelector(".ak-detail")?.textContent).toContain("model/raw");
  expect(container.textContent).toContain("team-a <raw>");
  expect(container.textContent).toContain("Spend is unknown");
  expect(container.querySelector("[role=status]")?.textContent).toContain("Bridge ok LiteLLM unknown retrying in 3 s");
  expect(container.querySelector("tbody tr .ak-pill")?.textContent).toBe("active");
  const callsBeforeLocale = vi.mocked(client.fetchApiKeys).mock.calls.length + vi.mocked(client.fetchApiKey).mock.calls.length + vi.mocked(client.fetchApiKeysStatus).mock.calls.length;
  await act(async () => setLocale("zh-CN"));
  expect(Array.from(container.querySelectorAll(".ak-detail dt")).map((node) => node.textContent)).toEqual([
    "花费", "预算", "预算重置时间", "并行请求数", "创建时间", "模型",
  ]);
  expect(container.querySelector(".ak-detail")?.textContent).toContain("$2.50 / 30d");
  expect(container.textContent).toContain("team-a <raw>");
  expect(container.textContent).toContain("花费为 未知");
  expect(container.querySelector("[role=status]")?.textContent).toContain("桥接服务 正常 LiteLLM 未知 3 秒后重试");
  expect(container.querySelector("tbody tr .ak-pill")?.textContent).toBe("活跃");
  const callsAfterLocale = vi.mocked(client.fetchApiKeys).mock.calls.length + vi.mocked(client.fetchApiKey).mock.calls.length + vi.mocked(client.fetchApiKeysStatus).mock.calls.length;
  expect(callsAfterLocale).toBe(callsBeforeLocale);
  await act(async () => setLocale("en"));
  expect(Array.from(container.querySelectorAll(".ak-detail dt")).map((node) => node.textContent)).toEqual([
    "Spend", "Budget", "Budget resets", "Parallel requests", "Created", "Models",
  ]);
});

it("shows the bridge error instead of an empty table when the list fails", async () => {
  const rawError = "The bridge rejected <raw> token; waiting before retrying";
  vi.mocked(client.fetchApiKeys).mockRejectedValue(new Error(rawError));
  const { container } = render(<ApiKeysPage />);
  await flush();
  expect(container.querySelector("[role=alert]")?.textContent).toContain(rawError);
  expect(container.querySelector("[role=alert] raw")).toBeNull();
  expect(container.querySelector("table")).toBeNull();
  await act(async () => setLocale("zh-CN"));
  expect(container.querySelector("[role=alert]")?.textContent).toContain("无法加载密钥");
  expect(container.querySelector("[role=alert]")?.textContent).toContain(rawError);
});

it("localizes the all-models fallback without changing the key record", async () => {
  vi.mocked(client.fetchApiKey).mockResolvedValue({ key: { ...base, id: ID, alias: "team-a", spend: 0, models: [] } });
  const { container } = render(<ApiKeysPage />);
  await flush();
  await act(async () => (container.querySelector(".ak-link") as HTMLButtonElement).click());
  await flush();
  expect(container.querySelector(".ak-detail")?.textContent).toContain("all");
  await act(async () => setLocale("zh-CN"));
  expect(container.querySelector(".ak-detail")?.textContent).toContain("全部");
});

it("shows translated empty and pending states without issuing extra requests", async () => {
  let resolveKeys!: (value: { keys: [] }) => void;
  vi.mocked(client.fetchApiKeys).mockImplementationOnce(() => new Promise((resolve) => { resolveKeys = resolve; }));
  const { container } = render(<ApiKeysPage />);
  await flush();
  expect(container.querySelector("button")?.textContent).toBe("Refreshing…");
  expect(container.querySelector("table")).toBeNull();
  await act(async () => setLocale("zh-CN"));
  expect(container.querySelector("button")?.textContent).toBe("正在刷新…");
  await act(async () => resolveKeys({ keys: [] }));
  await flush();
  expect(container.textContent).toContain("桥接服务未报告任何密钥");
});
