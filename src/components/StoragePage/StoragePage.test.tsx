import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, deleteStoragePath, fetchDockerStorage, fetchStorageFolders, fetchStorageScan, fetchStorageStatus, removeDockerContainers, removeDockerImages, startStorageScan, forgetStorageSudo } from "../../api/client";
import type { DockerStorage, SparkSnapshot, StorageEntry, StorageScanSnapshot, StorageStatus } from "../../api/types";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { DeleteDialog, type DeleteTarget } from "./DeleteDialog";
import { DockerTab } from "./DockerTab";
import { StoragePage } from "./StoragePage";
import { useAdminAccess } from "./useAdminAccess";

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
    fetchDockerStorage: vi.fn(),
    removeDockerImages: vi.fn(),
    removeDockerContainers: vi.fn(),
    forgetStorageSudo: vi.fn(),
    // Needs attention (NeedsAttention.test.tsx): nothing to show here.
    fetchStorageQuarantine: vi.fn(async () => ({ items: [] })),
  };
});

const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [
    { source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 900e9, availBytes: 100e9 },
    { source: "/dev/nvme0n1p1", fstype: "vfat", mount: "/boot/efi", totalBytes: 511e6, usedBytes: 7e6, availBytes: 504e6 },
  ],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const e = (path: string, bytes: number, type: StorageEntry["type"] = "dir", expanded = false, locked: string | null = null): StorageEntry => ({ path, bytes, type, expanded, locked });
const SCAN: StorageScanSnapshot = {
  job: { id: "j1", state: "done", path: "/", depth: 3, mode: "new", elevated: false, startedAt: 1, finishedAt: 2, error: null },
  revision: 1,
  session: {
    root: "/",
    scannedAt: 2,
    elevated: false,
    unreadable: 0,
    timedOut: false,
    entries: [
      e("/", 1000, "dir", true, "This is the whole disk."),
      e("/home", 800, "dir", true, "A top-level system folder."),
      e("/home/me", 700, "dir", true, "A whole home folder."),
      e("/home/me/models", 600, "dir", false),
      e("/home/me/notes.txt", 50, "file"),
    ],
  },
};

const text = () => document.body.textContent ?? "";
const button = (label: string | RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.includes(label) : label.test(b.textContent ?? ""))) as HTMLButtonElement;
const byLabel = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/storage");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  vi.mocked(fetchStorageScan).mockResolvedValue({ job: null, revision: 0, session: null });
});

