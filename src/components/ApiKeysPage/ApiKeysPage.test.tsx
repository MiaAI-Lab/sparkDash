import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { ApiKeysPage } from "./ApiKeysPage";
import { fmtUsd } from "./apiKeysFormat";
import * as client from "../../api/apiKeysClient";

const ID = "a".repeat(64);
const base = {
  state: "active" as const, blocked: false, maxBudget: null, budgetDuration: null, budgetResetAt: null, expires: null,
  createdAt: null, lastActive: null, rpmLimit: 60, tpmLimit: null, maxParallelRequests: null, models: [],
};

vi.mock("../../api/apiKeysClient", () => ({
  fetchApiKeysStatus: vi.fn(async () => ({ configured: true, bridge: "ok", upstream: "ok", error: null, retryAfterSec: null })),
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

it("formats unknown spend as unknown, never as zero", () => {
  expect(fmtUsd(null)).toBe("unknown");
  expect(fmtUsd(0)).toBe("$0.0000");
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

it("opens a key's detail on click", async () => {
  vi.mocked(client.fetchApiKey).mockResolvedValue({ key: { ...base, id: ID, alias: "team-a", spend: null, models: ["m1"] } });
  const { container } = render(<ApiKeysPage />);
  await flush();
  await act(async () => {
    (container.querySelector(".ak-link") as HTMLButtonElement).click();
  });
  await flush();
  expect(client.fetchApiKey).toHaveBeenCalledWith(ID);
  expect(container.querySelector(".ak-detail")?.textContent).toContain("m1");
  expect(container.textContent).toContain("Spend is unknown");
});

it("shows the bridge error instead of an empty table when the list fails", async () => {
  vi.mocked(client.fetchApiKeys).mockRejectedValue(new Error("The bridge rejected the token; waiting before retrying"));
  const { container } = render(<ApiKeysPage />);
  await flush();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("rejected the token");
  expect(container.querySelector("table")).toBeNull();
});
