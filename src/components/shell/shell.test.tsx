import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar, RAIL_KEYBOARD_CODES, markRailDrop } from "./AppSidebar";
import { MobileTabBar } from "./MobileTabBar";
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

describe("keyboard access", () => {
  it("the rail's keyboard drag does not start on Enter or Space", () => {
    expect(RAIL_KEYBOARD_CODES.start).not.toContain("Enter");
    expect(RAIL_KEYBOARD_CODES.start).not.toContain("Space");
    expect(RAIL_KEYBOARD_CODES.end).toContain("Enter");
  });

  it("Enter on a rail Spark is left to the link (not prevented by the drag sensor)", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AppSidebar sparks={[makeSpark("a"), makeSpark("b")]} activeId={null} onSelect={onSelect} onAdd={() => {}} onReorder={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />
    );
    const btn = container.querySelector<HTMLAnchorElement>('nav[aria-label="Sparks"] a')!;
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    act(() => {
      btn.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("rail drag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("the click that follows a drop does not open the Spark, a later click does", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <AppSidebar sparks={[makeSpark("a"), makeSpark("b")]} activeId={null} onSelect={onSelect} onAdd={() => {}} onReorder={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />
    );
    const link = container.querySelector<HTMLAnchorElement>('nav[aria-label="Sparks"] a')!;
    act(() => markRailDrop());
    act(() => link.click());
    expect(onSelect).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("rail drag native click", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("cancels the link's default navigation even when the click is stopped at the document", () => {
    const { container } = render(
      <AppSidebar sparks={[makeSpark("a"), makeSpark("b")]} activeId={null} onSelect={() => {}} onAdd={() => {}} onReorder={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />
    );
    const link = container.querySelector<HTMLAnchorElement>('nav[aria-label="Sparks"] a')!;
    // What dnd-kit does while a drag winds down.
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener("click", stop, true);
    try {
      act(() => markRailDrop());
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      act(() => vi.advanceTimersByTime(500));
      const later = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener("click", stop, true);
    }
  });
});

describe("CommandPalette accessibility", () => {
  const cmds = [cmd("a", "Overview"), cmd("b", "Energy")];
  const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;

  it("points the input at the selected option and follows the arrow keys", () => {
    render(<CommandPalette open onClose={() => {}} commands={cmds} />);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-controls")).toBe(document.querySelector('[role="listbox"]')!.id);
    expect(input().getAttribute("aria-activedescendant")).toBe(document.querySelectorAll('[role="option"]')[0].id);
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(input().getAttribute("aria-activedescendant")).toBe(document.querySelectorAll('[role="option"]')[1].id);
    expect(document.querySelectorAll('[role="option"]')[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ignores Enter while an IME is composing", () => {
    const run = vi.fn();
    render(<CommandPalette open onClose={() => {}} commands={[cmd("a", "Overview", "Go to", run)]} />);
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog, makes the app inert, and restores both on close", () => {
    const root = document.createElement("div");
    root.id = "root";
    const opener = document.createElement("button");
    root.append(opener);
    document.body.append(root);
    opener.focus();
    const { root: r } = render(<CommandPalette open commands={cmds} onClose={() => {}} />);
    expect(document.activeElement).toBe(input());
    expect(root.hasAttribute("inert")).toBe(true);
    act(() => r.render(<CommandPalette open={false} commands={cmds} onClose={() => {}} />));
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("MobileTabBar sheet", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("traps focus in the sheet and gives it back to the Sparks button on Escape", () => {
    const sparks = [makeSpark("a")];
    const { container } = render(
      <MobileTabBar sparks={sparks} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} />
    );
    const opener = [...container.querySelectorAll("button")].find((b) => b.textContent === "Sparks")!;
    opener.focus();
    act(() => opener.click());
    const sheet = document.querySelector(".sheet")!;
    expect(sheet.contains(document.activeElement)).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // The sheet slides down first, then unmounts.
    expect(document.querySelector(".sheet.is-leaving")).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".sheet")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Stats opens Token totals, Fleet energy and Activity; Sparks no longer lists them; Showcase follows Prefill", () => {
    const { container } = render(
      <MobileTabBar sparks={[makeSpark("a")]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} />
    );
    const tab = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
    expect(tab("Search")).toBeUndefined();
    act(() => tab("Stats").click());
    let names = [...document.querySelectorAll(".sheet .rail-item__name")].map((n) => n.textContent);
    expect(names).toEqual(["Token totals", "Fleet energy", "Activity"]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(400));
    act(() => tab("Sparks").click());
    names = [...document.querySelectorAll(".sheet .rail-item__name")].map((n) => n.textContent);
    expect(names).not.toContain("Token totals");
    expect(names).not.toContain("Fleet energy");
    expect(names).not.toContain("Activity");
    expect(names.indexOf("Showcase")).toBe(names.indexOf("Prefill") + 1);
  });
});
