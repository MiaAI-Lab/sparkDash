import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchDockerStorage, fetchStorageStatus, pruneDockerBuilderCache, removeDockerContainers, removeDockerImages } from "../../api/client";
import type { DockerContainer, DockerImage, DockerStorage, SparkSnapshot, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { DockerTab } from "./DockerTab";
import { QUICK_DAYS_PREF, QuickCleanup } from "./QuickCleanup";
import { useAdminAccess } from "./useAdminAccess";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchDockerStorage: vi.fn(),
  fetchStorageStatus: vi.fn(),
  removeDockerImages: vi.fn(),
  removeDockerContainers: vi.fn(),
  pruneDockerBuilderCache: vi.fn(),
  forgetStorageSudo: vi.fn(),
}));

const NOW = Date.now();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ID = (c: string) => `sha256:${c.repeat(64)}`;
const CID = (c: string) => c.repeat(64);

const img = (c: string, extra: Partial<DockerImage>): DockerImage => ({ id: ID(c), tags: [`${c}:1`], sizeBytes: 1e9, created: ago(30), usedBy: [], status: "unused", registryDigest: true, ...extra });
const ctr = (c: string, extra: Partial<DockerContainer>): DockerContainer => ({ id: CID(c), name: `job-${c}`, state: "exited", imageId: ID("e"), created: ago(40), removable: true, finishedAt: ago(20), ...extra });

/** This Spark: one old pulled image, one young untagged one, one old built here, two in use; an old and a new stopped container. */
const DATA: DockerStorage = {
  rootDir: "/var/lib/docker",
  usage: {
    images: { count: 5, active: 2, sizeBytes: 40e9, reclaimableBytes: 15e9 },
    containers: { count: 3, active: 1, sizeBytes: 1e9, reclaimableBytes: 3e8 },
    buildCache: { count: 50, active: 0, sizeBytes: 10e9, reclaimableBytes: 9e9 },
  },
  images: [
    img("a", { tags: ["old:1"], sizeBytes: 10e9, created: ago(30) }),
    img("b", { tags: [], sizeBytes: 2e9, created: ago(2) }),
    img("c", { tags: ["mine:dev"], sizeBytes: 5e9, created: ago(40), registryDigest: false }),
    img("d", { tags: ["web:1"], created: ago(60), status: "running", usedBy: [{ name: "web", state: "running" }] }),
    img("e", { tags: ["job:1"], created: ago(60), status: "stopped", usedBy: [{ name: "job-1", state: "exited" }] }),
  ],
  containers: [ctr("1", { finishedAt: ago(20) }), ctr("2", { finishedAt: ago(1) }), ctr("3", { name: "web", state: "running", removable: false, imageId: ID("d"), finishedAt: undefined })],
  listing: { images: "ok", containers: "ok" },
};

const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 900e9, availBytes: 100e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string | RegExp) => buttons().find((b) => (typeof label === "string" ? b.textContent?.includes(label) : label.test(b.textContent ?? ""))) as HTMLButtonElement;
const row = (title: string) => [...document.body.querySelectorAll<HTMLElement>(".st-quick__row")].find((r) => r.querySelector(".st-quick__title")?.textContent?.startsWith(title)) as HTMLElement;
const sheet = () => document.body.querySelector(".st-dialog") as HTMLElement | null;
const category = (title: string) => [...document.body.querySelectorAll<HTMLElement>(".st-quick-cat")].find((c) => c.textContent?.includes(title)) as HTMLElement;
const categoryBox = (title: string) => category(title).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const goButton = () => sheet()!.querySelector<HTMLButtonElement>(".st-quick-go")!;
const peerRows = () => [...document.body.querySelectorAll<HTMLElement>(".st-peers__row")];
const peerBox = (name: string) => peerRows().find((r) => r.querySelector("b")?.textContent === name)!.querySelector<HTMLInputElement>("input")!;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function Harness({ data = DATA, peers = [], asAdmin = false, status = STATUS, onChanged = () => {} }: { data?: DockerStorage; peers?: SparkSnapshot[]; asAdmin?: boolean; status?: StorageStatus; onChanged?: () => void }) {
  const access = useAdminAccess("s1", status);
  return <QuickCleanup spark={{ ...makeSpark("s1"), name: "Spark One" }} data={data} peers={peers} access={access} asAdmin={asAdmin} onChanged={onChanged} />;
}

