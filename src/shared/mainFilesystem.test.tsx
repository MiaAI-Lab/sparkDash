import { describe, expect, it } from "vitest";
import type { StorageFilesystem } from "../api/types";
import { DiskSummary } from "../components/StoragePage/DiskSummary";
import { SparkPicker, mainDisk } from "../components/StoragePage/SparkPicker";
import { makeSpark } from "../testing/fixtures";
import { flush, render } from "../testing/render";
import fixtures from "./mainFilesystem.fixtures.json";
import { isSystemMount, mainFilesystem, metricsView, statusView } from "./mainFilesystem";

const MiB = 1024 * 1024;

interface Row {
  device: string;
  mount: string;
  totalBytes: number;
}

/** One layout as both callers see it. Sizes are whole MiB, as the snapshot reports them, so both print alike. */
function shapes(rows: Row[]) {
  const mib = (r: Row) => Math.round(r.totalBytes / MiB);
  const status: StorageFilesystem[] = rows.map((r) => ({
    source: `/dev/${r.device}`,
    fstype: "ext4",
    mount: r.mount,
    totalBytes: mib(r) * MiB,
    usedBytes: Math.round(mib(r) * 0.4) * MiB,
    availBytes: (mib(r) - Math.round(mib(r) * 0.4)) * MiB,
  }));
  const metrics = rows.map((r) => ({
    device: r.device,
    label: r.mount,
    used: Math.round(mib(r) * 0.4),
    total: mib(r),
    available: mib(r) - Math.round(mib(r) * 0.4),
    percentage: 40,
    readSpeed: 0,
    writeSpeed: 0,
  }));
  return { status, metrics };
}

describe("mainFilesystem: one policy for the main disk", () => {
  for (const layout of fixtures.layouts) {
    it(`${layout.name}`, () => {
      const { status, metrics } = shapes(layout.rows);
      const a = mainFilesystem(status, statusView);
      const b = mainFilesystem(metrics, metricsView);
      if (layout.expected == null) {
        expect(a).toBeNull();
        expect(b).toBeNull();
        return;
      }
      expect([a?.source, a?.mount]).toEqual([`/dev/${layout.expected.device}`, layout.expected.mount]);
      expect([b?.device, b?.label]).toEqual([layout.expected.device, layout.expected.mount]);
    });
  }

  it("boot, firmware and snap mounts never count", () => {
    expect(["/boot", "/boot/efi", "/efi", "/snap/x/1"].every(isSystemMount)).toBe(true);
    expect(["/", "/home", "/data/boot"].some(isSystemMount)).toBe(false);
  });
});

describe("the Spark card and the disk summary describe the same disk", () => {
  for (const layout of fixtures.layouts) {
    it(`${layout.name}`, async () => {
      const { status, metrics } = shapes(layout.rows);
      const spark = makeSpark("s1");
      spark.metrics.storage = metrics;
      render(
        <>
          <SparkPicker sparks={[spark]} activeId="s1" onSelect={() => {}} />
          <DiskSummary filesystems={status} />
        </>
      );
      await flush();
      const card = document.body.querySelector(".st-spark__sub")?.textContent ?? "";
      const summary = document.body.querySelector(".st-disk__foot span")?.textContent ?? null;
      if (layout.expected == null) {
        expect(card).toBe("Disk size not reported yet");
        expect(document.body.querySelector(".st-disks")).toBeNull();
        return;
      }
      expect(summary).not.toBeNull();
      expect(card).toBe(summary);
      const name = document.body.querySelector(".st-disk__name b")?.textContent;
      expect(name).toBe(layout.expected.mount === "/" ? "Main disk" : layout.expected.mount);
      expect(document.body.textContent).not.toContain("/boot");
      expect(mainDisk(spark)).not.toBeNull();
    });
  }
});
