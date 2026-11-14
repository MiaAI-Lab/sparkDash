import { describe, expect, it } from "vitest";
import { formatBytes, formatBytesPerSec, formatDiskSize, formatGb, formatMb } from "./formatBytes";

describe("formatBytesPerSec", () => {
  it("rolls 1024.0 of a unit into the next unit", () => {
    expect(formatBytesPerSec(1023.95 * 1024)).toBe("1.0 MB/s");
    expect(formatBytesPerSec(1023.95 * 1024 * 1024)).toBe("1.0 GB/s");
  });

  it("keeps rates that do not round to 1024", () => {
    expect(formatBytesPerSec(500)).toBe("500 B/s");
    expect(formatBytesPerSec(1536)).toBe("1.5 KB/s");
    expect(formatBytesPerSec(1023.94 * 1024)).toBe("1023.9 KB/s");
    expect(formatBytesPerSec(1024 * 1024)).toBe("1.0 MB/s");
  });
});

describe("formatMb", () => {
  it("rolls 1024 MB into 1.0 GB", () => {
    expect(formatMb(1023.5)).toBe("1.0 GB");
  });

  it("keeps a smaller reading and an exact gigabyte", () => {
    expect(formatMb(512)).toBe("512 MB");
    expect(formatMb(1536)).toBe("1.5 GB");
  });
});

describe("formatGb", () => {
  it("rolls 1024 MB into 1 GB", () => {
    expect(formatGb(1023.5)).toBe("1 GB");
  });

  it("keeps a smaller reading and an exact two gigabytes", () => {
    expect(formatGb(512)).toBe("512 MB");
    expect(formatGb(2048)).toBe("2 GB");
  });
});

describe("formatDiskSize", () => {
  it("keeps a 1.8 TB root disk short enough for the Overview mini-stat", () => {
    // Live RTX PRO 6000 root disk: 836010 MB used of 1875626 MB.
    expect(formatDiskSize(836010)).toBe("816 GB");
    expect(formatDiskSize(1875626)).toBe("1.8 TB");
    // GB10 4 TB NVMe.
    expect(formatDiskSize(3845092)).toBe("3.7 TB");
  });

  it("rolls 1024 GB into 1.0 TB and 1024 MB into 1 GB", () => {
    expect(formatDiskSize(1023.6 * 1024)).toBe("1.0 TB");
    expect(formatDiskSize(1023.6)).toBe("1 GB");
  });

  it("keeps small readings in MB", () => {
    expect(formatDiskSize(608)).toBe("608 MB");
    expect(formatDiskSize(0)).toBe("0 MB");
  });
});

describe("formatBytes", () => {
  it("prints small sizes exactly and larger ones in the fewest characters", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(18 * 1024)).toBe("18 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(4.2 * 1024 ** 3)).toBe("4.2 GB");
    expect(formatBytes(884_985_819_136)).toBe("824 GB");
    expect(formatBytes(1.3 * 1024 ** 4)).toBe("1.3 TB");
  });

  it("rolls a value that would print as 1024 into the next unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3 - 1)).toBe("1.0 GB");
    expect(formatBytes(1023.96 * 1024 ** 2)).toBe("1.0 GB");
  });

  it("shows a dash for a size that is not known", () => {
    expect(formatBytes(null)).toBe("\u2014");
    expect(formatBytes(undefined)).toBe("\u2014");
    expect(formatBytes(-1)).toBe("\u2014");
    expect(formatBytes(Number.NaN)).toBe("\u2014");
  });
});