describe("StoragePage", () => {
  it("offers Sparks only, shows their disks, and starts at the question 'what to look at'", async () => {
    const host = { ...makeSpark("pc"), kind: "host" as const, name: "Gaming PC" };
    render(<StoragePage sparks={[makeSpark("s1"), host]} />);
    await flush();
    expect(text()).toContain("Storage Manager");
    expect(text()).not.toContain("Gaming PC");
    expect(fetchStorageStatus).toHaveBeenCalledWith("s1");
    expect(text()).toContain("93.1 GB free");
    expect(text()).not.toContain("/boot/efi");
    expect(text()).toContain("Whole disk");
    expect(button("Analyse").disabled).toBe(false);
  });

  it("offers whole disk, home folder, cache folder and a specific folder, nothing else", async () => {
    vi.mocked(fetchStorageStatus).mockResolvedValue({ ...STATUS, homeDir: "/home/me" });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    const titles = [...document.body.querySelectorAll(".st-choice__title")].map((n) => n.textContent);
    expect(titles).toEqual(["Whole disk", "Home folder", "Cache folder", "A specific folder"]);
    const paths = [...document.body.querySelectorAll(".st-choice__path")].map((n) => n.textContent);
    expect(paths).toEqual(["/", "/home/me", "/home/me/.cache"]);
    act(() => (document.body.querySelectorAll<HTMLButtonElement>(".st-choice")[2]).click());
    vi.mocked(startStorageScan).mockResolvedValue({ job: { ...SCAN.job!, state: "running", finishedAt: null } });
    await act(async () => button("Analyse").click());
    expect(startStorageScan).toHaveBeenCalledWith("s1", { path: "/home/me/.cache", depth: 3, mode: "new" });
  });

  it("never points the home folder at /root: it uses the person's home under /home", async () => {
    vi.mocked(fetchStorageStatus).mockResolvedValue({ ...STATUS, user: "root", sudo: "root", homeDir: "/root", peopleHomes: ["/home/zurih"] });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    const paths = [...document.body.querySelectorAll(".st-choice__path")].map((n) => n.textContent);
    expect(paths).toEqual(["/", "/home/zurih", "/home/zurih/.cache"]);
    expect(text()).not.toContain("/root");
  });

  it("hides the home and cache choices when the account is root and nobody has a home folder", async () => {
    vi.mocked(fetchStorageStatus).mockResolvedValue({ ...STATUS, user: "root", sudo: "root", homeDir: "/root", peopleHomes: [] });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect([...document.body.querySelectorAll(".st-choice__title")].map((n) => n.textContent)).toEqual(["Whole disk", "A specific folder"]);
  });

  it("chooses a specific folder by clicking through the Spark's folders, without typing a path", async () => {
    vi.mocked(fetchStorageStatus).mockResolvedValue({ ...STATUS, homeDir: "/home/me" });
    vi.mocked(fetchStorageFolders).mockImplementation(async (_id, path) => ({
      path,
      dirs: path === "/home/me" ? ["models", "projects"] : path === "/home/me/models" ? ["llama"] : [],
      more: false,
    }));
    vi.mocked(startStorageScan).mockResolvedValue({ job: { ...SCAN.job!, state: "running", finishedAt: null } });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    act(() => button("A specific folder").click());
    await flush();
    expect(document.body.querySelector('.st-analyse__custom input[type="text"]')).toBeNull();
    expect(fetchStorageFolders).toHaveBeenCalledWith("s1", "/home/me");
    expect(text()).toContain("projects");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-picker__row")].find((b) => b.textContent?.includes("models"))!.click());
    await flush();
    expect(fetchStorageFolders).toHaveBeenCalledWith("s1", "/home/me/models");
    expect(document.body.querySelector(".st-picker__chosen")?.textContent).toContain("/home/me/models");
    await act(async () => button("Analyse").click());
    expect(startStorageScan).toHaveBeenCalledWith("s1", { path: "/home/me/models", depth: 3, mode: "new" });
    // Going back up through the path bar.
  });

  it("the folder picker goes up, shows empty and failed folders, and keeps a fixed-height list", async () => {
    vi.mocked(fetchStorageStatus).mockResolvedValue({ ...STATUS, homeDir: "/home/me" });
    vi.mocked(fetchStorageFolders).mockImplementation(async (_id, path) => {
      if (path === "/home") throw new ApiError("This folder cannot be opened by the dashboard's account", 403, "permission");
      return { path, dirs: [], more: false };
    });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    act(() => button("A specific folder").click());
    await flush();
    expect(text()).toContain("No folders inside");
    await act(async () => button(/Up to home/).click());
    await flush();
    expect(text()).toContain("cannot be opened");
    expect(document.body.querySelector(".st-picker__list")).toBeTruthy();
    await act(async () => button(/Up to the top/).click());
    await flush();
    expect(document.body.querySelector(".st-picker__chosen")?.textContent).toContain("/");
  });

  it("says so when there is no Spark at all", async () => {
    render(<StoragePage sparks={[{ ...makeSpark("pc"), kind: "host" }]} />);
    await flush();
    expect(text()).toContain("No DGX Spark to look at");
    expect(fetchStorageStatus).not.toHaveBeenCalled();
  });

  it("reports an unreachable Spark with a way to retry", async () => {
    vi.mocked(fetchStorageStatus).mockRejectedValueOnce(new Error("ssh: Connection refused"));
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("Could not reach");
    expect(text()).toContain("Connection refused");
    await act(async () => button("Try again").click());
    await flush();
    expect(text()).toContain("Whole disk");
  });

  it("starts an analysis and shows the result biggest first with drill-down and a lock on protected folders", async () => {
    vi.mocked(startStorageScan).mockResolvedValue({ job: { ...SCAN.job!, state: "running", finishedAt: null } });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    await act(async () => button("Analyse").click());
    expect(startStorageScan).toHaveBeenCalledWith("s1", { path: "/", depth: 3, mode: "new" });
    expect(text()).toContain("Analysing");
  });

  it("reopens on an earlier analysis kept by the server", async () => {
    vi.mocked(fetchStorageScan).mockResolvedValue(SCAN);
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("home");
    expect(byLabel("Cannot be deleted here: A top-level system folder.")).toBeTruthy();
    expect(byLabel("Delete home")).toBeFalsy();
    // Opening a folder that was scanned is instant; the contents are listed biggest first.
    await act(async () => byLabel("Open home").click());
    await act(async () => byLabel("Open me").click());
    const names = [...document.body.querySelectorAll(".st-row__name")].map((n) => n.textContent);
    expect(names.slice(0, 2)).toEqual(["models", "notes.txt"]);
    expect(byLabel("Delete models")).toBeTruthy();
    expect(startStorageScan).not.toHaveBeenCalled();
  });

  it("scans a folder first when it was never looked inside", async () => {
    vi.mocked(fetchStorageScan).mockResolvedValue(SCAN);
    vi.mocked(startStorageScan).mockResolvedValue({ job: { ...SCAN.job!, id: "j2", state: "running", mode: "drill", path: "/home/me/models", finishedAt: null } });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    await act(async () => byLabel("Open home").click());
    await act(async () => byLabel("Open me").click());
    await act(async () => byLabel("Open models").click());
    expect(startStorageScan).toHaveBeenCalledWith("s1", { path: "/home/me/models", depth: 3, mode: "drill" });
    expect(text()).toContain("Looking inside");
  });

  it("warns about folders it could not open and offers the administrator scan", async () => {
    const snap = { ...SCAN, session: { ...SCAN.session!, unreadable: 12 } };
    vi.mocked(fetchStorageScan).mockResolvedValue(snap);
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("12 folders could not be opened");
    expect(button("Analyse as administrator")).toBeTruthy();
  });
});

