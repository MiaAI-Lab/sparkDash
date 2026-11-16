import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NodeAgentCollector, cpuOutput, storageOutput } from "../NodeAgentCollector.js";
import { NODE_AGENT_SCHEMA, NodeAgentClient, normalizeNodeAgent, usesNodeAgent } from "../nodeAgent.js";
import { SystemCollector, collectionWasSuccessful } from "../SystemCollector.js";
import { createCollector } from "../../sparks/SparkMonitor.js";

const GIB = 1024 ** 3;

const spark = {
  id: "spark-a",
  kind: "spark",
  platform: "linux",
  isLocal: false,
  ssh: { user: "user", host: "192.0.2.10", auth: "key", port: 22 },
  agent: { url: "http://192.0.2.10:9110" },
  disabledDevices: [],
  disabledInterfaces: [],
};

/** A GB10-shaped snapshot: NVML has no framebuffer figures, the pool is MemTotal. */
function snapshot(over = {}) {
  return {
    schema: NODE_AGENT_SCHEMA,
    hostname: "spark-a",
    kernelRelease: "6.11.0",
    arch: "aarch64",
    bootId: "0f6c9a52-3b7e-4c1e-9d2a-5a4d8b1c2e3f",
    collectedAtMs: 1_000_000,
    uptimeS: 3600.4,
    cpu: {
      model: null,
      cores: 20,
      times: [1000, 0, 1000, 8000, 0, 0, 0, 0, 0, 0],
      load: [0.5, 0.4, 0.3],
      tempSensors: [
        { source: "acpitz", millidegrees: 48000 },
        { source: "thermal zone", millidegrees: 51000 },
      ],
    },
    memory: { totalKb: 128 * 1024 * 1024, availableKb: 100 * 1024 * 1024, freeKb: 90 * 1024 * 1024 },
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB10",
        uuid: "GPU-11111111-2222-3333-4444-555555555555",
        tempC: 45,
        utilPct: 37,
        powerW: 12.468,
        powerLimitW: null,
        smClockMhz: 2400,
        smClockMaxMhz: 3000,
        fanPct: null,
        pcie: null,
        memUsedBytes: null,
        memTotalBytes: null,
        throttle: { hwThermal: false, swThermal: false, hwSlowdown: false, swPowerCap: true, hwPowerBrake: false, raw: 4 },
        processes: [{ pid: 4242, name: "/usr/bin/python3 -m vllm, serve", usedBytes: 20 * GIB + 769_000 }],
      },
    ],
    gpuDriver: "580.95.05",
    gpuError: null,
    gpuClockCapMarker: "2100 0f6c9a52-3b7e-4c1e-9d2a-5a4d8b1c2e3f",
    kernelLog: { complete: true, nvErrNoMemory: 2, xid: 1, oomKills: 0, lastXid: "Xid 13" },
    disks: [
      { device: "/dev/nvme0n1p2", mount: "/", fsType: "ext4", totalBytes: 1000 * GIB, usedBytes: 400 * GIB + 1, availableBytes: 550 * GIB },
    ],
    blockStats: { nvme0n1: { sectorsRead: 1000, sectorsWritten: 2000 } },
    network: {
      defaultInterface: "enP7s7",
      interfaces: [
        { name: "lo", rxBytes: 5, txBytes: 5, operstate: "unknown", speedMbps: null, mac: null, ipv4: ["127.0.0.1"] },
        { name: "enP7s7", rxBytes: 1_000_000, txBytes: 2_000_000, operstate: "up", speedMbps: 10000, mac: "aa:bb:cc:dd:ee:ff", ipv4: ["192.0.2.10"] },
        { name: "docker0", rxBytes: 0, txBytes: 0, operstate: "down", speedMbps: null, mac: null, ipv4: [] },
      ],
    },
    agent: { version: "0.1.0", startedAtMs: 1, rssKb: 3000, cpuSeconds: 0.5, samples: 3, minIntervalMs: 1000 },
    ...over,
  };
}

const RDMA = {
  schema: NODE_AGENT_SCHEMA,
  collectedAtMs: 1_000_000,
  devices: [
    {
      name: "rocep1s0f0",
      state: "4: ACTIVE",
      physState: "5: LinkUp",
      rate: "200 Gb/sec (2X NDR)",
      linkLayer: "Ethernet",
      netdev: "enp1s0f0np0",
      hwCounters: { out_of_buffer: 0, packet_seq_err: 0 },
      rxData: 100,
      txData: 200,
    },
  ],
  netdevs: [
    { name: "enp1s0f0np0", operstate: "up", mtu: 9000, speed: 200000, rxBytes: 10, txBytes: 20, rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0 },
  ],
};

