/**
 * GET /metrics renders the fleet in Prometheus text format 0.0.4. These tests
 * parse the output back with a strict reader of the exposition grammar, so a
 * malformed line, a family described twice, a split family or a duplicate
 * series fails here instead of failing a user's whole scrape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  METRIC_FAMILIES,
  PROMETHEUS_CONTENT_TYPE,
  escapeLabelValue,
  formatValue,
  metricsEntries,
  renderPrometheusMetrics,
} from "../prometheus.js";

const MIB = 1024 * 1024;

// ─── A strict exposition-format reader ─────────────────────────────────────
const NAME = "[a-zA-Z_:][a-zA-Z0-9_:]*";
const LABEL_NAME = "[a-zA-Z_][a-zA-Z0-9_]*";
const LABEL_VALUE = '(?:[^"\\\\\\n]|\\\\[\\\\"n])*';
const VALUE = "(?:[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?|NaN|[-+]Inf)";
const HELP_RE = new RegExp(`^# HELP (${NAME}) (.*)$`);
const TYPE_RE = new RegExp(`^# TYPE (${NAME}) (counter|gauge|histogram|summary|untyped)$`);
const SAMPLE_RE = new RegExp(
  `^(${NAME})(?:\\{((?:${LABEL_NAME}="${LABEL_VALUE}")(?:,${LABEL_NAME}="${LABEL_VALUE}")*,?)?\\})? (${VALUE})(?: -?\\d+)?$`
);
const LABEL_RE = new RegExp(`(${LABEL_NAME})="(${LABEL_VALUE})"`, "g");

function unescapeLabel(value) {
  return value.replace(/\\(["\\n])/g, (_m, c) => (c === "n" ? "\n" : c));
}

function parseValue(text) {
  if (text === "NaN") return NaN;
  if (text === "+Inf") return Infinity;
  if (text === "-Inf") return -Infinity;
  return Number(text);
}

/**
 * Parse exposition text; throws on any grammar or structure violation.
 * @returns {Map<string, { help: string, type: string, samples: Array<{ labels: Record<string,string>, value: number }> }>}
 */
function parseExposition(text) {
  assert.ok(text.endsWith("\n"), "exposition must end with a line feed");
  const families = new Map();
  const closed = new Set();
  let current = null;
  const lines = text.slice(0, -1).split("\n");
  for (const [i, line] of lines.entries()) {
    const where = `line ${i + 1}: ${JSON.stringify(line)}`;
    let m;
    if ((m = HELP_RE.exec(line))) {
      const [, name, help] = m;
      assert.ok(!families.has(name) || families.get(name).help == null, `HELP twice for ${name} (${where})`);
      assert.ok(!closed.has(name), `${name} resumed after another family (${where})`);
      if (current && current !== name) closed.add(current);
      current = name;
      const fam = families.get(name) || { help: null, type: null, samples: [] };
      fam.help = help;
      families.set(name, fam);
      continue;
    }
    if ((m = TYPE_RE.exec(line))) {
      const [, name, type] = m;
      const fam = families.get(name) || { help: null, type: null, samples: [] };
      assert.equal(fam.type, null, `TYPE twice for ${name} (${where})`);
      assert.equal(fam.samples.length, 0, `TYPE after samples for ${name} (${where})`);
      if (current && current !== name) closed.add(current);
      current = name;
      fam.type = type;
      families.set(name, fam);
      continue;
    }
    assert.ok(!line.startsWith("#"), `unexpected comment (${where})`);
    m = SAMPLE_RE.exec(line);
    assert.ok(m, `not a valid sample line (${where})`);
    const [, name, rawLabels, rawValue] = m;
    const fam = families.get(name);
    assert.ok(fam && fam.type, `sample for undeclared family ${name} (${where})`);
    assert.equal(current, name, `sample for ${name} outside its family block (${where})`);
    const labels = {};
    for (const [, key, value] of (rawLabels || "").matchAll(LABEL_RE)) {
      assert.ok(!(key in labels), `label ${key} twice (${where})`);
      labels[key] = unescapeLabel(value);
    }
    const series = JSON.stringify(Object.entries(labels).sort());
    assert.ok(
      !fam.samples.some((s) => JSON.stringify(Object.entries(s.labels).sort()) === series),
      `duplicate series (${where})`
    );
    fam.samples.push({ labels, value: parseValue(rawValue) });
  }
  for (const [name, fam] of families) {
    assert.ok(fam.help != null, `${name} has no HELP`);
    assert.ok(fam.type != null, `${name} has no TYPE`);
    if (fam.type === "counter") assert.match(name, /_total$/, `counter ${name} must end in _total`);
    else assert.doesNotMatch(name, /_total$/, `${fam.type} ${name} must not end in _total`);
  }
  return families;
}

