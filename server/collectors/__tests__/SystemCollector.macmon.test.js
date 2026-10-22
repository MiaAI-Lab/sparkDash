import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { SystemCollector, MACMON_CMD, parseMacmonSample, parseMacNetwork } from "../SystemCollector.js";
import { DARWIN_UPTIME_CMD } from "../../sparks/SparkMonitor.js";

// `macmon pipe -s 1` output captured from a Mac Studio (M3 Ultra, 512 GB, macOS 27), core lists trimmed.
const SAMPLE = '{"all_power":0.0,"ane_power":0.0,"cpu_active_ratio":0.03531907498836517,"cpu_power":0.0,"cpu_scaled_ratio":0.03248313441872597,"cpu_usage_pct":0.123,"ecpu_active_ratio":0.01392458938062191,"ecpu_cores":[{"active_ratio":0.06073359400033951,"core_id":0,"die_id":0,"freq_mhz":1020,"scaled_ratio":0.02412315644323826},{"active_ratio":0.018134476616978645,"core_id":1,"die_id":0,"freq_mhz":1020,"scaled_ratio":0.007202946115285158}],"ecpu_freq_mhz":1020,"ecpu_scaled_ratio":0.005530796013772488,"ecpu_usage":[1020,0.005530796013772488],"fans":[{"max_rpm":3625,"name":"fan0","rpm":1005},{"max_rpm":3625,"name":"fan1","rpm":1006}],"gpu_active_ratio":0.0,"gpu_freq_mhz":0,"gpu_power":0.0,"gpu_ram_power":0.0,"gpu_scaled_ratio":0.0,"gpu_usage":[1398,0.42],"memory":{"ram_total":549755813888,"ram_usage":198868484096,"swap_total":0,"swap_usage":0},"pcpu_active_ratio":0.04245057329535484,"pcpu_cores":[{"active_ratio":0.0,"core_id":0,"die_id":0,"freq_mhz":0,"scaled_ratio":0.0},{"active_ratio":0.0,"core_id":1,"die_id":0,"freq_mhz":0,"scaled_ratio":0.0}],"pcpu_freq_mhz":1092,"pcpu_scaled_ratio":0.041467249393463135,"pcpu_usage":[1092,0.041467249393463135],"ram_power":0.0,"sys_power":33.5,"temp":{"cpu_temp_avg":39.63,"gpu_temp_avg":36.82},"timestamp":"2026-10-13T20:56:41.464508+00:00"}';

const mac = () => new SystemCollector({ id: "studio", isLocal: false, platform: "darwin", ssh: { host: "studio.local", user: "mon" } });
const withSample = (c, out = SAMPLE) => {
  let calls = 0;
  c._macmonSample = (() => {
    const orig = SystemCollector.prototype._macmonSample;
    return function () { return orig.call(this, async () => { calls += 1; return out; }); };
  })();
  return () => calls;
};

test("parseMacmonSample takes the last JSON line and rejects junk", () => {
  assert.equal(parseMacmonSample(`noise\n${SAMPLE}`).sys_power, 33.5);
  assert.equal(parseMacmonSample("NO_MACMON"), null);
  assert.equal(parseMacmonSample("{not json"), null);
  assert.equal(parseMacmonSample(""), null);
});

test("macOS GPU/CPU/RAM come from one macmon sample", async () => {
  const c = mac();
  const calls = withSample(c);
  const [gpu, cpu, ram, um] = await Promise.all([c.collectGpu(), c.collectCpu(), c.collectRam(), c.collectUnifiedMemory()]);
  assert.equal(calls(), 1, "one SSH round trip shared by all four collectors");
  assert.equal(gpu.vendor, "apple");
  assert.equal(gpu.gpus.length, 1);
  assert.equal(gpu.usage, 42);
  assert.equal(gpu.temperature, 36.8);
  assert.equal(gpu.power.systemDraw, 34);
  assert.equal(gpu.metricAvailability.powerLimit, false);
  assert.equal(cpu.usage, 12);
  assert.equal(cpu.temperature, 39.6);
  assert.equal(cpu.temperatureSource, "macmon");
  assert.equal(ram.total, 524288);
  assert.equal(ram.used, Math.round(198868484096 / 1048576));
  assert.equal(um.total, 524288);
  assert.equal(um.gpuUsed, 0);
});

