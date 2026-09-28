import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { SystemCollector } from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

const c = Object.create(SystemCollector.prototype);
const parse = (raw) => c._parseSensorTemp(raw);

// ─── _getCPUTemperature with mocked sysfs ─────────────────
const SYS = HOST_PATHS.SYS; // /host/sys
const orig = {
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync,
};

/** Restore the real fs methods after each mocked test. */
function restoreFs() {
  fs.existsSync = orig.existsSync;
  fs.readdirSync = orig.readdirSync;
  fs.readFileSync = orig.readFileSync;
}

/**
 * Build a fake hwmon+thermal tree, keyed by path, and mock fs so
 * `_getCPUTemperature()` walks it as if it were the real sysfs.
 *
 * @param {Record<string, string>} names  hwmon dir name -> driver name
 * @param {Record<string, string>} temps  hwmon dir -> { tempN_input: raw }
 * @param {Record<string, number>} zones  thermal_zoneN -> raw millidegrees
 */
function mockSysfs({ names = {}, temps = {}, zones = {} } = {}) {
  const hwmonDirs = Object.keys(names);
  const zoneDirs = Object.keys(zones);

  fs.existsSync = (p) => {
    const str = String(p);
    if (str === `${SYS}/class/hwmon`) return hwmonDirs.length > 0;
    if (str === `${SYS}/class/thermal`) return zoneDirs.length > 0;
    // hwmon name file / temp input, or thermal zone temp file
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (str === `${base}/name`) return true;
      if (str.startsWith(base + "/")) return true;
    }
    for (const zone of zoneDirs) {
      if (str === `${SYS}/class/thermal/${zone}/temp`) return true;
    }
    return false;
  };

  fs.readdirSync = (p) => {
    if (p === `${SYS}/class/hwmon`) return hwmonDirs;
    if (p === `${SYS}/class/thermal`) return zoneDirs;
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (p === base) return Object.keys(temps[dir] ?? {}).length ? Object.keys(temps[dir]) : ["temp1_input"];
    }
    return [];
  };

  fs.readFileSync = (p, enc) => {
    const str = String(p);
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (str === `${base}/name`) return names[dir];
      const m = str.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/temp(\\d+)_input$`));
      if (m) {
        const raw = temps[dir]?.[`temp${m[1]}_input`];
        return String(raw ?? 0);
      }
    }
    for (const zone of zoneDirs) {
      if (str === `${SYS}/class/thermal/${zone}/temp`) return String(zones[zone]);
    }
    return "0";
  };
}

test("remote CPU command includes the sensor dump and the RAPL triple", () => {
  const spark = new SystemCollector({ id: "spark-test", kind: "spark" });
  const host = new SystemCollector({ id: "host-test", kind: "host" });
  const sparkCmd = spark._buildRemoteCpuCommand();
  const hostCmd = host._buildRemoteCpuCommand();
  assert.equal(sparkCmd, hostCmd);
  assert.match(sparkCmd, /coretemp\|k10temp\|zenpower\|acpitz/);
  assert.match(sparkCmd, /thermal_zone\*\/temp/);
  assert.match(sparkCmd, /\|\| true$/);
  // stat / cpuinfo / temps / rapl energy / rapl max-range / rapl PL1
  assert.equal((sparkCmd.match(/echo '---'/g) || []).length, 5);
  assert.match(sparkCmd, /powercap\/intel-rapl:0\/energy_uj/);
  assert.match(sparkCmd, /constraint_0_power_limit_uw/);
});

test("remote CPU collection returns temperature for DGX Spark nodes", async () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  const result = await collector._getRemoteCpu(async (spark, command) => {
    assert.equal(spark.id, "spark-test");
    assert.match(command, /coretemp\|k10temp\|zenpower\|acpitz/);
    assert.match(command, /thermal_zone\*\/temp/);
    // GB10: the three RAPL sections come back EMPTY — estimate path must survive.
    return [
      "cpu 100 0 40 860 0 0 0 0",
      "---",
      "CPU architecture: 8",
      "---",
      "70900",
      "---",
      "",
      "---",
      "",
      "---",
      "",
    ].join("\n");
  });

  assert.equal(result.temperature, 70.9);
  assert.equal(result.tdp, 65);
  assert.equal(result.source, "estimate");
});

test("remote CPU collection reports measured RAPL package watts", async () => {
  const collector = new SystemCollector({ id: "x86-test", kind: "host" });
  const now = Date.now();
  let call = 0;
  const exec = async () => {
    call++;
    // 50 mJ elapsed between the two 1s-apart samples → 50 W, PL1 65 W.
    const energy = call === 1 ? 1_000_000_000 : 1_050_000_000;
    return [
      call === 1 ? "cpu 100 0 40 860 0 0 0 0" : "cpu 200 0 80 1720 0 0 0 0",
      "---",
      "model name  : Intel Core i3-10100",
      "---",
      "61000",
      "---",
      String(energy),
      "---",
      "262143328850",
      "---",
      "65000000",
    ].join("\n");
  };
  // Force both samples into a ≥0.5s window via a fake clock.
  const realNow = Date.now;
  Date.now = () => now + (call === 0 ? 0 : call === 1 ? 0 : 1000);
  try {
    const first = await collector._getRemoteCpu(exec);
    assert.equal(first.source, "estimate", "first poll has no baseline window");
    const second = await collector._getRemoteCpu(exec);
    assert.equal(second.source, "rapl");
    assert.equal(second.draw, 50);
    assert.equal(second.tdp, 65, "PL1 from constraint_0_power_limit_uw");
  } finally {
    Date.now = realNow;
  }
});

test("RAPL counter wrap is corrected by max_energy_range", () => {
  const collector = Object.create(SystemCollector.prototype);
  collector.lastRaplReading = { energyUj: 262_141_128_850, maxRangeUj: 262_143_328_850, at: 1_000 };
  const s = collector._raplSample({ energyUj: 1_000_000, maxRangeUj: 262_143_328_850, now: 3_000 });
  // delta = 1e6 − 262_141_128_850 + range = 3_200_000 uJ over 2 s = 1.6 W
  assert.equal(s.watts, 1.6);
});

test("converts millidegrees to Celsius", () => {
  assert.equal(parse("70900"), 70.9);
  assert.equal(parse("69200"), 69.2);
});

test("takes the first plausible reading, not the highest", () => {
  assert.equal(parse("70900\n80000\n62200"), 70.9);
});

test("skips the blank line left by the section split", () => {
  assert.equal(parse("\n69200\n66200\n"), 69.2);
});

test("skips unreadable sensors", () => {
  assert.equal(parse("\n\n64500"), 64.5);
  assert.equal(parse("not-a-number\n64500"), 64.5);
});

test("rejects out-of-range values", () => {
  assert.equal(parse("0"), 0);
  assert.equal(parse("-5000"), 0);
  assert.equal(parse("200000"), 0);
  assert.equal(parse("250000"), 0);
  assert.equal(parse("0\n250000\n70900"), 70.9);
});

test("returns 0 when nothing is reported", () => {
  assert.equal(parse(""), 0);
  assert.equal(parse("\n\n"), 0);
  assert.equal(parse(undefined), 0);
});

test("rounds to one decimal", () => {
  assert.equal(parse("69250"), 69.3);
  assert.equal(parse("69240"), 69.2);
});

// ─── sensor-selection tests ───────────────────────────────
test("prefers the hottest coretemp input over lower ones", async () => {
  mockSysfs({
    names: { hwmon0: "acpitz", hwmon1: "coretemp" },
    temps: {
      hwmon0: { temp1_input: "84000", temp2_input: "68000" },
      hwmon1: { temp1_input: "52000", temp2_input: "61000", temp3_input: "58000" },
    },
    zones: {},
  });
  try {
    const t = await c._getCPUTemperature();
    // hottest coretemp input wins, not temp1 (52) nor acpitz (84)
    assert.equal(t, 61);
  } finally {
    restoreFs();
  }
});

test("falls back to hottest acpitz zone when no CPU sensor exists", async () => {
  mockSysfs({
    names: { hwmon0: "acpitz" },
    temps: {
      hwmon0: { temp1_input: "84000", temp2_input: "68000", temp3_input: "71000" },
    },
    zones: {
      thermal_zone0: 83000,
      thermal_zone1: 69000,
      thermal_zone2: 85000,
    },
  });
  try {
    const t = await c._getCPUTemperature();
    // hottest board zone (85), above hwmon acpitz temp1 (84)
    assert.equal(t, 85);
  } finally {
    restoreFs();
  }
});

test("thermal-zone fallback picks the max zone", async () => {
  mockSysfs({ names: {}, temps: {}, zones: { thermal_zone0: 70000, thermal_zone1: 82000 } });
  try {
    const t = await c._getCPUTemperature();
    assert.equal(t, 82);
  } finally {
    restoreFs();
  }
});

test("returns 0 when no sensors are readable", async () => {
  mockSysfs({ names: {}, temps: {}, zones: {} });
  try {
    const t = await c._getCPUTemperature();
    assert.equal(t, 0);
  } finally {
    restoreFs();
  }
});

test("ignores non-CPU/non-board hwmon drivers (nvme, mlx5, mt7925)", async () => {
  mockSysfs({
    names: { hwmon0: "nvme", hwmon1: "mlx5", hwmon2: "mt7925_phy0", hwmon3: "acpitz" },
    temps: {
      hwmon0: { temp1_input: "52850" },
      hwmon1: { temp1_input: "68000" },
      hwmon2: { temp1_input: "59000" },
      hwmon3: { temp1_input: "76000" },
    },
    zones: {},
  });
  try {
    const t = await c._getCPUTemperature();
    // only acpitz is considered → hottest (only) = 76
    assert.equal(t, 76);
  } finally {
    restoreFs();
  }
});

test("rejects out-of-range values and falls through", async () => {
  mockSysfs({
    names: { hwmon0: "coretemp" },
    temps: { hwmon0: { temp1_input: "0", temp2_input: "250000", temp3_input: "70900" } },
    zones: {},
  });
  try {
    const t = await c._getCPUTemperature();
    assert.equal(t, 70.9);
  } finally {
    restoreFs();
  }
});

test("collectCpu reports SoC/board temp for non-host kinds (GB10 acpitz)", async () => {
  // Object.create drops the constructor fields; build a real instance-like obj
  // with the methods stubbed so we only exercise the temperature path.
  const spark = Object.create(SystemCollector.prototype);
  spark.spark = { kind: "spark", isLocal: true, id: "spark1" };
  // Baseline so the /proc/stat diff yields 50%: used +50 on total +100.
  spark.lastCpuStat = { total: 100, used: 50 };
  spark.lastCpuUsagePct = 50;
  spark._getCPUUsage = async () => ({ total: 200, used: 100 });
  spark._getCPUPower = async () => ({ draw: 20, tdp: 65 });
  spark._getCPUTemperature = async () => 84; // GB10 acpitz SoC/board reading
  try {
    const result = await spark.collectCpu();
    assert.equal(result.temperature, 84, "non-host kind reports the acpitz SoC temp");
    assert.equal(result.usage, 50);
  } finally {
    restoreFs();
  }
});

test("collectCpu reports temp for host kind", async () => {
  const spark = Object.create(SystemCollector.prototype);
  spark.spark = { kind: "host", isLocal: true, id: "host1" };
  spark.lastCpuStat = { total: 100, used: 50 };
  spark.lastCpuUsagePct = 50;
  spark._getCPUUsage = async () => ({ total: 200, used: 100 });
  spark._getCPUPower = async () => ({ draw: 120, tdp: 185 });
  spark._getCPUTemperature = async () => 61;
  try {
    const result = await spark.collectCpu();
    assert.equal(result.temperature, 61);
    assert.equal(result.usage, 50);
  } finally {
    restoreFs();
  }
});
