import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adviseStorageDelete, ApiError, deleteStoragePath } from "../../api/client";
import type { StorageAdvice, StorageBulkDeleteJob, StorageEntry, StorageStatus } from "../../api/types";
import { adviceOf, lowAdvice } from "../../testing/advice";
import { cleanupRenders, flush, render } from "../../testing/render";
import { BulkDeleteDialog } from "./BulkDeleteDialog";
import { ADVICE_TIMEOUT_MS, adviceConfirmMatches, adviceHeadline, adviceSatisfied, effectiveLevel, flaggedItems, frictionOf, levelCounts, ownUnchecked, sharedUnchecked, type AdviceState } from "./deleteAdvice";
import { DeleteDialog, type DeleteTarget } from "./DeleteDialog";
import { summarize } from "./selection";
import { useAdminAccess } from "./useAdminAccess";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  adviseStorageDelete: vi.fn(),
  deleteStoragePath: vi.fn(),
}));

const STATUS: StorageStatus = { user: "me", sudo: "no", passwordAllowed: true, filesystems: [], docker: { state: "ok", rootDir: null } };
const FILE: DeleteTarget = { path: "/data/models/w.bin", type: "file", bytes: 5e9 };
const FOLDER: DeleteTarget = { path: "/data/models", type: "dir", bytes: 9e9 };

const text = () => document.body.textContent ?? "";
const button = (label: string | RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.includes(label) : label.test(b.textContent ?? ""))) as HTMLButtonElement;
const block = () => document.body.querySelector(".st-advice") as HTMLElement;
const headline = () => block().querySelector('[role="status"]')!.textContent;
const slot = (cls: string) => block().querySelector(`.st-advice__confirm > .${cls}`) as HTMLElement;
const shown = (el: HTMLElement) => !el.classList.contains("is-off") && !el.hasAttribute("inert");
const tick = () => slot("st-advice__tick").querySelector("input") as HTMLInputElement;
const phrase = () => slot("st-advice__typed").querySelector("input") as HTMLInputElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A check that answers when the test says so, and notices being stopped. */
function deferred() {
  let resolve!: (a: StorageAdvice) => void;
  let reject!: (e: unknown) => void;
  const signals: AbortSignal[] = [];
  vi.mocked(adviseStorageDelete).mockImplementation(
    (_id, _paths, signal) =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
        if (signal) {
          signals.push(signal);
          signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }
      })
  );
  return { resolve: (a: StorageAdvice) => act(async () => resolve(a)), reject: (e: unknown) => act(async () => reject(e)), signals };
}

function Single({ target }: { target: DeleteTarget }) {
  const access = useAdminAccess("s1", STATUS);
  const [open, setOpen] = useState<DeleteTarget | null>(target);
  return (
    <>
      <button type="button" onClick={() => setOpen(target)}>
        reopen
      </button>
      <DeleteDialog sparkId="s1" sparkName="Spark One" target={open} access={access} preferAdmin={false} onClose={() => setOpen(null)} onDeleted={() => setOpen(null)} ack={{ user: "me", acknowledgedAt: 1 }} />
    </>
  );
}

beforeEach(() => {
  vi.mocked(adviseStorageDelete).mockReset();
  vi.mocked(deleteStoragePath).mockReset();
  vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: FILE.path });
});
afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