/** Collector over a scripted sequence of snapshots; `null` in the list means the agent is down. */
function collectorWith(list) {
  const queue = [...list];
  let current = queue[0];
  const client = {
    calls: 0,
    async snapshot() {
      client.calls += 1;
      if (current === null) throw new Error("node agent http://192.0.2.10:9110: ECONNREFUSED");
      return structuredClone(current);
    },
    async rdma() {
      if (current === null) throw new Error("node agent http://192.0.2.10:9110: ECONNREFUSED");
      return structuredClone(RDMA);
    },
  };
  const collector = new NodeAgentCollector({ ...spark }, { client });
  const next = () => {
    queue.shift();
    current = queue[0];
  };
  return { collector, client, next };
}

test("only remote Linux units with an agent url use the node agent", () => {
  assert.equal(usesNodeAgent(spark), true);
  assert.equal(usesNodeAgent({ ...spark, agent: null }), false);
  assert.equal(usesNodeAgent({ ...spark, isLocal: true }), false);
  assert.equal(usesNodeAgent({ ...spark, platform: "windows" }), false);
  assert.equal(usesNodeAgent({ ...spark, kind: "mac", platform: "darwin" }), false);
  assert.ok(createCollector(spark) instanceof NodeAgentCollector);
  const ssh = createCollector({ ...spark, agent: null });
  assert.ok(ssh instanceof SystemCollector && !(ssh instanceof NodeAgentCollector));
});

test("agent urls keep only a safe origin", () => {
  assert.deepEqual(normalizeNodeAgent({ url: " http://192.0.2.10:9110/ " }), { url: "http://192.0.2.10:9110" });
  assert.deepEqual(normalizeNodeAgent({ url: "https://node.example:9110" }), { url: "https://node.example:9110" });
  for (const url of ["ftp://192.0.2.10", "http://u:p@192.0.2.10", "http://192.0.2.10/x", "http://192.0.2.10/?a=1", "http://169.254.169.254", "nope"]) {
    assert.equal(normalizeNodeAgent({ url }), null, url);
  }
  assert.equal(normalizeNodeAgent({ port: 9110 }), null);
  assert.equal(normalizeNodeAgent(null), null);
});

test("GPU readings follow the SSH rules: GB10 pool from MemTotal, whole-MiB processes, exact power, throttle, clock cap and kernel counters", async () => {
  const { collector } = collectorWith([snapshot()]);
  const gpu = await collector.collectGpu();
  assert.equal(collectionWasSuccessful(gpu), true);
  assert.equal(gpu.temperature, 45);
  assert.equal(gpu.usage, 37);
  assert.equal(gpu.power.draw, 12.47);
  assert.equal(gpu.gpus[0].power.draw, 12.47);
  assert.equal(gpu.power.limit, 120);
  assert.deepEqual(gpu.vram, { used: 20480, total: 131072, percentage: 16, available: 102400 });
  assert.deepEqual(gpu.processes, [{ pid: 4242, name: "/usr/bin/python3 -m vllm,serve", vramMB: 20480 }]);
  assert.equal(gpu.throttle.reason, "power");
  assert.equal(gpu.throttle.clockCapMHz, 2100);
  assert.equal(gpu.gpus[0].uuid, "GPU-11111111-2222-3333-4444-555555555555");
  assert.equal(gpu.nvErrNoMemory, 2);
  assert.deepEqual(gpu.kernelErrors, { xid: 1, oomKills: 0, lastXid: "Xid 13" });
});

test("kernel counters stay unknown when the agent could not read the whole boot", async () => {
  const { collector } = collectorWith([snapshot({ kernelLog: { complete: false, nvErrNoMemory: 0, xid: 0, oomKills: 0, lastXid: null } })]);
  const gpu = await collector.collectGpu();
  assert.equal(gpu.nvErrNoMemory, null);
  assert.equal(gpu.kernelErrors, null);
});

test("a host without NVML reports no GPU instead of a measured idle one", async () => {
  const { collector } = collectorWith([snapshot({ gpus: [], gpuError: "NVML unavailable" })]);
  const gpu = await collector.collectGpu();
  assert.equal(collectionWasSuccessful(gpu), false);
  assert.deepEqual(gpu.gpus ?? [], []);
});

test("CPU usage comes from counter deltas, and a repeated snapshot keeps the last reading instead of 0%", async () => {
  const first = snapshot();
  const second = snapshot({ collectedAtMs: 1_002_000, cpu: { ...first.cpu, times: [1300, 0, 1300, 8400, 0, 0, 0, 0, 0, 0] } });
  const { collector, next } = collectorWith([first, second, second]);
  await collector.collectCpu();
  next();
  const cpu = await collector.collectCpu();
  assert.equal(cpu.usage, 60);
  assert.equal(cpu.temperatureLabel, "ACPI");
  assert.equal(cpu.temperature, 48);
  assert.equal(cpu.tdp, 65);
  next();
  assert.equal((await collector.collectCpu()).usage, 60);
});

