import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AtticProbe,
  parseAtticProbe,
  ATTIC_PROBE_COMMAND,
  ATTIC_STATUS_FILE,
} from "../AtticProbe.js";

const NOW = 1793659800;

/** What atticd 0.1.0 writes to /run/spark-attic/status.json, lending 2 GiB to two clients. */
const READY = {
  name: "spark-attic",
  version: "0.1.0",
  state: "ready",
  why: "",
  driver: "580.178.04",
  mode: "heap",
  validated: true,
  validated_at: "2026-11-02T23:25:31Z",
  size_mib: 2044,
  free_mib: 0,
  largest_mib: 0,
  lent_mib: 2044,
  draining_mib: 0,
  clients: 2,
  every_s: 10,
  pid: 4711,
  updated: NOW - 4,
};

/** atticd on a driver it has no VALIDATED record for: it lends nothing. */
const UNVALIDATED = {
  ...READY,
  state: "refusing",
  why: "driver 580.196.07 has no VALIDATED artifact for heap",
  driver: "580.196.07",
  validated: false,
  validated_at: "",
  size_mib: 0,
  free_mib: 0,
  lent_mib: 0,
  clients: 0,
};

const unit = (load, active) =>
  `attic-probe unit attic.service LoadState=${load}\nattic-probe unit attic.service ActiveState=${active}`;
const RUNNING = unit("loaded", "active");
const STOPPED = unit("loaded", "inactive");
const NOT_INSTALLED = unit("not-found", "inactive");

/** The probe's output: the node's clock, the file line, then what systemd reported for the unit. */
function out({ now = NOW, file = { json: READY }, units = RUNNING } = {}) {
  const lines = [`attic-probe now ${now ?? ""}`];
  if (file === "none" || file === "unreadable") lines.push(`attic-probe file ${file}`);
  else lines.push(`attic-probe json ${typeof file.json === "string" ? file.json : JSON.stringify(file.json)}`);
  if (units) lines.push(units);
  return lines.join("\n");
}

test("parseAtticProbe reads spark-attic lending", () => {
  const p = parseAtticProbe(out());
  assert.equal(p.available, true);
  assert.equal(p.state, "lending");
  assert.deepEqual(p.attic, {
    status: "ready",
    why: null,
    version: "0.1.0",
    driver: "580.178.04",
    mode: "heap",
    validated: true,
    validatedAt: "2026-11-02T23:25:31Z",
    sizeMib: 2044,
    freeMib: 0,
    largestMib: 0,
    lentMib: 2044,
    drainingMib: 0,
    clients: 2,
    ageS: 4,
    everyS: 10,
  });
  assert.deepEqual(p.atticd, { present: true, active: true, state: "active" });
  assert.equal(p.error, null);
  assert.deepEqual(Object.keys(p).sort(), ["attic", "atticd", "available", "error", "state"]);
});

/** The probe's output on a DGX Spark under stock DGX OS 7.6.0 (driver 580.178.04), atticd 0.1.0 under attic.service
 * lending nothing, verbatim from a live run (2026-11-04). */
const DGXOS_LIVE = `attic-probe now 1793828710
attic-probe json {"name":"spark-attic","version":"0.1.0","state":"ready","why":"","driver":"580.178.04","mode":"heap","validated":true,"validated_at":"2026-11-04T17:33:44Z","size_mib":2044,"free_mib":2044,"largest_mib":2044,"lent_mib":0,"draining_mib":0,"clients":0,"every_s":10,"pid":2256,"updated":1793828705}
attic-probe unit attic.service LoadState=loaded
attic-probe unit attic.service ActiveState=active`;