function samplesOf(families, name, filter = {}) {
  const fam = families.get(name);
  if (!fam) return [];
  return fam.samples.filter((s) => Object.entries(filter).every(([k, v]) => s.labels[k] === v));
}

function valueOf(families, name, filter) {
  const found = samplesOf(families, name, filter);
  assert.equal(found.length, 1, `expected one ${name} sample for ${JSON.stringify(filter)}, got ${found.length}`);
  return found[0].value;
}

// ─── Fixtures shaped like live SparkMonitor snapshots ──────────────────────
function throttle(overrides = {}) {
  return {
    thermal: false,
    hwSlowdown: false,
    powerCap: false,
    active: false,
    reason: "ok",
    smClockMHz: 1794,
    smClockMaxMHz: 3003,
    smClockPct: 59.7,
    detail: "Clocks not limited",
    ...overrides,
  };
}

/** spark-1: GB10 head serving one TensorFold endpoint. */
function gb10Head() {
  const vram = { used: 100540, total: 124610, percentage: 81, available: 7832 };
  return {
    id: "spark-1",
    name: "spark-1",
    kind: "spark",
    online: true,
    uptime: 105945,
    role: "head",
    llmPorts: [8888],
    metrics: {
      gpu: {
        temperature: 43,
        usage: 0,
        power: { draw: 6.58, limit: 120, systemDraw: 27 },
        vram,
        throttle: throttle(),
        gpus: [
          {
            index: 0,
            name: "NVIDIA GB10",
            uuid: "GPU-0a3cf9ea-0502-437e-f12e-3c4649403375",
            temperature: 43,
            usage: 0,
            power: { draw: 6.58, limit: 120 },
            vram,
            throttle: throttle(),
          },
        ],
      },
      cpu: { usage: 1, temperature: 46.2, temperatureLabel: "ACPI", temperatureSource: "acpitz", draw: 5.8, tdp: 65 },
      ram: { used: 116775, total: 124610, percentage: 94 },
      storage: [
        { device: "nvme0n1p2", label: "/", used: 690098, total: 3845092, available: 2959642, percentage: 19, disabled: false },
      ],
      network: {
        primaryInterface: "enP7s7",
        interfaces: [
          { name: "enP7s7", rxSpeed: 30021, txSpeed: 21474, ip: "192.168.1.119", operstate: "up", disabled: false },
          { name: "docker0", rxSpeed: 5, txSpeed: 6, ip: null, operstate: "up", disabled: true },
        ],
      },
      unifiedMemory: { total: 124610, gpuUsed: 100540, cpuUsed: 16234, used: 116774, available: 7836, percentage: 94 },
      llm: [
        {
          available: true,
          backend: "tensorfold",
          modelId: "GLM-5.3-Flash-EXL3",
          generationTps: 41.5,
          prefillTps: 0,
          totalOutputTokens: 47349,
          totalPromptTokens: 1333789,
          totalCachedTokens: 878720,
          kvCacheUsage: 0.0524,
          requestsRunning: 1,
          requestsWaiting: null,
          error: null,
        },
      ],
    },
  };
}

