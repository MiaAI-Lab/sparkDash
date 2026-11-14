import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, deleteStoragePath, fetchStorageDeleteMany, fetchStorageScan, fetchStorageStatus, startStorageDeleteMany } from "../../api/client";
import type { StorageBulkDeleteJob, StorageEntry, StorageScanSnapshot, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { StoragePage } from "./StoragePage";

vi.mock("../../api/client", async (importOriginal) => {
  const { lowAdvice } = await import("../../testing/advice");
  return {
    ...(await importOriginal<typeof import("../../api/client")>()),
    // The delete check: everything checked, nothing found, so the dialogs work as they did before it.
    adviseStorageDelete: vi.fn(async (_id: string, paths: string[]) => lowAdvice(paths)),
    fetchStorageStatus: vi.fn(),
    fetchStorageScan: vi.fn(),
    fetchStorageFolders: vi.fn(),
    startStorageScan: vi.fn(),
    cancelStorageScan: vi.fn(),
    deleteStoragePath: vi.fn(),
    startStorageDeleteMany: vi.fn(),
    fetchStorageDeleteMany: vi.fn(),
    fetchDockerStorage: vi.fn(),
    forgetStorageSudo: vi.fn(),
    acknowledgeElevatedDelete: vi.fn(),
    fetchStorageQuarantine: vi.fn(async () => ({ items: [] })),
  };
});

const MB = 1024 * 1024;
const NOW = Date.now();
const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 400e9, availBytes: 600e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};
const entry = (path: string, bytes: number, extra: Partial<StorageEntry> = {}, type: StorageEntry["type"] = "dir", expanded = false): StorageEntry => ({ path, bytes, type, expanded, locked: null, ...extra });
const ENTRIES = [
  entry("/data", 1300 * MB, {}, "dir", true),
  entry("/data/models", 600 * MB),
  entry("/data/cache", 300 * MB, { sharedBytes: 100 * MB }),
  entry("/data/sub", 200 * MB, {}, "dir", true),
  entry("/data/sub/x.bin", 150 * MB, {}, "file"),
  entry("/data/a.bin", 50 * MB, {}, "file"),
  entry("/data/notes.txt", 2 * MB, {}, "file"),
  entry("/data/.ssh", 1 * MB, { locked: "SSH keys. Deleting them can lock the dashboard out of this Spark." }),
];
let revision = 4;
const snapshot = (entries: StorageEntry[]): StorageScanSnapshot => ({
  job: { id: "j1", state: "done", path: "/data", depth: 3, mode: "new", elevated: false, startedAt: 1, finishedAt: 2, error: null },
  revision: revision++,
  now: NOW,
  session: { root: "/data", scannedAt: NOW, analysedAt: NOW, elevated: false, unreadable: 0, timedOut: false, hardlinks: "exact", dated: false, entries },
});
const job = (over: Partial<StorageBulkDeleteJob> = {}): StorageBulkDeleteJob => ({
  id: "b1",
  state: "running",
  elevated: false,
  total: 3,
  done: 0,
  current: null,
  startedAt: NOW,
  finishedAt: null,
  success: false,
  deleted: [],
  failed: [],
  skipped: [],
  covered: [],
  stopped: null,
  ...over,
});

const text = () => document.body.textContent ?? "";
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => document.body.querySelector(`[aria-label="${label}"]`) as T;
const box = (name: string) => byLabel<HTMLInputElement>(`Select ${name}`);
const allBox = () => document.body.querySelector(".st-pick--all input") as HTMLInputElement;
const button = (label: string | RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""))) as HTMLButtonElement;
const bar = () => document.body.querySelector(".st-selbar") as HTMLElement | null;
const picked = () => [...document.body.querySelectorAll<HTMLInputElement>(".st-row .st-pick__box")].filter((b) => b.checked && !b.disabled).map((b) => b.getAttribute("aria-label")!.replace("Select ", ""));
const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;