test("parseAtticProbe reads a live probe from stock DGX OS: lending nothing, validated, attic.service active", () => {
  const p = parseAtticProbe(DGXOS_LIVE);
  assert.equal(p.available, true);
  assert.equal(p.state, "lending");
  assert.deepEqual(p.attic, {
    status: "ready",
    why: null,
    version: "0.1.0",
    driver: "580.178.04",
    mode: "heap",
    validated: true,
    validatedAt: "2026-11-04T17:33:44Z",
    sizeMib: 2044,
    freeMib: 2044,
    largestMib: 2044,
    lentMib: 0,
    drainingMib: 0,
    clients: 0,
    ageS: 5,
    everyS: 10,
  });
  assert.deepEqual(p.atticd, { present: true, active: true, state: "active" });
  assert.equal(p.error, null);
});

test("parseAtticProbe: lending nothing is still lending, with the numbers", () => {
  const p = parseAtticProbe(out({ file: { json: { ...READY, free_mib: 2044, largest_mib: 2044, lent_mib: 0, clients: 0 } } }));
  assert.equal(p.state, "lending");
  assert.equal(p.attic.lentMib, 0);
  assert.equal(p.attic.sizeMib, 2044);
});

test("parseAtticProbe: a refusing atticd says why", () => {
  const why = "bring-up check failed: the carveout is 0 MiB";
  const p = parseAtticProbe(out({ file: { json: { ...READY, state: "refusing", why, size_mib: 0, lent_mib: 0 } } }));
  assert.equal(p.state, "refusing");
  assert.equal(p.attic.status, "refusing");
  assert.equal(p.attic.why, why);
  assert.equal(p.attic.validated, true);
});

test("parseAtticProbe: a driver not yet validated is its own state", () => {
  const p = parseAtticProbe(out({ file: { json: UNVALIDATED } }));
  assert.equal(p.state, "unvalidated");
  assert.equal(p.attic.driver, "580.196.07");
  assert.equal(p.attic.validated, false);
  assert.equal(p.attic.validatedAt, null);
  assert.match(p.attic.why, /VALIDATED/);
  assert.equal(p.attic.lentMib, 0);
});

test("parseAtticProbe: with no driver loaded atticd refuses for that, not for validation", () => {
  const p = parseAtticProbe(out({ file: { json: { ...UNVALIDATED, driver: "none", why: "no NVIDIA driver loaded" } } }));
  assert.equal(p.state, "refusing");
  assert.equal(p.attic.driver, "none");
});

test("parseAtticProbe: a stale status file is unknown, never lending", () => {
  const fresh = parseAtticProbe(out({ file: { json: { ...READY, updated: NOW - 30 } } }));
  assert.equal(fresh.state, "lending", "three periods old is still fresh");

  for (const units of [RUNNING, NOT_INSTALLED, null]) {
    const p = parseAtticProbe(out({ file: { json: { ...READY, updated: NOW - 31 } }, units }));
    assert.equal(p.state, "unknown", String(units));
    assert.equal(p.attic.status, "stale");
    assert.equal(p.attic.ageS, 31);
    assert.equal(p.attic.everyS, 10);
    for (const k of ["lentMib", "freeMib", "sizeMib", "largestMib", "clients", "driver", "mode", "validated"]) {
      assert.equal(p.attic[k], null, `${k} is unknown in a stale file`);
    }
  }

  const future = parseAtticProbe(out({ file: { json: { ...READY, updated: NOW + 600 } } }));
  assert.equal(future.attic.status, "stale", "written far ahead of the node's clock");
  assert.equal(future.state, "unknown");
});

test("parseAtticProbe: a stale file that a stopped atticd left is off", () => {
  for (const active of ["inactive", "failed"]) {
    const p = parseAtticProbe(out({ file: { json: { ...READY, updated: NOW - 600 } }, units: unit("loaded", active) }));
    assert.equal(p.state, "off", active);
    assert.equal(p.attic.status, "stale");
    assert.deepEqual(p.atticd, { present: true, active: false, state: active });
  }
});

