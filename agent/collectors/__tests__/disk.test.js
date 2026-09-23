import test from "node:test";
import assert from "node:assert/strict";
import { collectDisk } from "../disk.js";

const DF_OUT = [
  "Filesystem     Type     1024-blocks        Used      Available Capacity Mounted on",
  "/dev/nvme0n1p2 ext4      209715200   104857600     62914560      44% /",
  "tmpfs          tmpfs      67108864             0     67108864       0% /dev/shm",
  "overlay        overlay  257683368   104857600    135400000      44% /var/lib/docker/overlay2/x/merged",
  "/dev/loop2     squashfs  123456789    12345678          0     100% /snap/core22",
  "/dev/nvme0n1p1 ext4       52428800    52428800     5242880      90% /boot",
].join("\n");

test("disk: filters pseudo fs, converts to MB (ground truth)", async () => {
  const out = await collectDisk({ exec: async () => DF_OUT });
  assert.equal(out.length, 2);
  const root = out.find((d) => d.mount === "/");
  assert.deepEqual(root, {
    device: "/dev/nvme0n1p2",
    mount: "/",
    usedMB: 100,
    totalMB: 200,
    availableMB: 60,
    percentage: 63, // 100/(100+60) = 62.5 → 63
  });
  const boot = out.find((d) => d.mount === "/boot");
  assert.deepEqual(boot, {
    device: "/dev/nvme0n1p1",
    mount: "/boot",
    usedMB: 50,
    totalMB: 50,
    availableMB: 5,
    percentage: 91, // 50/55
  });
});

test("disk: excludes /boot/efi and /snap mounts", async () => {
  const out = await collectDisk({
    exec: async () =>
      [
        "Filesystem     Type     1024-blocks        Used      Available Capacity Mounted on",
        "/dev/nvme0n1p3 vfat         20971520      3145728     17825792      15% /boot/efi",
        "/dev/nvme0n1p4 ext4      104857600    10485760     89128960      10% /mnt/data",
      ].join("\n"),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].mount, "/mnt/data");
});

test("disk: returns [] when df fails", async () => {
  const exec = async () => {
    throw new Error("df: not found");
  };
  assert.deepEqual(await collectDisk({ exec }), []);
});

test("disk: returns [] when df has no data rows", async () => {
  assert.deepEqual(
    await collectDisk({ exec: async () => "Filesystem     Type     1024-blocks" }),
    []
  );
});
