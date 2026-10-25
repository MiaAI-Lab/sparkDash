import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MacAgentCollector,
  MAC_AGENT_DEFAULT_PORT,
  macAgentBaseUrl,
  isUnavailable,
  FETCH_TIMEOUT_MS,
  COLD_FETCH_TIMEOUT_MS,
  COLD_RETRY_MAX_ATTEMPTS,
  COLD_RETRY_BASE_MS,
  COLD_RETRY_MAX_BACKOFF_MS,
  RUNTIMES_POLL_INTERVAL_MS,
  RUNTIMES_POLL_MAX_ATTEMPTS,
  runtimesProbeSchedule,
} from "../MacAgentCollector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "mac", "agent-snapshot.json"), "utf8")
);

const spark = {
  id: "macbook-m5",
  kind: "mac",
  isLocal: false,
  lanIp: "10.0.0.9",
  agent: { port: 8790 },
  ssh: { user: "macuser", host: "10.0.0.9", auth: "key" },
};

/** Collector over a stub agent; `mode` decides how /metrics answers. */
function collectorWith(mode, { execCalls = [], sleep = async () => {}, fetchImpl } = {}) {
  const requested = [];
  const fetch = fetchImpl || (async (url) => {
    requested.push(url);
    if (mode === "down") throw new Error("ECONNREFUSED");
    if (mode === "garbage") return { ok: true, json: async () => ({ hello: "world" }) };
    if (mode === "http500") return { ok: false, status: 503, json: async () => ({}) };
    if (mode === "pending") return { ok: false, status: 503, json: async () => ({ status: "pending", reason: "metrics collection still running" }) };
    if (mode === "pending200") return { ok: true, json: async () => ({ status: "pending", reason: "metrics collection still running" }) };
    return { ok: true, json: async () => structuredClone(snapshot) };
  });
  const exec = async (_spark, cmd) => {
    execCalls.push(cmd);
    // SSH fallback answers look like the batched Mac snapshot read.
    return "__SPARKDASH_SECTION__sysctl\nhw.memsize: 274877906944\n";
  };
  const collector = new MacAgentCollector({ ...spark }, { fetchImpl: fetch, exec, sleep });
  return { collector, requested, execCalls };
}

function timeoutError() {
  return Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
}

test("agent url: configured url wins, then host/port, then the default port", () => {
  assert.equal(
    macAgentBaseUrl({ kind: "mac", agent: { url: "http://mac.tailnet.ts.net:9000/" } }),
    "http://mac.tailnet.ts.net:9000"
  );
  assert.equal(
    macAgentBaseUrl({ kind: "mac", lanIp: "10.0.0.9", agent: { port: 9100 } }),
    "http://10.0.0.9:9100"
  );
  assert.equal(
    macAgentBaseUrl({ kind: "mac", isLocal: true, agent: {} }),
    `http://127.0.0.1:${MAC_AGENT_DEFAULT_PORT}`
  );
});

test("vitals come from one agent read and keep the existing shapes", async () => {
  const { collector, requested } = collectorWith("ok");
  const [cpu, ram, um, storage, gpu] = await Promise.all([
    collector.collectCpu(),
    collector.collectRam(),
    collector.collectUnifiedMemory(),
    collector.collectStorage(),
    collector.collectGpu(),
  ]);
  assert.equal(cpu.usage, 37.5);
  assert.equal(cpu.temperature, null, "Apple Silicon reports no CPU temperature");
  assert.equal(ram.total, 131072);
  assert.equal(ram.used, 110103);
  assert.deepEqual(ram.swap, { total: 10240, used: 8607, free: 1633 });
  assert.equal(um.gpuUsed, 14938);
  assert.equal(um.cpuUsed, 95165);
  assert.deepEqual(um.bandwidth, { current: 0, peak: 0 });
  assert.equal(storage[0].label, "/System/Volumes/Data");
  assert.equal(storage[0].total, 3811147);
  assert.equal(gpu.vram.total, 131072);
  assert.equal(gpu.vram.used, 110103);
  assert.equal(gpu.powermetricsAvailable, false, "powermetrics was refused for lack of root");
  assert.equal(isUnavailable(gpu.unavailable, "gpu.power"), true);
  assert.equal(isUnavailable(gpu.unavailable, "ane.power"), true);
  await collector.collectNetwork();
  assert.equal(
    requested.filter((url) => url.endsWith("/metrics")).length <= 2,
    true,
    "the TTL cache keeps a poll cycle to one or two agent reads"
  );
});