test("parseAtticProbe: an unreadable status file is unknown", () => {
  for (const file of ["unreadable", { json: "{not json" }, { json: "" }, { json: { ...READY, name: "other" } }]) {
    const p = parseAtticProbe(out({ file }));
    assert.equal(p.attic.status, "unreadable", JSON.stringify(file));
    assert.equal(p.state, "unknown", "the unit says active, but its file cannot be trusted");
    assert.equal(p.attic.lentMib, null);
    assert.ok(p.attic.why);
  }
  assert.equal(parseAtticProbe(out({ file: "unreadable" })).attic.why, `cannot read ${ATTIC_STATUS_FILE}`);
});

test("parseAtticProbe: no clock reading leaves the status unknown", () => {
  const p = parseAtticProbe(out({ now: null }));
  assert.equal(p.attic.status, "unknown");
  assert.equal(p.attic.lentMib, null);
  assert.equal(p.state, "unknown");
});

test("parseAtticProbe: a state atticd does not write is unknown", () => {
  const p = parseAtticProbe(out({ file: { json: { ...READY, state: "dozing" } } }));
  assert.equal(p.attic.status, "unknown");
  assert.equal(p.state, "unknown");
});

test("parseAtticProbe: no status file, by what systemd says of attic.service", () => {
  const cases = [
    [NOT_INSTALLED, "not installed", { present: false, active: false, state: "not installed" }],
    [STOPPED, "off", { present: true, active: false, state: "inactive" }],
    [unit("loaded", "failed"), "off", { present: true, active: false, state: "failed" }],
    [RUNNING, "unknown", { present: true, active: true, state: "active" }], // runs with --no-status-file
    [unit("loaded", "activating"), "unknown", { present: true, active: null, state: "activating" }],
    [null, "unknown", { present: null, active: null, state: null }], // no systemd to ask
  ];
  for (const [units, state, atticd] of cases) {
    const p = parseAtticProbe(out({ file: "none", units }));
    assert.equal(p.attic, null);
    assert.equal(p.state, state, String(units));
    assert.deepEqual(p.atticd, atticd);
  }
});

test("parseAtticProbe ignores a login banner and rejects output that is not its own", () => {
  const p = parseAtticProbe(`Welcome to DGX OS\n\n${out()}\nlast login: today`);
  assert.equal(p.state, "lending");
  assert.equal(parseAtticProbe("Welcome to DGX OS\n"), null);
  assert.equal(parseAtticProbe(""), null);
  assert.equal(parseAtticProbe(undefined), null);
});

test("parseAtticProbe drops numbers that are not counts", () => {
  const p = parseAtticProbe(out({ file: { json: { ...READY, lent_mib: -1, free_mib: "0", clients: null } } }));
  assert.equal(p.attic.status, "ready");
  assert.equal(p.attic.lentMib, null);
  assert.equal(p.attic.freeMib, null);
  assert.equal(p.attic.clients, null);
});

test("AtticProbe returns default shape with error when the command fails", async () => {
  const probe = new AtticProbe({ isLocal: true });
  probe._execLocal = async () => {
    throw new Error("ssh: connect to host 192.0.2.8 port 22: No route to host");
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.state, "unknown");
  assert.equal(snap.attic, null);
  assert.deepEqual(snap.atticd, { present: null, active: null, state: null });
  assert.match(snap.error, /No route to host/);
  probe.dispose();
});

test("AtticProbe reports unrecognised output rather than throwing, and clears it after recovery", async () => {
  const probe = new AtticProbe({ isLocal: true });
  probe._execLocal = async () => "sh: 1: syntax error";
  const bad = await probe.probe();
  assert.equal(bad.available, false);
  assert.match(bad.error, /Unrecognised/);

  probe._execLocal = async () => out();
  const ok = await probe.probe();
  assert.equal(ok.error, null);
  assert.equal(ok.state, "lending");
});

// ─── The command itself, run by real shells against a fixture tree ───────────