test("storage matches df: rounded-up percent, MiB sizes and read/write rates from the parent device", async () => {
  const first = snapshot();
  const second = snapshot({ collectedAtMs: 1_002_000, blockStats: { nvme0n1: { sectorsRead: 3000, sectorsWritten: 6000 } } });
  const { collector, next } = collectorWith([first, second]);
  await collector.collectStorage();
  next();
  const [disk] = await collector.collectStorage();
  assert.equal(disk.device, "nvme0n1p2");
  assert.equal(disk.label, "/");
  assert.equal(disk.percentage, 43);
  assert.equal(disk.total, 1024000);
  assert.equal(disk.readSpeed, 512_000);
  assert.equal(disk.writeSpeed, 1_024_000);
  assert.match(storageOutput(first), /^\/dev\/nvme0n1p2 ext4 /m);
});

test("network: physical interfaces, default route, address, WoL MAC and rates", async () => {
  const first = snapshot();
  const later = structuredClone(first);
  later.collectedAtMs = 1_002_000;
  later.network.interfaces[1].rxBytes += 4_000_000;
  const { collector, next } = collectorWith([first, later]);
  await collector.collectNetwork();
  await new Promise((r) => setTimeout(r, 20));
  next();
  const net = await collector.collectNetwork();
  assert.deepEqual(net.interfaces.map((i) => i.name), ["enP7s7"]);
  assert.equal(net.primaryInterface, "enP7s7");
  assert.equal(net.linkSpeedMbps, 10000);
  assert.equal(net.wolMac, "aa:bb:cc:dd:ee:ff");
  assert.equal(net.interfaces[0].ip, "192.0.2.10");
  assert.equal(net.interfaces[0].operstate, "up");
  assert.ok(net.interfaces[0].rxSpeed > 0);
});

test("RAM and unified memory use MemAvailable and the GPU processes", async () => {
  const { collector } = collectorWith([snapshot()]);
  assert.deepEqual(await collector.collectRam(), { used: 28672, total: 131072, percentage: 22 });
  const um = await collector.collectUnifiedMemory();
  assert.equal(um.gpuUsed, 20480);
  assert.equal(um.cpuUsed, 8192);
  assert.equal(um.available, 102400);
  assert.equal(um.availableSource, "linux-memavailable");
});

test("RoCE ports come from the agent's RDMA readings without a shell", async () => {
  const { collector } = collectorWith([snapshot()]);
  const roce = await collector.collectRoce();
  assert.equal(roce.available, true);
  assert.equal(roce.devices.length, 1);
  assert.equal(roce.devices[0].name, "rocep1s0f0");
});

test("hardware, uptime and liveness read the agent; nothing goes to SSH", async () => {
  const { collector } = collectorWith([snapshot()]);
  const hw = await collector.detectHardware();
  assert.equal(hw.gpuChip, "NVIDIA GB10");
  assert.equal(hw.cudaDriver, "580.95.05");
  assert.equal(hw.cpuCores, 20);
  assert.equal(hw.totalMemoryGB, 128);
  assert.equal(await collector.readUptime(), 3600);
  assert.equal(await collector.pingHost(), true);
  assert.equal(await collector.probeResidentModels(), null);
  await assert.rejects(collector._sshExec(spark, "true"), /do not run metric commands over SSH/);
});

test("when the agent is down every domain reports unknown and liveness fails (no SSH fallback)", async () => {
  const { collector } = collectorWith([null]);
  assert.equal(collectionWasSuccessful(await collector.collectGpu()), false);
  assert.equal(collectionWasSuccessful(await collector.collectCpu()), false);
  assert.deepEqual(await collector.collectStorage(), []);
  assert.equal(await collector.detectHardware(), null);
  await assert.rejects(collector.readUptime(), /ECONNREFUSED/);
});

test("cpuOutput refuses a snapshot without counters", () => {
  assert.throws(() => cpuOutput(snapshot({ cpu: { times: null } })), /no CPU counters/);
});

/** A local stand-in for the agent's HTTP API. */
async function withAgent(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("client sends the bearer token, shares concurrent reads, and explains failures", async () => {
  let hits = 0;
  let auth = null;
  await withAgent(
    (req, res) => {
      hits += 1;
      auth = req.headers.authorization;
      if (req.url !== "/v1/snapshot") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(snapshot()));
    },
    async (url) => {
      const client = new NodeAgentClient({ url }, { token: "t".repeat(32) });
      const [a, b] = await Promise.all([client.snapshot(), client.snapshot()]);
      assert.equal(hits, 1);
      assert.equal(auth, `Bearer ${"t".repeat(32)}`);
      assert.equal(a.collectedAtMs, b.collectedAtMs);
      await assert.rejects(new NodeAgentClient({ url }, { token: "" }).snapshot(), /SPARKDASH_AGENT_TOKEN is not set/);
    }
  );
  await withAgent(
    (_req, res) => res.writeHead(401).end("unauthorized\n"),
    async (url) => {
      await assert.rejects(new NodeAgentClient({ url }, { token: "x".repeat(32) }).snapshot(), /HTTP 401 \(check SPARKDASH_AGENT_TOKEN\)/);
    }
  );
  await withAgent(
    (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ schema: "other/9" })),
    async (url) => {
      await assert.rejects(new NodeAgentClient({ url }, { token: "x".repeat(32) }).snapshot(), /unsupported document/);
    }
  );
});