/** A discrete host with two cards, one power-capped. */
function multiGpuHost() {
  const card = (index, name, overrides = {}) => ({
    index,
    name,
    uuid: `GPU-${index}`,
    temperature: 50 + index,
    usage: 30 + index * 40,
    power: { draw: 100 + index, limit: 300 },
    vram: { used: 1000 * (index + 1), total: 16000, percentage: 0, available: 16000 - 1000 * (index + 1) },
    throttle: throttle(),
    ...overrides,
  });
  return {
    id: "gpu-box",
    name: "GPU box",
    kind: "host",
    online: true,
    uptime: 600,
    role: "standalone",
    llmPorts: [30000, 30001],
    metrics: {
      gpu: {
        temperature: 51,
        usage: 70,
        power: { draw: 201, limit: 600 },
        vram: { used: 3000, total: 32000, percentage: 9, available: 29000 },
        throttle: throttle({ powerCap: true, active: true, reason: "power" }),
        gpus: [
          card(0, "NVIDIA GeForce RTX 5080"),
          card(1, "NVIDIA GeForce RTX 5060 Ti", {
            throttle: throttle({ powerCap: true, active: true, reason: "power" }),
          }),
        ],
      },
      cpu: { usage: 12.5, temperature: 53.3, temperatureSource: "k10temp", draw: 26.7, tdp: 185 },
      ram: { used: 58243, total: 91870, percentage: 63 },
      storage: [],
      network: { interfaces: [] },
      // On a discrete host this is system RAM — not GPU headroom.
      unifiedMemory: { total: 91870, available: 33627 },
      llm: [
        {
          available: true,
          backend: "sglang",
          modelId: "qwen38",
          generationTps: 0,
          prefillTps: 0,
          totalOutputTokens: 0,
          totalPromptTokens: null,
          totalCachedTokens: null,
          kvCacheUsage: null,
          error: null,
        },
        { available: false, backend: null, modelId: null, generationTps: 0, prefillTps: 0, totalOutputTokens: 0, error: "ECONNREFUSED" },
      ],
    },
  };
}

