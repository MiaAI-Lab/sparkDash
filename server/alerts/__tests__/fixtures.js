/** Minimal SparkMonitor-shaped snapshots for the alert tests. */
export function unit(overrides = {}) {
  const { metrics = {}, ...rest } = overrides;
  return {
    id: "spark-1",
    name: "spark-1",
    kind: "spark",
    online: true,
    offlineReason: null,
    role: "head",
    workerNode: false,
    llmMonitoring: true,
    llmPort: 8888,
    llmPorts: [8888],
    ...rest,
    metrics: {
      gpu: {
        temperature: 50,
        usage: 10,
        power: { draw: 20, limit: 100 },
        vram: { used: 90_000, total: 124_610, percentage: 72, available: 30_000 },
        throttle: { active: false, reason: "ok", thermal: false, hwSlowdown: false, powerCap: false, detail: "", smClockPct: 100 },
        ...(metrics.gpu || {}),
      },
      unifiedMemory: {
        total: 124_610,
        gpuUsed: 90_000,
        cpuUsed: 4_000,
        used: 94_000,
        available: 30_000,
        percentage: 75,
        ...(metrics.unifiedMemory || {}),
      },
      storage: metrics.storage || [
        { device: "/dev/nvme0n1p2", label: "/", used: 500, total: 1000, available: 500, percentage: 50 },
      ],
      llm: metrics.llm || [{ available: true, modelId: "m", kvCacheUsage: 0.1, error: null }],
      ...(metrics.extra || {}),
    },
  };
}

/** A clock the test moves by hand. */
export function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  now.set = (ms) => {
    t = ms;
  };
  return now;
}

/** A fetch stub that records calls and answers `status`. */
export function stubFetch(status = 200, opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body, headers: init?.headers });
    if (opts.throws) throw opts.throws;
    return new Response(opts.body ?? "ok", { status });
  };
  fn.calls = calls;
  return fn;
}
