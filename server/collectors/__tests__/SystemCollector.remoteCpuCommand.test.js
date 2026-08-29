import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRemoteCpuCommand } from "../SystemCollector.js";

const exec = promisify(execFile);

// A kind "host" unit with no hwmon match and no readable thermal_zone temp file
// (e.g. a VM with a passed-through GPU) leaves the thermal glob unexpanded, so
// the final `cat` exits 1. It is the last command in the ";"-joined chain, so
// the whole remote command exits non-zero, and sshExec (execFile) rejects on a
// non-zero exit — _getRemoteCpu then falls back to _defaultCpu(), losing usage,
// draw and tdp as well as temperature. _parseSensorTemp already maps "nothing
// readable" to 0, so degrading to "no temperature" is the intended behaviour.

test("host CPU probe exits 0 on a machine with no thermal sensors", async () => {
  const cmd = buildRemoteCpuCommand("host");
  // execFile rejects on a non-zero exit, exactly how sshExec fails.
  const { stdout } = await exec("/bin/sh", ["-c", cmd]);
  assert.equal(
    stdout.split("---").length,
    3,
    "stat / cpuinfo / sensor sections must all be present even with no sensors"
  );
});

test("host CPU probe cannot fail on the sensor read", () => {
  // On a box that does have thermal zones the test above passes trivially, so
  // pin the exit-tolerance in the command itself too.
  const cmd = buildRemoteCpuCommand("host");
  assert.match(cmd, /thermal_zone\*\/temp 2>\/dev\/null \|\| true/);
});

test("spark CPU probe omits the sensor probe entirely", () => {
  // DGX Sparks deliberately skip the extra sensor read, so the GB10 path stays
  // a two-section command.
  const cmd = buildRemoteCpuCommand("spark");
  assert.doesNotMatch(cmd, /hwmon/);
  assert.doesNotMatch(cmd, /thermal_zone/);
  assert.equal(cmd.split("---").length, 2);
});