describe("delete check: what each answer asks", () => {
  const ready = (level: StorageAdvice["level"], complete = true): AdviceState => ({ status: "ready", advice: adviceOf([{ path: "/a", level, complete, reasons: level === "review" && complete ? [{ rule: "recent-write", level: "review", text: "x." }] : [] }]) });
  it("maps levels to friction, and treats a missing answer as review, never as low", () => {
    expect(frictionOf({ status: "loading" })).toBe("wait");
    expect(effectiveLevel({ status: "loading" })).toBeNull();
    expect(frictionOf(ready("low"))).toBe("none");
    expect(frictionOf(ready("review"))).toBe("tick");
    expect(frictionOf(ready("high"))).toBe("typed");
    expect(effectiveLevel({ status: "failed", message: "x" })).toBe("review");
    expect(effectiveLevel({ status: "skipped" })).toBe("review");
    expect(frictionOf({ status: "failed", message: "x" })).toBe("tick");
  });
  it("says when the delete may go ahead", () => {
    expect(adviceSatisfied({ status: "loading" }, true, "delete anyway")).toBe(false);
    expect(adviceSatisfied(ready("low"), false, "")).toBe(true);
    expect(adviceSatisfied(ready("review"), false, "")).toBe(false);
    expect(adviceSatisfied(ready("review"), true, "")).toBe(true);
    // A tick is not enough for high.
    expect(adviceSatisfied(ready("high"), true, "")).toBe(false);
    expect(adviceSatisfied(ready("high"), false, "  Delete Anyway ")).toBe(true);
    expect(adviceConfirmMatches("delete  anyway")).toBe(false);
    expect(adviceConfirmMatches("delete anyway!")).toBe(false);
    expect(adviceSatisfied({ status: "skipped" }, true, "")).toBe(true);
  });
  it("headlines stay short and honest", () => {
    expect(adviceHeadline({ status: "loading" })).toBe("Checking…");
    expect(adviceHeadline(ready("low"))).toBe("Nothing found");
    expect(adviceHeadline(ready("review"))).toBe("Worth a look");
    expect(adviceHeadline(ready("review", false))).toBe("Not fully checked");
    expect(adviceHeadline(ready("high"))).toBe("Look before deleting");
    expect(adviceHeadline({ status: "failed", message: "x" })).toBe("Could not check");
    expect(adviceHeadline({ status: "skipped" })).toBe("Not checked");
  });
  it("counts and orders items for the bulk summary", () => {
    const items = adviceOf([
      { path: "/a", level: "low" },
      { path: "/b", level: "review", reasons: [{ rule: "recent-write", level: "review", text: "x." }] },
      { path: "/c", level: "high", reasons: [{ rule: "in-use", level: "high", text: "x." }] },
      { path: "/d", level: "low", reasons: [{ rule: "age", level: "note", text: "n." }] },
    ]).items;
    expect(levelCounts(items)).toEqual({ low: 2, review: 1, high: 1 });
    expect(flaggedItems(items).map((i) => i.path)).toEqual(["/c", "/b", "/d"]);
  });
  it("says once what no item could have checked, and lists an item only for what is its own", () => {
    const others = { rule: "processes-others", text: "Programs of other accounts were not checked." };
    const walk = { rule: "walk", text: "Ran out of time." };
    const items = adviceOf([
      { path: "/a", level: "review", complete: false, unchecked: [others] },
      { path: "/b", level: "review", complete: false, unchecked: [others, walk] },
      { path: "/c", level: "review", complete: false, unchecked: [walk, others] },
    ]).items;
    expect(sharedUnchecked(items)).toEqual([others]);
    expect(ownUnchecked(items[1], [others])).toEqual([walk]);
    expect(flaggedItems(items, [others]).map((i) => i.path)).toEqual(["/b", "/c"]);
    // One item: nothing to share.
    expect(sharedUnchecked(items.slice(0, 1))).toEqual([]);
  });
});

