import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeElevatedDelete, ApiError, deleteStoragePath, fetchStorageQuarantine, resolveStorageQuarantine, revokeElevatedDelete } from "../../api/client";
import type { StorageElevatedDeleteAck, StorageQuarantineItem, StorageStatus } from "../../api/types";
import { cleanupRenders, flush, render } from "../../testing/render";
import { AdminDeleteAckNote } from "./AdminDeleteAck";
import { DeleteDialog, type DeleteTarget } from "./DeleteDialog";
import { NeedsAttention } from "./NeedsAttention";
import { useAdminAccess } from "./useAdminAccess";

vi.mock("../../api/client", async (importOriginal) => {
  const { lowAdvice } = await import("../../testing/advice");
  return {
    ...(await importOriginal<typeof import("../../api/client")>()),
    // The delete check: everything checked, nothing found, so the dialogs work as they did before it.
    adviseStorageDelete: vi.fn(async (_id: string, paths: string[]) => lowAdvice(paths)),
    fetchStorageQuarantine: vi.fn(),
    resolveStorageQuarantine: vi.fn(),
    acknowledgeElevatedDelete: vi.fn(async () => ({ success: true, ack: { user: "me", acknowledgedAt: 5 } })),
    revokeElevatedDelete: vi.fn(async () => ({ success: true, revoked: true })),
    deleteStoragePath: vi.fn(),
  };
});

const STATUS: StorageStatus = { user: "me", sudo: "no", passwordAllowed: true, filesystems: [], docker: { state: "ok", rootDir: null } };
const item = (over: Partial<StorageQuarantineItem> = {}): StorageQuarantineItem => ({
  id: "0b6f1c2e-6a0e-4c1f-9d55-4a1e7a3c2b10",
  state: "conflict",
  elevated: false,
  type: "dir",
  createdAt: 1761480000000,
  path: "/data/models/llama",
  stagedPath: "/home/me/.local/state/sparkdash/staging/0b6f1c2e-6a0e-4c1f-9d55-4a1e7a3c2b10",
  reason: "Its name is in use again, so it was not put back.",
  ...over,
});

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function Harness({ status = STATUS, ack = null, onNotice = () => {}, onChanged = () => {} }: { status?: StorageStatus; ack?: StorageElevatedDeleteAck | null; onNotice?: (n: unknown) => void; onChanged?: () => void }) {
  const access = useAdminAccess("s1", status);
  return <NeedsAttention sparkId="s1" sparkName="Spark One" access={access} account="me" ack={ack} refreshKey={status} onNotice={onNotice} onChanged={onChanged} />;
}

beforeEach(() => {
  vi.mocked(fetchStorageQuarantine).mockReset();
  vi.mocked(resolveStorageQuarantine).mockReset();
  vi.mocked(deleteStoragePath).mockReset();
  vi.mocked(acknowledgeElevatedDelete).mockClear();
});