test("powermetrics refusal shows as a declared gap, not a zero", async () => {
  const { collector } = collectorWith("ok");
  const gpu = await collector.collectGpu();
  assert.equal(gpu.usage, 0);
  assert.equal(gpu.power.draw, 0);
  assert.equal(gpu.powermetricsAvailable, false);
  const gap = gpu.unavailable.find((row) => row.metric === "gpu.power");
  assert.match(gap.reason, /root/);
});

test("unified memory is a measured reading even when powermetrics is refused", async () => {
  // The base collector's default marks every GPU field unavailable (no GPU
  // found); the Overview card renders those as "—", which hid a Mac's memory.
  const { collector } = collectorWith("ok");
  const gpu = await collector.collectGpu();
  assert.equal(gpu.metricAvailability.vramUsed, true);
  assert.equal(gpu.metricAvailability.vramTotal, true);
  assert.equal(gpu.metricAvailability.usage, false, "busy % needs powermetrics");
  assert.equal(gpu.metricAvailability.powerDraw, false);
  assert.equal(gpu.metricAvailability.powerLimit, false, "a Mac has no GPU power limit");
});

test("network: interface, ip, reachability probes, and counter-delta speeds", async () => {
  const { collector } = collectorWith("ok");
  const first = await collector.collectNetwork();
  assert.equal(first.primaryInterface, "en0");
  assert.equal(first.interfaces[0].ip, "10.0.0.9");
  assert.equal(first.interfaces[0].rxSpeed, 0, "no previous sample to difference against");
  assert.deepEqual(
    first.reachability.map((row) => row.ok),
    [true, true]
  );
  collector._agentCache = null;
  collector._lastNet.time -= 2000;
  snapshot.network.interfaces[0].rxBytes += 4_000_000;
  const second = await collector.collectNetwork();
  assert.ok(
    second.interfaces[0].rxSpeed >= 1_900_000 && second.interfaces[0].rxSpeed <= 2_100_000,
    `expected ~2 MB/s, got ${second.interfaces[0].rxSpeed}`
  );
});

test("runtimes: names, ports, models, and the unknown-listener row", async () => {
  const { collector } = collectorWith("ok");
  const result = await collector.collectRuntimes();
  assert.equal(result.agentOnline, true);
  assert.deepEqual(
    result.runtimes.map((row) => [row.name, row.port, row.state]),
    [
      ["mtplx-mux", 8200, "serving"],
      ["tensorfold", 8300, "serving"],
      ["other-runtime", 9099, "listening"],
    ]
  );
  assert.equal(
    result.runtimes.find((row) => row.name === "tensorfold").model,
    "qwen3.8-27b"
  );
  assert.equal(
    result.runtimes.find((row) => row.name === "other-runtime").label,
    "infer.py",
    "an uncatalogued server keeps its command basename"
  );
  assert.ok(result.unavailable.length >= 3);
});

test("uptime and hardware come from the agent too", async () => {
  const { collector } = collectorWith("ok");
  assert.equal(await collector.readBootTime(), 1790917878);
  const hw = await collector.detectHardware();
  assert.equal(hw.device, "Mac (Mac17,6)");
  assert.equal(hw.cpuModel, "Apple M5 Max");
  assert.equal(hw.cpuCores, 18);
  assert.equal(hw.totalMemoryGB, 128);
  assert.equal(await collector.pingHost(), true);
});

test("agent down: SSH answers the vitals and the gap says the agent is gone", async () => {
  for (const mode of ["down", "garbage", "http500", "pending", "pending200"]) {
    const execCalls = [];
    const { collector } = collectorWith(mode, { execCalls });
    const runtimes = await collector.collectRuntimes();
    assert.equal(runtimes.agentOnline, false, mode);
    assert.deepEqual(runtimes.runtimes, [], mode);
    const gap = runtimes.unavailable.find((row) => row.metric === "agent");
    assert.match(gap.reason, /mac agent unreachable/, mode);

    // Vitals fall back to the SSH reads instead of going blank.
    await collector.collectRam();
    assert.ok(
      execCalls.some((cmd) => cmd.includes("vm_stat") || cmd.includes("sysctl")),
      `${mode}: expected an SSH fallback read`
    );
  }
});