describe("delete check in the single delete dialog", () => {
  it("is laid out at full size while it runs, deleting waits, then nothing found changes nothing", async () => {
    const d = deferred();
    render(<Single target={FILE} />);
    await flush();
    expect(adviseStorageDelete).toHaveBeenCalledWith("s1", [FILE.path], expect.any(AbortSignal));
    const body = block().querySelector(".st-advice__body") as HTMLElement;
    const swap = block().querySelector(".st-advice__confirm") as HTMLElement;
    expect(block().getAttribute("aria-busy")).toBe("true");
    expect(body.querySelector(".st-advice__skeleton")).toBeTruthy();
    expect(headline()).toContain("Checking…");
    // Every confirmation is there from the start (so the space is taken), only the one that applies is shown.
    expect(swap.children.length).toBe(4);
    expect(shown(slot("st-advice__wait"))).toBe(true);
    for (const c of ["st-advice__none", "st-advice__tick", "st-advice__typed"]) expect(slot(c).classList.contains("is-off")).toBe(true);
    expect(slot("st-advice__tick").hasAttribute("inert")).toBe(true);
    expect(slot("st-advice__typed").hasAttribute("inert")).toBe(true);
    expect(button("Delete permanently").disabled).toBe(true);
    await d.resolve(lowAdvice([FILE.path]));
    // Same elements, same place: nothing was swapped out.
    expect(block().querySelector(".st-advice__body")).toBe(body);
    expect(block().querySelector(".st-advice__confirm")).toBe(swap);
    expect(swap.children.length).toBe(4);
    expect(block().getAttribute("aria-busy")).toBe("false");
    expect(block().classList.contains("is-low")).toBe(true);
    expect(headline()).toContain("Delete check: Low.");
    expect(headline()).toContain("Nothing found");
    expect(body.textContent).toContain("Checked on Spark One: programs and running containers");
    expect(shown(slot("st-advice__none"))).toBe(true);
    expect(shown(slot("st-advice__wait"))).toBe(false);
    // A file still deletes with one click, as before.
    expect(button("Delete permanently").disabled).toBe(false);
    await act(async () => button("Delete permanently").click());
    await flush();
    expect(deleteStoragePath).toHaveBeenCalledWith("s1", { path: FILE.path });
  });

  it("review lists the reasons, written out, and needs a tick", async () => {
    const d = deferred();
    render(<Single target={FILE} />);
    await flush();
    await d.resolve(
      adviceOf([
        {
          path: FILE.path,
          level: "review",
          complete: false,
          reasons: [
            { rule: "recent-write", level: "review", text: "Changed recently: it was written 4 minutes ago." },
            { rule: "age", level: "note", text: "Last changed today, according to the analysis." },
          ],
          unchecked: [{ rule: "processes-others", text: "Only this account's programs were checked." }],
        },
      ])
    );
    expect(block().classList.contains("is-review")).toBe(true);
    const marks = [...block().querySelectorAll(".st-advice__list > li")].map((li) => [li.className, li.querySelector(".st-advice__mark")!.textContent]);
    expect(marks).toEqual([
      ["is-review", "Review"],
      ["is-unchecked", "Not checked"],
      ["is-note", "Note"],
    ]);
    expect(text()).toContain("Changed recently: it was written 4 minutes ago.");
    expect(shown(slot("st-advice__tick"))).toBe(true);
    expect(shown(slot("st-advice__typed"))).toBe(false);
    const del = button("Delete permanently");
    expect(del.disabled).toBe(true);
    act(() => tick().click());
    expect(del.disabled).toBe(false);
    act(() => tick().click());
    expect(del.disabled).toBe(true);
  });

  it("high needs the typed phrase, on top of a folder's name", async () => {
    const d = deferred();
    render(<Single target={FOLDER} />);
    await flush();
    await d.resolve(adviceOf([{ path: FOLDER.path, level: "high", reasons: [{ rule: "in-use", level: "high", text: "In use right now: open in python3 (process 41)." }] }]));
    expect(headline()).toContain("Delete check: High.");
    expect(headline()).toContain("Look before deleting");
    expect(shown(slot("st-advice__typed"))).toBe(true);
    expect(shown(slot("st-advice__tick"))).toBe(false);
    expect(slot("st-advice__typed").textContent).toContain("Type delete anyway to delete it all the same");
    const del = button("Delete permanently");
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "models");
    expect(del.disabled).toBe(true);
    setInput(phrase(), "delete");
    expect(del.disabled).toBe(true);
    setInput(phrase(), "Delete anyway");
    expect(del.disabled).toBe(false);
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: FOLDER.path });
    // Enter in the phrase deletes, as Enter in the name does.
    act(() => phrase().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(deleteStoragePath).toHaveBeenCalledWith("s1", { path: FOLDER.path });
  });

  it("a failed check says nothing was checked and asks for a tick; it never blocks the delete", async () => {
    const d = deferred();
    render(<Single target={FILE} />);
    await flush();
    await d.reject(new ApiError("Could not reach Spark One: timed out", 502, "unreachable"));
    expect(headline()).toContain("Could not check");
    expect(headline()).toContain("Delete check: Review.");
    expect(block().classList.contains("is-review")).toBe(true);
    expect(text()).toContain("The check could not be done: Could not reach Spark One: timed out. Nothing about this item was checked, so proceed with care.");
    expect(text()).not.toContain("Nothing found");
    expect(button("Delete permanently").disabled).toBe(true);
    act(() => tick().click());
    expect(button("Delete permanently").disabled).toBe(false);
    await act(async () => button("Delete permanently").click());
    await flush();
    expect(deleteStoragePath).toHaveBeenCalled();
  });

  it("not waiting counts as not checked", async () => {
    const d = deferred();
    render(<Single target={FILE} />);
    await flush();
    act(() => button("Don’t wait").click());
    await flush();
    expect(d.signals[0].aborted).toBe(true);
    expect(headline()).toContain("Not checked");
    expect(text()).toContain("You chose not to wait for the check.");
    expect(shown(slot("st-advice__tick"))).toBe(true);
    expect(button("Delete permanently").disabled).toBe(true);
  });

  it("a check that takes too long is given up and treated as not checked", async () => {
    vi.useFakeTimers();
    const d = deferred();
    render(<Single target={FILE} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(ADVICE_TIMEOUT_MS + 1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(d.signals[0].aborted).toBe(true);
    expect(headline()).toContain("Could not check");
    expect(text()).toContain("The Spark did not answer in time");
    expect(frictionOf({ status: "failed", message: "" })).toBe("tick");
  });

  it("closing stops the check, and opening again checks again from the start", async () => {
    const d = deferred();
    render(<Single target={FILE} />);
    await flush();
    await d.resolve(adviceOf([{ path: FILE.path, level: "high" }]));
    act(() => button("Cancel").click());
    await flush();
    act(() => button("reopen").click());
    await flush();
    expect(adviseStorageDelete).toHaveBeenCalledTimes(2);
    // The earlier answer is not shown again while the new check runs.
    expect(headline()).toContain("Checking…");
    expect(phrase().value).toBe("");
    act(() => button("Cancel").click());
    await flush();
    expect(d.signals[1].aborted).toBe(true);
  });
});