describe("Needs attention", () => {
  it("shows nothing when nothing is waiting, or when the list cannot be read", async () => {
    vi.mocked(fetchStorageQuarantine).mockResolvedValue({ items: [] });
    render(<Harness />);
    await flush();
    expect(document.body.querySelector(".st-attention")).toBeNull();
    vi.mocked(fetchStorageQuarantine).mockRejectedValue(new Error("unreachable"));
    render(<Harness />);
    await flush();
    expect(document.body.querySelector(".st-attention")).toBeNull();
  });

  it("lists each kept item with where it was and why, with the actions that fit its state", async () => {
    vi.mocked(fetchStorageQuarantine).mockResolvedValue({
      items: [item(), item({ id: "aaaaaaaa-0000-0000-0000-000000000001", state: "gone", path: "/data/old.bin", type: "file", reason: null }), item({ id: "aaaaaaaa-0000-0000-0000-000000000002", state: "unknown", path: "/data/odd" })],
    });
    render(<Harness />);
    await flush();
    const cards = [...document.body.querySelectorAll(".st-attention__item")];
    expect(cards).toHaveLength(3);
    expect(text()).toContain("3 deletes on Spark One did not finish");
    expect(cards[0].textContent).toContain("/data/models/llama");
    expect(cards[0].textContent).toContain("in use again");
    expect([...cards[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Put back", "Delete"]);
    expect([...cards[1].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss"]);
    expect(cards[2].querySelectorAll("button")).toHaveLength(0);
    expect(cards[2].textContent).toContain("Check /home/me/.local/state/sparkdash/staging/");
  });

  it("put back: a refusal is shown right under the item card, and a success says so and re-reads the list", async () => {
    vi.mocked(fetchStorageQuarantine).mockResolvedValueOnce({ items: [item()] }).mockResolvedValue({ items: [] });
    vi.mocked(resolveStorageQuarantine)
      .mockRejectedValueOnce(new ApiError("Something new is now at /data/models/llama. Rename or remove it, then put this item back.", 409, "restore-conflict"))
      .mockResolvedValueOnce({ success: true, id: item().id, outcome: "restored" });
    const onNotice = vi.fn();
    const onChanged = vi.fn();
    render(<Harness onNotice={onNotice} onChanged={onChanged} />);
    await flush();
    await act(async () => button("Put back").click());
    const dialog = document.body.querySelector(".st-dialog") as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("Put this back?");
    expect(dialog.textContent).toContain("nothing is replaced");
    await act(async () => (dialog.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement).click());
    await flush();
    expect(resolveStorageQuarantine).toHaveBeenCalledWith("s1", item().id, "restore", {});
    const kids = [...(dialog.querySelector(".modal-sheet__body") as HTMLElement).children];
    expect(kids[0].classList.contains("st-target")).toBe(true);
    expect(kids[1].classList.contains("st-problem")).toBe(true);
    expect(kids[1].textContent).toContain("Something new is now at");
    await act(async () => (dialog.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement).click());
    await flush();
    expect(onNotice).toHaveBeenCalledWith({ tone: "ok", text: "Put llama back in its place." });
    expect(onChanged).toHaveBeenCalled();
    await flush();
    expect(document.body.querySelector(".st-attention")).toBeNull();
  });

  it("Dismiss only ever drops the record: it asks for forget, and when something is staged again it says so and re-reads the list", async () => {
    const gone = item({ state: "gone", reason: null });
    vi.mocked(fetchStorageQuarantine)
      .mockResolvedValueOnce({ items: [gone] })
      .mockResolvedValueOnce({ items: [item({ state: "staged", reason: null })] });
    vi.mocked(resolveStorageQuarantine).mockRejectedValueOnce(
      new ApiError("Something is in the staging folder for this item, so its record was kept. Look at the list again: it can be put back or deleted.", 409, "payload-present")
    );
    render(<Harness />);
    await flush();
    await act(async () => button("Dismiss").click());
    const dialog = document.body.querySelector(".st-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Dismiss this record?");
    expect(dialog.textContent).toContain("Nothing on the Spark changes.");
    await act(async () => (dialog.querySelector(".modal-sheet__footer .btn--primary") as HTMLButtonElement).click());
    await flush();
    expect(resolveStorageQuarantine).toHaveBeenCalledWith("s1", gone.id, "forget", {});
    expect(resolveStorageQuarantine).not.toHaveBeenCalledWith("s1", gone.id, "delete", expect.anything());
    expect(dialog.querySelector(".st-problem")?.textContent).toContain("its record was kept");
    expect(fetchStorageQuarantine).toHaveBeenCalledTimes(2);
    // Behind the dialog the list now offers what fits a staged item.
    const card = document.body.querySelector(".st-attention__item") as HTMLElement;
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Put back", "Delete"]);
  });

  it("an item kept from an administrator delete asks for the sudo password, and for the acknowledgement to delete a folder", async () => {
    vi.mocked(fetchStorageQuarantine).mockResolvedValue({ items: [item({ elevated: true, state: "staged" })] });
    vi.mocked(resolveStorageQuarantine).mockResolvedValue({ success: true, id: item().id, outcome: "deleted" });
    render(<Harness />);
    await flush();
    await act(async () => button("Delete").click());
    const dialog = document.body.querySelector(".st-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Processes running as me are treated as having root access.");
    const del = button("Delete as administrator");
    setInput(dialog.querySelector('input[type="password"]') as HTMLInputElement, "pw");
    expect(del.disabled).toBe(true); // a password alone never implies the acknowledgement
    act(() => (dialog.querySelector(".st-ack input") as HTMLInputElement).click());
    expect(del.disabled).toBe(false);
    await act(async () => del.click());
    await flush();
    expect(acknowledgeElevatedDelete).toHaveBeenCalledWith("s1", "me");
    expect(resolveStorageQuarantine).toHaveBeenCalledWith("s1", item().id, "delete", { sudo: true, sudoPassword: "pw", remember: false });
  });
});

function DeleteHarness({ target, ack = null, status = STATUS }: { target: DeleteTarget; ack?: StorageElevatedDeleteAck | null; status?: StorageStatus }) {
  const access = useAdminAccess("s1", status);
  const [open, setOpen] = useState<DeleteTarget | null>(target);
  return <DeleteDialog sparkId="s1" sparkName="Spark One" target={open} access={access} preferAdmin={false} onClose={() => setOpen(null)} onDeleted={() => setOpen(null)} ack={ack} account="me" />;
}

describe("Delete dialog: administrator deletes of folders", () => {
  const folder: DeleteTarget = { path: "/data/models", type: "dir", bytes: 3e9 };
  const tickAdmin = () => act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());

  it("the first one shows the statement, laid out with the administrator fields, and stores the acknowledgement before deleting", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: folder.path });
    render(<DeleteHarness target={folder} status={{ ...STATUS, sudo: "yes" }} />);
    await flush();
    const reserve = document.body.querySelector(".st-reserve") as HTMLElement;
    expect(reserve.querySelector(".st-ack")).toBeTruthy(); // reserved while hidden: ticking moves nothing
    expect(reserve.classList.contains("is-off")).toBe(true);
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "models");
    tickAdmin();
    const del = button("Delete as administrator");
    expect(del.disabled).toBe(true);
    act(() => (reserve.querySelector(".st-ack input") as HTMLInputElement).click());
    expect(del.disabled).toBe(false);
    await act(async () => del.click());
    await flush();
    expect(acknowledgeElevatedDelete).toHaveBeenCalledWith("s1", "me");
    expect(deleteStoragePath).toHaveBeenCalledWith("s1", { path: folder.path, sudo: true });
  });

  it("no statement once acknowledged, for a file, or when the dashboard already is root", async () => {
    render(<DeleteHarness target={folder} ack={{ user: "me", acknowledgedAt: 1 }} />);
    await flush();
    expect(document.body.querySelector(".st-ack")).toBeNull();
    cleanupRenders();
    render(<DeleteHarness target={{ path: "/data/a.bin", type: "file", bytes: 1 }} />);
    await flush();
    expect(document.body.querySelector(".st-ack")).toBeNull();
    cleanupRenders();
    render(<DeleteHarness target={folder} status={{ ...STATUS, sudo: "root" }} />);
    await flush();
    expect(document.body.querySelector(".st-ack")).toBeNull();
  });

  it("the Spark saying it is off brings the statement back; a tree others can write to offers the command to run by hand", async () => {
    vi.mocked(deleteStoragePath)
      .mockRejectedValueOnce(new ApiError("Deleting folders as administrator is not turned on for this Spark.", 409, "no-ack"))
      .mockRejectedValueOnce(new ApiError("drop can be changed by other accounts (it is world-writable).", 409, "tree-writable-by-others"));
    render(<DeleteHarness target={folder} ack={{ user: "me", acknowledgedAt: 1 }} status={{ ...STATUS, sudo: "yes" }} />);
    await flush();
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "models");
    tickAdmin();
    await act(async () => button("Delete as administrator").click());
    await flush();
    expect(text()).toContain("Deleting folders as administrator is off for this Spark");
    const ack = document.body.querySelector(".st-ack input") as HTMLInputElement;
    expect(ack.checked).toBe(false);
    act(() => ack.click());
    await act(async () => button("Delete as administrator").click());
    await flush();
    expect(text()).toContain("drop can be changed by other accounts");
    expect((document.getElementById("st-manual-cmd") as HTMLTextAreaElement).value).toBe("sudo rm -rf --one-file-system -- '/data/models'");
  });
});

describe("Administrator-delete note on the Storage page", () => {
  it("says who is trusted like root since when, and turns it off", async () => {
    const onChanged = vi.fn();
    render(<AdminDeleteAckNote sparkId="s1" ack={{ user: "me", acknowledgedAt: Date.UTC(2026, 9, 1) }} account="me" onChanged={onChanged} />);
    expect(text()).toContain("processes running as me are treated as having root access");
    await act(async () => button("Turn off").click());
    await flush();
    expect(revokeElevatedDelete).toHaveBeenCalledWith("s1");
    expect(onChanged).toHaveBeenCalled();
    cleanupRenders();
    render(<AdminDeleteAckNote sparkId="s1" ack={null} account="me" onChanged={onChanged} />);
    expect(document.body.querySelector(".st-ack-note")).toBeNull();
  });
});