describe("StoragePage address bar", () => {
  const open = async () => {
    vi.mocked(fetchStorageScan).mockResolvedValue(SCAN);
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
  };
  const param = (k: string) => new URLSearchParams(window.location.search).get(k);
  const names = () => [...document.body.querySelectorAll(".st-row__name")].map((n) => n.textContent);

  it("puts the folder in the address and lets Back and Forward walk through the folders", async () => {
    await open();
    expect(param("path")).toBeNull();
    expect(param("spark")).toBe("s1");
    expect(param("tab")).toBe("files");
    await act(async () => byLabel("Open home").click());
    expect(param("path")).toBe("/home");
    await act(async () => byLabel("Open me").click());
    expect(param("path")).toBe("/home/me");
    expect(names().slice(0, 2)).toEqual(["models", "notes.txt"]);

    await act(async () => {
      window.history.back();
    });
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(param("path")).toBe("/home");
    expect(names()).toContain("me");
    await act(async () => {
      window.history.forward();
    });
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(names().slice(0, 2)).toEqual(["models", "notes.txt"]);
  });

  it("opens a copied link on the same folder, and on the tab it names", async () => {
    window.history.replaceState(null, "", "/storage?spark=s1&path=%2Fhome%2Fme");
    await open();
    expect(names().slice(0, 2)).toEqual(["models", "notes.txt"]);
    expect(document.body.querySelector("#st-panel-files")?.hasAttribute("hidden")).toBe(false);

    window.history.replaceState(null, "", "/storage?tab=docker");
    vi.mocked(fetchDockerStorage).mockResolvedValue({ rootDir: null, usage: {}, images: [], containers: [] });
    document.body.replaceChildren();
    await open();
    expect(document.body.querySelector("#st-panel-docker")?.hasAttribute("hidden")).toBe(false);
  });

  it("a link to a folder that is not in the analysis lands on the nearest folder that is", async () => {
    window.history.replaceState(null, "", "/storage?path=%2Fhome%2Fme%2Fgone%2Fdeeper");
    await open();
    expect(names().slice(0, 2)).toEqual(["models", "notes.txt"]);
    expect(document.body.querySelector(".st-crumbs__here")?.textContent).toBe("me");
  });

  it("the breadcrumb goes back to the top with a clean address", async () => {
    window.history.replaceState(null, "", "/storage?path=%2Fhome%2Fme");
    await open();
    const top = [...document.body.querySelectorAll<HTMLButtonElement>(".st-crumbs__link")].find((b) => b.textContent === "Whole disk")!;
    await act(async () => top.click());
    expect(param("path")).toBeNull();
  });

  it("switching tab adds a history entry too", async () => {
    await open();
    const tab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes("Docker"))!;
    vi.mocked(fetchDockerStorage).mockResolvedValue({ rootDir: null, usage: {}, images: [], containers: [] });
    await act(async () => tab.click());
    expect(param("tab")).toBe("docker");
    // Back returns to the Files tab, not to whichever tab was used last.
    await act(async () => {
      window.history.back();
    });
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(param("tab")).toBe("files");
    expect(document.body.querySelector("#st-panel-files")?.hasAttribute("hidden")).toBe(false);
  });
});

function DeleteHarness({ target, status = STATUS, onDeleted = () => {} }: { target: DeleteTarget; status?: StorageStatus; onDeleted?: (t: DeleteTarget) => void }) {
  const access = useAdminAccess("s1", status);
  const [open, setOpen] = useState<DeleteTarget | null>(target);
  // Administrator folder deletes acknowledged here; the acknowledgement itself is tested in NeedsAttention.test.tsx.
  return <DeleteDialog sparkId="s1" sparkName="Spark One" target={open} access={access} preferAdmin={false} onClose={() => setOpen(null)} onDeleted={onDeleted} ack={{ user: "me", acknowledgedAt: 1 }} />;
}

