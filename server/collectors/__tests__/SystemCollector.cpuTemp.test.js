import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { SystemCollector } from "../SystemCollector.js";

const c = Object.create(SystemCollector.prototype);
const parse = (raw) => c._parseSensorTemp(raw);
const pick = (candidates) => c._pickCpuTemperature(candidates);
const label = (source) => c._cpuTempSourceLabel(source);

test("remote CPU command always includes the sensor dump", () => {
  const spark = new SystemCollector({ id: "spark-test", kind: "spark" });
  const host = new SystemCollector({ id: "host-test", kind: "host" });
  const sparkCmd = spark._buildRemoteCpuCommand();
  const hostCmd = host._buildRemoteCpuCommand();
  assert.equal(sparkCmd, hostCmd);
  assert.match(sparkCmd, /coretemp\|k10temp\|zenpower\|acpitz/);
  // Every sensor line names itself, so the reader can say which one it used.
  assert.match(sparkCmd, /echo "\$n \$v"/);
  assert.match(sparkCmd, /\$z\/type/);
  assert.match(sparkCmd, /\|\| true$/);
  assert.equal((sparkCmd.match(/echo '---'/g) || []).length, 2);
});

test("remote CPU collection returns temperature for DGX Spark nodes", async () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  const result = await collector._getRemoteCpu(async (spark, command) => {
    assert.equal(spark.id, "spark-test");
    assert.match(command, /coretemp\|k10temp\|zenpower\|acpitz/);
    assert.equal((command.match(/echo '---'/g) || []).length, 2);
    return [
      "cpu 100 0 40 860 0 0 0 0",
      "---",
      "CPU architecture: 8",
      "---",
      "acpitz 70900",
    ].join("\n");
  });

  assert.equal(result.temperature, 70.9);
  assert.equal(result.temperatureSource, "acpitz");
  assert.equal(result.tdp, 65);
  // GB10 exposes no CPU package sensor, and the card must not claim otherwise.
  assert.equal(result.temperatureLabel, "ACPI");
  assert.equal(result.temperatureSource, "acpitz");
});

test("remote CPU temperature names an x86 die sensor", () => {
  const sensor = pick(c._parseSensorCandidates("coretemp 45200\n"));
  assert.equal(sensor.temperature, 45.2);
  assert.equal(sensor.temperatureSource, "coretemp");
  assert.equal(sensor.temperatureLabel, "CPU");
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

test("names what the sensor actually is", () => {
  assert.equal(label("coretemp"), "CPU");
  assert.equal(label("k10temp"), "CPU");
  assert.equal(label("acpitz"), "ACPI");
  assert.equal(label("soc_thermal"), "SoC");
  assert.equal(label("mt7925_phy0"), "mt7925_phy0");
  assert.equal(label(null), null);
});

test("prefers a real CPU sensor wherever it appears, and labels the fallback", () => {
  // The reported bug: the first zone on a GB10 is acpitz, ~15 °C above the die,
  // and the panel called it "CPU". A CPU sensor must win wherever it is found...
  const preferred = pick([
    { source: "acpitz", millidegrees: 44800 },
    { source: "coretemp", millidegrees: 38200 },
  ]);
  assert.deepEqual(preferred, { temperature: 38.2, temperatureLabel: "CPU", temperatureSource: "coretemp" });

  // ...and when there is none, the reading is kept but named honestly.
  const fallback = pick([
    { source: "acpitz", millidegrees: 44800 },
    { source: "acpitz", millidegrees: 43100 },
  ]);
  assert.deepEqual(fallback, { temperature: 44.8, temperatureLabel: "ACPI", temperatureSource: "acpitz" });

  // Unnamed (older command shape) readings still work, unlabelled.
  assert.deepEqual(pick([{ source: null, millidegrees: 70900 }]), {
    temperature: 70.9,
    temperatureLabel: null,
    temperatureSource: null,
  });

  // Implausible values are skipped; nothing readable means 0 with no label.
  assert.deepEqual(pick([{ source: "coretemp", millidegrees: 0 }]), {
    temperature: 0,
    temperatureLabel: null,
    temperatureSource: null,
  });
  assert.deepEqual(pick([]), { temperature: 0, temperatureLabel: null, temperatureSource: null });
});

test("remote sensor dump parsing tolerates both formats", () => {
  assert.deepEqual(c._parseSensorCandidates("acpitz 44800\ncoretemp 38200\n"), [
    { source: "acpitz", millidegrees: 44800 },
    { source: "coretemp", millidegrees: 38200 },
  ]);
  assert.deepEqual(c._parseSensorCandidates("\n70900\n"), [{ source: null, millidegrees: 70900 }]);
  assert.deepEqual(c._parseSensorCandidates(""), []);
});

// Outside Docker there is no /host/sys: the local CPU temperature must come from /sys, not read as "no sensor".
test("_sysRoot: the host bind mount when it exists, else /sys", () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/sysroot-");
  try {
    assert.equal(c._sysRoot([dir + "/missing", dir]), dir);
    assert.equal(c._sysRoot([dir, "/sys"]), dir);
    assert.equal(c._sysRoot([dir + "/missing", dir + "/also-missing"]), dir + "/also-missing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local CPU temperature is read from the given sysfs root (acpitz zones on a GB10, no /host/sys)", () => {
  const root = fs.mkdtempSync(os.tmpdir() + "/sysfs-");
  try {
    // A GB10-shaped tree: hwmon chips named acpitz_0.., nvme, mlx5; thermal zones of type acpitz.
    for (const [chip, name] of [["hwmon0", "acpitz_0"], ["hwmon7", "nvme"], ["hwmon8", "mlx5"]]) {
      fs.mkdirSync(`${root}/class/hwmon/${chip}`, { recursive: true });
      fs.writeFileSync(`${root}/class/hwmon/${chip}/name`, `${name}\n`);
      fs.writeFileSync(`${root}/class/hwmon/${chip}/temp1_input`, "41000\n");
    }
    for (const [zone, milli] of [["thermal_zone0", "78800"], ["thermal_zone1", "66100"]]) {
      fs.mkdirSync(`${root}/class/thermal/${zone}`, { recursive: true });
      fs.writeFileSync(`${root}/class/thermal/${zone}/type`, "acpitz\n");
      fs.writeFileSync(`${root}/class/thermal/${zone}/temp`, `${milli}\n`);
    }
    const reading = pick(c._localCpuTempCandidates(root));
    assert.equal(reading.temperature, 78.8);
    assert.equal(reading.temperatureSource, "acpitz");
    assert.equal(reading.temperatureLabel, "ACPI");
    // No sysfs there at all: nothing readable, no throw.
    assert.equal(pick(c._localCpuTempCandidates(root + "/none")).temperature, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_getNetworkLinkSpeedMbps reads the link speed from the sysfs root in use", async () => {
  const root = fs.mkdtempSync(os.tmpdir() + "/sysnet-");
  try {
    fs.mkdirSync(`${root}/class/net/eth9`, { recursive: true });
    fs.writeFileSync(`${root}/class/net/eth9/speed`, "10000\n");
    const col = Object.create(SystemCollector.prototype);
    col._sysRoots = () => [root + "/nope", root];
    assert.equal(await col._getNetworkLinkSpeedMbps("eth9"), 10000);
    assert.equal(await col._getNetworkLinkSpeedMbps("eth0"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