/** A remote unit that failed liveness — its metrics are stale defaults. */
function offlineUnit() {
  return {
    id: "spark-3",
    name: "spark-3",
    kind: "spark",
    online: false,
    uptime: null,
    role: "worker",
    llmPorts: [],
    metrics: {
      gpu: { temperature: 0, usage: 0, power: { draw: 0, limit: 120 }, vram: { used: 0, total: 0, available: 0 }, gpus: [] },
      cpu: { usage: 0, temperature: 0, draw: 0, tdp: 0 },
      ram: { used: 0, total: 0, percentage: 0 },
      storage: [],
      network: { interfaces: [] },
      unifiedMemory: { total: 0, available: 0 },
      llm: [],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────
test("every line of a mixed fleet parses, and each family is described once", () => {
  const text = renderPrometheusMetrics([gb10Head(), multiGpuHost(), offlineUnit()]);
  const families = parseExposition(text);
  for (const [name, fam] of families) {
    const declared = METRIC_FAMILIES.find((f) => f.name === name);
    assert.ok(declared, `${name} is not in METRIC_FAMILIES`);
    assert.equal(fam.type, declared.type);
    assert.equal(text.split(`# HELP ${name} `).length, 2, `${name}: exactly one HELP`);
    assert.equal(text.split(`# TYPE ${name} `).length, 2, `${name}: exactly one TYPE`);
    for (const sample of fam.samples) {
      for (const key of ["unit", "unit_name", "kind", "role"]) {
        assert.ok(sample.labels[key], `${name} sample is missing ${key}`);
      }
    }
  }
  assert.match(PROMETHEUS_CONTENT_TYPE, /^text\/plain; version=0\.0\.4/);
});

test("an offline unit exports sparkdash_up 0 and nothing else", () => {
  const families = parseExposition(renderPrometheusMetrics([offlineUnit()]));
  assert.deepEqual([...families.keys()], ["sparkdash_up"]);
  assert.deepEqual(families.get("sparkdash_up").samples, [
    { labels: { unit: "spark-3", unit_name: "spark-3", kind: "spark", role: "worker" }, value: 0 },
  ]);
});

test("an empty fleet still describes sparkdash_up", () => {
  const text = renderPrometheusMetrics([]);
  assert.equal(text, (() => {
    const up = METRIC_FAMILIES[0];
    return `# HELP ${up.name} ${up.help}\n# TYPE ${up.name} gauge\n`;
  })());
  parseExposition(text);
});

test("GB10 values arrive in base units", () => {
  const families = parseExposition(renderPrometheusMetrics([gb10Head()]));
  const unit = { unit: "spark-1" };
  assert.equal(valueOf(families, "sparkdash_up", unit), 1);
  assert.equal(valueOf(families, "sparkdash_uptime_seconds", unit), 105945);
  assert.equal(valueOf(families, "sparkdash_gpu_temperature_celsius", { ...unit, gpu: "0" }), 43);
  assert.equal(valueOf(families, "sparkdash_gpu_power_watts", { ...unit, gpu: "0" }), 6.58);
  assert.equal(valueOf(families, "sparkdash_gpu_power_limit_watts", { ...unit, gpu: "0" }), 120);
  assert.equal(valueOf(families, "sparkdash_gpu_utilization_ratio", { ...unit, gpu: "0" }), 0);
  assert.equal(valueOf(families, "sparkdash_gpu_memory_used_bytes", { ...unit, gpu: "0" }), 100540 * MIB);
  assert.equal(valueOf(families, "sparkdash_gpu_memory_total_bytes", { ...unit, gpu: "0" }), 124610 * MIB);
  // Unified pool: headroom is MemAvailable, not total − GPU used.
  assert.equal(valueOf(families, "sparkdash_memory_available_bytes", unit), 7836 * MIB);
  assert.equal(valueOf(families, "sparkdash_cpu_utilization_ratio", unit), 0.01);
  assert.equal(valueOf(families, "sparkdash_cpu_temperature_celsius", { ...unit, sensor: "acpitz" }), 46.2);
  assert.equal(valueOf(families, "sparkdash_ram_used_bytes", unit), 116775 * MIB);
  assert.equal(valueOf(families, "sparkdash_ram_total_bytes", unit), 124610 * MIB);
  assert.equal(valueOf(families, "sparkdash_disk_total_bytes", { ...unit, mount: "/", device: "nvme0n1p2" }), 3845092 * MIB);
  assert.equal(valueOf(families, "sparkdash_disk_used_bytes", { ...unit, mount: "/" }), 690098 * MIB);
  assert.equal(valueOf(families, "sparkdash_disk_available_bytes", { ...unit, mount: "/" }), 2959642 * MIB);
  assert.equal(valueOf(families, "sparkdash_network_receive_bytes_per_second", { ...unit, interface: "enP7s7" }), 30021);
  assert.equal(valueOf(families, "sparkdash_network_transmit_bytes_per_second", { ...unit, interface: "enP7s7" }), 21474);
  // An interface hidden in sparkDash stays hidden from the scraper.
  assert.equal(samplesOf(families, "sparkdash_network_receive_bytes_per_second", { interface: "docker0" }).length, 0);
  assert.deepEqual(samplesOf(families, "sparkdash_gpu_info", unit)[0].labels, {
    unit: "spark-1",
    unit_name: "spark-1",
    kind: "spark",
    role: "head",
    gpu: "0",
    name: "NVIDIA GB10",
    uuid: "GPU-0a3cf9ea-0502-437e-f12e-3c4649403375",
  });
  for (const reason of ["thermal", "power", "hw"]) {
    assert.equal(valueOf(families, "sparkdash_gpu_throttled", { ...unit, gpu: "0", reason }), 0);
  }
});

test("multi-GPU hosts get one series per card, labelled by index", () => {
  const families = parseExposition(renderPrometheusMetrics([multiGpuHost()]));
  const unit = { unit: "gpu-box" };
  assert.deepEqual(
    samplesOf(families, "sparkdash_gpu_temperature_celsius", unit).map((s) => [s.labels.gpu, s.value]),
    [["0", 50], ["1", 51]]
  );
  assert.equal(valueOf(families, "sparkdash_gpu_utilization_ratio", { ...unit, gpu: "1" }), 0.7);
  assert.equal(valueOf(families, "sparkdash_gpu_memory_used_bytes", { ...unit, gpu: "1" }), 2000 * MIB);
  assert.equal(valueOf(families, "sparkdash_gpu_info", { ...unit, gpu: "1" }), 1);
  assert.equal(samplesOf(families, "sparkdash_gpu_info", { ...unit, gpu: "1" })[0].labels.name, "NVIDIA GeForce RTX 5060 Ti");
  assert.equal(valueOf(families, "sparkdash_gpu_throttled", { ...unit, gpu: "0", reason: "power" }), 0);
  assert.equal(valueOf(families, "sparkdash_gpu_throttled", { ...unit, gpu: "1", reason: "power" }), 1);
  // Discrete GPU headroom is free VRAM — the system-RAM figure is not used.
  assert.equal(valueOf(families, "sparkdash_memory_available_bytes", unit), 29000 * MIB);
  // No aggregate series beside the per-card ones.
  assert.equal(samplesOf(families, "sparkdash_gpu_temperature_celsius", unit).length, 2);
});

test("LLM endpoints: rates, counters, and nothing invented for a down or silent engine", () => {
  const families = parseExposition(renderPrometheusMetrics([gb10Head(), multiGpuHost()]));
  const tf = { unit: "spark-1", port: "8888", backend: "tensorfold", model: "GLM-5.3-Flash-EXL3" };
  assert.equal(valueOf(families, "sparkdash_llm_up", tf), 1);
  assert.equal(valueOf(families, "sparkdash_llm_generation_tokens_per_second", tf), 41.5);
  assert.equal(valueOf(families, "sparkdash_llm_prefill_tokens_per_second", tf), 0);
  assert.equal(valueOf(families, "sparkdash_llm_kv_cache_usage_ratio", tf), 0.0524);
  assert.equal(valueOf(families, "sparkdash_llm_requests_running", tf), 1);
  assert.equal(valueOf(families, "sparkdash_llm_generated_tokens_total", tf), 47349);
  assert.equal(valueOf(families, "sparkdash_llm_prompt_tokens_total", tf), 1333789);
  assert.equal(valueOf(families, "sparkdash_llm_cached_prompt_tokens_total", tf), 878720);
  // null → omitted, not 0.
  assert.equal(samplesOf(families, "sparkdash_llm_requests_waiting", { unit: "spark-1" }).length, 0);

  const sg = { unit: "gpu-box", port: "30000" };
  assert.equal(valueOf(families, "sparkdash_llm_up", sg), 1);
  assert.equal(samplesOf(families, "sparkdash_llm_kv_cache_usage_ratio", sg).length, 0);
  assert.equal(samplesOf(families, "sparkdash_llm_prompt_tokens_total", sg).length, 0);
  // A zero output counter is what a backend without counters reports — not exported.
  assert.equal(samplesOf(families, "sparkdash_llm_generated_tokens_total", sg).length, 0);

  const down = { unit: "gpu-box", port: "30001" };
  assert.equal(valueOf(families, "sparkdash_llm_up", down), 0);
  assert.deepEqual(Object.keys(samplesOf(families, "sparkdash_llm_up", down)[0].labels).sort(), [
    "kind",
    "port",
    "role",
    "unit",
    "unit_name",
  ]);
  for (const name of families.keys()) {
    if (name === "sparkdash_llm_up") continue;
    assert.equal(samplesOf(families, name, down).length, 0, `${name} written for a down endpoint`);
  }
});

test("a failed GPU read is not exported as zeros", () => {
  const families = parseExposition(
    renderPrometheusMetrics([{ snapshot: gb10Head(), collected: { gpu: false, cpu: true } }])
  );
  for (const name of families.keys()) {
    assert.doesNotMatch(name, /^sparkdash_gpu_/, `${name} exported from a failed GPU collection`);
  }
  assert.equal(valueOf(families, "sparkdash_cpu_utilization_ratio", { unit: "spark-1" }), 0.01);

  // Before the first poll the snapshot holds the collector's zero defaults.
  const fresh = gb10Head();
  fresh.metrics.gpu = offlineUnit().metrics.gpu;
  fresh.metrics.cpu = offlineUnit().metrics.cpu;
  const freshFamilies = parseExposition(renderPrometheusMetrics([fresh]));
  assert.equal(samplesOf(freshFamilies, "sparkdash_gpu_temperature_celsius").length, 0);
  assert.equal(samplesOf(freshFamilies, "sparkdash_cpu_utilization_ratio").length, 0);
});

test("label values are escaped and read back intact", () => {
  const unit = gb10Head();
  unit.id = 'lab "A"';
  unit.name = 'Rack \\ 2\nshelf "top"';
  unit.metrics.llm[0].modelId = 'org/model "q4"\\v2';
  const families = parseExposition(renderPrometheusMetrics([unit]));
  const up = families.get("sparkdash_up").samples[0];
  assert.equal(up.labels.unit, 'lab "A"');
  assert.equal(up.labels.unit_name, 'Rack \\ 2\nshelf "top"');
  assert.equal(samplesOf(families, "sparkdash_llm_up")[0].labels.model, 'org/model "q4"\\v2');

  assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(formatValue(NaN), "NaN");
  assert.equal(formatValue(Infinity), "+Inf");
  assert.equal(formatValue(-Infinity), "-Inf");
  assert.equal(formatValue(0.5), "0.5");
});

test("the reader used above rejects malformed exposition", () => {
  parseExposition('# HELP a_b x\n# TYPE a_b gauge\na_b{u="1"} 1\n');
  const bad = {
    "unescaped quote": '# HELP a x\n# TYPE a gauge\na{u="x"y"} 1\n',
    "HELP twice": "# HELP a x\n# HELP a y\n# TYPE a gauge\na 1\n",
    "split family": '# HELP a x\n# TYPE a gauge\na 1\n# HELP b x\n# TYPE b gauge\nb 1\na{x="2"} 2\n',
    undeclared: "c 1\n",
    "duplicate series": '# HELP a x\n# TYPE a gauge\na{u="1"} 1\na{u="1"} 2\n',
    "counter without _total": "# HELP a x\n# TYPE a counter\na 1\n",
    "gauge with _total": "# HELP a_total x\n# TYPE a_total gauge\na_total 1\n",
    "bad value": "# HELP a x\n# TYPE a gauge\na one\n",
    "no trailing newline": "# HELP a x\n# TYPE a gauge\na 1",
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.throws(() => parseExposition(text), undefined, `accepted: ${what}`);
  }
});

test("duplicate series are dropped rather than failing the scrape", () => {
  const unit = gb10Head();
  unit.metrics.storage.push({ ...unit.metrics.storage[0] });
  const families = parseExposition(renderPrometheusMetrics([unit, unit]));
  assert.equal(samplesOf(families, "sparkdash_up").length, 1);
  assert.equal(samplesOf(families, "sparkdash_disk_total_bytes").length, 1);
});

test("the last successful sample time of each collector is exported per unit", () => {
  const unit = { ...gb10Head(), };
  const text = renderPrometheusMetrics([
    { snapshot: unit, collected: { gpu: true, cpu: true }, collectedAt: { gpu: 1_791_700_000_500, ram: 1_791_700_001_000, bad: -1, nan: NaN } },
  ]);
  const fam = parseExposition(text).get("sparkdash_collector_last_success_timestamp_seconds");
  assert.equal(fam.type, "gauge");
  const byCollector = Object.fromEntries(fam.samples.map((s) => [s.labels.collector, s.value]));
  assert.deepEqual(byCollector, { gpu: 1_791_700_000.5, ram: 1_791_700_001 });
  for (const sample of fam.samples) assert.equal(sample.labels.unit, "spark-1");
});

test("no collector series without a success, and none for an offline unit", () => {
  assert.equal(parseExposition(renderPrometheusMetrics([gb10Head()])).has("sparkdash_collector_last_success_timestamp_seconds"), false);
  const offline = parseExposition(renderPrometheusMetrics([{ snapshot: offlineUnit(), collectedAt: { gpu: 1_791_700_000_000 } }]));
  assert.deepEqual([...offline.keys()], ["sparkdash_up"]);
});

test("metricsEntries wires each monitor's snapshot, provenance and success times into the export", () => {
  const monitor = {
    snapshot: () => gb10Head(),
    _metricCollectionSuccessful: { gpu: true, cpu: true },
    lastSuccess: () => ({ gpu: 1_791_700_000_000 }),
  };
  const entries = metricsEntries([monitor, undefined, null]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].collectedAt, { gpu: 1_791_700_000_000 });
  assert.deepEqual(entries[0].collected, { gpu: true, cpu: true });
  const fam = parseExposition(renderPrometheusMetrics(entries)).get("sparkdash_collector_last_success_timestamp_seconds");
  assert.equal(fam.samples[0].value, 1_791_700_000);
});
