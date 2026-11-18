// Runs the real generated make and restore programs under `sh` against a stub
// `systemctl` and `sudo` that keep their state in a temporary directory. This is
// what proves the undo record: the string tests next door only see program text.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeHeadlessProgram, restoreProgram, parseHeadlessResult } from "../headless/actions.js";

const SYSTEMCTL = `#!/bin/sh
SB="$SANDBOX"
case "$1" in
  get-default) cat "$SB/default" ;;
  set-default)
    [ -e "$SB/fail-set-default" ] && exit 1
    echo "$2" > "$SB/default"
    echo x >> "$SB/set-default.calls" ;;
  show)
    prop="$3"; unit="$4"
    # systemctl show -p Prop unit
    case "$prop" in
      ActiveState) f="$SB/$unit.as" ;;
      UnitFileState) f="$SB/$unit.ufs" ;;
    esac
    [ -f "$f" ] && echo "$prop=$(cat "$f")"
    exit 0 ;;
  is-active) [ "$(cat "$SB/$3.as" 2>/dev/null)" = active ] ;;
  stop)
    [ -e "$SB/fail-stop-$2" ] && exit 1
    echo inactive > "$SB/$2.as" ;;
  start)
    [ -e "$SB/fail-start-$2" ] && exit 1
    echo active > "$SB/$2.as" ;;
  disable)
    echo disabled > "$SB/$3.ufs"
    echo inactive > "$SB/$3.as" ;;
  enable) echo enabled > "$SB/$2.ufs" ;;
  *) exit 0 ;;
esac
`;

// Runs whatever follows the sudo options, as the real program would after sudo.
const SUDO = `#!/bin/sh
while [ "\${1#-}" != "$1" ]; do
  case "$1" in -p) shift ;; esac
  shift
done
exec "$@"
`;

const DM = "display-manager.service";

/**
 * A unit that boots to the desktop: graphical default, an active display
 * manager, and cups and bluetooth enabled and running.
 */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const sb = path.join(root, "sys");
  fs.mkdirSync(bin);
  fs.mkdirSync(sb);
  fs.writeFileSync(path.join(bin, "systemctl"), SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sudo"), SUDO, { mode: 0o755 });
  const put = (name, value) => fs.writeFileSync(path.join(sb, name), `${value}\n`);
  put("default", "graphical.target");
  put(`${DM}.as`, "active");
  for (const unit of ["cups.service", "bluetooth.service"]) {
    put(`${unit}.ufs`, "enabled");
    put(`${unit}.as`, "active");
  }
  const stateDir = path.join(root, "state");
  const run = (program) => {
    const res = spawnSync("sh", ["-c", program], {
      env: { PATH: `${bin}:${process.env.PATH}`, SANDBOX: sb, HOME: root },
      encoding: "utf8",
    });
    return { status: res.status, out: res.stdout, err: res.stderr, result: parseHeadlessResult(res.stdout) };
  };
  return {
    stateDir,
    stateFile: path.join(stateDir, "state"),
    make: (units) => run(makeHeadlessProgram(units, { stateDir })),
    restore: () => run(restoreProgram({ stateDir })),
    read: (name) => fs.readFileSync(path.join(sb, name), "utf8").trim(),
    flag: (name) => fs.writeFileSync(path.join(sb, name), "1\n"),
    unflag: (name) => fs.rmSync(path.join(sb, name), { force: true }),
    setDefaultCalls: () => {
      const f = path.join(sb, "set-default.calls");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").length : 0;
    },
    root,
  };
}

test("make then restore puts back the boot default, the services and the display manager", (t) => {
  const s = sandbox(t);
  const made = s.make(["cups.service"]);
  assert.equal(made.status, 0, made.err);
  assert.equal(s.read("default"), "multi-user.target");
  assert.equal(s.read(`${DM}.as`), "inactive");
  assert.equal(s.read("cups.service.ufs"), "disabled");
  assert.deepEqual(made.result.disabled, ["cups.service"]);
  assert.match(fs.readFileSync(s.stateFile, "utf8"), /^default_target=graphical\.target$/m);

  const restored = s.restore();
  assert.equal(restored.status, 0, restored.err);
  assert.equal(s.read("default"), "graphical.target");
  assert.equal(s.read("cups.service.ufs"), "enabled");
  assert.equal(s.read("cups.service.as"), "active");
  assert.equal(s.read(`${DM}.as`), "active");
  assert.deepEqual(restored.result.failed, []);
  assert.equal(restored.result.defaultAfter, "graphical.target");
  assert.equal(fs.existsSync(s.stateFile), false, "a finished restore removes its record");
});