test("pending responses cannot become telemetry or cached hardware", async () => {
  for (const mode of ["pending", "pending200"]) {
    const { collector, execCalls } = collectorWith(mode);
    assert.equal(await collector._agentSnapshot(), null);
    assert.equal(collector._agentCache, null);
    const ram = await collector.collectRam();
    assert.equal(ram.total, 262144);
    await Promise.all([
      collector.collectCpu(), collector.collectGpu(), collector.collectUnifiedMemory(),
      collector.collectStorage(), collector.collectNetwork(), collector.readBootTime(),
      collector.detectHardware(), collector.pingHost(),
    ]);
    assert.equal(collector._agentCache, null);
    assert.ok(execCalls.length > 0);
    const runtimes = await collector.collectRuntimes();
    assert.equal(runtimes.agentOnline, false);
    assert.ok(isUnavailable(runtimes.unavailable, "agent"));
  }
});


test("a privileged agent temperature reaches the dashboard metrics", async () => {
  const data = structuredClone(snapshot);
  data.cpu.temperature = 46.23;
  data.cpu.temperatureUnit = "celsius";
  data.gpu.temperature = 42.11;
  data.gpu.temperatureUnit = "celsius";
  data.unavailable = (data.unavailable || []).filter((row) => !String(row.metric).endsWith(".temperature"));
  const collector = new MacAgentCollector(spark, {
    fetchImpl: async () => ({ ok: true, json: async () => data }),
    exec: async () => { throw new Error("SSH must not run"); },
  });
  const cpu = await collector.collectCpu();
  const gpu = await collector.collectGpu();
  assert.equal(cpu.temperature, 46.23);
  assert.equal(gpu.temperature, 42.11);
  assert.equal(isUnavailable(gpu.unavailable, "cpu.temperature"), false);
  assert.equal(isUnavailable(gpu.unavailable, "gpu.temperature"), false);
});

test("reachable agent owns every system read even when optional metadata is missing", async () => {
  const execCalls = [];
  const data = { schema: "sparkdash.mac-agent/1", thermal: { pressureState: "slow", lastRecordedEvents: ["Thermal Warning Level = 100"], source: "pmset -g therm" } };
  const collector = new MacAgentCollector(spark, {
    fetchImpl: async () => ({ ok: true, json: async () => data }),
    exec: async (_spark, cmd) => { execCalls.push(cmd); throw new Error("SSH must not run"); },
  });
  const results = await Promise.all([
    collector.collectCpu(), collector.collectGpu(), collector.collectRam(),
    collector.collectUnifiedMemory(), collector.collectNetwork(), collector.collectStorage(),
    collector.readBootTime(), collector.detectHardware(), collector.pingHost(), collector.collectRuntimes(),
  ]);
  assert.equal(results[0].temperature, null);
  assert.equal(results[1].temperature, null);
  assert.equal(results[1].thermalPressure, "slow");
  assert.deepEqual(results[1].thermal, data.thermal);
  assert.equal(results[6], null);
  assert.equal(results[7], null);
  assert.equal(results[9].agentOnline, true);
  assert.ok(isUnavailable(results[9].unavailable, "cpu.temperature"));
  assert.deepEqual(execCalls, []);
});

test("runtimes probe schedule is bounded and covers a 7-10s cold first response", () => {
  const steps = runtimesProbeSchedule();
  assert.equal(steps.length, COLD_RETRY_MAX_ATTEMPTS + RUNTIMES_POLL_MAX_ATTEMPTS);
  assert.ok(COLD_FETCH_TIMEOUT_MS >= 10_000, "cold budget must cover the observed 7-10s first response");
  assert.ok(COLD_FETCH_TIMEOUT_MS <= 15_000, "cold budget stays near the agent 12s collect deadline");
  assert.equal(steps[0].timeoutMs, COLD_FETCH_TIMEOUT_MS);
  assert.equal(steps[0].delayBeforeMs, 0);
  assert.equal(FETCH_TIMEOUT_MS, 4_000, "warm metric polls keep the short budget");

  const retryDelays = steps.filter((step) => step.phase === "retry").map((step) => step.delayBeforeMs);
  assert.deepEqual(retryDelays, [COLD_RETRY_BASE_MS, COLD_RETRY_MAX_BACKOFF_MS, COLD_RETRY_MAX_BACKOFF_MS]);
  assert.ok(retryDelays.every((ms) => ms <= COLD_RETRY_MAX_BACKOFF_MS));
  assert.ok(retryDelays[1] >= retryDelays[0], "backoff does not shrink");

  const polls = steps.filter((step) => step.phase === "poll");
  assert.equal(polls.length, RUNTIMES_POLL_MAX_ATTEMPTS);
  assert.ok(RUNTIMES_POLL_MAX_ATTEMPTS <= 8);
  assert.ok(RUNTIMES_POLL_INTERVAL_MS >= 1_000 && RUNTIMES_POLL_INTERVAL_MS <= 30_000);
  assert.ok(polls.every((step) => step.delayBeforeMs === RUNTIMES_POLL_INTERVAL_MS));
  assert.ok(polls.every((step) => step.timeoutMs === FETCH_TIMEOUT_MS));
});