describe("DeleteDialog", () => {
  const folder: DeleteTarget = { path: "/home/me/models", type: "dir", bytes: 3e9 };

  it("asks for the folder's name before it will delete, and never for a file", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: folder.path });
    const onDeleted = vi.fn();
    render(<DeleteHarness target={folder} onDeleted={onDeleted} />);
    await flush();
    const del = button("Delete permanently");
    expect(del.disabled).toBe(true);
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "model");
    expect(del.disabled).toBe(true);
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "models");
    expect(del.disabled).toBe(false);
    await act(async () => del.click());
    await flush();
    expect(deleteStoragePath).toHaveBeenCalledWith("s1", { path: "/home/me/models" });
    expect(onDeleted).toHaveBeenCalledWith(folder);
  });

  it("ticking 'as administrator' or 'remember' changes nothing about the dialog: those parts are laid out all along, only hidden", async () => {
    render(<DeleteHarness target={folder} />);
    await flush();
    const admin = document.body.querySelector(".st-reserve") as HTMLElement;
    expect(admin.classList.contains("is-off")).toBe(true); // reserved, not shown
    expect(admin.hasAttribute("inert")).toBe(true); // and not reachable by keyboard or screen reader
    expect(admin.querySelector('input[type="password"]')).toBeTruthy(); // so it already takes its space
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    expect(admin.classList.contains("is-off")).toBe(false);
    expect(admin.hasAttribute("inert")).toBe(false);
    const hint = document.body.querySelector(".st-admin__rememberhint") as HTMLElement;
    expect(hint.classList.contains("is-off")).toBe(true);
    act(() => (document.body.querySelector(".st-admin__remember input") as HTMLInputElement).click());
    expect(hint.classList.contains("is-off")).toBe(false);
    expect(document.body.querySelector(".st-admin__remember span")?.textContent).toBe("Remember it on this dashboard");
  });

  it("the 'type the name' caption can be selected without pulling focus into the input, and the input is still named by it", async () => {
    render(<DeleteHarness target={folder} />);
    await flush();
    const input = document.getElementById("st-confirm-name") as HTMLInputElement;
    const caption = document.getElementById("st-confirm-label") as HTMLElement;
    expect(caption.tagName).not.toBe("LABEL");
    expect(document.querySelector('label[for="st-confirm-name"]')).toBeNull();
    expect(input.getAttribute("aria-labelledby")).toBe("st-confirm-label");
    expect(caption.textContent).toBe("Type models to confirm");
    // Click on the name inside the caption while focus is elsewhere: focus must not jump to the input.
    const cancel = button("Cancel");
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    act(() => (caption.querySelector("b") as HTMLElement).click());
    expect(document.activeElement).toBe(cancel);
    // The name is one selectable unit.
    expect(caption.querySelector("b")?.className).toContain("st-selectable");
  });

  it("a failure is shown right under the item, above the fields, so it is never pushed out of view", async () => {
    vi.mocked(deleteStoragePath).mockRejectedValueOnce(new ApiError("Permission denied", 403, "permission"));
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} />);
    await flush();
    await act(async () => button("Delete permanently").click());
    await flush();
    const body = document.body.querySelector(".st-dialog .modal-sheet__body")!;
    const kids = [...body.children];
    const problem = kids.findIndex((el) => el.classList.contains("st-problem"));
    const fields = kids.findIndex((el) => el.querySelector(".st-admin__field, .st-admin__remember"));
    expect(problem).toBeGreaterThan(-1);
    expect(problem).toBeLessThan(fields);
    expect(problem).toBeLessThanOrEqual(1); // straight after the item card
  });

  it("deletes a file with one click", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/home/me/a.bin" });
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} />);
    await flush();
    expect(document.getElementById("st-confirm-name")).toBeNull();
    expect(button("Delete permanently").disabled).toBe(false);
  });

  it("switches to administrator when the Spark refuses, asks for the sudo password, and sends it", async () => {
    vi.mocked(deleteStoragePath)
      .mockRejectedValueOnce(new ApiError("Permission denied", 403, "permission", true))
      .mockResolvedValueOnce({ success: true, path: folder.path });
    const onDeleted = vi.fn();
    render(<DeleteHarness target={folder} onDeleted={onDeleted} />);
    await flush();
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "models");
    await act(async () => button("Delete permanently").click());
    await flush();
    expect(text()).toContain("not allowed to delete everything");
    expect(text()).toContain("some of it may already be gone");
    const admin = button("Delete as administrator");
    expect(admin.disabled).toBe(true); // needs the password first
    const pw = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw).toBeTruthy();
    setInput(pw, "hunter2");
    expect(admin.disabled).toBe(false);
    await act(async () => admin.click());
    await flush();
    expect(deleteStoragePath).toHaveBeenLastCalledWith("s1", { path: folder.path, sudo: true, sudoPassword: "hunter2", remember: false });
    expect(onDeleted).toHaveBeenCalled();
  });

  it("a wrong password is reported on the password box and forgotten", async () => {
    vi.mocked(deleteStoragePath).mockRejectedValue(new ApiError("The sudo password was not accepted", 403, "bad-password"));
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    const pw = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    setInput(pw, "nope");
    await act(async () => button("Delete as administrator").click());
    await flush();
    expect(text()).toContain("password was not accepted");
    expect((document.body.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  });

  it("when Settings allows plain http, the password box shows even where the page is not a secure context", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} status={{ ...STATUS, passwordAllowed: true, plainPasswordAllowed: true }} />);
      await flush();
      act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
      expect(document.body.querySelector('input[type="password"]')).toBeTruthy();
      expect(document.getElementById("st-manual-cmd")).toBeNull();
    } finally {
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    }
  });

  it("passwordless sudo needs no password field", async () => {
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} status={{ ...STATUS, sudo: "yes" }} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    expect(button("Delete as administrator").disabled).toBe(false);
  });

  it("on a plain-http connection it offers the command to run on the Spark instead of a password box", async () => {
    render(<DeleteHarness target={{ path: "/home/me/it's here", type: "file", bytes: 10 }} status={{ ...STATUS, passwordAllowed: false }} />);
    await flush();
    expect(document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]')).toBeTruthy();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    expect((document.getElementById("st-manual-cmd") as HTMLTextAreaElement).value).toBe("sudo rm -rf --one-file-system -- '/home/me/it'\\''s here'");
  });
});

const ID = (c: string) => `sha256:${c.repeat(64)}`;
const DOCKER: DockerStorage = {
  rootDir: "/var/lib/docker",
  usage: {
    images: { count: 3, active: 1, sizeBytes: 90e9, reclaimableBytes: 40e9 },
    containers: { count: 1, active: 1, sizeBytes: 1e6, reclaimableBytes: 0 },
  },
  containers: [],
  images: [
    { id: ID("a"), tags: ["old:1"], sizeBytes: 30e9, created: "2026-10-01T00:00:00Z", usedBy: [], status: "unused" },
    { id: ID("b"), tags: [], sizeBytes: 30e9, created: null, usedBy: [], status: "unused" },
    { id: ID("c"), tags: ["web:latest"], sizeBytes: 5e9, created: null, usedBy: [{ name: "web", state: "running" }], status: "running" },
  ],
};

