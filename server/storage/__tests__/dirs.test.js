import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseDirsOutput, parseStatusOutput } from "../commands.js";

const runHere = (name, args = []) => execFileSync("sh", ["-c", buildProgram(name, { args })], { encoding: "utf8" });

test("dirs.sh lists real folders only, not files or symbolic links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-dirs-"));
  try {
    fs.mkdirSync(path.join(root, "models"));
    fs.mkdirSync(path.join(root, ".cache"));
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    fs.symlinkSync(root, path.join(root, "loop"));
    const res = parseDirsOutput(runHere("dirs", [root]));
    assert.deepEqual(res.dirs, [".cache", "models"]);
    assert.equal(res.more, false);
    assert.equal(parseDirsOutput(runHere("dirs", [path.join(root, "nope")])).code, "not-found");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status.sh reports this account's home and people's homes under /home", () => {
  const res = parseStatusOutput(runHere("status"));
  assert.equal(res.ok, true);
  assert.equal(res.homeDir, os.userInfo().homedir);
  for (const h of res.peopleHomes) assert.match(h, /^\/home\/[^/]+$/);
});

test("the status parser keeps only plausible home paths", () => {
  const res = parseStatusOutput("RESULT=ok\nUSER=root\nSUDO=root\nHOME_DIR=/root\nPEOPLE_HOME=/home/zurih\nPEOPLE_HOME=/home/a/b\nPEOPLE_HOME=/etc\nDOCKER=ok\n");
  assert.equal(res.homeDir, "/root");
  assert.deepEqual(res.peopleHomes, ["/home/zurih"]);
  assert.equal(parseStatusOutput("RESULT=ok\nUSER=x\nSUDO=no\nHOME_DIR=relative\nDOCKER=ok\n").homeDir, null);
});
