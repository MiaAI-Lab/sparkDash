/**
 * SparkMonitor wiring for Apple Silicon Mac units (kind "mac").
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SparkMonitor, createCollector } from "../SparkMonitor.js";
import { SystemCollector } from "../../collectors/SystemCollector.js";
import { MacSystemCollector } from "../../collectors/MacSystemCollector.js";

// Constructing a mac/host monitor starts background hardware detection over
// SSH; keep these unit tests off the network.
MacSystemCollector.prototype.detectHardware = async () => null;
SystemCollector.prototype.detectHardware = async () => null;

function unit(overrides = {}) {
  return {
    id: "mac-studio",
    name: "mac-studio",
    lanIp: "100.64.0.10",
    isLocal: false,
    ssh: { host: "100.64.0.10", user: "macuser", auth: "key" },
    llmPorts: [8000],
    role: "standalone",
    llmMonitoring: true,
    disabledDevices: [],
    disabledInterfaces: [],
    kind: "mac",
    ...overrides,
  };
}

test("collector is chosen by unit kind", () => {
  assert.ok(createCollector(unit()) instanceof MacSystemCollector);
  assert.ok(!(createCollector(unit({ kind: "host" })) instanceof MacSystemCollector));
  assert.ok(createCollector(unit({ kind: "host" })) instanceof SystemCollector);
  assert.ok(!(createCollector(unit({ kind: "spark" })) instanceof MacSystemCollector));
  assert.ok(!(createCollector(unit({ kind: undefined })) instanceof MacSystemCollector));
});

test("a mac unit with an agent endpoint uses the agent collector", async () => {
  const { MacAgentCollector } = await import("../../collectors/MacAgentCollector.js");
  const withAgent = unit({ agent: { port: 8790 } });
  assert.ok(createCollector(withAgent) instanceof MacAgentCollector);
  // The agent collector is still a Mac collector, so SSH stays as the fallback.
  assert.ok(createCollector(withAgent) instanceof MacSystemCollector);
  assert.ok(!(createCollector(unit({ agent: null })) instanceof MacAgentCollector));
  // Only mac units get an agent transport; a DGX Spark keeps the NVIDIA path.
  assert.ok(!(createCollector(unit({ kind: "spark", agent: { port: 8790 } })) instanceof MacAgentCollector));
});

test("a mac unit gets a Mac hardware summary, not the DGX Spark specs", () => {
  const monitor = new SparkMonitor(unit());
  assert.ok(monitor.collector instanceof MacSystemCollector);
  assert.equal(monitor._hardwareSummary.device, "Apple Silicon Mac");
  assert.notEqual(monitor._hardwareSummary.cpuModel, "GB10");
  monitor.stop?.();
});

test("spark and host summaries are unchanged", () => {
  const spark = new SparkMonitor(unit({ kind: "spark", isLocal: true, ssh: undefined }));
  assert.equal(spark._hardwareSummary.device, "NVIDIA DGX Spark");
  spark.stop?.();
  const host = new SparkMonitor(unit({ kind: "host" }));
  assert.equal(host._hardwareSummary.device, "Linux GPU host");
  host.stop?.();
});

test("mac uptime comes from kern.boottime", async () => {
  const monitor = new SparkMonitor(unit());
  const boot = Math.floor(Date.now() / 1000) - 3600;
  monitor.collector.readBootTime = async () => boot;
  const up = await monitor._readUptime();
  assert.ok(up >= 3599 && up <= 3601, `uptime ${up}`);
  monitor.collector.readBootTime = async () => null;
  assert.equal(await monitor._readUptime(), null);
  monitor.stop?.();
});

test("switching a unit to kind mac swaps in the Mac collector", () => {
  const monitor = new SparkMonitor(unit({ kind: "host" }));
  assert.ok(!(monitor.collector instanceof MacSystemCollector));
  monitor.updateConfig(unit({ kind: "mac" }));
  assert.ok(monitor.collector instanceof MacSystemCollector);
  monitor.updateConfig(unit({ kind: "host" }));
  assert.ok(!(monitor.collector instanceof MacSystemCollector));
  monitor.stop?.();
});

test("moving the agent endpoint rebuilds the collector", async () => {
  const { MacAgentCollector } = await import("../../collectors/MacAgentCollector.js");
  const monitor = new SparkMonitor(unit());
  assert.ok(!(monitor.collector instanceof MacAgentCollector));
  monitor.updateConfig(unit({ agent: { port: 8790 } }));
  assert.ok(monitor.collector instanceof MacAgentCollector);
  assert.equal(monitor.collector.baseUrl, "http://100.64.0.10:8790");
  monitor.updateConfig(unit({ agent: { port: 9100 } }));
  assert.equal(monitor.collector.baseUrl, "http://100.64.0.10:9100");
  monitor.updateConfig(unit({ agent: null }));
  assert.ok(!(monitor.collector instanceof MacAgentCollector));
  monitor.stop?.();
});

test("the runtimes domain carries detected runtimes and declared gaps into the snapshot", async () => {
  const monitor = new SparkMonitor(unit({ agent: { port: 8790 } }));
  // Non-agent units never poll the domain; an agent unit does.
  monitor._running = true; // the poll loop's gate, without opening SSH
  monitor.online = true; // bypass the SSH-liveness pause; this test never probes liveness
  monitor.collector.collectRuntimes = async () => ({
    runtimes: [
      { name: "tensorfold", label: "TensorFold", role: "server", pid: 2302, port: 8300, model: "qwen3.8-27b", state: "serving", detectedBy: "inventory" },
    ],
    unavailable: [{ metric: "gpu.power", reason: "powermetrics requires root" }],
    agentOnline: true,
  });
  await monitor._pollDomain("runtimes");
  const snapshot = monitor.snapshot();
  assert.deepEqual(
    snapshot.metrics.runtimes.map((row) => [row.name, row.port, row.state]),
    [["tensorfold", 8300, "serving"]]
  );
  assert.equal(snapshot.metrics.unavailable[0].metric, "gpu.power");
  assert.equal(snapshot.metrics.agentOnline, true);

  // A DGX Spark has no inventory to report: the fields stay null rather than
  // an empty array that would read as "nothing serving".
  const dgx = new SparkMonitor(unit({ kind: "spark", isLocal: true, ssh: undefined }));
  dgx._running = true;
  await dgx._pollDomain("runtimes");
  assert.equal(dgx.snapshot().metrics.runtimes, null);
  assert.equal(dgx.snapshot().metrics.unavailable, null);
  monitor.stop?.();
  dgx.stop?.();
});
