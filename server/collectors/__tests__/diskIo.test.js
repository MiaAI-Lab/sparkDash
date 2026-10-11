import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

const MARKER = "---sparkdash-block-io---";
const DF = [
  "Filesystem     Type     1B-blocks         Used     Available Use% Mounted on",
  "/dev/nvme0n1p2 ext4  1000000000000 400000000000  600000000000  40% /",
  "/dev/nvme0n1p1 vfat      536870912     10000000     526870912   2% /boot/efi",
  "/dev/nvme1n1p1 ext4  2000000000000 500000000000 1500000000000  25% /data",
].join("\n");

/** `name` + the kernel's stat fields, where the 3rd is sectors read and the 7th sectors written. */
const stat = (name, read, written) => `${name} 100 0 ${read} 0 50 0 ${written} 0 0 0 0`;
const output = (nvme0, nvme1) =>
  [DF, MARKER, stat("nvme0n1", nvme0.read, nvme0.written), stat("nvme1n1", nvme1.read, nvme1.written), stat("loop0", 1, 1)].join("\n");

const remote = () => new SystemCollector({ id: "worker", isLocal: false, ssh: { host: "10.0.0.2", user: "me" } });

test("remote units report disk read/write speed from the block-device counters", () => {
  const c = remote();
  const first = c._parseRemoteStorage(output({ read: 1000, written: 2000 }, { read: 0, written: 0 }), 10_000);
  assert.deepEqual(first.map((d) => [d.label, d.readSpeed, d.writeSpeed]), [["/", 0, 0], ["/data", 0, 0]]);

  // 5 s later: +20480 sectors read (10 MiB) and +40960 written (20 MiB) on nvme0n1, +2048 read on nvme1n1.
  const second = c._parseRemoteStorage(output({ read: 21_480, written: 42_960 }, { read: 2048, written: 0 }), 15_000);
  const root = second.find((d) => d.label === "/");
  assert.equal(root.readSpeed, 2 * 1024 * 1024);
  assert.equal(root.writeSpeed, 4 * 1024 * 1024);
  const data = second.find((d) => d.label === "/data");
  assert.equal(data.readSpeed, Math.round((2048 * 512) / 5));
  assert.equal(data.writeSpeed, 0);
});

test("a remote unit that returns no counters still lists its disks, at 0", () => {
  const disks = remote()._parseRemoteStorage(DF, 1000);
  assert.equal(disks.length, 2);
  assert.ok(disks.every((d) => d.readSpeed === 0 && d.writeSpeed === 0));
});

test("two mounts on one disk, read within a poll, share its rate instead of the second reading 0", () => {
  const c = remote();
  c._diskRate("nvme0n1", 0, 0, 10_000);
  const a = c._diskRate("nvme0n1", 20_480, 0, 15_000);
  const b = c._diskRate("nvme0n1", 20_480, 0, 15_003);
  assert.equal(a.readSpeed, 2 * 1024 * 1024);
  assert.deepEqual(b, a);
  // The next poll still measures from the first sample of the previous one.
  const next = c._diskRate("nvme0n1", 20_480, 0, 20_000);
  assert.equal(next.readSpeed, 0);
});

test("a counter that went backwards (device reset) reads 0, not a negative speed", () => {
  const c = remote();
  c._diskRate("sda", 5000, 5000, 1000);
  assert.deepEqual(c._diskRate("sda", 10, 10, 6000), { readSpeed: 0, writeSpeed: 0 });
});
