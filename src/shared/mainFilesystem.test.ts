import { describe, expect, it } from "vitest";
import fixtures from "./mainFilesystem.fixtures.json";
import { isSystemMount, mainFilesystem, metricsView, statusView } from "./mainFilesystem";

interface Row {
  device: string;
  mount: string;
  totalBytes: number;
}

/** Every caller must agree, so each layout runs through both real views. */
function pickWith<T>(rows: readonly T[], view: (item: T) => { mount: string; device?: string | null; totalBytes: number }) {
  return mainFilesystem(rows, view);
}

describe("mainFilesystem", () => {
  it.each(fixtures.layouts.map((l) => [l.name, l] as const))("%s", (_name, layout) => {
    const rows = layout.rows as Row[];
    const viaMetrics = pickWith(
      rows.map((r) => ({ device: r.device, label: r.mount, total: r.totalBytes })),
      (d) => metricsView(d)
    );
    const viaStatus = pickWith(
      rows.map((r) => ({ source: r.device, mount: r.mount, totalBytes: r.totalBytes })),
      (f) => statusView(f)
    );
    if (layout.expected == null) {
      expect(viaMetrics).toBeNull();
      expect(viaStatus).toBeNull();
    } else {
      // The pick is the caller's own row, so each shape carries the answer under its own names.
      expect(viaMetrics?.device).toBe(layout.expected.device);
      expect(viaMetrics?.label).toBe(layout.expected.mount);
      expect(viaStatus?.source).toBe(layout.expected.device);
      expect(viaStatus?.mount).toBe(layout.expected.mount);
    }
  });

  it("returns null for missing or non-array input", () => {
    expect(mainFilesystem(null, metricsView)).toBeNull();
    expect(mainFilesystem(undefined, metricsView)).toBeNull();
  });

  it("classifies system mounts", () => {
    for (const mount of ["/boot", "/boot/efi", "/efi", "/efi/firmware", "/snap", "/snap/core22/1380", "/var/snap/lxd/common/lxd"]) {
      expect(isSystemMount(mount)).toBe(true);
    }
    for (const mount of ["/", "/home", "/data/sub", "/var/lib/docker"]) {
      expect(isSystemMount(mount)).toBe(false);
    }
    expect(isSystemMount(undefined)).toBe(true);
  });
});
