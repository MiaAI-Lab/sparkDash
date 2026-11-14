import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDockerStorage, fetchStorageContext, fetchStorageScan, fetchStorageStatus, startStorageScan } from "../../api/client";
import type { SparkSnapshot, StorageContext, StorageEntry, StorageScanSnapshot, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { StoragePage } from "./StoragePage";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchStorageStatus: vi.fn(),
  fetchStorageContext: vi.fn(),
  fetchStorageScan: vi.fn(),
  startStorageScan: vi.fn(),
  cancelStorageScan: vi.fn(),
  deleteStoragePath: vi.fn(),
  fetchDockerStorage: vi.fn(),
  removeDockerImages: vi.fn(),
  removeDockerContainers: vi.fn(),
  forgetStorageSudo: vi.fn(),
}));

const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 400e9, availBytes: 600e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const e = (path: string, bytes: number, type: StorageEntry["type"] = "dir", expanded = false, locked: string | null = null): StorageEntry => ({ path, bytes, type, expanded, locked });
const NOW = Date.now();
const SAVED: StorageScanSnapshot = {
  job: { id: "j1", state: "done", path: "/", depth: 3, mode: "new", elevated: false, startedAt: 1, finishedAt: 2, error: null },
  revision: 1,
  now: NOW,
  session: {
    root: "/",
    scannedAt: NOW - 3 * 3_600_000,
    analysedAt: NOW - 3 * 3_600_000,
    elevated: false,
    unreadable: 4,
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

const CTX = (over: Partial<StorageContext> = {}): StorageContext => ({
  kind: "ssh",
  transport: "ssh",
  uid: 1000,
  account: "me",
  home: "/home/me",
  accountHome: "/home/me",
  hostname: "spark-2",
  bootId: null,
  hostPidNs: null,
  inContainer: false,
  sudo: "no",
  linger: "unknown",
  capabilities: [],
  probedAt: NOW,
  features: {},
  ...over,
});

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
const byLabel = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const param = (k: string) => new URLSearchParams(window.location.search).get(k);
const online = makeSpark("s1");
const offline: SparkSnapshot = { ...makeSpark("s2", false), name: "Spark Two" };

beforeEach(() => {
  window.history.replaceState(null, "", "/storage");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  vi.mocked(fetchStorageContext).mockResolvedValue(CTX());
  vi.mocked(fetchStorageScan).mockResolvedValue({ job: null, revision: 0, session: null });
});

describe("an offline Spark (B5)", () => {
  it("can be picked, and shows its saved analysis with its age while nothing can be started", async () => {
    vi.mocked(fetchStorageScan).mockImplementation(async (id) => (id === "s2" ? SAVED : { job: null, revision: 0, session: null }));
    render(<StoragePage sparks={[online, offline]} />);
    await flush();
    const card = [...document.body.querySelectorAll<HTMLButtonElement>(".st-spark")].find((b) => b.textContent?.includes("Spark Two"))!;
    expect(card.disabled).toBe(false);
    expect(card.textContent).toContain("Offline");
    await act(async () => card.click());
    await flush();
    expect(param("spark")).toBe("s2");
    expect(fetchStorageStatus).not.toHaveBeenCalledWith("s2");
    expect(fetchStorageContext).not.toHaveBeenCalledWith("s2");
    expect(text()).toContain("Spark Two is offline.");
    expect(text()).toContain("You are looking at the analysis saved 3h ago.");
    expect(text()).toContain("Last analysed 3h ago");
    // Browsing works; starting work does not, and each disabled control points at the reason.
    await act(async () => byLabel("Open home").click());
    expect(param("path")).toBe("/home");
    for (const label of ["Analyse again", "Look somewhere else"]) {
      const b = button(label);
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-describedby")).toBe("st-readonly-reason");
    }
    expect(document.getElementById("st-readonly-reason")?.textContent).toContain("is offline");
    expect(button("Analyse as administrator").disabled).toBe(true);
    await act(async () => byLabel("Open me").click());
    const del = byLabel("Delete models");
    expect(del.disabled).toBe(true);
    expect(del.getAttribute("title")).toContain("Spark Two is offline");
    // A folder the saved analysis never measured: opening it starts nothing.
    await act(async () => byLabel("Open models").click());
    expect(startStorageScan).not.toHaveBeenCalled();
    expect(text()).toContain("did not measure inside this folder");
  });

  it("opens straight from a link, on the folder in it, and Docker says it cannot be read", async () => {
    window.history.replaceState(null, "", "/storage?spark=s2&path=%2Fhome%2Fme");
    vi.mocked(fetchStorageScan).mockResolvedValue(SAVED);
    render(<StoragePage sparks={[online, offline]} />);
    await flush();
    expect(param("spark")).toBe("s2");
    expect(param("path")).toBe("/home/me");
    expect(document.body.querySelector(".st-crumbs__here")?.textContent).toBe("me");
    expect(fetchStorageStatus).not.toHaveBeenCalled();
    const tab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes("Docker"))!;
    await act(async () => tab.click());
    expect(param("tab")).toBe("docker");
    expect(text()).toContain("Docker on Spark Two cannot be read while it is offline");
    expect(fetchDockerStorage).not.toHaveBeenCalled();
  });

  it("says so when there is no saved analysis to show", async () => {
    window.history.replaceState(null, "", "/storage?spark=s2");
    render(<StoragePage sparks={[online, offline]} />);
    await flush();
    expect(text()).toContain("There is no saved analysis for it yet.");
    expect(text()).toContain("No saved analysis for Spark Two");
    expect(button("Analyse")).toBeUndefined();
  });

  it("comes back to life when the Spark is reachable again", async () => {
    window.history.replaceState(null, "", "/storage?spark=s2");
    vi.mocked(fetchStorageScan).mockResolvedValue(SAVED);
    const { root } = render(<StoragePage sparks={[online, offline]} />);
    await flush();
    expect(button("Analyse again").disabled).toBe(true);
    await act(async () => root.render(<StoragePage sparks={[online, { ...offline, online: true }]} />));
    await flush();
    expect(fetchStorageStatus).toHaveBeenCalledWith("s2");
    expect(text()).not.toContain("is offline");
    expect(button("Analyse again").disabled).toBe(false);
    expect(byLabel("Delete notes.txt")).toBeFalsy(); // still at the top: notes.txt is inside /home/me
  });
});

describe("execution context line and trust note", () => {
  it("says quietly how the dashboard reaches the Spark", async () => {
    render(<StoragePage sparks={[online]} />);
    await flush();
    await flush();
    expect(fetchStorageContext).toHaveBeenCalledWith("s1");
    expect(document.body.querySelector(".st-disk__ctx")?.textContent).toBe("Runs over SSH as me");
  });

  it("names the container path and the dashboard's own Spark", async () => {
    vi.mocked(fetchStorageContext).mockResolvedValueOnce(CTX({ kind: "container-local", transport: "nsenter", account: "root" }));
    const first = render(<StoragePage sparks={[online]} />);
    await flush();
    await flush();
    expect(document.body.querySelector(".st-disk__ctx")?.textContent).toBe("Runs via the dashboard's container as root");
    act(() => first.root.unmount());
    document.body.replaceChildren();
    vi.mocked(fetchStorageContext).mockResolvedValueOnce(CTX({ kind: "native-local", transport: "local" }));
    render(<StoragePage sparks={[online]} />);
    await flush();
    await flush();
    expect(document.body.querySelector(".st-disk__ctx")?.textContent).toBe("Runs on this Spark as me");
  });

  it("shows nothing when the probe fails: the line is informative only", async () => {
    vi.mocked(fetchStorageContext).mockRejectedValue(new Error("ssh: timed out"));
    render(<StoragePage sparks={[online]} />);
    await flush();
    await flush();
    expect(document.body.querySelector(".st-disk__ctx")).toBeNull();
    expect(document.body.querySelector(".st-disks")).toBeTruthy(); // the disk itself still shows
  });

  it("states the single trusted-administrator model plainly, without claiming who did what", async () => {
    render(<StoragePage sparks={[online]} />);
    await flush();
    const note = document.body.querySelector(".st-trust")?.textContent ?? "";
    expect(note).toContain("everyone who can open this dashboard");
    expect(note).toContain("There are no separate accounts");
    expect(note).toContain("not who did it");
  });
});