test("cold start: a 7-10s first /metrics is accepted, then the next read is one fast probe", async () => {
  const coldMs = 8_000;
  const granted = [];
  const sleeps = [];
  let calls = 0;
  const collector = new MacAgentCollector(spark, {
    createTimeoutSignal: (ms) => {
      granted.push(ms);
      const controller = new AbortController();
      if (ms < coldMs) controller.abort(timeoutError());
      return controller.signal;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (init?.signal?.aborted) throw init.signal.reason;
      return { ok: true, json: async () => structuredClone(snapshot) };
    },
    exec: async () => {
      throw new Error("SSH must not run");
    },
  });

  const first = await collector.collectRuntimes();
  assert.equal(first.agentOnline, true);
  assert.equal(calls, 1, "the 8s response fits the cold budget, so it is not aborted and retried");
  assert.deepEqual(sleeps, []);
  assert.equal(granted[0], COLD_FETCH_TIMEOUT_MS);
  assert.equal(
    first.runtimes.find((row) => row.name === "tensorfold").model,
    "qwen3.8-27b"
  );

  const second = await collector.collectRuntimes();
  assert.equal(second.agentOnline, true);
  assert.equal(calls, 2, "a warm follow-up is one probe, not another cold-start loop");
  assert.deepEqual(sleeps, []);
});

test("cold timeout retries with capped backoff and returns the later success, not the first failure", async () => {
  const sleeps = [];
  const granted = [];
  let calls = 0;
  const collector = new MacAgentCollector(spark, {
    createTimeoutSignal: (ms) => {
      granted.push(ms);
      return AbortSignal.timeout(60_000);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw timeoutError();
      return { ok: true, json: async () => structuredClone(snapshot) };
    },
    exec: async () => {
      throw new Error("SSH must not run");
    },
  });

  const result = await collector.collectRuntimes();
  assert.equal(result.agentOnline, true, "agentOnline is the latest probe, not the timed-out first one");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [COLD_RETRY_BASE_MS]);
  assert.ok(sleeps.every((ms) => ms <= COLD_RETRY_MAX_BACKOFF_MS));
  assert.deepEqual(granted, [COLD_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS]);
  assert.equal(result.runtimes.length, 3);
  assert.equal(isUnavailable(result.unavailable, "agent"), false);
});

test("runtimes poll recovers after the in-call retries all miss", async () => {
  const sleeps = [];
  let calls = 0;
  const collector = new MacAgentCollector(spark, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls <= COLD_RETRY_MAX_ATTEMPTS) throw timeoutError();
      return { ok: true, json: async () => structuredClone(snapshot) };
    },
    exec: async () => {
      throw new Error("SSH must not run");
    },
  });

  const result = await collector.collectRuntimes();
  assert.equal(calls, COLD_RETRY_MAX_ATTEMPTS + 1);
  assert.equal(result.agentOnline, true);
  assert.deepEqual(
    result.runtimes.map((row) => row.name),
    ["mtplx-mux", "tensorfold", "other-runtime"]
  );
  assert.equal(sleeps.at(-1), RUNTIMES_POLL_INTERVAL_MS);
  assert.equal(sleeps.filter((ms) => ms === RUNTIMES_POLL_INTERVAL_MS).length, 1);
  assert.ok(sleeps.every((ms) => ms <= Math.max(COLD_RETRY_MAX_BACKOFF_MS, RUNTIMES_POLL_INTERVAL_MS)));
});

