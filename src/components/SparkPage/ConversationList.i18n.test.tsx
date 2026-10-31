import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { ConversationList } from "./ConversationList";
import type { ConversationRow } from "../../api/types";

const now = Date.parse("2026-10-12T12:00:00Z");

function row(partial: Partial<ConversationRow> & Pick<ConversationRow, "id" | "source">): ConversationRow {
  return { handle: partial.handle || partial.id, badge: "unknown", port: 8000, ...partial };
}

async function switchLocale(locale: "en" | "zh-CN") {
  await act(async () => {
    await setLocale(locale);
  });
}

afterEach(async () => {
  await switchLocale("en");
});

describe("ConversationList i18n", () => {
  it("localizes empty and add-harness chrome without changing the callback", async () => {
    const onAdd = vi.fn();
    await switchLocale("en");
    const view = render(<ConversationList conversations={[]} onAddHarness={onAdd} now={now} />);

    expect(view.container.textContent).toContain("No sessions on this LLM. Attach OpenClaw, Hermes, OpenCode, oh-my-pi, or DeepSeek Harness.");
    expect(view.container.querySelector(".occupancy-head-add")?.getAttribute("aria-label")).toBe("Add harness");
    await act(async () => {
      [...view.container.querySelectorAll("button")].find((button) => button.textContent === "+ Harness")?.click();
    });
    expect(onAdd).toHaveBeenCalledOnce();

    await switchLocale("zh-CN");
    expect(view.container.textContent).toContain("此 LLM 上没有会话。请连接 OpenClaw、Hermes、OpenCode、oh-my-pi 或 DeepSeek Harness。");
    expect(view.container.querySelector(".occupancy-head-add")?.getAttribute("aria-label")).toBe("添加 Harness");
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("switches mounted session chrome from English to Chinese and back without changing metadata, grouping, tones, or callbacks", async () => {
    const onAdd = vi.fn();
    await switchLocale("en");
    const view = render(
      <ConversationList
        now={now}
        onAddHarness={onAdd}
        conversations={[
          row({ id: "generating", source: "opencode", agent: "raw-agent", handle: "raw-handle", badge: "generating", stale: true, lastUsedAt: now - 90_000, contextUsed: 1200, contextWindow: 8000, contextApprox: true }),
          row({ id: "now", source: "opencode", agent: "raw-agent", handle: "now-handle", lastUsedAt: now - 1_000 }),
          row({ id: "minutes", source: "opencode", agent: "raw-agent", handle: "minutes-handle", lastUsedAt: now - 2 * 60_000 }),
          row({ id: "warm", source: "opencode", agent: "raw-agent", handle: "warm-handle", lastUsedAt: now - 30 * 60_000 }),
          row({ id: "hours", source: "opencode", agent: "raw-agent", handle: "hours-handle", lastUsedAt: now - 2 * 60 * 60_000 }),
          row({ id: "days", source: "opencode", agent: "raw-agent", handle: "days-handle", lastUsedAt: now - 2 * 24 * 60 * 60_000 }),
          row({ id: "missing", source: "opencode", agent: "raw-agent", handle: "missing-handle" }),
          row({ id: "stalled", source: "opencode", agent: "raw-agent", handle: "stalled-handle", badge: "stalled", lastUsedAt: now - 60_000 }),
          row({ id: "idle", source: "unmapped-source", agent: "raw-agent-2", handle: "idle-handle", lastUsedAt: now - 8 * 24 * 60 * 60_000 }),
        ]}
      />
    );

    expect(view.container.textContent).toContain("Sessions");
    expect(view.container.textContent).toContain("OpenCode · raw-agent");
    expect(view.container.textContent).toContain("unmapped-source · raw-agent-2");
    expect(view.container.textContent).toContain("raw-handle");
    expect(view.container.textContent).toContain("Generating stale");
    for (const age of ["now", "2m", "2h", "2d", "—", "Stalled"]) expect(view.container.textContent).toContain(age);
    expect(view.container.querySelector(".occupancy-row.is-generating")).not.toBeNull();
    expect(view.container.querySelector(".occupancy-row.is-recent")).not.toBeNull();
    expect(view.container.querySelector(".occupancy-row.is-warm")).not.toBeNull();
    expect(view.container.querySelector(".occupancy-row.is-idle")).not.toBeNull();
    expect(view.container.querySelector(".occupancy-row.is-stalled")).not.toBeNull();
    expect(view.container.querySelector(".occupancy-row.is-generating")?.getAttribute("title")).toBe("Last refresh failed; this row is stale");
    expect(view.container.querySelector(".occupancy-row.is-generating .occupancy-ctx")?.getAttribute("title")).toBe("~1,200 / 8,000 tokens");

    await switchLocale("zh-CN");
    expect(view.container.textContent).toContain("会话");
    expect(view.container.textContent).toContain("正在生成 已过期");
    expect(view.container.textContent).toContain("OpenCode · raw-agent");
    expect(view.container.textContent).toContain("unmapped-source · raw-agent-2");
    expect(view.container.textContent).toContain("raw-handle");
    expect(view.container.textContent).toContain("30 分钟前");
    for (const age of ["刚刚", "2 分钟前", "2 小时前", "2 天前", "—", "已停滞"]) expect(view.container.textContent).toContain(age);
    expect(view.container.textContent).toContain(new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(now - 8 * 24 * 60 * 60_000));
    expect(view.container.querySelector(".occupancy-row.is-generating")?.getAttribute("title")).toBe("上次刷新失败；此行数据已过期");
    expect(view.container.querySelector(".occupancy-row.is-generating .occupancy-ctx")?.getAttribute("title")).toBe("~1,200 / 8,000 个 token");

    await act(async () => {
      const add = view.container.querySelector<HTMLButtonElement>(".occupancy-head-add");
      expect(add).not.toBeNull();
      add?.click();
    });
    expect(onAdd).toHaveBeenCalledOnce();

    await switchLocale("en");
    expect(view.container.textContent).toContain("Sessions");
    expect(view.container.textContent).toContain("Generating stale");
    expect(view.container.textContent).toContain("30m");
  });
});