function click(el: HTMLElement, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(entries = ENTRIES) {
  vi.mocked(fetchStorageScan).mockResolvedValue(snapshot(entries));
  render(<StoragePage sparks={[makeSpark("s1")]} />);
  await flush();
  await flush();
}

beforeEach(() => {
  window.history.replaceState(null, "", "/storage");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  vi.mocked(fetchStorageDeleteMany).mockResolvedValue({ job: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Files list: ticking rows", () => {
  it("every deletable row starts with a tick box; a locked row has a disabled one that says why", async () => {
    await open();
    for (const name of ["models", "cache", "sub", "a.bin", "notes.txt"]) {
      expect(box(name).type).toBe("checkbox");
      expect(box(name).disabled).toBe(false);
    }
    const locked = box(".ssh");
    expect(locked.disabled).toBe(true);
    const why = document.getElementById(locked.getAttribute("aria-describedby")!)!;
    expect(why.textContent).toContain("SSH keys");
    // Shown on a tap (or a long press), not only on hover.
    const frame = locked.closest(".st-pick") as HTMLElement;
    expect(frame.className).not.toContain("is-open");
    click(frame);
    expect(frame.className).toContain("is-open");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(frame.className).not.toContain("is-open");
    act(() => {
      frame.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(frame.className).toContain("is-open");
    // The header has a cell for every column the rows have, the tick box column included.
    const cols = document.body.querySelector(".st-cols")!.children.length;
    const first = document.body.querySelector(".st-row")!;
    const cells = [...first.children].reduce((n, c) => n + (c.classList.contains("st-row__meta") ? c.children.length : 1), 0);
    expect(cells).toBe(cols);
    // The single delete is still there, unchanged.
    expect(byLabel("Delete models")).toBeTruthy();
  });

  it("the header box is clear, mixed or checked, and its label says what it will do", async () => {
    await open();
    expect(allBox().getAttribute("aria-label")).toBe("Select all 5");
    expect(allBox().checked).toBe(false);
    expect(allBox().indeterminate).toBe(false);
    expect(bar()).toBeNull();
    click(box("models"));
    expect(allBox().checked).toBe(false);
    expect(allBox().indeterminate).toBe(true);
    expect(allBox().getAttribute("aria-label")).toBe("Select all 5");
    click(allBox());
    expect(picked().sort()).toEqual(["a.bin", "cache", "models", "notes.txt", "sub"]);
    expect(allBox().checked).toBe(true);
    expect(allBox().indeterminate).toBe(false);
    expect(allBox().getAttribute("aria-label")).toBe("Deselect all");
    expect(button("Deselect all")).toBeTruthy();
    click(allBox());
    expect(picked()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("select all takes only the rows a filter shows, and the selection is kept when the filter changes", async () => {
    await open();
    setInput(document.body.querySelector('input[aria-label="Filter this folder"]') as HTMLInputElement, "bin");
    expect(allBox().getAttribute("aria-label")).toBe("Select all 1");
    click(allBox());
    expect(picked()).toEqual(["a.bin"]);
    setInput(document.body.querySelector('input[aria-label="Filter this folder"]') as HTMLInputElement, "");
    expect(picked()).toEqual(["a.bin"]);
    expect(allBox().indeterminate).toBe(true);
    click(box("models"));
    // Filtered again: one ticked row is not shown, and the bar says so.
    setInput(document.body.querySelector('input[aria-label="Filter this folder"]') as HTMLInputElement, "mod");
    expect(bar()!.textContent).toContain("2 selected");
    expect(bar()!.textContent).toContain("1 not shown");
  });

  it("shift-click ticks the range between the last row toggled and this one, in the order shown", async () => {
    await open();
    // A to Z: folders first, then files.
    click(button("A to Z"));
    click(box("cache"));
    click(box("a.bin"), { shiftKey: true });
    expect(picked().sort()).toEqual(["a.bin", "cache", "models", "sub"]);
    // Biggest first is another order (models, cache, sub, a.bin, notes.txt): a range now follows it.
    click(button("Clear"));
    click(button("Biggest first"));
    click(box("notes.txt"));
    click(box("cache"), { shiftKey: true });
    expect(picked().sort()).toEqual(["a.bin", "cache", "notes.txt", "sub"]);
    // Shift-click on a ticked row unticks the range from the last row toggled (cache) to it.
    click(box("sub"), { shiftKey: true });
    expect(picked().sort()).toEqual(["a.bin", "notes.txt"]);
    // A ctrl/cmd-click is a plain toggle.
    click(box("models"), { ctrlKey: true });
    expect(picked().sort()).toEqual(["a.bin", "models", "notes.txt"]);
  });

  it("the selection bar counts the items and what deleting them frees, shared data counted once", async () => {
    await open();
    click(box("models"));
    click(box("cache"));
    const sel = bar()!;
    expect(sel.textContent).toContain("2 selected");
    // 600 MB + (300 MB less the 100 MB linked from elsewhere).
    expect(sel.textContent).toContain("frees about 800 MB");
    expect(button("Select all 5")).toBeTruthy();
    expect(button("Clear")).toBeTruthy();
    expect(button(/Delete selected/)).toBeTruthy();
    // Ticked rows are marked, not only by colour: the box is the cue.
    const row = box("models").closest(".st-row")!;
    expect(row.className).toContain("is-selected");
    click(button("Clear"));
    expect(bar()).toBeNull();
    expect(row.className).not.toContain("is-selected");
  });

  it("the selection is kept while sorting, and cleared when the folder changes", async () => {
    await open();
    click(box("models"));
    click(button("A to Z"));
    click(button("Newest first"));
    expect(picked()).toEqual(["models"]);
    await act(async () => byLabel("Open sub").click());
    expect(bar()).toBeNull();
    expect(box("x.bin").checked).toBe(false);
    await act(async () => {
      window.history.back();
    });
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(picked()).toEqual([]);
  });

  it("after a refresh, items that are gone are dropped from the selection and the rest stay ticked", async () => {
    await open();
    click(box("models"));
    click(box("notes.txt"));
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/data/notes.txt" });
    vi.mocked(fetchStorageScan).mockResolvedValue(snapshot(ENTRIES.filter((e) => e.path !== "/data/notes.txt")));
    click(byLabel("Delete notes.txt"));
    // Deleting waits for the delete check (mocked: nothing found).
    await flush();
    await act(async () => button("Delete permanently").click());
    await flush();
    expect(deleteStoragePath).toHaveBeenCalledWith("s1", { path: "/data/notes.txt" });
    expect(picked()).toEqual(["models"]);
    expect(bar()!.textContent).toContain("1 selected");
  });

  it("one ticked item opens the ordinary delete dialog", async () => {
    await open();
    click(box("models"));
    click(button(/Delete selected/));
    expect(dialog()!.textContent).toContain("Delete this folder?");
    expect(dialog()!.textContent).toContain("Type models to confirm");
  });
});

describe("Bulk delete", () => {
  const openBulk = async (names: string[]) => {
    await open();
    for (const n of names) click(box(n));
    click(button(/Delete selected/));
  };

  it("lists the items, the total and what it frees, and needs the typed phrase before anything runs", async () => {
    await openBulk(["models", "cache", "notes.txt"]);
    const d = dialog()!;
    expect(d.textContent).toContain("Delete 3 items?");
    const names = [...d.querySelectorAll(".st-bulk__name")].map((n) => n.firstChild?.textContent);
    expect(names).toEqual(["models", "cache", "notes.txt"]);
    expect(d.querySelector(".st-bulk__head")!.textContent).toContain("3 items");
    expect(d.querySelector(".st-bulk__head")!.textContent).toContain("deleting frees about 802 MB");
    expect(d.textContent).toContain("This cannot be undone.");
    expect(d.textContent).toContain("There is no trash to restore from.");
    expect(d.textContent).toContain("100 MB of this is shared.");
    // The phrase is a caption to select, not a label.
    expect(d.querySelector("#st-bulk-confirm-label")!.tagName).toBe("DIV");
    expect(d.querySelector("#st-bulk-confirm-label .st-selectable")!.textContent).toBe("delete 3 items");
    const go = button("Delete 3 permanently");
    expect(go.disabled).toBe(true);
    const input = d.querySelector("#st-bulk-confirm") as HTMLInputElement;
    setInput(input, "delete 3 item");
    expect(go.disabled).toBe(true);
    setInput(input, "delete 2 items");
    expect(go.disabled).toBe(true);
    setInput(input, "Delete 3 items");
    expect(go.disabled).toBe(false);
    expect(startStorageDeleteMany).not.toHaveBeenCalled();
    // The administrator part is laid out but hidden until ticked.
    expect(d.querySelector(".st-reserve")!.className).toContain("is-off");
  });

  it("lists the first six by name and counts the rest", async () => {
    const many = [entry("/data", 1000 * MB, {}, "dir", true), ...Array.from({ length: 9 }, (_, i) => entry(`/data/f${i}.bin`, (20 - i) * MB, {}, "file"))];
    await open(many);
    click(allBox());
    click(button(/Delete selected/));
    const d = dialog()!;
    expect(d.querySelectorAll(".st-bulk__list > li:not(.st-bulk__cols)")).toHaveLength(6);
    expect(d.querySelector(".st-bulk__more")!.textContent).toBe("and 3 more");
    expect(d.textContent).toContain("Delete 9 items?");
  });

  it("sends one request, shows the progress in place of the phrase, then reports a mixed result", async () => {
    vi.useFakeTimers();
    await openBulk(["models", "cache", "a.bin"]);
    const d = dialog()!;
    vi.mocked(startStorageDeleteMany).mockResolvedValue({ job: job({ total: 3 }) });
    vi.mocked(fetchStorageDeleteMany)
      .mockResolvedValueOnce({ job: job({ done: 1, current: "/data/cache", deleted: ["/data/models"] }) })
      .mockResolvedValueOnce({
        job: job({
          state: "done",
          done: 3,
          finishedAt: NOW,
          deleted: ["/data/models", "/data/a.bin"],
          failed: [{ path: "/data/cache", code: "protected-descendant", message: "It contains SSH keys; it is kept under Needs attention.", partial: false, quarantineId: "0b6f1c2e-6a0e-4c1f-9d55-4a1e7a3c2b10" }],
        }),
      });
    setInput(d.querySelector("#st-bulk-confirm") as HTMLInputElement, "delete 3 items");
    const progress = d.querySelector(".st-bulk-progress") as HTMLElement;
    const field = d.querySelector(".st-bulk__confirm") as HTMLElement;
    expect(progress.className).toContain("is-off");
    await act(async () => button("Delete 3 permanently").click());
    expect(startStorageDeleteMany).toHaveBeenCalledTimes(1);
    expect(startStorageDeleteMany).toHaveBeenCalledWith("s1", { paths: ["/data/models", "/data/cache", "/data/a.bin"] });
    expect(button(/Deleting 1 of 3/)).toBeTruthy();
    // The phrase and the progress share one place: one is hidden, never removed, so nothing moves.
    expect(field.className).toContain("is-off");
    expect(progress.className).not.toContain("is-off");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(progress.textContent).toContain("Deleting 2 of 3…");
    expect(progress.textContent).toContain("cache");
    // Escape does not close it while it runs.
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(dialog()).toBeTruthy();
    vi.mocked(fetchStorageScan).mockResolvedValue(snapshot(ENTRIES.filter((e) => e.path !== "/data/models" && e.path !== "/data/a.bin")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(dialog()).toBeNull();
    const report = document.body.querySelector(".st-banner.is-warn")!;
    expect(report.textContent).toContain("Deleted 2 of 3.");
    expect(report.textContent).toContain("About 650 MB freed.");
    expect(report.textContent).toContain("1 could not be deleted: cache — It contains SSH keys; it is kept under Needs attention.");
    expect(report.textContent).toContain("1 is kept under Needs attention.");
    const details = report.querySelector("details")!;
    expect(details.querySelector("summary")!.textContent).toContain("Show what was not deleted (1)");
    expect(details.querySelector("li")!.textContent).toContain("/data/cache");
    // What was deleted left the list and the selection; what failed stays ticked to try again.
    expect(picked()).toEqual(["cache"]);
    expect(box("models")).toBeNull();
  });

  it("a wrong password keeps the dialog open with the password to fix, and nothing is reported", async () => {
    vi.useFakeTimers();
    await openBulk(["models", "cache"]);
    const d = dialog()!;
    act(() => (d.querySelector(".check-row:not(.st-advice__tick) input") as HTMLInputElement).click());
    setInput(d.querySelector('input[type="password"]') as HTMLInputElement, "wrong");
    setInput(d.querySelector("#st-bulk-confirm") as HTMLInputElement, "delete 2 items");
    // Folders as administrator: the acknowledgement is asked for, as in the single dialog.
    expect(d.textContent).toContain("Deleting folders as administrator is off for this Spark.");
    expect(button("Delete 2 as administrator").disabled).toBe(true);
    act(() => (d.querySelector(".st-ack input") as HTMLInputElement).click());
    expect(button("Delete 2 as administrator").disabled).toBe(false);
    vi.mocked(startStorageDeleteMany).mockResolvedValue({ job: job({ total: 2, elevated: true }) });
    vi.mocked(fetchStorageDeleteMany).mockResolvedValueOnce({
      job: job({ state: "done", total: 2, elevated: true, done: 1, failed: [{ path: "/data/models", code: "bad-password", message: "The sudo password was not accepted", partial: false }], skipped: [{ path: "/data/cache", reason: "Not tried: the sudo password was not accepted." }], stopped: { code: "bad-password", message: "The sudo password was not accepted" } }),
    });
    await act(async () => button("Delete 2 as administrator").click());
    expect(startStorageDeleteMany).toHaveBeenCalledWith("s1", { paths: ["/data/models", "/data/cache"], sudo: true, sudoPassword: "wrong", remember: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain("The sudo password was not accepted. Check it and try again.");
    expect(document.body.querySelector(".st-bulk-report")).toBeNull();
    expect(button("Delete 2 as administrator")).toBeTruthy();
  });

  it("a refusal before anything runs (a bad path, busy) is shown under the items", async () => {
    await openBulk(["models", "cache"]);
    vi.mocked(startStorageDeleteMany).mockRejectedValue(new ApiError("Another change is still running on this Spark", 409, "busy"));
    setInput(dialog()!.querySelector("#st-bulk-confirm") as HTMLInputElement, "delete 2 items");
    await act(async () => button("Delete 2 permanently").click());
    const problem = dialog()!.querySelector(".st-problem")!;
    expect(problem.textContent).toContain("Another change is still running");
    // Right under the items.
    expect(problem.previousElementSibling!.className).toContain("st-bulk");
    expect(button("Delete 2 permanently").disabled).toBe(false);
  });

  it("all deleted: the dialog closes, the result is reported, and focus goes back to the list", async () => {
    vi.useFakeTimers();
    await openBulk(["a.bin", "notes.txt"]);
    vi.mocked(startStorageDeleteMany).mockResolvedValue({ job: job({ total: 2 }) });
    vi.mocked(fetchStorageDeleteMany).mockResolvedValueOnce({ job: job({ state: "done", total: 2, done: 2, success: true, deleted: ["/data/a.bin", "/data/notes.txt"] }) });
    vi.mocked(fetchStorageScan).mockResolvedValue(snapshot(ENTRIES.filter((e) => !["/data/a.bin", "/data/notes.txt"].includes(e.path))));
    setInput(dialog()!.querySelector("#st-bulk-confirm") as HTMLInputElement, "delete 2 items");
    await act(async () => button("Delete 2 permanently").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // The dialog fades out and goes (its close animation), then focus lands on the list.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(dialog()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(document.body.querySelector(".st-banner.is-ok")!.textContent).toContain("Deleted 2 items. About 52.0 MB freed.");
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(allBox());
  });
});

describe("A bulk delete started earlier", () => {
  it("is followed when the page opens, and its result reported when it ends", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchStorageDeleteMany).mockImplementation(async (_id, jobId) =>
      jobId ? { job: job({ id: "b9", state: "done", total: 4, done: 4, deleted: ["/data/models", "/data/cache", "/data/a.bin"], skipped: [{ path: "/data/notes.txt", reason: "Not tried: the dashboard lost contact with the Spark." }] }) } : { job: job({ id: "b9", total: 4, done: 1 }) }
    );
    await open();
    expect(text()).toContain("Deleting 2 of 4 on Spark s1…");
    expect(text()).toContain("A bulk delete started earlier is still running.");
    // Nothing else may start meanwhile.
    expect(button(/Analyse again/).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(text()).not.toContain("still running");
    const report = document.body.querySelector(".st-bulk-report")!.closest(".st-banner")!;
    expect(report.textContent).toContain("Deleted 3 of 4.");
    expect(report.textContent).toContain("1 was not tried: the dashboard lost contact with the Spark.");
    expect(fetchStorageScan).toHaveBeenCalledTimes(2);
  });
});