test("macOS without macmon degrades to defaults; RAM falls back to sysctl", async () => {
  const c = mac();
  withSample(c, "NO_MACMON");
  c._getRemoteRamMac = async () => ({ used: 1, total: 2, percentage: 50 });
  const gpu = await c.collectGpu();
  assert.equal(gpu.gpus.length, 0);
  assert.deepEqual(await c.collectRam(), { used: 1, total: 2, percentage: 50 });
  assert.equal((await c.collectCpu()).usage, 0);
});

const MAC_NETWORK = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0       1500  <Link#4>    02:1a:7f:3c:9d:2e    100     0      10000      200     0      20000     0
en0       1500  192.168.1    192.168.1.10         100     0      10000      200     0      20000     0
lo0       16384 <Link#1>                          900     0     900000      900     0     900000     0
utun3     1500  <Link#22>                          10      0       1000       10     0       1000     0
en1       1500  <Link#5>                                0     0          0        0     0          0     0
---IFCONFIG---
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 02:1a:7f:3c:9d:2e
\tinet 192.168.1.10 netmask 0xffffff00 broadcast 192.168.1.255
\tmedia: autoselect (1000baseT <full-duplex>)
\tstatus: active
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
---ROUTE---
   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
`;

test("macOS network keeps physical en0, drops loopback/tunnels/dormant, and deltas counters", () => {
  const stats = new Map();
  const first = parseMacNetwork(MAC_NETWORK, stats, 1000);
  assert.equal(first.primaryInterface, "en0");
  assert.equal(first.linkSpeedMbps, 1000);
  assert.equal(first.wolMac, "02:1a:7f:3c:9d:2e");
  assert.deepEqual(first.interfaces.map((i) => i.name), ["en0"]);
  assert.equal(first.interfaces[0].ip, "192.168.1.10");
  assert.equal(first.interfaces[0].operstate, "up");
  assert.equal(first.interfaces[0].rxSpeed, 0);

  const second = parseMacNetwork(MAC_NETWORK.replace("10000", "16000").replace("20000", "26000"), stats, 2000);
  assert.equal(second.interfaces[0].rxSpeed, 6000);
  assert.equal(second.interfaces[0].txSpeed, 6000);
});

test("macOS network counter reset reports 0, not a negative rate", () => {
  const stats = new Map();
  parseMacNetwork(MAC_NETWORK, stats, 1000);
  const reset = parseMacNetwork(MAC_NETWORK.replace("10000", "10").replace("20000", "20"), stats, 2000);
  assert.equal(reset.interfaces[0].rxSpeed, 0);
  assert.equal(reset.interfaces[0].txSpeed, 0);
});

test("MACMON_CMD and DARWIN_UPTIME_CMD are valid POSIX sh", () => {
  for (const cmd of [MACMON_CMD, DARWIN_UPTIME_CMD]) execFileSync("sh", ["-n", "-c", cmd]);
  assert.match(MACMON_CMD, /opt\/homebrew\/bin\/macmon/);
  assert.match(MACMON_CMD, /HOME\/\.cargo\/bin\/macmon/);
});

test("DARWIN_UPTIME_CMD parses kern.boottime", () => {
  const fake = DARWIN_UPTIME_CMD.replace("sysctl -n kern.boottime", "echo '{ sec = 1000, usec = 5 } Mon Oct 12 20:07:41 2026'").replace("$(date +%s)", "4600");
  assert.equal(execFileSync("sh", ["-c", fake]).toString().trim(), "3600");
});

test("a Mac without macmon costs one SSH call a minute, not one per poll", async () => {
  const c = mac();
  const calls = withSample(c, "NO_MACMON");
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    for (let i = 0; i < 4; i++) await c.collectGpu();
    await c.collectCpu();
  } finally {
    console.error = orig;
  }
  assert.equal(calls(), 1);
  assert.equal(logged.filter((l) => /macmon/.test(l)).length, 1);
});