test("a dead agent stops at the runtimes poll bound and still reports unreachable", async () => {
  const sleeps = [];
  let calls = 0;
  const { collector } = collectorWith("down", {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    },
  });

  const result = await collector.collectRuntimes();
  assert.equal(result.agentOnline, false);
  assert.deepEqual(result.runtimes, []);
  assert.match(result.unavailable[0].reason, /mac agent unreachable/);
  assert.equal(calls, COLD_RETRY_MAX_ATTEMPTS + RUNTIMES_POLL_MAX_ATTEMPTS);
  assert.equal(sleeps.length, calls - 1);
  assert.equal(sleeps.filter((ms) => ms === RUNTIMES_POLL_INTERVAL_MS).length, RUNTIMES_POLL_MAX_ATTEMPTS);
});

test("stopping the collector abandons the rest of the runtimes schedule", async () => {
  let calls = 0;
  let enteredSleep;
  const sleeping = new Promise((resolve) => {
    enteredSleep = resolve;
  });
  let releaseSleep;
  const released = new Promise((resolve) => {
    releaseSleep = resolve;
  });
  const collector = new MacAgentCollector(spark, {
    sleep: async () => {
      enteredSleep();
      await released;
    },
    fetchImpl: async () => {
      calls += 1;
      throw timeoutError();
    },
    exec: async () => {
      throw new Error("SSH must not run");
    },
  });

  const pending = collector.collectRuntimes();
  await sleeping;
  assert.equal(calls, 1);
  collector.invalidatePendingCollections();
  releaseSleep();
  const result = await pending;
  assert.equal(result.agentOnline, false);
  assert.equal(calls, 1, "a stopped collector does not keep probing");
});

test("a healthy runtimes read does not retry or poll", async () => {
  let calls = 0;
  const collector = new MacAgentCollector(spark, {
    sleep: async () => {
      throw new Error("healthy path must not sleep");
    },
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => structuredClone(snapshot) };
    },
    exec: async () => {
      throw new Error("SSH must not run");
    },
  });
  const result = await collector.collectRuntimes();
  assert.equal(calls, 1);
  assert.equal(result.agentOnline, true);
  assert.equal(result.agentVersion, snapshot.agentVersion);
  assert.equal(result.collectedAt, snapshot.collectedAt);
});

test("valid agent CPU and memory readings participate in history/export collection", async () => {
  const { collectionWasSuccessful } = await import("../SystemCollector.js");
  const { collector } = collectorWith("ok");
  assert.equal(collectionWasSuccessful(await collector.collectCpu()), true);
  assert.equal(collectionWasSuccessful(await collector.collectGpu()), true);
});

test("a missing agent CPU reading is unavailable rather than a measured idle zero", async () => {
  const { collectionWasSuccessful } = await import("../SystemCollector.js");
  const data = structuredClone(snapshot);
  data.cpu.usagePercent = null;
  const { collector } = collectorWith("ok", { fetchImpl: async () => ({ ok: true, json: async () => data }) });
  const cpu = await collector.collectCpu();
  assert.equal(cpu.usageAvailable, false);
  assert.equal(collectionWasSuccessful(cpu), false);
});

test("stale agent payloads cannot refresh vitals or runtime inventory", async () => {
  const data = { ...structuredClone(snapshot), sampleStale: true, sampleAgeSeconds: 60 };
  const { collector } = collectorWith("ok", { fetchImpl: async () => ({ ok: true, json: async () => data }) });
  assert.equal(await collector._agentSnapshot(), null);
  const probe = await collector._probeAgentOnce(100);
  assert.deepEqual(probe, { ok: false, retryable: true, reason: "stale" });
});

test("agent targets reject unsafe URLs and forbidden DNS answers", async () => {
  for (const url of ["http://169.254.169.254", "http://2852039166", "http://user:pass@10.0.0.9", "file:///etc/passwd", "http://10.0.0.9/redirect"]) {
    assert.throws(() => macAgentBaseUrl({ agent: { url } }));
  }
  const { assertMacAgentTarget } = await import("../MacAgentCollector.js");
  await assert.rejects(() => assertMacAgentTarget("http://fixture.example", { lookup: async () => [{ address: "169.254.169.254" }] }), /forbidden/);
});
