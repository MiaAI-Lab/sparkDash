import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHeadlessProbe,
  HEADLESS_PROBE_COMMAND,
  HEADLESS_UNITS,
  DISPLAY_MANAGER_UNIT,
} from "../HeadlessProbe.js";

/** A desktop unit: graphical boot default, display manager active, gnome-shell and Xorg resident. */
const DESKTOP = [
  "headless-probe default graphical.target",
  "headless-probe dm Id=display-manager.service",
  "headless-probe dm LoadState=loaded",
  "headless-probe dm ActiveState=active",
  "headless-probe proc gnome-shell 108544 0",
  "headless-probe proc Xorg 12800 0",
  "headless-probe proc gdm-session-wor 4096 -",
  "headless-probe unit cups.service LoadState=loaded",
  "headless-probe unit cups.service ActiveState=active",
  "headless-probe unit cups.service UnitFileState=enabled",
  "headless-probe unit cups.socket LoadState=loaded",
  "headless-probe unit cups.socket ActiveState=inactive",
  "headless-probe unit cups.socket UnitFileState=enabled",
  "headless-probe unit bluetooth.service LoadState=loaded",
  "headless-probe unit bluetooth.service ActiveState=inactive",
  "headless-probe unit bluetooth.service UnitFileState=disabled",
  "headless-probe unit colord.service LoadState=loaded",
  "headless-probe unit colord.service ActiveState=active",
  "headless-probe unit colord.service UnitFileState=static",
  "headless-probe unit kerneloops.service LoadState=not-found",
  "headless-probe unit kerneloops.service ActiveState=inactive",
  "headless-probe unit kerneloops.service UnitFileState=",
].join("\n");

test("reads a running desktop, its memory and the optional services", () => {
  const p = parseHeadlessProbe(DESKTOP);
  assert.equal(p.available, true);
  assert.equal(p.state, "desktop");
  assert.equal(p.defaultTarget, "graphical.target");
  assert.deepEqual(p.displayManager, {
    unit: DISPLAY_MANAGER_UNIT,
    present: true,
    active: true,
    enabled: null,
    state: "active",
  });
  assert.deepEqual(p.desktop.processes, [
    { name: "gnome-shell", rssMib: 106, swapMib: 0 },
    { name: "Xorg", rssMib: 12.5, swapMib: 0 },
    { name: "gdm-session-wor", rssMib: 4, swapMib: null },
  ]);
  assert.equal(p.desktop.rssMib, 122.5);
  // One unreadable VmSwap makes the total unknown, not smaller.
  assert.equal(p.desktop.swapMib, null);
  assert.equal(p.units.length, HEADLESS_UNITS.length);
  assert.deepEqual(p.units.find((u) => u.unit === "cups.service"), {
    unit: "cups.service",
    present: true,
    active: true,
    enabled: true,
    state: "active",
  });
  assert.deepEqual(p.units.find((u) => u.unit === "bluetooth.service"), {
    unit: "bluetooth.service",
    present: true,
    active: false,
    enabled: false,
    state: "inactive",
  });
  // static is neither enabled nor disabled.
  assert.equal(p.units.find((u) => u.unit === "colord.service").enabled, null);
  assert.deepEqual(p.units.find((u) => u.unit === "kerneloops.service"), {
    unit: "kerneloops.service",
    present: false,
    active: false,
    enabled: false,
    state: "not installed",
  });
  // Units the probe did not report stay unknown.
  assert.deepEqual(p.units.find((u) => u.unit === "cups-browsed.service"), {
    unit: "cups-browsed.service",
    present: null,
    active: null,
    enabled: null,
    state: null,
  });
});

test("reads a headless unit: multi-user boot default, no display manager, no desktop processes", () => {
  const p = parseHeadlessProbe(
    [
      "headless-probe default multi-user.target",
      "headless-probe dm Id=display-manager.service",
      "headless-probe dm LoadState=loaded",
      "headless-probe dm ActiveState=inactive",
    ].join("\n")
  );
  assert.equal(p.state, "headless");
  assert.equal(p.defaultTarget, "multi-user.target");
  assert.equal(p.displayManager.active, false);
  assert.deepEqual(p.desktop, { processes: [], rssMib: null, swapMib: null });
});

test("reads a mixed unit: multi-user boot default but the desktop still runs until reboot", () => {
  const p = parseHeadlessProbe(
    [
      "headless-probe default multi-user.target",
      "headless-probe dm LoadState=loaded",
      "headless-probe dm ActiveState=active",
      "headless-probe proc gnome-shell 108544 0",
    ].join("\n")
  );
  assert.equal(p.state, "mixed");
  assert.equal(p.desktop.rssMib, 106);
});

test("a stopped display manager on a graphical boot default is unknown, not headless", () => {
  const p = parseHeadlessProbe(
    ["headless-probe default graphical.target", "headless-probe dm LoadState=loaded", "headless-probe dm ActiveState=inactive"].join("\n")
  );
  assert.equal(p.state, "unknown");
});

test("a desktop process with no display-manager answer still counts as a running desktop", () => {
  const p = parseHeadlessProbe(
    ["headless-probe default graphical.target", "headless-probe proc Xorg 12800 0"].join("\n")
  );
  assert.equal(p.state, "desktop");
  assert.equal(p.displayManager.active, null);
});

test("no boot default is unknown", () => {
  const p = parseHeadlessProbe("headless-probe default ");
  assert.equal(p.state, "unknown");
  assert.equal(p.defaultTarget, null);
});

test("an unrecognised target is unknown", () => {
  const p = parseHeadlessProbe(
    ["headless-probe default rescue.target", "headless-probe dm LoadState=loaded", "headless-probe dm ActiveState=active"].join("\n")
  );
  assert.equal(p.state, "unknown");
});

test("a login banner is not data, and no probe line at all is null", () => {
  assert.equal(parseHeadlessProbe("Welcome to Ubuntu 24.04 LTS\nLast login: Mon Nov 17"), null);
  assert.equal(parseHeadlessProbe(""), null);
  assert.equal(parseHeadlessProbe(undefined), null);
});

test("the probe command is read-only and asks only about allow-listed units", () => {
  assert.match(HEADLESS_PROBE_COMMAND, /systemctl get-default/);
  assert.match(HEADLESS_PROBE_COMMAND, /systemctl show -p LoadState -p ActiveState -p UnitFileState/);
  assert.ok(!/set-default|disable|stop |enable |start /.test(HEADLESS_PROBE_COMMAND));
  for (const unit of HEADLESS_UNITS) assert.ok(HEADLESS_PROBE_COMMAND.includes(unit), unit);
  for (const forbidden of ["snapd", "NetworkManager", "ssh.service", "docker", "tailscale", "nvidia"]) {
    assert.ok(!HEADLESS_PROBE_COMMAND.includes(forbidden), forbidden);
  }
});
