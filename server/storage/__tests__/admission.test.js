import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdmissionController } from "../admission.js";

// ─── The in-process controller ─────────────────────────────

test("one piece of storage work per Spark: a scan keeps out changes and other scans, and the other way round", () => {
  const a = new AdmissionController();
  const scan = a.admit("s1", { kind: "heavy" });
  assert.throws(() => a.admit("s1", { kind: "heavy" }), (e) => e.status === 409 && e.code === "scan-running");
  assert.throws(() => a.admit("s1", { kind: "mutation" }), (e) => e.status === 409 && e.code === "scan-running");
  // Another Spark is unaffected.
  const other = a.admit("s2", { kind: "mutation" });
  assert.throws(() => a.admit("s2", { kind: "mutation" }), (e) => e.status === 409 && e.code === "busy");
  assert.throws(() => a.admit("s2", { kind: "heavy" }), (e) => e.status === 409 && e.code === "busy");
  scan.release();
  scan.release(); // twice is harmless and never frees someone else's slot
  const next = a.admit("s1", { kind: "mutation" });
  scan.release();
  assert.throws(() => a.admit("s1", { kind: "heavy" }), (e) => e.code === "busy");
  next.release();
  other.release();
  assert.equal(a.holder("s1"), null);
});

test("at most two heavy jobs across the fleet; changes do not count against it", () => {
  const a = new AdmissionController();
  const one = a.admit("s1", { kind: "heavy" });
  a.admit("s2", { kind: "heavy" });
  assert.equal(a.heavyCount(), 2);
  assert.throws(() => a.admit("s3", { kind: "heavy" }), (e) => e.status === 429 && e.code === "fleet-busy" && /try again/i.test(e.message));
  const change = a.admit("s3", { kind: "mutation" });
  change.release();
  one.release();
  assert.doesNotThrow(() => a.admit("s3", { kind: "heavy" }).release());
  assert.equal(new AdmissionController({ fleetHeavy: 1 }).admit("x", { kind: "heavy" }) != null, true);
});

test("a holder can say why it keeps the Spark", () => {
  const a = new AdmissionController();
  let reason = "running";
  a.admit("s1", { kind: "heavy", refusal: () => ({ code: "scan-running", message: `scan ${reason}` }) });
  assert.throws(() => a.admit("s1", { kind: "mutation" }), (e) => e.status === 409 && e.message === "scan running");
  reason = "stopping";
  assert.throws(() => a.admit("s1", { kind: "heavy" }), (e) => e.message === "scan stopping");
  assert.throws(() => a.admit("s1", { kind: "other" }), /unknown work kind/);
});

// ─── The unit lock (unit-state.sh), as a real process ─────

