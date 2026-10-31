import test from "node:test";
import assert from "node:assert/strict";
import {
  SystemCollector,
  collectionWasSuccessful,
  cleanPiModel,
  parsePiThrottle,
  piCpuModel,
  piGpuChip,
} from "../SystemCollector.js";

const pi = () => new SystemCollector({ id: "luffy-1", kind: "pi", isLocal: false, ssh: { host: "192.0.2.10" } });

test("Pi model strings drop the device-tree NUL padding", () => {
  assert.equal(cleanPiModel("Raspberry Pi 4 Model B Rev 1.4\0"), "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(cleanPiModel(null), "");
});

test("Pi throttle flags decode the firmware bitmask", () => {
  const flags = parsePiThrottle("throttled=0x50005\n");
  assert.deepEqual(flags, {
    raw: "0x50005",
    underVoltage: true,
    freqCapped: false,
    throttled: true,
    softTempLimit: false,
    underVoltageOccurred: true,
    freqCappedOccurred: false,
    throttledOccurred: true,
    softTempLimitOccurred: false,
  });
  assert.equal(parsePiThrottle("throttled=0x0")?.underVoltage, false);
});

test("an unavailable vcgencmd stays unknown, not 'not throttled'", () => {
  assert.equal(parsePiThrottle(""), null);
  assert.equal(parsePiThrottle("vcgencmd: command not found"), null);
});

test("Pi model names map to the right CPU and GPU generation", () => {
  assert.equal(piCpuModel("Raspberry Pi 4 Model B Rev 1.4"), "Cortex-A72");
  assert.equal(piCpuModel("Raspberry Pi 5 Model B Rev 1.0"), "Cortex-A76");
  assert.equal(piCpuModel("Raspberry Pi 3 Model B Plus Rev 1.3"), "Cortex-A53");
  assert.equal(piGpuChip("Raspberry Pi 4 Model B Rev 1.4"), "VideoCore VI");
  assert.equal(piGpuChip("Raspberry Pi 5 Model B Rev 1.0"), "VideoCore VII");
});

test("Pi status reads model, revision, serial and throttle in one round trip", async () => {
  const collector = pi();
  const status = await collector.collectPiStatus(async (spark, command) => {
    assert.equal(spark.id, "luffy-1");
    assert.match(command, /device-tree\/model/);
    assert.match(command, /vcgencmd get_throttled/);
    return [
      "Raspberry Pi 4 Model B Rev 1.4\0",
      "---",
      "Model           : Raspberry Pi 4 Model B Rev 1.4",
      "Revision        : c03114",
      "Serial          : 10000000abcdef01",
      "---",
      "throttled=0x50005",
    ].join("\n");
  });
  assert.equal(status.model, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(status.revision, "c03114");
  assert.equal(status.serial, "10000000abcdef01");
  assert.equal(status.throttleAvailable, true);
  assert.equal(status.throttle.underVoltage, true);
});

test("Pi status tolerates a missing vcgencmd", async () => {
  const collector = pi();
  const status = await collector.collectPiStatus(async () =>
    ["Raspberry Pi 4 Model B Rev 1.4\0", "---", "Revision        : c03114", "---", ""].join("\n")
  );
  assert.equal(status.model, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(status.throttle, null);
  assert.equal(status.throttleAvailable, false);
});

test("Pi status returns null when SSH itself fails", async () => {
  const collector = pi();
  const status = await collector.collectPiStatus(async () => {
    throw new Error("connection refused");
  });
  assert.equal(status, null);
});

test("Pi CPU collection has no fabricated power and still counts as successful", async () => {
  const collector = pi();
  collector._getRemoteCpu = async () => ({
    usage: 12,
    temperature: 61.2,
    temperatureLabel: "CPU",
    temperatureSource: "cpu-thermal",
    draw: null,
    tdp: null,
  });
  const result = await collector.collectCpu();
  assert.equal(result.draw, null);
  assert.equal(result.tdp, null);
  assert.equal(collectionWasSuccessful(result), true);
});

test("Pi remote CPU reports null power but a real temperature", async () => {
  const collector = pi();
  const result = await collector._getRemoteCpu(async () =>
    [
      "cpu 100 0 40 860 0 0 0 0",
      "---",
      "CPU architecture: 8",
      "---",
      "cpu-thermal 65000",
    ].join("\n")
  );
  assert.equal(result.temperature, 65);
  assert.equal(result.temperatureLabel, "CPU");
  assert.equal(result.draw, null);
  assert.equal(result.tdp, null);
});

test("Pi hardware detection fills the header from the board model", async () => {
  const collector = pi();
  const hardware = await collector.detectPiHardware(async () =>
    ["Raspberry Pi 4 Model B Rev 1.4\0", "---", "4", "---", "MemTotal:        8064000 kB"].join("\n")
  );
  assert.equal(hardware.device, "Raspberry Pi 4 Model B Rev 1.4");
  assert.equal(hardware.cpuModel, "Cortex-A72");
  assert.equal(hardware.cpuCores, 4);
  assert.equal(hardware.totalMemoryGB, 8);
  assert.equal(hardware.gpuChip, "VideoCore VI");
});

test("Pi storage drops the fixed /boot/firmware volume", () => {
  const collector = pi();
  const output = [
    "Filesystem Type 1-blocks Used Available Capacity Mounted",
    "/dev/root ext4 1000000 400000 600000 40% /",
    "/dev/mmcblk0p1 vfat 500000 100000 400000 20% /boot/firmware",
  ].join("\n");
  const disks = collector._parseRemoteStorage(output);
  assert.deepEqual(disks.map((d) => d.label), ["/"]);
});