function DockerHarness({ status = STATUS, peers = [], onNotice = () => {} }: { status?: StorageStatus; peers?: SparkSnapshot[]; onNotice?: (n: { tone: string; text: string } | null) => void }) {
  const access = useAdminAccess("s1", status);
  return <DockerTab spark={makeSpark("s1")} peers={peers} access={access} onNotice={onNotice} onDiskChanged={() => {}} />;
}

describe("DockerTab", () => {
  it("uses Docker's reclaimable estimate, not the sum of overlapping image sizes", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(DOCKER);
    render(<DockerHarness />);
    await flush();
    expect(text()).toContain("2 unused");
    expect(text()).toContain("about 37.3 GB"); // Docker's 40e9 reclaimable, in 1024 units
    expect(text()).not.toContain("55.9 GB"); // the 60e9 the two images add up to
  });

  it("only unused images can be selected, and removal sends exactly those IDs", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(DOCKER);
    vi.mocked(removeDockerImages).mockResolvedValue({ success: true, removed: [ID("a"), ID("b")], skipped: [], failed: [] });
    render(<DockerHarness />);
    await flush();
    const checks = [...document.body.querySelectorAll<HTMLInputElement>(".st-img__check")];
    expect(checks.map((c) => c.disabled)).toEqual([false, false, true]);
    await act(async () => button("Select all 2 unused").click());
    expect(text()).toContain("2 selected");
    await act(async () => button("Remove 2 images").click());
    expect(text()).toContain("Remove 2 images?");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
    expect(removeDockerImages).toHaveBeenCalledWith("s1", { ids: [ID("a"), ID("b")] });
  });

  it("when Docker needs administrator access it asks for the password and retries", async () => {
    vi.mocked(fetchDockerStorage)
      .mockRejectedValueOnce(new ApiError("Docker needs administrator rights for this account", 403, "docker-denied"))
      .mockResolvedValueOnce(DOCKER);
    render(<DockerHarness />);
    await flush();
    expect(text()).toContain("Docker needs administrator access");
    const pw = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    setInput(pw, "pw");
    await act(async () => button("Unlock Docker").click());
    await flush();
    expect(fetchDockerStorage).toHaveBeenLastCalledWith("s1", { sudo: true, sudoPassword: "pw", remember: false });
    expect(text()).toContain("2 unused");
  });

  it("with passwordless sudo it just retries as administrator", async () => {
    vi.mocked(fetchDockerStorage)
      .mockRejectedValueOnce(new ApiError("denied", 403, "docker-denied"))
      .mockResolvedValueOnce(DOCKER);
    render(<DockerHarness status={{ ...STATUS, sudo: "yes" }} />);
    await flush();
    await flush();
    expect(fetchDockerStorage).toHaveBeenLastCalledWith("s1", { sudo: true });
    expect(text()).toContain("2 unused");
  });

  it("says plainly when Docker is not installed", async () => {
    vi.mocked(fetchDockerStorage).mockRejectedValue(new ApiError("Docker is not installed on this Spark", 409, "no-docker"));
    render(<DockerHarness />);
    await flush();
    expect(text()).toContain("Docker is not installed here");
  });
});

const CID = (c: string) => c.repeat(64);
const WITH_STOPPED: DockerStorage = {
  rootDir: "/var/lib/docker",
  usage: { images: { count: 2, active: 1, sizeBytes: 60e9, reclaimableBytes: 30e9 } },
  images: [
    { id: ID("d"), tags: ["glm:v1"], sizeBytes: 30e9, created: null, usedBy: [{ name: "glm-head", state: "exited" }, { name: "glm-job", state: "exited" }], status: "stopped" },
    { id: ID("c"), tags: ["web:latest"], sizeBytes: 5e9, created: null, usedBy: [{ name: "web", state: "running" }], status: "running" },
  ],
  containers: [
    { id: CID("1"), name: "glm-head", state: "exited", imageId: ID("d"), created: "2026-09-01T00:00:00Z", removable: true },
    { id: CID("2"), name: "glm-job", state: "created", imageId: ID("d"), created: "2026-09-02T00:00:00Z", removable: true },
    { id: CID("3"), name: "web", state: "running", imageId: ID("c"), created: "2026-10-01T00:00:00Z", removable: false },
  ],
};
const AFTER: DockerStorage = { ...WITH_STOPPED, images: [{ ...WITH_STOPPED.images[0], usedBy: [], status: "unused" }, WITH_STOPPED.images[1]], containers: [WITH_STOPPED.containers[2]] };