const hasShell = (s) => spawnSync(s, ["-c", "true"]).error == null;
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Runs ATTIC_PROBE_COMMAND with /run/spark-attic moved under a temp root and a
 * stand-in systemctl that answers for attic.service from FAKE_ATTICD
 * ("load:active"; unset: no systemd, nothing printed).
 */
function runCommand(shell, { status, mode, dirMode, atticd }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attic-probe-"));
  try {
    const dir = path.join(root, path.dirname(ATTIC_STATUS_FILE));
    fs.mkdirSync(dir, { recursive: true });
    if (status !== undefined) {
      const file = path.join(root, ATTIC_STATUS_FILE);
      fs.writeFileSync(file, typeof status === "string" ? status : JSON.stringify(status) + "\n");
      if (mode !== undefined) fs.chmodSync(file, mode);
    }
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        'case "$6" in attic.service) s=$FAKE_ATTICD ;; esac',
        '[ -n "$s" ] || exit 1',
        "printf 'LoadState=%s\\nActiveState=%s\\n' \"${s%%:*}\" \"${s#*:}\"",
      ].join("\n"),
      { mode: 0o755 }
    );
    if (dirMode !== undefined) fs.chmodSync(dir, dirMode);
    const cmd = ATTIC_PROBE_COMMAND.replaceAll(path.dirname(ATTIC_STATUS_FILE), dir);
    const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_ATTICD: atticd ?? "" };
    const r = spawnSync(shell, ["-c", cmd], { env, encoding: "utf8" });
    if (dirMode !== undefined) fs.chmodSync(dir, 0o755);
    return r;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The SSH user's login shell may be any of these (zsh aborts on an unmatched glob; the command has none).
for (const shell of ["sh", "bash", "zsh"]) {
  test(`the probe command under ${shell}: atticd lending, from the file`, { skip: !hasShell(shell) }, () => {
    const now = Math.floor(Date.now() / 1000);
    const r = runCommand(shell, { status: { ...READY, updated: now }, atticd: "loaded:active" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const p = parseAtticProbe(r.stdout);
    assert.equal(p.state, "lending");
    assert.equal(p.attic.status, "ready");
    assert.equal(p.attic.lentMib, 2044);
    assert.deepEqual(p.atticd, { present: true, active: true, state: "active" });
  });
}

test("the probe command: spark-attic not installed", () => {
  const p = parseAtticProbe(runCommand("sh", { atticd: "not-found:inactive" }).stdout);
  assert.equal(p.state, "not installed");
  assert.equal(p.attic, null);
});

test("the probe command: attic.service stopped", () => {
  const p = parseAtticProbe(runCommand("sh", { atticd: "loaded:inactive" }).stdout);
  assert.equal(p.state, "off");
});

test("the probe command: no systemd to ask and no status file", () => {
  const r = runCommand("sh", {});
  assert.equal(r.status, 0);
  const p = parseAtticProbe(r.stdout);
  assert.equal(p.available, true);
  assert.equal(p.state, "unknown");
});

test("the probe command reads at most 4 KiB of the file, on one line", () => {
  const r = runCommand("sh", { status: "x".repeat(10000) + "\n" + "y".repeat(10), atticd: "loaded:active" });
  const line = r.stdout.split("\n").find((l) => l.startsWith("attic-probe json "));
  assert.equal(line.length, "attic-probe json ".length + 4096);
  assert.equal(parseAtticProbe(r.stdout).attic.status, "unreadable");
});

test("the probe command: a status file this user may not read", { skip: asRoot && "root reads every file" }, () => {
  const file = runCommand("sh", { status: READY, mode: 0o000, atticd: "loaded:active" });
  assert.equal(parseAtticProbe(file.stdout).attic.status, "unreadable");
  const dir = runCommand("sh", { status: READY, dirMode: 0o000, atticd: "loaded:active" });
  assert.equal(parseAtticProbe(dir.stdout).attic.status, "unreadable", "a directory it may not search");
});