test("a second make keeps the first record and adds its own services, so restore still undoes both", (t) => {
  const s = sandbox(t);
  // The first run changes the boot default, then cannot stop the display manager.
  s.flag(`fail-stop-${DM}`);
  const first = s.make(["cups.service"]);
  assert.notEqual(first.status, 0);
  assert.equal(s.read("default"), "multi-user.target", "the unit is now in the mixed state");

  // Retrying from the mixed state used to overwrite the record with multi-user.target.
  s.unflag(`fail-stop-${DM}`);
  const second = s.make(["bluetooth.service"]);
  assert.equal(second.status, 0, second.err);
  const record = fs.readFileSync(s.stateFile, "utf8");
  assert.match(record, /^default_target=graphical\.target$/m);
  assert.match(record, /^unit cups\.service enabled active$/m);
  assert.match(record, /^unit bluetooth\.service enabled active$/m);

  const restored = s.restore();
  assert.equal(restored.status, 0, restored.err);
  assert.equal(s.read("default"), "graphical.target");
  for (const unit of ["cups.service", "bluetooth.service"]) {
    assert.equal(s.read(`${unit}.ufs`), "enabled", unit);
    assert.equal(s.read(`${unit}.as`), "active", unit);
  }
  assert.equal(s.read(`${DM}.as`), "active");
});

test("a unit already in the record is not recorded again with its changed state", (t) => {
  const s = sandbox(t);
  assert.equal(s.make(["cups.service"]).status, 0);
  // cups is now disabled and inactive; a second make that ticks it again must not
  // replace the enabled/active entry the restore depends on.
  assert.equal(s.make(["cups.service"]).status, 0);
  const lines = fs.readFileSync(s.stateFile, "utf8").split("\n").filter((l) => l.startsWith("unit cups.service"));
  assert.deepEqual(lines, ["unit cups.service enabled active"]);
});

test("when the record cannot be written, nothing is changed", (t) => {
  const s = sandbox(t);
  // A state directory under a regular file cannot be created.
  const blocker = path.join(s.root, "blocker");
  fs.writeFileSync(blocker, "x");
  const res = spawnSync("sh", ["-c", makeHeadlessProgram(["cups.service"], { stateDir: path.join(blocker, "sub") })], {
    env: { PATH: `${path.join(s.root, "bin")}:${process.env.PATH}`, SANDBOX: path.join(s.root, "sys"), HOME: s.root },
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0);
  assert.equal(s.read("default"), "graphical.target");
  assert.equal(s.setDefaultCalls(), 0, "the boot default must not change without an undo record");
  assert.equal(s.read("cups.service.ufs"), "enabled");
});

test("a restore that cannot start the display manager reports it and keeps the record for a retry", (t) => {
  const s = sandbox(t);
  assert.equal(s.make(["cups.service"]).status, 0);
  s.flag(`fail-start-${DM}`);
  const restored = s.restore();
  assert.deepEqual(restored.result.failed, [DM]);
  assert.equal(fs.existsSync(s.stateFile), true, "the record stays so restore can be run again");
  assert.equal(restored.result.defaultAfter, "graphical.target");

  s.unflag(`fail-start-${DM}`);
  const again = s.restore();
  assert.deepEqual(again.result.failed, []);
  assert.equal(s.read(`${DM}.as`), "active");
  assert.equal(fs.existsSync(s.stateFile), false);
});

test("restore with no record only puts the boot default back", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.root, "sys", "default"), "multi-user.target\n");
  const restored = s.restore();
  assert.equal(restored.status, 0, restored.err);
  assert.equal(restored.result.mode, "default-only");
  assert.equal(s.read("default"), "graphical.target");
  assert.equal(s.read("cups.service.ufs"), "enabled", "nothing else is touched");
});

test("a state directory that could carry shell text is refused", () => {
  assert.throws(() => makeHeadlessProgram([], { stateDir: "/tmp/x; rm -rf /" }), /unsafe headless state directory/);
  assert.throws(() => restoreProgram({ stateDir: "/var/lib/../etc" }), /unsafe headless state directory/);
});