describe("DockerTab containers", () => {
  beforeEach(() => {
    vi.mocked(removeDockerImages).mockReset();
    vi.mocked(removeDockerContainers).mockReset();
  });

  it("lists stopped containers first, and a running one cannot be selected", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(WITH_STOPPED);
    render(<DockerHarness />);
    await flush();
    expect(text()).toContain("2 stopped");
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('[aria-label^="Select container"]')];
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["Select container glm-head", "Select container glm-job"]);
    act(() => button("All 3").click());
    const all = [...document.body.querySelectorAll<HTMLInputElement>('[aria-label^="Select container"]')];
    expect(all.find((b) => b.getAttribute("aria-label")?.endsWith("web"))!.disabled).toBe(true);
  });

  it("removes selected containers with exactly their IDs", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(WITH_STOPPED);
    vi.mocked(removeDockerContainers).mockResolvedValue({ success: true, removed: [CID("1"), CID("2")], skipped: [], failed: [] });
    render(<DockerHarness />);
    await flush();
    await act(async () => button("Select all 2 stopped").click());
    await act(async () => button("Remove 2 containers").click());
    expect(text()).toContain("Remove 2 containers?");
    // From the section's own button the image is not removed unless asked for.
    expect((document.body.querySelector('.st-dialog input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
    expect(removeDockerContainers).toHaveBeenCalledWith("s1", { ids: [CID("1"), CID("2")] });
    expect(removeDockerImages).not.toHaveBeenCalled();
  });

  it("from an image row: removes its stopped containers, then the image once it is unused", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValueOnce(WITH_STOPPED).mockResolvedValueOnce(AFTER).mockResolvedValue(AFTER);
    vi.mocked(removeDockerContainers).mockResolvedValue({ success: true, removed: [CID("1"), CID("2")], skipped: [], failed: [] });
    vi.mocked(removeDockerImages).mockResolvedValue({ success: true, removed: [ID("d")], skipped: [], failed: [] });
    render(<DockerHarness />);
    await flush();
    await act(async () => button("Remove containers…").click());
    expect((document.body.querySelector('.st-dialog input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
    await flush();
    expect(removeDockerContainers).toHaveBeenCalledWith("s1", { ids: [CID("1"), CID("2")] });
    expect(removeDockerImages).toHaveBeenCalledWith("s1", { ids: [ID("d")] });
  });

  it("keeps the image when another container still uses it", async () => {
    const still: DockerStorage = { ...AFTER, images: [{ ...AFTER.images[0], usedBy: [{ name: "other", state: "exited" }], status: "stopped" }, AFTER.images[1]] };
    vi.mocked(fetchDockerStorage).mockResolvedValueOnce(WITH_STOPPED).mockResolvedValue(still);
    vi.mocked(removeDockerContainers).mockResolvedValue({ success: true, removed: [CID("1"), CID("2")], skipped: [], failed: [] });
    render(<DockerHarness />);
    await flush();
    await act(async () => button("Remove containers…").click());
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
    await flush();
    expect(removeDockerImages).not.toHaveBeenCalled();
  });

  it("a refused removal stays in the dialog with the reason, and a wrong password is forgotten", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(WITH_STOPPED);
    vi.mocked(removeDockerContainers).mockRejectedValue(new ApiError("Docker needs administrator rights for this account", 403, "docker-denied"));
    render(<DockerHarness />);
    await flush();
    await act(async () => button("Remove containers…").click());
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
    expect(document.body.querySelector(".st-dialog")).toBeTruthy();
    expect(text()).toContain("Docker needs administrator rights");
  });
});

describe("DockerTab: the same images on other Sparks", () => {
  const two = { ...makeSpark("s2"), name: "Spark Two" };
  const three = { ...makeSpark("s3"), name: "Spark Three" };
  const peerData = (images: DockerStorage["images"]): DockerStorage => ({ rootDir: null, usage: {}, containers: [], images });
  const mineUnused = DOCKER.images.slice(0, 2); // a and b, unused

  async function openRemove(peers: SparkSnapshot[], onNotice = vi.fn()) {
    vi.mocked(removeDockerImages).mockReset();
    vi.mocked(removeDockerImages).mockResolvedValue({ success: true, removed: [], skipped: [], failed: [] });
    render(<DockerHarness peers={peers} onNotice={onNotice} />);
    await flush();
    await act(async () => button("Select all 2 unused").click());
    await act(async () => button("Remove 2 images").click());
    await flush();
    return onNotice;
  }
  const confirm = async () => {
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(".st-dialog .btn--danger")][0].click());
    await flush();
  };

  it("asks, and by default removes only on the Spark you are looking at", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (id) => (id === "s2" ? peerData(mineUnused.map((i) => ({ ...i }))) : DOCKER));
    await openRemove([two]);
    expect(text()).toContain("Also on your other Sparks");
    expect(text()).toContain("Spark Two");
    expect(text()).toContain("has all these 2 images");
    const box = document.body.querySelector('.st-peers input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await confirm();
    expect(removeDockerImages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeDockerImages).mock.calls[0][0]).toBe("s1");
    expect(fetchDockerStorage).toHaveBeenCalledWith("s2", { light: true });
  });

  it("removes the ticked Spark's copies too, but only those nothing uses there", async () => {
    const there = [{ ...mineUnused[0] }, { ...mineUnused[1], status: "running" as const, usedBy: [{ name: "web", state: "running" }] }];
    vi.mocked(fetchDockerStorage).mockImplementation(async (id) => (id === "s2" ? peerData(there) : DOCKER));
    const onNotice = await openRemove([two]);
    expect(text()).toContain("1 unused will go; 1 used are kept");
    act(() => (document.body.querySelector('.st-peers input[type="checkbox"]') as HTMLInputElement).click());
    vi.mocked(removeDockerImages).mockResolvedValueOnce({ success: true, removed: [ID("a"), ID("b")], skipped: [], failed: [] });
    vi.mocked(removeDockerImages).mockResolvedValueOnce({ success: true, removed: [ID("a")], skipped: [], failed: [] });
    await confirm();
    expect(removeDockerImages).toHaveBeenNthCalledWith(2, "s2", { ids: [ID("a")] });
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Spark Two: removed 1 image.") }));
  });

  it("retries as administrator when Docker needs it there, and removes the same way", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (id, body) => {
      if (id !== "s2") return DOCKER;
      if (!body?.sudo) throw new ApiError("denied", 403, "docker-denied");
      return peerData(mineUnused.map((i) => ({ ...i })));
    });
    await openRemove([two]);
    expect(fetchDockerStorage).toHaveBeenCalledWith("s2", { light: true, sudo: true });
    expect(text()).toContain("removed as administrator");
    act(() => (document.body.querySelector('.st-peers input[type="checkbox"]') as HTMLInputElement).click());
    await confirm();
    expect(removeDockerImages).toHaveBeenNthCalledWith(2, "s2", { ids: [ID("a"), ID("b")], sudo: true });
  });

  it("says when another Spark could not be checked, and keeps a disabled row for Sparks without these images", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (id) => {
      if (id === "s2") throw new ApiError("Docker needs administrator rights for this account", 403, "no-sudo");
      if (id === "s3") return peerData([{ ...DOCKER.images[2] }]);
      return DOCKER;
    });
    await openRemove([two, three]);
    expect(text()).toContain("Spark Two Could not be checked");
    // Every Spark keeps its row, so the sheet does not change size as the answers arrive.
    expect(text()).toContain("Spark Three Does not have this image.");
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('.st-peers input[type="checkbox"]')];
    expect(boxes.map((b) => b.disabled)).toEqual([true, true]);
  });

  it("shows one row per Spark from the very first render, with a one-line detail", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation((id) => (id === "s1" ? Promise.resolve(DOCKER) : new Promise(() => {})));
    await openRemove([two, three]);
    expect(document.body.querySelectorAll(".st-peers__row")).toHaveLength(2);
    expect(document.body.querySelectorAll(".st-peers__detail")).toHaveLength(2);
    expect(text()).toContain("Checking…");
  });

  it("shows nothing extra when there are no other Sparks", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(DOCKER);
    await openRemove([]);
    expect(text()).not.toContain("Also on your other Sparks");
  });
});

