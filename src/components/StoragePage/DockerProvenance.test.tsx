import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDockerStorage } from "../../api/client";
import type { DockerStorage, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { DockerTab } from "./DockerTab";
import { useAdminAccess } from "./useAdminAccess";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchDockerStorage: vi.fn(),
  removeDockerImages: vi.fn(),
  removeDockerContainers: vi.fn(),
}));

const STATUS: StorageStatus = { user: "me", sudo: "no", passwordAllowed: true, filesystems: [], docker: { state: "ok", rootDir: "/var/lib/docker" } };
const ID = (c: string) => `sha256:${c.repeat(64)}`;
const CID = (c: string) => c.repeat(64);

const DATA: DockerStorage = {
  rootDir: "/var/lib/docker",
  usage: { images: { count: 4, active: 1, sizeBytes: 90e9, reclaimableBytes: 40e9 } },
  images: [
    { id: ID("a"), tags: ["mine:dev"], sizeBytes: 30e9, created: null, usedBy: [], status: "unused", registryDigest: false },
    { id: ID("b"), tags: ["nvcr.io/nvidia/x:1"], sizeBytes: 20e9, created: null, usedBy: [], status: "unused", registryDigest: true },
    { id: ID("c"), tags: ["old:1"], sizeBytes: 10e9, created: null, usedBy: [], status: "unused" },
    { id: ID("d"), tags: ["job:v1"], sizeBytes: 5e9, created: null, usedBy: [{ name: "job", state: "exited" }], status: "stopped", registryDigest: false },
  ],
  containers: [{ id: CID("1"), name: "job", state: "exited", imageId: ID("d"), created: "2026-09-01T00:00:00Z", removable: true }],
};

function Harness() {
  const access = useAdminAccess("s1", STATUS);
  return <DockerTab spark={makeSpark("s1")} access={access} onNotice={() => {}} onDiskChanged={() => {}} />;
}

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
const row = (name: string) => [...document.body.querySelectorAll(".st-img")].find((r) => r.querySelector(".st-img__name")?.textContent?.startsWith(name)) as HTMLElement;

beforeEach(() => {
  vi.mocked(fetchDockerStorage).mockResolvedValue(DATA);
});

describe("Docker wording (B8): nothing is called safe, and built-here images say so", () => {
  it("marks an image with no registry digest as built here, and never one whose provenance is unknown", async () => {
    render(<Harness />);
    await flush();
    expect(row("mine:dev").textContent).toContain("Built here, not pulled");
    expect(row("job:v1").textContent).toContain("Built here, not pulled");
    expect(row("nvcr.io/nvidia/x:1").textContent).not.toContain("Built here");
    expect(row("old:1").textContent).not.toContain("Built here");
  });

  it("the images summary asks for review instead of promising safety", async () => {
    render(<Harness />);
    await flush();
    const head = document.body.querySelector('[aria-label="Docker images"] .st-images__head p')?.textContent ?? "";
    expect(head).toContain("3 unused");
    expect(head).toContain("Review before removing");
    expect(head).toContain("one was built here, not pulled, so it may be the only copy");
    expect(text()).not.toMatch(/\bsafe\b|regenerable/i);
  });

  it("the remove-images dialog is 'Review first', names what was built here, and does not say it can all come back", async () => {
    render(<Harness />);
    await flush();
    await act(async () => button("Select all 3 unused").click());
    await act(async () => button("Remove 3 images").click());
    const dialog = document.body.querySelector(".st-dialog")!;
    expect(dialog.textContent).toContain("Review first");
    expect(dialog.textContent).toContain("A pulled image comes back only by pulling it again, while its registry still has it");
    expect(dialog.textContent).toContain("1 of them was built here, not pulled: removing it may delete the only copy.");
    expect(dialog.querySelectorAll(".st-imglist__built")).toHaveLength(1);
    expect(dialog.textContent).not.toContain("Anything you need again can be pulled or built again");
    expect(dialog.textContent).not.toMatch(/\bsafe\b|regenerable/i);
  });

  it("removing a stopped container is 'Careful': its writable layer may hold data you can't re-create", async () => {
    render(<Harness />);
    await flush();
    const containers = document.body.querySelector('[aria-label="Docker containers"]')!;
    expect(containers.textContent).toContain("writable layer, which may hold data you can’t re-create");
    await act(async () => button("Remove container…").click());
    const dialog = document.body.querySelector(".st-dialog")!;
    expect(dialog.textContent).toContain("Careful");
    expect(dialog.textContent).toContain("writable layer");
    expect(dialog.textContent).toContain("may hold data you can’t re-create");
    // Its image was built here: the "also remove the image" choice says what that means.
    expect(dialog.textContent).toContain("It was built here, not pulled: removing it may delete the only copy.");
  });

  it("check boxes keep their names and sit inside a label that is the tap target", async () => {
    render(<Harness />);
    await flush();
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>(".st-img__check")];
    expect(boxes.length).toBe(5);
    for (const b of boxes) {
      expect(b.parentElement?.className).toBe("st-img__hit");
      expect(b.getAttribute("aria-label")).toMatch(/^Select /);
    }
  });
});
