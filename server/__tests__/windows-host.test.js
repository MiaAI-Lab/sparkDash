/**
 * Running the server on a Windows host: POSIX-mode checks that cannot pass
 * there are skipped, and the storage programs reach the unit with LF endings.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeStateAtomically } from "../energy/atomicWrite.js";
import { identityPermissionsSafe } from "../startupPreflight.js";
import { buildProgram } from "../storage/commands.js";

/** Real fs, but stat reports 0666 and a directory fsync fails with EPERM, as on Windows. */
function windowsLikeFs() {
  const dirFds = new Set();
  return {
    ...fs,
    openSync(target, flags, mode) {
      const fd = fs.openSync(target, flags, mode);
      if (fs.fstatSync(fd).isDirectory()) dirFds.add(fd);
      return fd;
    },
    fsyncSync(fd) {
      if (dirFds.has(fd)) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      return fs.fsyncSync(fd);
    },
    statSync(target) {
      const st = fs.statSync(target);
      return { ...st, mode: (st.mode & ~0o777) | 0o666, isFile: () => st.isFile() };
    },
  };
}

test("state writes succeed on Windows, where stat always reports 0666 and directories cannot be fsynced", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-winmode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  writeStateAtomically(file, "{\"ok\":true}\n", windowsLikeFs(), "win32");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"ok\":true}\n");
});

test("state writes still refuse a file left group- or world-readable on POSIX", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-winmode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => writeStateAtomically(path.join(dir, "state.json"), "{}\n", windowsLikeFs(), "linux"),
    /expected mode 0600, got 0666/
  );
});

test("the SSH identity mode is not judged on Windows", () => {
  assert.equal(identityPermissionsSafe(0o666, "win32"), null);
  assert.equal(identityPermissionsSafe(0o644, "linux"), false);
  assert.equal(identityPermissionsSafe(0o600, "linux"), true);
  assert.equal(identityPermissionsSafe(null, "linux"), null);
});

test("storage programs carry no carriage returns, even from a CRLF checkout", () => {
  for (const name of ["status", "context", "dirs", "scan"]) {
    assert.doesNotMatch(buildProgram(name), /\r/, name);
  }
});