describe("delete check in the bulk delete dialog", () => {
  const MB = 1024 * 1024;
  const entries: StorageEntry[] = [
    { path: "/data/a", bytes: 300 * MB, type: "dir", expanded: false, locked: null },
    { path: "/data/b", bytes: 200 * MB, type: "dir", expanded: false, locked: null },
    { path: "/data/c.bin", bytes: 100 * MB, type: "file", expanded: false, locked: null },
    { path: "/data/d.bin", bytes: 50 * MB, type: "file", expanded: false, locked: null },
    { path: "/data/a/inner", bytes: 10 * MB, type: "dir", expanded: false, locked: null },
  ];
  const selection = summarize(new Set(entries.map((e) => e.path)), new Map(entries.map((e) => [e.path, e])));
  const OTHERS = { rule: "processes-others", text: "Programs of other accounts (root, services) were not checked." };

  function Bulk({ onStart }: { onStart: (paths: string[]) => Promise<StorageBulkDeleteJob> }) {
    const access = useAdminAccess("s1", STATUS);
    const [open, setOpen] = useState(true);
    return <BulkDeleteDialog sparkId="s1" sparkName="Spark One" selection={open ? selection : null} access={access} preferAdmin={false} ack={{ user: "me", acknowledgedAt: 1 }} job={null} onStart={(p) => onStart(p)} onClose={() => setOpen(false)} />;
  }

  it("sums up the items, lists each one with something to say, and the highest level sets the friction", async () => {
    const d = deferred();
    const onStart = vi.fn(async () => ({ id: "j1" }) as StorageBulkDeleteJob);
    render(<Bulk onStart={onStart} />);
    await flush();
    expect(adviseStorageDelete).toHaveBeenCalledWith("s1", ["/data/a", "/data/b", "/data/c.bin", "/data/d.bin"], expect.any(AbortSignal));
    expect(block().classList.contains("st-advice--bulk")).toBe(true);
    await d.resolve(
      adviceOf(
        [
          { path: "/data/a", level: "review", complete: false, unchecked: [OTHERS] },
          { path: "/data/b", level: "high", complete: false, reasons: [{ rule: "git-uncommitted", level: "high", text: "This git repository has 2 changed files not committed." }], unchecked: [OTHERS] },
          { path: "/data/c.bin", level: "review", complete: false, unchecked: [OTHERS, { rule: "walk", text: "Ran out of time before looking inside it." }] },
          { path: "/data/d.bin", level: "review", complete: false, unchecked: [OTHERS] },
        ],
        ["/data/a/inner"]
      )
    );
    const body = block().querySelector(".st-advice__body") as HTMLElement;
    expect(body.querySelector(".st-advice__sum")!.textContent).toBe("1 High · 3 Review · 1 inside selected folders, checked with them");
    // Said once for every item, not under each.
    expect(body.querySelector(".st-advice__shared")!.textContent).toBe("Not checkedFor every item: Programs of other accounts (root, services) were not checked.");
    expect(body.textContent!.split("Programs of other accounts").length - 1).toBe(1);
    const rows = [...body.querySelectorAll(".st-advice__item")].map((li) => [li.querySelector("b")!.textContent, li.querySelector(".st-advice__itemlevel")!.textContent]);
    expect(rows).toEqual([
      ["b", "High"],
      ["c.bin", "Review"],
    ]);
    expect(body.textContent).toContain("2 other items: nothing else found.");
    expect(body.textContent).toContain("This git repository has 2 changed files not committed.");
    // Both phrases: the bulk one and the check's.
    const go = button(/Delete 4 permanently/);
    setInput(document.getElementById("st-bulk-confirm") as HTMLInputElement, "delete 4 items");
    expect(go.disabled).toBe(true);
    setInput(phrase(), "delete anyway");
    expect(go.disabled).toBe(false);
    await act(async () => go.click());
    await flush();
    expect(onStart).toHaveBeenCalledWith(["/data/a", "/data/b", "/data/c.bin", "/data/d.bin"]);
  });

  it("nothing found anywhere leaves the bulk flow as it was", async () => {
    const d = deferred();
    render(<Bulk onStart={vi.fn(async () => ({ id: "j1" }) as StorageBulkDeleteJob)} />);
    await flush();
    await d.resolve(lowAdvice(["/data/a", "/data/b", "/data/c.bin", "/data/d.bin"]));
    expect(headline()).toContain("Nothing found");
    expect(block().querySelectorAll(".st-advice__item").length).toBe(0);
    setInput(document.getElementById("st-bulk-confirm") as HTMLInputElement, "delete 4 items");
    expect(button(/Delete 4 permanently/).disabled).toBe(false);
  });
});
