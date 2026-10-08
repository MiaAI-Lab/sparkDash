import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette, filterCommands, fuzzyScore, type PaletteCommand } from "./CommandPalette";
import { railSubLabel, showcaseTarget } from "./sparkSummary";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const cmd = (id: string, label: string, group = "Go to", run = () => {}): PaletteCommand => ({ id, group, label, run });

describe("command palette matching", () => {
  it("ranks prefix and substring hits above scattered subsequences", () => {
    expect(fuzzyScore("spa", "Spark one")).toBeGreaterThan(fuzzyScore("spa", "Add a Spark"));
    expect(fuzzyScore("zzz", "Spark one")).toBe(-Infinity);
  });

  it("filters to matching commands and keeps everything for an empty query", () => {
    const all = [cmd("a", "Overview"), cmd("b", "spark-01"), cmd("c", "Open settings", "Actions")];
    expect(filterCommands(all, "")).toHaveLength(3);
    expect(filterCommands(all, "set").map((c) => c.id)).toEqual(["c"]);
    expect(filterCommands(all, "nomatchxyz")).toHaveLength(0);
  });
});

describe("CommandPalette", () => {
  it("runs the highlighted command on Enter and closes", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={[cmd("a", "Overview", "Go to", run)]} />);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} onClose={() => {}} commands={[cmd("a", "Overview")]} />);
    expect(document.querySelector(".palette")).toBeNull();
  });
});

describe("AppSidebar", () => {
  it("lists every Spark, marks the active one and shows an off label for offline units", () => {
    const sparks = [makeSpark("a"), makeSpark("b", false)];
    const { container } = render(
      <AppSidebar
        sparks={sparks}
        activeId="b"
        onSelect={() => {}}
        onAdd={() => {}}
        onEdit={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
        connected
      />
    );
    expect(container.querySelector('nav[aria-label="Sparks"]')?.textContent).toContain("Spark a");
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("Spark b");
    expect(railSubLabel(sparks[1])).toBe("off");
  });

  it("only offers the showcase when an online Spark has a reachable LLM", () => {
    expect(showcaseTarget([makeSpark("a", false)])).toBeNull();
  });
});
