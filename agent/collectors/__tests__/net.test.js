import test from "node:test";
import assert from "node:assert/strict";
import { collectNet, resetNetBaseline } from "../net.js";

const NET_DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 1234567      10    0    0    0     0          0         0  1234567      10    0    0    0     0          0         0",
  "  eth0: 104857600    5000    0    0    0     0          0         0  52428800    4000    0    0    0     0          0         0",
  "docker0: 1000        50    0    0    0     0          0         0    1000        50    0    0    0     0          0         0",
].join("\n");

const IP_OUT = [
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN",
  "    inet 127.0.0.1/8 scope host lo",
  "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP",
  "    inet 192.168.50.150/24 brd 192.168.50.255 scope global eth0",
].join("\n");

const readFile = async (p) => {
  if (p === "/proc/net/dev") return NET_DEV;
  if (p === "/sys/class/net/eth0/speed") return "25000\n";
  throw new Error(`ENOENT: ${p}`);
};

/**
 * Stateful /proc/net/dev mock: counters advance between reads so the delta
 * is measurable. Read 1: zero; read 2: eth0 rx=104857600 B, tx=52428800 B.
 */
function makeNetDevReader() {
  let reads = 0;
  const readFile = async (p) => {
    if (p === "/proc/net/dev") {
      reads += 1;
      const rx = reads === 1 ? 0 : 104857600;
      const tx = reads === 1 ? 0 : 52428800;
      return [
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
        "    lo: 1234567      10    0    0    0     0          0         0  1234567      10    0    0    0     0          0         0",
        `  eth0: ${rx}    5000    0    0    0     0          0         0  ${tx}    4000    0    0    0     0          0         0`,
        "docker0: 1000        50    0    0    0     0          0         0    1000        50    0    0    0     0          0         0",
      ].join("\n");
    }
    if (p === "/sys/class/net/eth0/speed") return "25000\n";
    throw new Error(`ENOENT: ${p}`);
  };
  return readFile;
}

test("net: excludes virtual ifaces; first call → 0 speeds; second → delta MB/s (ground truth)", async () => {
  resetNetBaseline();
  const exec = async () => IP_OUT;
  const readFile = makeNetDevReader();
  const first = await collectNet({ exec, readFile, now: () => 0 });
  assert.equal(first.length, 1); // lo + docker0 excluded
  assert.equal(first[0].iface, "eth0");
  assert.equal(first[0].rxSpeed, 0);
  assert.equal(first[0].txSpeed, 0);

  const second = await collectNet({ exec, readFile, now: () => 10_000 });
  assert.deepEqual(second, [
    {
      iface: "eth0",
      ip: "192.168.50.150",
      rxSpeed: 10, // 104857600 B / 10 s = 10 MB/s
      txSpeed: 5, // 52428800 B / 10 s = 5 MB/s
      linkSpeedMbps: 25000,
    },
  ]);
});

test("net: missing ip tool → ip null, speeds still computed", async () => {
  resetNetBaseline();
  const exec = async () => {
    throw new Error("ip: not found");
  };
  const readFile = makeNetDevReader();
  await collectNet({ exec, readFile, now: () => 0 });
  const second = await collectNet({ exec, readFile, now: () => 10_000 });
  assert.equal(second[0].ip, null);
  assert.equal(second[0].rxSpeed, 10);
});

test("net: link speed unknown → null", async () => {
  resetNetBaseline();
  const readFileNoSpeed = async (p) => {
    if (p === "/proc/net/dev") return NET_DEV;
    throw new Error(`ENOENT: ${p}`);
  };
  const out = await collectNet({ exec: async () => IP_OUT, readFile: readFileNoSpeed });
  assert.equal(out[0].linkSpeedMbps, null);
});

test("net: returns [] when /proc/net/dev is unreadable", async () => {
  const readFileDeny = async () => {
    throw new Error("deny");
  };
  assert.deepEqual(await collectNet({ exec: async () => IP_OUT, readFile: readFileDeny }), []);
});
