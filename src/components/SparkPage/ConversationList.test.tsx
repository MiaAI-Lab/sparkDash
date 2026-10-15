import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { ConversationList } from "./ConversationList";
import type { ConversationRow } from "../../api/types";

const now = Date.parse("2026-10-12T12:00:00Z");

function row(partial: Partial<ConversationRow> & Pick<ConversationRow, "id" | "source">): ConversationRow {
  return {
    handle: partial.handle || partial.id,
    badge: "unknown",
    port: 8000,
    ...partial,
  };
}

describe("ConversationList", () => {
  it("names the five harnesses and opens setup from the empty state", () => {
    const onAdd = vi.fn();
    render(<ConversationList conversations={[]} onAddHarness={onAdd} now={now} />);
    expect(document.body.textContent).toContain("OpenClaw, Hermes, OpenCode, oh-my-pi, or DeepSeek Harness");
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "+ Harness");
    button?.click();
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("shows Generating and Stalled only for those badges, and hides a blank context", () => {
    render(
      <ConversationList
        now={now}
        conversations={[
          row({ id: "a", source: "opencode", handle: "Mapped", badge: "unknown", lastUsedAt: now - 2 * 60_000, agent: "coder" }),
          row({ id: "b", source: "hermes", handle: "Live", badge: "generating", lastUsedAt: now - 60 * 60_000, contextUsed: 1200, contextWindow: 8000 }),
          row({ id: "c", source: "dsh", handle: "Stuck", badge: "stalled", lastUsedAt: now - 60_000 }),
        ]}
      />
    );
    const text = document.body.textContent || "";
    expect(text).toContain("OpenCode · coder");
    expect(text).toContain("2m");
    expect(text).toContain("Generating");
    expect(text).toContain("Stalled");
    expect(text).toContain("1.2k/8.0k");
    const mapped = [...document.querySelectorAll(".occupancy-row")].find((item) => item.textContent?.includes("Mapped"));
    expect(mapped?.textContent).not.toContain("Generating");
    expect(mapped?.querySelector(".occupancy-ctx")?.textContent).toBe("");
  });
});