const UNIT_STATE = new URL("../scripts/unit-state.sh", import.meta.url).pathname;
const hasFlock = (() => {
  try {
    execFileSync("sh", ["-c", "command -v flock"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const SKIP = process.platform !== "linux" ? "needs Linux /proc" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-lock-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  return { dir, home, state: path.join(home, ".local/state/sparkdash"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** `mode`: "flock" or "pidfile" (flock taken away, as on a unit without util-linux). */
const prelude = (mode) => `. '${UNIT_STATE}'; ${mode === "pidfile" ? "SD_FLOCK=''; " : ""}sd_state_init || { echo init-failed; exit 3; }; `;
const tryLock = (sb, mode) => execFileSync("sh", ["-c", `${prelude(mode)}sd_lock 0; echo "rc=$?"`], { env: { ...process.env, HOME: sb.home }, encoding: "utf8" }).trim();
const probe = (sb, mode) => execFileSync("sh", ["-c", `${prelude(mode)}sd_lock_probe`], { env: { ...process.env, HOME: sb.home }, encoding: "utf8" }).trim();

/** A holder that takes the lock and keeps it (and, with `child`, hands it to a child that outlives it). */
async function holder(sb, mode, { child = false } = {}) {
  const script = `${prelude(mode)}sd_lock 0 || exit 4; echo locked; ${child ? "setsid sleep 300 & echo child=$!; " : ""}exec sleep 300`;
  const p = spawn("sh", ["-c", script], { env: { ...process.env, HOME: sb.home }, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  for (let i = 0; i < 200 && !out.includes("locked") && (!child || !out.includes("child=")); i++) await sleep(20);
  for (let i = 0; i < 100 && child && !/child=\d+/.test(out); i++) await sleep(20);
  const childPid = Number(/child=(\d+)/.exec(out)?.[1]) || null;
  const exited = new Promise((r) => p.on("exit", r));
  return { p, childPid, exited };
}

for (const mode of ["flock", "pidfile"]) {
  const skip = SKIP || (mode === "flock" && !hasFlock && "flock is not installed");
  test(`unit lock (${mode}): a live holder keeps others out; a holder that died leaves no stale lock`, { skip }, async () => {
    const sb = sandbox();
    const h = await holder(sb, mode);
    try {
      assert.equal(tryLock(sb, mode), "rc=1");
      assert.equal(probe(sb, mode), "held");
      h.p.kill("SIGKILL");
      await h.exited;
      assert.equal(probe(sb, mode), "free");
      assert.equal(tryLock(sb, mode), "rc=0");
    } finally {
      h.p.kill("SIGKILL");
      sb.cleanup();
    }
  });
}

test("unit lock (flock): a child that outlives its parent keeps the lock until it is gone too", { skip: SKIP || (!hasFlock && "flock is not installed") }, async () => {
  const sb = sandbox();
  const h = await holder(sb, "flock", { child: true });
  try {
    assert.ok(h.childPid);
    h.p.kill("SIGKILL");
    await h.exited;
    assert.equal(tryLock(sb, "flock"), "rc=1", "the child still holds it");
    process.kill(h.childPid, "SIGKILL");
    await sleep(100);
    assert.equal(tryLock(sb, "flock"), "rc=0");
  } finally {
    try { process.kill(h.childPid, "SIGKILL"); } catch { /* gone */ }
    sb.cleanup();
  }
});

test("unit lock (pidfile): stale by another boot or by a reused pid, held while the recorded process lives", { skip: SKIP }, async () => {
  const sb = sandbox();
  const other = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    assert.equal(tryLock(sb, "pidfile"), "rc=0"); // creates the state folder; that holder has exited
    const pidf = path.join(sb.state, "storage.lock.pid");
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const start = fs.readFileSync(`/proc/${other.pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19];
    const write = (pid, st, b) => fs.writeFileSync(pidf, `PID=${pid}\nSTART=${st}\nBOOT=${b}\n`);

    write(other.pid, start, boot); // a live process with matching identity: held
    assert.equal(tryLock(sb, "pidfile"), "rc=1");
    assert.equal(probe(sb, "pidfile"), "held");
    write(other.pid, String(Number(start) + 1), boot); // same pid, other start time: the pid was reused
    assert.equal(probe(sb, "pidfile"), "free");
    assert.equal(tryLock(sb, "pidfile"), "rc=0");
    write(other.pid, start, "00000000-0000-0000-0000-000000000000"); // another boot
    assert.equal(tryLock(sb, "pidfile"), "rc=0");
    assert.equal(fs.existsSync(pidf), true, "taken over, not just removed");
  } finally {
    try { process.kill(other.pid, "SIGKILL"); } catch { /* gone */ }
    sb.cleanup();
  }
});

test("the state folder must be private: a symbolic link is refused and loose permissions are tightened", { skip: SKIP }, () => {
  const sb = sandbox();
  try {
    const init = () => execFileSync("sh", ["-c", `. '${UNIT_STATE}'; sd_state_init && echo ok || echo refused`], { env: { ...process.env, HOME: sb.home }, encoding: "utf8" }).trim();
    assert.equal(init(), "ok");
    assert.equal(fs.statSync(sb.state).mode & 0o777, 0o700);
    fs.chmodSync(sb.state, 0o755);
    assert.equal(init(), "ok");
    assert.equal(fs.statSync(sb.state).mode & 0o777, 0o700, "made private again");
    fs.rmSync(sb.state, { recursive: true });
    fs.mkdirSync(path.join(sb.dir, "elsewhere"));
    fs.symlinkSync(path.join(sb.dir, "elsewhere"), sb.state);
    assert.equal(init(), "refused");
    // No HOME at all.
    assert.equal(execFileSync("sh", ["-c", `. '${UNIT_STATE}'; HOME=; sd_state_init && echo ok || echo refused`], { encoding: "utf8" }).trim(), "refused");
  } finally {
    sb.cleanup();
  }
});
