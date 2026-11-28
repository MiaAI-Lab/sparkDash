// @ts-expect-error -- Node builtin available when running under Vitest
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StorageMetrics } from "../../api/types";
import { StoragePanel } from "./StoragePanel";
import { render } from "../../testing/render";

const disk = (over: Partial<StorageMetrics> = {}): StorageMetrics => ({
  device: "disk3s5",
  label: "/System/Volumes/Data",
  used: 134_227,
  total: 482_746,
  available: 314_635,
  percentage: 28,
  readSpeed: 0,
  writeSpeed: 0,
  ...over,
});

function panel(disk: StorageMetrics) {
  return render(
    <StoragePanel
      storage={[disk]}
      sparkId="mac-mini"
      disabledDevices={[]}
      onDisabledChange={() => {}}
    />
  );
}

describe("StoragePanel category breakdown", () => {
  it("renders a segmented bar and legend for a disk with agent categories", () => {
    const { container } = panel(disk({
      categories: [
        { id: "applications", megabytes: 12_605 },
        { id: "documents", megabytes: 3_572 },
        { id: "trash", megabytes: 803 },
        { id: "systemData", megabytes: 114_750 },
      ],
    }));
    const bar = container.querySelector(".sp-storage-bar");
    expect(bar).not.toBeNull();
    const segments = [...container.querySelectorAll(".sp-storage-bar__seg")];
    expect(segments.map((s) => s.className)).toEqual([
      "sp-storage-bar__seg sp-storage-bar__seg--applications",
      "sp-storage-bar__seg sp-storage-bar__seg--documents",
      "sp-storage-bar__seg sp-storage-bar__seg--trash",
      "sp-storage-bar__seg sp-storage-bar__seg--system-data",
    ]);
    expect(container.querySelector(".sp-storage-bar__free")).not.toBeNull();
    const legend = container.textContent ?? "";
    expect(legend).toContain("Applications");
    expect(legend).toContain("Documents");
    expect(legend).toContain("Trash");
    expect(legend).toContain("System Data");
    // legend sizes come from formatGb on the category megabytes
    expect(legend).toContain("12 GB");
    expect(legend).toContain("803 MB");
  });

  it("keeps the plain usage bar when the disk has no categories", () => {
    const { container } = panel(disk());
    expect(container.querySelector(".sp-storage-bar")).toBeNull();
    expect(container.querySelector(".sp-storage-legend")).toBeNull();
    expect(container.querySelector(".sp-bar__fill")).not.toBeNull();
  });

  it("hides zero-byte categories and collapses zero-byte restricted ones into a compact summary", () => {
    const { container } = panel(disk({
      categories: [
        { id: "media", megabytes: 0 },
        { id: "mail", megabytes: 0, restricted: true },
        { id: "trash", megabytes: 0, restricted: true },
        { id: "documents", megabytes: 3_572, restricted: true },
        { id: "systemData", megabytes: 114_750 },
      ],
    }));
    const legend = container.textContent ?? "";
    expect(legend).not.toContain("Media");
    expect(legend).not.toContain("Mail*");
    expect(legend).not.toContain("Trash*");
    expect(container.querySelector(".sp-storage-bar__seg--mail")).toBeNull();
    expect(container.querySelector(".sp-storage-bar__seg--trash")).toBeNull();
    expect(legend).toContain("Documents*");
    expect(legend).toContain("3 GB");
    const restrictedDocs = container.querySelector(".sp-storage-bar__seg--documents.is-restricted");
    expect(restrictedDocs).not.toBeNull();
    const docsTitle = restrictedDocs?.getAttribute("title") ?? "";
    expect(docsTitle).toContain("Documents");
    expect(docsTitle).toContain("Full Disk Access");

    const summary = container.querySelector(".sp-storage-legend__restricted");
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain("+2 restricted*");
    const summaryTitle = summary?.getAttribute("title") ?? "";
    expect(summaryTitle).toContain("Mail");
    expect(summaryTitle).toContain("Trash");
    expect(summaryTitle).toContain("Full Disk Access");
  });

  it("renders unknown future categories as the raw id on a neutral gray segment", () => {
    const { container } = panel(disk({
      categories: [
        { id: "vmCompute", megabytes: 9_000 },
        { id: "systemData", megabytes: 114_750 },
      ],
    }));
    expect(container.querySelector(".sp-storage-bar__seg--vm-compute")).not.toBeNull();
    expect(container.textContent).toContain("vmCompute");
  });

  it("falls back to the plain usage bar when all categories are zero and unrestricted", () => {
    const { container } = panel(disk({
      categories: [
        { id: "media", megabytes: 0 },
        { id: "systemData", megabytes: 0 },
      ],
    }));
    expect(container.querySelector(".sp-storage-bar")).toBeNull();
    expect(container.querySelector(".sp-storage-legend")).toBeNull();
    expect(container.querySelector(".sp-bar__fill")).not.toBeNull();
  });

  it("keeps the free segment visible on a 95% full disk with many tiny categories", () => {
    const total = 100_000;
    const { container } = panel(disk({
      total,
      used: 95_000,
      available: 5_000,
      percentage: 95,
      categories: [
        { id: "applications", megabytes: 50 },
        { id: "developer", megabytes: 50 },
        { id: "photos", megabytes: 50 },
        { id: "media", megabytes: 50 },
        { id: "mail", megabytes: 50 },
        { id: "messages", megabytes: 50 },
        { id: "icloudDrive", megabytes: 50 },
        { id: "iosFiles", megabytes: 50 },
        { id: "trash", megabytes: 50 },
        { id: "documents", megabytes: 10_000 },
        { id: "systemData", megabytes: 84_550 },
      ],
    }));
    const free = container.querySelector(".sp-storage-bar__free") as HTMLElement | null;
    expect(free).not.toBeNull();
    const freePct = parseFloat(free?.style.getPropertyValue("--seg-pct") || "0");
    expect(freePct).toBeCloseTo(5, 1);
  });

  it("defines a neutral default background and distinct colors for photos and messages in spark.css", () => {
    const css = readFileSync("src/styles/spark.css", "utf8");
    expect(css).toMatch(/\.sp-storage-bar__seg,\s*\.sp-storage-legend__dot\s*\{\s*background:\s*color-mix\(/);
    const photosBg = css.match(/\.sp-storage-bar__seg--photos\s*\{\s*background:\s*([^;]+);/)?.[1]?.trim();
    const messagesBg = css.match(/\.sp-storage-bar__seg--messages\s*\{\s*background:\s*([^;]+);/)?.[1]?.trim();
    expect(photosBg).toBeTruthy();
    expect(messagesBg).toBeTruthy();
    expect(photosBg).not.toBe(messagesBg);
  });
});
