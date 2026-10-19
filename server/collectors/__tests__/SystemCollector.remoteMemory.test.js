/**
 * The remote unified-memory command must exit 0 when nvidia-smi fails:
 * sshExec treats any non-zero exit as a hard error and would discard the
 * /proc/meminfo lines that were already printed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SystemCollector } from "../SystemCollector.js";

test("remote unified memory: a failing nvidia-smi does not fail the command", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-smi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // An nvidia-smi that fails the way a broken NVML does.
  fs.writeFileSync(path.join(dir, "nvidia-smi"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });

  const collector = new SystemCollector({ id: "r1", kind: "spark", host: "10.0.0.2", lanIp: "10.0.0.2" });
  let exitCode = null;
  // Run the collector's own command in a local shell, rejecting on a non-zero
  // exit exactly as sshExec does.
  const executor = (_spark, cmd) =>
    new Promise((resolve, reject) => {
      execFile("sh", ["-c", cmd], { env: { PATH: `${dir}:/usr/bin:/bin` } }, (err, stdout) => {
        exitCode = err ? err.code : 0;
        if (err) reject(err);
        else resolve(stdout);
      });
    });

  const memory = await collector._getRemoteUnifiedMemory(executor);
  assert.equal(exitCode, 0, "the command's exit status must not be nvidia-smi's");
  assert.equal(memory.gpuUsed, 0);
});
