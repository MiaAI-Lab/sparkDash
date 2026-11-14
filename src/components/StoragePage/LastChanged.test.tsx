import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStorageScan, fetchStorageStatus } from "../../api/client";
import type { StorageEntry, StorageScanSnapshot, StorageStatus } from "../../api/types";
import { relativeTime } from "../../shared/relativeTime";
import { makeSpark } from "../../testing/fixtures";
import { cleanupRenders, flush, render } from "../../testing/render";
import { StoragePage } from "./StoragePage";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
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
  fetchStorageQuarantine: vi.fn(async () => ({ items: [] })),
}));

const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 400e9, availBytes: 600e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const MB = 1024 * 1024;
const DAY = 86_400_000;
const NOW = Date.now();
const secs = (ms: number) => Math.floor(ms / 1000);
const T = { models: secs(NOW - 400 * DAY), cache: secs(NOW - 3 * DAY), fresh: secs(NOW), root: secs(NOW) };

const entry = (path: string, bytes: number, extra: Partial<StorageEntry> = {}, type: StorageEntry["type"] = "dir", expanded = false): StorageEntry => ({ path, bytes, type, expanded, locked: null, ...extra });
const snapshot = (entries: StorageEntry[], session: Partial<NonNullable<StorageScanSnapshot["session"]>> = {}): StorageScanSnapshot => ({
  job: { id: "j1", state: "done", path: "/data", depth: 3, mode: "new", elevated: false, startedAt: 1, finishedAt: 2, error: null },
  revision: 4,
  now: NOW,
  session: { root: "/data", scannedAt: NOW, analysedAt: NOW, elevated: false, unreadable: 0, timedOut: false, hardlinks: "exact", dated: true, entries, ...session },
});
const DATED = [
  entry("/data", 1000 * MB, { modifiedAt: T.root }, "dir", true),
  entry("/data/models", 600 * MB, { modifiedAt: T.models }),
  entry("/data/cache", 300 * MB, { modifiedAt: T.cache }),
  entry("/data/fresh.bin", 50 * MB, { modifiedAt: T.fresh }, "file"),
  entry("/data/unknown", 40 * MB),
];

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const names = () => [...document.body.querySelectorAll(".st-row:not(.st-row--rest) .st-row__name")].map((n) => n.textContent);
const cell = (name: string, cls: string) => {
  const row = [...document.body.querySelectorAll(".st-row")].find((r) => r.querySelector(".st-row__name")?.textContent === name)!;
  return row.querySelector(cls) as HTMLElement;
};
const open = async (snap: StorageScanSnapshot) => {
  vi.mocked(fetchStorageScan).mockResolvedValue(snap);
  render(<StoragePage sparks={[makeSpark("s1")]} />);
  await flush();
};

beforeEach(() => {
  window.history.replaceState(null, "", "/storage");
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
});