const ok = (removed: string[]) => ({ success: true, removed, skipped: [], failed: [] });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  vi.mocked(removeDockerContainers).mockImplementation(async (_id, body) => ok(body.ids));
  vi.mocked(removeDockerImages).mockImplementation(async (_id, body) => ok(body.ids));
  vi.mocked(pruneDockerBuilderCache).mockResolvedValue({ success: true, olderThanDays: 7, adapter: "buildx", reclaimedBytes: 1.2e9 });
});

describe("Quick clean-up card", () => {
  it("each row counts from the list already read and words its size honestly", async () => {
    render(<Harness />);
    expect(row("Unused images created more than 7 days ago").textContent).toContain("1 image · up to 9.3 GB (images share layers)");
    expect(row("Unused images created more than 7 days ago").textContent).toContain("1 built here is kept");
    expect(row("Dangling images").textContent).toContain("1 image · up to 1.9 GB (images share layers)");
    expect(row("All unused images").textContent).toContain("2 images · up to 11.2 GB (images share layers)");
    expect(row("Stopped containers that exited more than 7 days ago").textContent).toContain("1 container · up to about 286 MB (Docker's estimate for every stopped container)");
    expect(row("Build cache not used in the last 7 days").textContent).toContain("up to about 8.4 GB (Docker's estimate for all unused build cache)");
    expect(text()).toContain("Volumes are never cleaned from here");
    expect(text()).not.toMatch(/\bsafe\b|regenerable|not used for/i);
    expect(fetchDockerStorage).not.toHaveBeenCalled();
  });

  it("a row with nothing to clean is unavailable, says why, and opens nothing", async () => {
    render(<Harness data={{ ...DATA, containers: [ctr("2", { finishedAt: ago(1) })] }} />);
    const r = row("Stopped containers");
    const go = r.querySelector<HTMLButtonElement>(".st-quick__go")!;
    expect(go.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(go.getAttribute("aria-describedby")!)?.textContent).toBe("Nothing to clean");
    act(() => go.click());
    expect(sheet()).toBeNull();
  });

  it("when Docker did not list its containers, nothing about images or containers is offered, with that reason", () => {
    render(<Harness data={{ ...DATA, listing: { images: "ok", containers: "failed" } }} />);
    expect(row("All unused images").textContent).toContain("Usage unknown: docker did not list its containers");
    expect(row("All unused images").querySelector(".st-quick__go")!.getAttribute("aria-disabled")).toBe("true");
    // Build cache does not depend on containers.
    expect(row("Build cache").querySelector(".st-quick__go")!.getAttribute("aria-disabled")).toBe("false");
  });

  it("the age is a radio group that follows the arrow keys, and is remembered in this browser", async () => {
    const first = render(<Harness />);
    const radios = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    act(() => radios()[2].click());
    expect(localStorage.getItem(QUICK_DAYS_PREF)).toBe("30");
    expect(text()).toContain("Unused images created more than 30 days ago");
    act(() => radios()[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[0]);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => first.root.unmount());
    document.body.replaceChildren();
    render(<Harness />);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("works with its default when this browser's storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Harness />);
    const radios = [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    act(() => radios[0].click());
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    get.mockRestore();
    set.mockRestore();
  });
});

describe("Quick clean-up sheet", () => {
  it("Recommended ticks old images, old containers and build cache, and nothing else", async () => {
    render(<Harness peers={[{ ...makeSpark("s2"), name: "Spark Two" }]} />);
    vi.mocked(fetchDockerStorage).mockImplementation(() => new Promise(() => {}));
    await act(async () => button("Recommended clean-up").click());
    expect(sheet()).toBeTruthy();
    const boxes = [...sheet()!.querySelectorAll<HTMLInputElement>(".st-quick-cat input")];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true]);
    expect(sheet()!.querySelector<HTMLInputElement>(".st-quick-built input")!.checked).toBe(false);
    expect(peerBox("Spark Two").checked).toBe(false);
    // With other Sparks on offer the label names where it acts.
    expect(goButton().textContent).toBe("Remove 1 image and 1 container on Spark One, clear build cache");
    expect(sheet()!.textContent).toContain("Review first");
    expect(sheet()!.textContent).toContain("Careful");
  });

  it("every category can be unticked and opened to see exactly what goes", async () => {
    render(<Harness />);
    await act(async () => button("Recommended clean-up").click());
    act(() => categoryBox("Stopped containers").click());
    expect(goButton().textContent).toBe("Remove 1 image, clear build cache");
    const more = category("Unused images created").querySelector<HTMLButtonElement>(".st-quick-cat__more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(more.getAttribute("aria-controls")!)!;
    expect([...list.querySelectorAll(".st-imglist__name")].map((n) => n.textContent)).toEqual(["old:1"]);
    act(() => categoryBox("Unused images created").click());
    act(() => categoryBox("Build cache").click());
    expect(goButton().textContent).toBe("Nothing selected");
    expect(goButton().disabled).toBe(true);
  });

  it("images built on this Spark stay out unless ticked in, and the label says they may not be re-creatable", async () => {
    render(<Harness />);
    await act(async () => button("Recommended clean-up").click());
    const built = sheet()!.querySelector<HTMLInputElement>(".st-quick-built input")!;
    expect(built.closest("label")!.textContent).toContain("may not be re-creatable");
    act(() => built.click());
    expect(goButton().textContent).toBe("Remove 2 images and 1 container, clear build cache");
    act(() => category("Unused images created").querySelector<HTMLButtonElement>(".st-quick-cat__more")!.click());
    expect(category("Unused images created").querySelector(".st-imglist__built")).toBeTruthy();
  });

  it("removes exactly the reviewed IDs (containers, images, then build cache), then reports plain counts and Docker's figures", async () => {
    const onChanged = vi.fn();
    vi.mocked(fetchStorageStatus)
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValueOnce({ ...STATUS, filesystems: [{ ...STATUS.filesystems[0], availBytes: 100e9 + 3 * 1024 ** 3 }] });
    render(<Harness onChanged={onChanged} />);
    await act(async () => button("Recommended clean-up").click());
    await act(async () => goButton().click());
    await flush();
    expect(removeDockerContainers).toHaveBeenCalledWith("s1", { ids: [CID("1")] });
    expect(removeDockerImages).toHaveBeenCalledWith("s1", { ids: [ID("a")] });
    expect(pruneDockerBuilderCache).toHaveBeenCalledWith("s1", { olderThanDays: 7 });
    const order = [removeDockerContainers, removeDockerImages, pruneDockerBuilderCache].map((f) => vi.mocked(f).mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(onChanged).toHaveBeenCalledTimes(1);
    const result = document.body.querySelector(".st-quick__result")!.textContent;
    expect(result).toContain("Removed 1 image and 1 container, and cleared build cache.");
    expect(result).toContain("Docker reports 1.1 GB of build cache reclaimed.");
    expect(result).toContain("Available space on / changed by +3.0 GB while this ran.");
    expect(document.body.querySelector(".st-quick__problems")).toBeNull();
  });

  it("an item that changed meanwhile is skipped and listed under a disclosure", async () => {
    vi.mocked(removeDockerImages).mockResolvedValue({ success: true, removed: [], skipped: [{ id: ID("a"), reason: "in-use" }], failed: [] });
    render(<Harness />);
    await act(async () => row("Unused images created").querySelector<HTMLButtonElement>(".st-quick__go")!.click());
    expect(goButton().textContent).toBe("Remove 1 image");
    await act(async () => goButton().click());
    await flush();
    expect(document.body.querySelector(".st-quick__result")!.textContent).toContain("1 item was kept or could not be removed (listed below).");
    const details = document.body.querySelector(".st-quick__problems")!;
    expect(details.textContent).toContain("old:1: kept, a container uses it now");
    expect(removeDockerContainers).not.toHaveBeenCalled();
    expect(pruneDockerBuilderCache).not.toHaveBeenCalled();
  });

  it("when the first request is refused nothing else runs and the sheet stays open with the reason", async () => {
    vi.mocked(removeDockerContainers).mockRejectedValue(new ApiError("Another change is still running on this Spark", 409, "busy"));
    render(<Harness />);
    await act(async () => button("Recommended clean-up").click());
    await act(async () => goButton().click());
    await flush();
    expect(sheet()).toBeTruthy();
    expect(sheet()!.querySelector(".st-problem")!.textContent).toContain("Another change is still running");
    expect(removeDockerImages).not.toHaveBeenCalled();
    expect(pruneDockerBuilderCache).not.toHaveBeenCalled();
  });

  it("as administrator the password box is in the sheet and goes with every request", async () => {
    render(<Harness asAdmin />);
    await act(async () => button("Recommended clean-up").click());
    expect(goButton().disabled).toBe(true);
    setInput(sheet()!.querySelector('input[type="password"]') as HTMLInputElement, "pw");
    await act(async () => goButton().click());
    await flush();
    const elevation = { sudo: true, sudoPassword: "pw", remember: false };
    expect(removeDockerContainers).toHaveBeenCalledWith("s1", { ids: [CID("1")], ...elevation });
    expect(removeDockerImages).toHaveBeenCalledWith("s1", { ids: [ID("a")], ...elevation });
    expect(pruneDockerBuilderCache).toHaveBeenCalledWith("s1", { olderThanDays: 7, ...elevation });
  });
});

describe("Quick clean-up on the other Sparks", () => {
  const two = { ...makeSpark("s2"), name: "Spark Two" };
  const three = { ...makeSpark("s3"), name: "Spark Three" };
  const four = { ...makeSpark("s4"), name: "Spark Four" };
  const peerData = (images: DockerImage[], containers: DockerContainer[] = []): DockerStorage => ({ rootDir: null, usage: {}, images, containers, listing: { images: "ok", containers: "ok" } });

  it("one row per Spark from the first render, each with a one-line detail, before any answer", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(() => new Promise(() => {}));
    render(<Harness peers={[two, three]} />);
    await act(async () => button("Recommended clean-up").click());
    expect(peerRows()).toHaveLength(2);
    expect(document.body.querySelectorAll(".st-peers__detail")).toHaveLength(2);
    expect(peerRows().map((r) => r.querySelector(".st-peers__detail")!.textContent)).toEqual(["Checking…", "Checking…"]);
    expect(fetchDockerStorage).toHaveBeenCalledWith("s2", { light: true });
  });

  it("applies the same rule to each Spark's own list; an unreadable Spark says so; rows never come or go", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (id) => {
      if (id === "s2") return peerData([img("p", { created: ago(30) }), img("q", { created: ago(2) }), img("r", { created: ago(30), registryDigest: false })], [ctr("7", { finishedAt: ago(30) })]);
      if (id === "s3") throw new ApiError("ssh: connect timed out", 502, "unreachable");
      return peerData([img("s", { created: ago(1) })]);
    });
    render(<Harness peers={[two, three, four]} />);
    await act(async () => button("Recommended clean-up").click());
    await flush();
    const details = peerRows().map((r) => r.querySelector(".st-peers__detail")!.textContent);
    expect(details[0]).toBe("Removes 1 image (up to 954 MB) and 1 container · 1 built there kept");
    expect(details[1]).toBe("Could not be checked: ssh: connect timed out");
    expect(details[2]).toBe("Nothing to clean there with this rule.");
    expect(peerRows()).toHaveLength(3);
    expect([two, three, four].map((s) => peerBox(s.name).disabled)).toEqual([false, true, true]);
    // The same rule: unticking containers changes what the other Spark would do.
    act(() => categoryBox("Stopped containers").click());
    expect(peerRows()[0].querySelector(".st-peers__detail")!.textContent).toBe("Removes 1 image (up to 954 MB) · 1 built there kept");
  });

  it("runs on each ticked Spark in turn; one failing does not stop the next, and build cache is cleared here only", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (id) => peerData([img(id === "s2" ? "p" : "s", { created: ago(30) })], [ctr(id === "s2" ? "7" : "8", { finishedAt: ago(30) })]));
    vi.mocked(removeDockerImages).mockImplementation(async (id, body) => {
      if (id === "s2") throw new ApiError("Docker is not running on this Spark", 409, "docker-down");
      return ok(body.ids);
    });
    render(<Harness peers={[two, four]} />);
    await act(async () => button("Recommended clean-up").click());
    await flush();
    act(() => peerBox("Spark Two").click());
    act(() => peerBox("Spark Four").click());
    expect(goButton().textContent).toBe("Remove 3 images and 3 containers on 3 Sparks, clear build cache");
    await act(async () => goButton().click());
    await flush();
    expect(removeDockerImages).toHaveBeenCalledWith("s2", { ids: [ID("p")] });
    expect(removeDockerImages).toHaveBeenCalledWith("s4", { ids: [ID("s")] });
    expect(removeDockerContainers).toHaveBeenCalledWith("s2", { ids: [CID("7")] });
    expect(removeDockerContainers).toHaveBeenCalledWith("s4", { ids: [CID("8")] });
    expect(pruneDockerBuilderCache).toHaveBeenCalledTimes(1);
    expect(pruneDockerBuilderCache).toHaveBeenCalledWith("s1", { olderThanDays: 7 });
    const result = document.body.querySelector(".st-quick__result")!.textContent!;
    expect(result).toContain("Spark Two: removed 1 container; images could not be cleaned (Docker is not running on this Spark).");
    expect(result).toContain("Spark Four: removed 1 image and 1 container.");
    expect(document.body.querySelector(".st-banner")!.className).toContain("is-warn");
  });

  it("where Docker needs administrator rights, it is read and changed through sudo there", async () => {
    vi.mocked(fetchDockerStorage).mockImplementation(async (_id, body) => {
      if (!body?.sudo) throw new ApiError("denied", 403, "docker-denied");
      return peerData([img("p", { created: ago(30) })]);
    });
    render(<Harness peers={[two]} />);
    await act(async () => row("All unused images").querySelector<HTMLButtonElement>(".st-quick__go")!.click());
    await flush();
    expect(peerRows()[0].textContent).toContain("as administrator");
    act(() => peerBox("Spark Two").click());
    await act(async () => goButton().click());
    await flush();
    expect(removeDockerImages).toHaveBeenCalledWith("s2", { ids: [ID("p")], sudo: true });
  });

  it("a build-cache-only sheet does not offer other Sparks", async () => {
    render(<Harness peers={[two]} />);
    await act(async () => row("Build cache").querySelector<HTMLButtonElement>(".st-quick__go")!.click());
    expect(sheet()!.querySelector(".st-peers")).toBeNull();
    expect(goButton().textContent).toBe("Clear build cache");
    expect(fetchDockerStorage).not.toHaveBeenCalled();
  });
});

describe("Quick clean-up in the Docker tab", () => {
  it("sits at the top of the tab and refreshes the list after a run", async () => {
    vi.mocked(fetchDockerStorage).mockResolvedValue(DATA);
    function Tab() {
      const access = useAdminAccess("s1", STATUS);
      return <DockerTab spark={makeSpark("s1")} access={access} onNotice={() => {}} onDiskChanged={onDisk} />;
    }
    const onDisk = vi.fn();
    render(<Tab />);
    await flush();
    const first = document.body.querySelector(".st-quick, .st-tiles, .st-images");
    expect(first?.classList.contains("st-quick")).toBe(true);
    await act(async () => row("Dangling images").querySelector<HTMLButtonElement>(".st-quick__go")!.click());
    await act(async () => goButton().click());
    await flush();
    expect(removeDockerImages).toHaveBeenCalledWith("s1", { ids: [ID("b")] });
    expect(fetchDockerStorage).toHaveBeenCalledTimes(2);
    expect(onDisk).toHaveBeenCalled();
  });
});
