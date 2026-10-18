import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar, RAIL_KEYBOARD_CODES, markRailDrop } from "./AppSidebar";
import { MobileTabBar } from "./MobileTabBar";
import { CommandPalette, filterCommands, fuzzyScore, type PaletteCommand } from "./CommandPalette";
import { railSubLabel, showcaseTarget } from "./sparkSummary";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { toolId } from "../../constants";

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

  it("links the Temps page with a deep-linkable href", () => {
    const { container } = render(
      <AppSidebar sparks={[]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />
    );
    const link = container.querySelector<HTMLAnchorElement>('a[href="/temps"]')!;
    expect(link.textContent).toContain("Temps");
  });

  it("only offers the showcase when an online Spark has a reachable LLM", () => {
    expect(showcaseTarget([makeSpark("a", false)])).toBeNull();
  });

  it("uses Strata activity flags instead of displaying an unmeasured zero decode rate", () => {
    const spark = makeSpark("strata");
    Object.assign(spark.metrics.llm[0], { backend: "strata", generationTps: 0, prefillTps: 0, prefillActive: true, decodeActive: false });
    const { container, root } = render(
      <AppSidebar sparks={[spark]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />,
    );
    const label = () => container.querySelector(".rail-item__sub")?.textContent;

    expect(label()).toBe("prefilling");
    act(() => root.render(
      <AppSidebar sparks={[{ ...spark, metrics: { ...spark.metrics, llm: [{ ...spark.metrics.llm[0], prefillActive: false, decodeActive: true }] } }]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />,
    ));
    expect(label()).toBe("decoding");
    act(() => root.render(
      <AppSidebar sparks={[{ ...spark, metrics: { ...spark.metrics, llm: [{ ...spark.metrics.llm[0], prefillActive: false, decodeActive: false }] } }]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />,
    ));
    expect(label()).toBe("0.0");
  });

  it("keeps rates in the sortable rail and prioritizes offline and worker labels", () => {
    const strata = makeSpark("strata");
    Object.assign(strata.metrics.llm[0], { backend: "strata", generationTps: 42.5, prefillTps: 0, decodeActive: true });
    const offline = makeSpark("offline", false);
    Object.assign(offline.metrics, { llm: [{ ...strata.metrics.llm[0], prefillActive: true, generationTps: 0 }] });
    const worker = makeSpark("worker");
    Object.assign(worker, { role: "worker", workerNode: true });
    Object.assign(worker.metrics.llm[0], { backend: "strata", generationTps: 0, prefillActive: true });
    const { container } = render(
      <AppSidebar sparks={[strata, offline, worker]} activeId={null} onSelect={() => {}} onAdd={() => {}} onReorder={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />,
    );
    const labels = [...container.querySelectorAll(".rail-item__sub")].map((label) => label.textContent);
    expect(labels).toEqual(["42.5", "off", "worker"]);
  });
});

describe("AppSidebar Tools section", () => {
  const props = { sparks: [makeSpark("a")], activeId: null, onSelect: () => {}, onAdd: () => {}, onOpenSettings: () => {}, onOpenSearch: () => {}, connected: true };
  const toggle = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>("button.rail-label--toggle")].find((b) => b.textContent === "Tools")!;
  beforeEach(() => localStorage.clear());

  it("sits directly above Benchmarks and links to /tools/rea like a normal link", () => {
    const onSelectTool = vi.fn();
    const { container } = render(<AppSidebar {...props} onSelectBench={() => {}} onSelectTool={onSelectTool} />);
    const labels = [...container.querySelectorAll("button.rail-label--toggle")].map((b) => b.textContent);
    expect(labels).toEqual(["Tools", "Benchmarks"]);
    const link = container.querySelector<HTMLAnchorElement>('nav[aria-label="Tools"] a')!;
    expect(link.getAttribute("href")).toBe("/tools/rea");
    // Ctrl-click and middle-click are left to the browser.
    const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    act(() => void link.dispatchEvent(ctrl));
    expect(ctrl.defaultPrevented).toBe(false);
    const mid = new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 });
    act(() => void link.dispatchEvent(mid));
    expect(mid.defaultPrevented).toBe(false);
    expect(onSelectTool).not.toHaveBeenCalled();
    act(() => link.click());
    expect(onSelectTool).toHaveBeenCalledWith("rea");
  });

  it("is open by default, remembers a collapse, and the key is sparkdash.sidebar.toolsOpen", () => {
    const { container } = render(<AppSidebar {...props} onSelectTool={() => {}} />);
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
    act(() => toggle(container).click());
    expect(localStorage.getItem("sparkdash.sidebar.toolsOpen")).toBe("0");
    expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector<HTMLElement>("#rail-tools")!.hidden).toBe(true);
  });

  it("stays open and marks the link current while a tool page is active, even if collapsed", () => {
    localStorage.setItem("sparkdash.sidebar.toolsOpen", "0");
    const { container } = render(<AppSidebar {...props} activeId={toolId("rea")} toolType="rea" onSelectTool={() => {}} />);
    expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector<HTMLElement>("#rail-tools")!.hidden).toBe(false);
    expect(container.querySelector('nav[aria-label="Tools"] a')!.getAttribute("aria-current")).toBe("page");
  });

  it("starts collapsed when stored closed and no tool is active", () => {
    localStorage.setItem("sparkdash.sidebar.toolsOpen", "0");
    const { container } = render(<AppSidebar {...props} onSelectTool={() => {}} />);
    expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
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

  it("Stats opens Token totals, Fleet energy, Temps and Activity; VulnHunter sits under Benchmarks; Sparks no longer lists them; Showcase follows Prefill", () => {
    const { container } = render(
      <MobileTabBar sparks={[makeSpark("a")]} activeId={null} onSelect={() => {}} onAdd={() => {}} onOpenSettings={() => {}} />
    );
    const tab = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
    expect(tab("Search")).toBeUndefined();
    act(() => tab("Stats").click());
    let names = [...document.querySelectorAll(".sheet .rail-item__name")].map((n) => n.textContent);
    expect(names).toEqual(["Token totals", "Fleet energy", "Temps", "Activity"]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(400));
    act(() => tab("Sparks").click());
    names = [...document.querySelectorAll(".sheet .rail-item__name")].map((n) => n.textContent);
    expect(names).not.toContain("Token totals");
    expect(names).not.toContain("Fleet energy");
    expect(names).not.toContain("Activity");
    expect(names).toContain("VulnHunter");
    expect(names.indexOf("Showcase")).toBe(names.indexOf("Prefill") + 1);
  });

  it("lists a Tools group with REA above Benchmarks and selects the tool id", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <MobileTabBar sparks={[makeSpark("a")]} activeId={toolId("rea")} onSelect={onSelect} onAdd={() => {}} onOpenSettings={() => {}} />
    );
    const tab = [...container.querySelectorAll("button")].find((b) => b.textContent === "Sparks")!;
    act(() => tab.click());
    const labels = [...document.querySelectorAll(".sheet .rail-label span")].map((n) => n.textContent);
    expect(labels.indexOf("Tools")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Tools")).toBeLessThan(labels.indexOf("Benchmarks"));
    const rea = [...document.querySelectorAll<HTMLButtonElement>(".sheet button")].find((b) => b.textContent === "REA")!;
    expect(rea.getAttribute("aria-current")).toBe("page");
    act(() => rea.click());
    expect(onSelect).toHaveBeenCalledWith(toolId("rea"));
  });
});