describe("Last changed", () => {
  it("shows when each item last changed: in words, the exact time on hover, the full date for screen readers", async () => {
    await open(snapshot(DATED));
    expect(document.body.querySelector(".st-cols")?.textContent).toContain("Last changed");
    const models = cell("models", ".st-row__date");
    const when = new Date(T.models * 1000);
    expect(models.tagName).toBe("TIME");
    expect(models.getAttribute("datetime")).toBe(when.toISOString());
    expect(models.querySelector("[aria-hidden]")?.textContent).toBe(relativeTime(T.models, NOW));
    expect(models.querySelector("[aria-hidden]")?.textContent).toBe("1 year ago");
    expect(models.getAttribute("title")).toBe(`Last changed ${when.toLocaleString()}`);
    expect(models.querySelector(".sr-only")?.textContent).toContain(when.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }));
    // Old things get a quiet emphasis, recent ones none.
    expect(models.className).toContain("is-old");
    expect(cell("cache", ".st-row__date").className).not.toContain("is-old");
    expect(cell("cache", ".st-row__date").textContent).toContain(relativeTime(T.cache, NOW));
    expect(cell("fresh.bin", ".st-row__date").textContent).toContain("today");
  });

  it("an unknown date is a dash with the reason, never a made-up date", async () => {
    await open(snapshot([...DATED, entry("/data/epoch", 30 * MB, { modifiedAt: 0 })]));
    const unknown = cell("unknown", ".st-row__date");
    expect(unknown.className).toContain("is-unknown");
    expect(unknown.querySelector("[aria-hidden]")?.textContent).toBe("—");
    expect(unknown.getAttribute("title")).toContain("Not known");
    expect(unknown.querySelector(".sr-only")?.textContent).toContain("Not known");
    expect(cell("epoch", ".st-row__date").getAttribute("title")).toContain("before 1980");
    expect(text()).not.toContain("1970");
  });

  it("an analysis without dates says why, and every row reads unknown", async () => {
    await open(snapshot(DATED.map(({ modifiedAt: _m, ...rest }) => rest), { dated: false }));
    expect(text()).toContain("made before dates were recorded");
    expect(cell("models", ".st-row__date").getAttribute("title")).toBe("Not known: this analysis did not record dates.");
    // The basic scan says it in its own note.
    cleanupRenders();
    await open(snapshot(DATED.map(({ modifiedAt: _m, ...rest }) => rest), { dated: false, hardlinks: "approx" }));
    expect(text()).toContain("It does not record when things last changed.");
  });

  it("sorts by last change: newest first on the first click, oldest first on the next, unknown last", async () => {
    await open(snapshot(DATED));
    expect(names()).toEqual(["models", "cache", "fresh.bin", "unknown"]);
    act(() => button("Newest first").click());
    expect(names()).toEqual(["fresh.bin", "cache", "models", "unknown"]);
    expect(button("Newest first").getAttribute("aria-pressed")).toBe("true");
    expect(button("Biggest first").getAttribute("aria-pressed")).toBe("false");
    act(() => button("Newest first").click());
    expect(names()).toEqual(["models", "cache", "fresh.bin", "unknown"]);
    expect(button("Oldest first").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Biggest first").click());
    expect(button("Newest first").getAttribute("aria-pressed")).toBe("false");
    expect(names()).toEqual(["models", "cache", "fresh.bin", "unknown"]);
  });

  it("oldest first puts the longest-untouched item on top", async () => {
    await open(snapshot([...DATED, entry("/data/ancient", 1 * MB, { modifiedAt: secs(NOW - 3000 * DAY) })]));
    act(() => button("Newest first").click());
    act(() => button("Newest first").click());
    expect(names()[0]).toBe("ancient");
    expect(names().at(-1)).toBe("unknown");
  });

  it("the Frees column is there only when something in the folder is shared", async () => {
    await open(snapshot(DATED));
    expect(document.body.querySelector(".st-list")?.className).not.toContain("has-frees");
    expect(document.body.querySelector(".st-cols")?.textContent).not.toContain("Frees");
    expect(document.body.querySelectorAll(".st-row__frees")).toHaveLength(0);
    // The delete button still says what deleting gives back.
    expect(document.body.querySelector('[aria-label="Delete models"]')?.getAttribute("title")).toContain("Frees 600 MB");

    cleanupRenders();
    await open(snapshot([...DATED, entry("/data/linked", 80 * MB, { sharedBytes: 80 * MB, modifiedAt: T.cache })]));
    expect(document.body.querySelector(".st-list")?.className).toContain("has-frees");
    expect(document.body.querySelector(".st-cols")?.textContent).toContain("Frees");
    expect(cell("models", ".st-row__frees").textContent).toBe("600 MB");
    expect(cell("linked", ".st-row__frees").textContent).toBe("0 B");
    // On narrow screens only the rows where it differs from the size keep "frees" under it (is-shared).
    expect(cell("linked", ".st-row__frees").className).toContain("is-shared");
    expect(cell("models", ".st-row__frees").className).not.toContain("is-shared");
  });

  it("each row keeps its date and frees in the one line that sits under the size on narrow screens", async () => {
    await open(snapshot([...DATED, entry("/data/linked", 80 * MB, { sharedBytes: 40 * MB, modifiedAt: T.cache })]));
    for (const row of document.body.querySelectorAll(".st-row:not(.st-row--rest)")) {
      const meta = row.querySelector(":scope > .st-row__meta")!;
      expect(meta).toBeTruthy();
      expect(meta.querySelector(".st-row__date")).toBeTruthy();
      expect(meta.querySelector(".st-row__frees")).toBeTruthy();
      expect(row.querySelector(":scope > .st-row__date, :scope > .st-row__frees")).toBeNull();
    }
    // The header has a heading for every column the rows have.
    const cols = document.body.querySelector(".st-cols")!.children.length;
    const first = document.body.querySelector(".st-row")!;
    const cells = [...first.children].reduce((n, c) => n + (c.classList.contains("st-row__meta") ? c.children.length : 1), 0);
    expect(cells).toBe(cols);
  });
});
