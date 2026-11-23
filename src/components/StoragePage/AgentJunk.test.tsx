import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAgentJunk, fetchStorageContext, fetchStorageDeleteMany, fetchStorageScan, fetchStorageStatus } from "../../api/client";
import type { AgentJunkItem, AgentJunkResult, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { ageParts, currentPick, groupItems, junkSelection, pickPaths, selectedTotals } from "./agentJunk";
import { StoragePage } from "./StoragePage";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchStorageStatus: vi.fn(),
  fetchStorageContext: vi.fn(),
  fetchStorageScan: vi.fn(),
  fetchStorageDeleteMany: vi.fn(),
  startStorageDeleteMany: vi.fn(),
  fetchStorageAdvice: vi.fn(),
  fetchAgentJunk: vi.fn(),
}));

const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 400e9, availBytes: 600e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const item = (path: string, verdict: AgentJunkItem["verdict"], bytes: number | null, over: Partial<AgentJunkItem> = {}): AgentJunkItem => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  type: "d",
  bytes,
  modifiedAt: 1,
  rule: "tmp-agent",
  group: "temp",
  agent: "Agent",
  verdict,
  score: 0.9,
  signals: [{ code: "age", days: 45 }],
  ...over,
});

const ITEMS: AgentJunkItem[] = [
  item("/home/me/p/.claude/worktrees/task", "junk", 3e9, { rule: "claude-worktree", group: "worktrees", agent: "Claude Code" }),
  item("/tmp/claude-1000", "junk", 1e9),
  item("/tmp/tmpabc", "likely", 2e6, { rule: "tmp-tool" }),
  item("/home/me/p/debug_x.py", "review", null, { type: "f", rule: "scratch-script", group: "scratch", signals: [{ code: "recent" }] }),
  item("/home/me/.claude/projects/-p", "keep", 5e6, { rule: "claude-sessions", group: "sessions", signals: [{ code: "memory" }] }),
];
const RESULT: AgentJunkResult = { checkedAt: Date.now(), home: "/home/me", git: "ok", complete: true, more: false, items: ITEMS };

describe("agent junk helpers", () => {
  it("picks by verdict, recognises the pick, and totals what is measured", () => {
    expect([...pickPaths(ITEMS, "smart")]).toEqual(["/home/me/p/.claude/worktrees/task", "/tmp/claude-1000"]);
    expect(pickPaths(ITEMS, "likely").size).toBe(3);
    expect(pickPaths(ITEMS, "all").size).toBe(5);
    expect(currentPick(ITEMS, pickPaths(ITEMS, "smart"))).toBe("smart");
    expect(currentPick(ITEMS, new Set(["/tmp/claude-1000"]))).toBeNull();
    expect(selectedTotals(ITEMS, pickPaths(ITEMS, "all"))).toEqual({ count: 5, bytes: 3e9 + 1e9 + 2e6 + 5e6, unmeasured: 1 });
  });

  it("groups biggest first and builds the bulk delete selection", () => {
    expect(groupItems(ITEMS).map((g) => g.group)).toEqual(["worktrees", "temp", "sessions", "scratch"]);
    const sel = junkSelection(ITEMS, new Set(["/tmp/claude-1000", "/home/me/p/debug_x.py"]))!;
    expect(sel.items.map((e) => [e.path, e.type])).toEqual([
      ["/tmp/claude-1000", "dir"],
      ["/home/me/p/debug_x.py", "file"],
    ]);
    expect(junkSelection(ITEMS, new Set())).toBeNull();
  });

  it("says an age in the coarsest plain unit", () => {
    expect(ageParts(3)).toEqual({ unit: "day", count: 3 });
    expect(ageParts(20)).toEqual({ unit: "week", count: 2 });
    expect(ageParts(120)).toEqual({ unit: "month", count: 4 });
    expect(ageParts(800)).toEqual({ unit: "year", count: 2 });
  });
});

async function settle() {
  for (let i = 0; i < 4; i++) await flush();
}
const pickButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".st-junk__picks button")].find((b) => b.textContent === label)!;
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/storage");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  vi.mocked(fetchStorageContext).mockResolvedValue(null as never);
  vi.mocked(fetchStorageScan).mockResolvedValue({ job: null, revision: 0, session: null });
  vi.mocked(fetchStorageDeleteMany).mockResolvedValue({ job: null });
  vi.mocked(fetchAgentJunk).mockReset();
  vi.mocked(fetchAgentJunk).mockResolvedValue(RESULT);
});

describe("Remove agent junk tab", () => {
  it("is highlighted, looks by itself when opened and ticks the smart pick", async () => {
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    const tab = document.getElementById("st-tab-junk") as HTMLButtonElement;
    expect(tab.textContent).toContain("Remove agent junk");
    expect(tab.textContent).toContain("New");
    // Nothing is asked of the Spark until the tab is opened.
    expect(fetchAgentJunk).not.toHaveBeenCalled();
    await act(async () => tab.click());
    await flush();
    await flush();
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("junk");
    expect(fetchAgentJunk).toHaveBeenCalledWith("s1");
    expect(text()).toContain("5 items found");
    expect(text()).toContain("Smart pick: 2 items that are safe to remove");
    expect(pickButton("Smart pick").getAttribute("aria-pressed")).toBe("true");
    const remove = button("Remove 2 items");
    expect(remove.disabled).toBe(false);
    expect(remove.textContent).toContain("3.7 GB");
    // Signals read as plain words.
    expect(text()).toContain("6 weeks old");
  });

  it("ticks more or nothing with one press, and filters by verdict", async () => {
    window.history.replaceState(null, "", "/storage?spark=s1&tab=junk");
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await settle();
    await act(async () => pickButton("Everything").click());
    expect(button("Remove 5 items")).toBeTruthy();
    expect(text()).toContain("(plus 1 not measured)");
    await act(async () => pickButton("Nothing").click());
    expect(document.body.querySelector<HTMLButtonElement>(".st-junk__bar .btn--danger")!.disabled).toBe(true);
    expect(text()).toContain("Tick what you want to remove.");
    // Show only "Keep": every other verdict is turned off.
    for (const v of ["Junk", "Probably junk", "Check first"]) {
      const chip = [...document.body.querySelectorAll<HTMLButtonElement>(".st-junk__chip")].find((b) => b.textContent?.startsWith(v))!;
      await act(async () => chip.click());
    }
    const groups = [...document.body.querySelectorAll(".st-junk__group")].map((g) => g.querySelector("b")?.textContent);
    expect(groups).toEqual(["Session logs and state"]);
  });

  it("opens the bulk delete dialog with the ticked items", async () => {
    window.history.replaceState(null, "", "/storage?spark=s1&tab=junk");
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await settle();
    await act(async () => button("Remove 2 items").click());
    await flush();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("task");
    expect(dialog?.textContent).toContain("claude-1000");
    expect(dialog?.textContent).toContain("delete 2 items");
  });

  it("says when nothing was found, and shows a failure with a way to try again", async () => {
    vi.mocked(fetchAgentJunk).mockResolvedValueOnce({ ...RESULT, items: [] });
    window.history.replaceState(null, "", "/storage?spark=s1&tab=junk");
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await settle();
    expect(text()).toContain("Nothing left behind on");
    vi.mocked(fetchAgentJunk).mockRejectedValueOnce(new Error("Could not reach Spark s1"));
    await act(async () => button("Look again").click());
    await flush();
    expect(text()).toContain("Could not look for agent junk: Could not reach Spark s1");
  });
});