describe("remembered sudo password", () => {
  const SAVED: StorageStatus = { ...STATUS, sudoSaved: true };

  it("sends a typed password for one request by default, and remembers it only when the box is ticked", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/home/me/a.bin" });
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    setInput(document.body.querySelector('input[type="password"]') as HTMLInputElement, "pw");
    const remember = document.body.querySelector(".st-admin__remember input") as HTMLInputElement;
    expect(remember.checked).toBe(false);
    const hint = document.body.querySelector(".st-admin__rememberhint") as HTMLElement;
    expect(hint.classList.contains("is-off")).toBe(true);
    act(() => remember.click());
    expect(hint.classList.contains("is-off")).toBe(false);
    expect(hint.textContent).toContain("Kept encrypted on the dashboard server");
    await act(async () => button("Delete as administrator").click());
    await flush();
    expect(deleteStoragePath).toHaveBeenLastCalledWith("s1", { path: "/home/me/a.bin", sudo: true, sudoPassword: "pw", remember: true });
  });

  it("ticking then unticking remember sends the password for this one request only", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/home/me/b.bin" });
    render(<DeleteHarness target={{ path: "/home/me/b.bin", type: "file", bytes: 10 }} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    setInput(document.body.querySelector('input[type="password"]') as HTMLInputElement, "pw");
    const box = document.body.querySelector(".st-admin__remember input") as HTMLInputElement;
    act(() => box.click());
    act(() => box.click());
    expect(box.checked).toBe(false);
    await act(async () => button("Delete as administrator").click());
    await flush();
    expect(deleteStoragePath).toHaveBeenLastCalledWith("s1", { path: "/home/me/b.bin", sudo: true, sudoPassword: "pw", remember: false });
  });

  it("with a password remembered there is nothing to type, and a plain request is enough", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/home/me/a.bin" });
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} status={SAVED} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    expect(text()).toContain("remembered on the dashboard");
    const del = button("Delete as administrator");
    expect(del.disabled).toBe(false);
    await act(async () => del.click());
    await flush();
    expect(deleteStoragePath).toHaveBeenLastCalledWith("s1", { path: "/home/me/a.bin", sudo: true });
  });

  it("a remembered password works from a connection that could not type one, with no manual command offered", async () => {
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} status={{ ...SAVED, passwordAllowed: false }} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    expect(document.getElementById("st-manual-cmd")).toBeNull();
    expect(button("Delete as administrator").disabled).toBe(false);
  });

  it("Forget password asks the server to forget it and re-reads the status", async () => {
    vi.mocked(forgetStorageSudo).mockResolvedValue({ success: true, forgotten: true });
    render(<DeleteHarness target={{ path: "/home/me/a.bin", type: "file", bytes: 10 }} status={SAVED} />);
    await flush();
    act(() => (document.body.querySelector('.check-row:not(.st-advice__tick) input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button("Forget password").click());
    expect(forgetStorageSudo).toHaveBeenCalledWith("s1");
  });
});

describe("last analysed note", () => {
  const withAge = (ms: number, now = Date.now()): StorageScanSnapshot => ({ ...SCAN, now, session: { ...SCAN.session!, analysedAt: now - ms, scannedAt: now - ms } });

  it("says how long ago, and the analysis is still there after a reload", async () => {
    vi.mocked(fetchStorageScan).mockResolvedValue(withAge(3 * 3_600_000));
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("Last analysed 3h ago");
    expect(document.body.querySelector(".st-analysed")?.className).not.toContain("is-old");
  });

  it("goes by the server's clock, not this browser's", async () => {
    const serverNow = Date.now() + 5 * 3_600_000; // this browser is 5 h behind the server
    vi.mocked(fetchStorageScan).mockResolvedValue(withAge(10 * 60_000, serverNow));
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("Last analysed 10m ago");
  });

  it("flags an analysis older than a day as possibly out of date", async () => {
    vi.mocked(fetchStorageScan).mockResolvedValue(withAge(3 * 24 * 3_600_000));
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    expect(text()).toContain("Last analysed 3d ago");
    expect(document.body.querySelector(".st-analysed")?.className).toContain("is-old");
  });
});

describe("shared (hard-linked) sizes", () => {
  const MB = 1024 * 1024;
  const entry = (path: string, bytes: number, extra: Partial<StorageEntry> = {}, type: StorageEntry["type"] = "dir", expanded = false): StorageEntry => ({ path, bytes, type, expanded, locked: null, ...extra });
  // The layout from the bug report: hub holds the data, native is made only of links to it.
  const shared = (hardlinks: "exact" | "approx" = "exact"): StorageScanSnapshot => ({
    job: { id: "j9", state: "done", path: "/cache", depth: 3, mode: "new", elevated: false, startedAt: 1, finishedAt: 2, error: null },
    revision: 7,
    now: Date.now(),
    session: {
      root: "/cache", scannedAt: Date.now(), analysedAt: Date.now(), elevated: false, unreadable: 0, timedOut: false, hardlinks,
      entries: [
        entry("/cache", 960 * MB, {}, "dir", true),
        entry("/cache/hub", 647 * MB, { sharedBytes: 475 * MB }),
        entry("/cache/native", 475 * MB, { sharedBytes: 475 * MB }),
        entry("/cache/other", 300 * MB),
      ],
    },
  });
  const cell = (name: string, cls: string) => {
    const row = [...document.body.querySelectorAll(".st-row")].find((r) => r.querySelector(".st-row__name")?.textContent === name)!;
    return row.querySelector(cls) as HTMLElement;
  };
  const open = async (snap: StorageScanSnapshot) => {
    vi.mocked(fetchStorageScan).mockResolvedValue(snap);
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
  };

  it("shows what deleting frees next to each folder, with the shared part hatched", async () => {
    await open(shared());
    expect(cell("hub", ".st-row__size").textContent).toBe("647 MB");
    expect(cell("hub", ".st-row__frees").textContent).toBe("172 MB");
    expect(cell("native", ".st-row__frees").textContent).toBe("0 B");
    expect(cell("native", ".st-row__frees").className).toContain("is-zero");
    expect(cell("other", ".st-row__frees").textContent).toBe("300 MB");
    expect(cell("other", ".st-row__frees").className).not.toContain("is-zero");
    // Hatched part: all of native's bar, 475/647 of hub's, none of other's.
    expect(cell("native", ".st-row__bar b")!.getAttribute("style")).toContain("--sw: 100%");
    expect(cell("hub", ".st-row__bar b")!.getAttribute("style")).toContain("--sw: 73.4");
    expect(cell("other", ".st-row__bar b")).toBeNull();
    expect(document.body.textContent).toContain("Hatched parts are shared");
    expect(document.body.textContent).toContain("add up to more than the folder");
  });

  it("makes the delete button say so when nothing would come back", async () => {
    await open(shared());
    expect(byLabel("Delete native").getAttribute("title")).toContain("frees no space");
    expect(byLabel("Delete hub").getAttribute("title")).toContain("Frees 172 MB");
    expect(byLabel("Delete other").getAttribute("title")).toContain("Frees 300 MB");
  });

  it("the delete dialog explains the shared part and warns when it frees nothing", async () => {
    await open(shared());
    await act(async () => byLabel("Delete native").click());
    expect(text()).toContain("deleting frees 0 B");
    expect(text()).toContain("Deleting this will not free any space.");
    expect(text()).toContain("hard-linked to files outside this folder");
    expect(button("Delete anyway (frees nothing)")).toBeTruthy();
    act(() => button("Cancel").click());
    await act(async () => byLabel("Delete hub").click());
    expect(text()).toContain("475 MB of this is shared.");
    expect(text()).toContain("Only 172 MB comes back.");
    expect(text()).not.toContain("will not free any space");
    expect(button("Delete permanently")).toBeTruthy();
  });

  it("after a delete, says how much was really freed", async () => {
    vi.mocked(deleteStoragePath).mockResolvedValue({ success: true, path: "/cache/hub" });
    vi.mocked(fetchStorageScan).mockResolvedValue(shared());
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    await act(async () => byLabel("Delete hub").click());
    setInput(document.getElementById("st-confirm-name") as HTMLInputElement, "hub");
    await act(async () => button("Delete permanently").click());
    await flush();
    expect(text()).toContain("Deleted hub. About 172 MB freed.");
    expect(text()).toContain("475 MB of it is hard-linked elsewhere");
  });

  it("an unshared folder behaves as before: nothing hatched, frees its whole size", async () => {
    await open({ ...SCAN, now: Date.now() });
    expect(document.body.querySelector(".st-row__bar b")).toBeNull();
    expect(document.body.textContent).not.toContain("Hatched parts");
  });

  it("the basic scan says its sizes may count hard-linked files more than once", async () => {
    await open(shared("approx"));
    expect(text()).toContain("Basic scan: a file hard-linked into several folders may be counted in each of them here.");
  });
});
