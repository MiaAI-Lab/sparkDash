import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { buildProgram, parseContextOutput, parseDockerListOutput, parseStatusOutput } from "../commands.js";
import { FEATURES, classifyContext, featureTable, supports, transportOf } from "../context.js";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";

const BOOT = "f1a8e17a-97f7-4384-afb7-3e7fddba0acb";
const answer = (over = {}) => {
  const v = {
    UID: "1000", ACCOUNT: "me", HOME: "/home/me", ACCOUNT_HOME: "/home/me", HOSTNAME: "spark-1", BOOT_ID: BOOT,
    NS_MNT: "4026531832", NS_PID: "4026531836", NS_USER: "4026531837", NS_NET: "4026531833", NS_CGROUP: "4026531835", NS_UTS: "4026531838",
    INIT_NS_MNT: "", INIT_NS_PID: "", IN_CONTAINER: "0",
    SYSTEMD_RUN: "yes", LINGER: "yes", PERL: "yes", FINDMNT: "yes", DOCKER: "yes", SETSID: "yes", FLOCK: "yes", BUILDX: "no", SUDO: "no",
    ...over,
  };
  return ["RESULT=ok", ...Object.entries(v).map(([k, x]) => `${k}=${x}`)].join("\n");
};

test("parseContextOutput reads the probe and derives the capability list", () => {
  const r = parseContextOutput(answer());
  assert.equal(r.ok, true);
  assert.equal(r.uid, 1000);
  assert.equal(r.account, "me");
  assert.equal(r.home, "/home/me");
  assert.equal(r.hostname, "spark-1");
  assert.equal(r.bootId, BOOT);
  assert.equal(r.namespaces.pid, "4026531836");
  assert.equal(r.hostPidNs, null, "PID 1 unreadable (not root): unknown, not a guess");
  assert.equal(r.sudo, "no");
  assert.equal(r.linger, "yes");
  assert.deepEqual(r.capabilities.sort(), ["account-home", "docker", "findmnt", "flock", "linger", "perl", "setsid", "systemd-run"].sort());
});

test("parseContextOutput: root in a container that shares the host PID namespace", () => {
  const r = parseContextOutput(answer({ UID: "0", ACCOUNT: "root", HOME: "/root", ACCOUNT_HOME: "/root", INIT_NS_PID: "4026531836", INIT_NS_MNT: "4026531832", SUDO: "no" }));
  assert.equal(r.sudo, "root", "uid 0 is root whatever the sudo line says");
  assert.equal(r.hostPidNs, true);
  assert.ok(r.capabilities.includes("root"));
  assert.ok(r.capabilities.includes("host-pid-ns"));
  const own = parseContextOutput(answer({ UID: "0", INIT_NS_PID: "4026532999" }));
  assert.equal(own.hostPidNs, false);
  assert.ok(!own.capabilities.includes("host-pid-ns"));
});

test("parseContextOutput is tolerant: malformed or missing lines read as unknown or absent, never present", () => {
  const r = parseContextOutput("RESULT=ok\nUID=abc\nHOME=relative/path\nHOSTNAME=bad host!\nBOOT_ID=xyz\nNS_PID=pid:[1]\nPERL=maybe\nLINGER=sometimes\nSUDO=yes\n");
  assert.equal(r.ok, true);
  assert.equal(r.uid, null);
  assert.equal(r.home, null);
  assert.equal(r.hostname, null);
  assert.equal(r.bootId, null);
  assert.equal(r.namespaces.pid, null);
  assert.equal(r.linger, "unknown");
  assert.equal(r.tools.perl, false);
  assert.deepEqual(r.capabilities, ["sudo-n"]);
  assert.equal(parseContextOutput("RESULT=error\nCODE=no-sh\nMSG=sh is not installed").code, "no-sh");
  assert.equal(parseContextOutput("garbage").ok, false);
  assert.ok(!parseContextOutput(answer({ HOME: "/root" })).capabilities.includes("account-home"), "HOME that is not the account's own");
});

/** A PATH where sudo, docker and systemd-run are harmless fakes: the test never runs the real ones. */
function fakeTools({ sudoOk = false, buildx = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-bin-"));
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write("sudo", sudoOk ? "exit 0" : "exit 1");
  write("docker", `[ "$1 $2" = "buildx version" ] && exit ${buildx ? 0 : 1}; exit 1`);
  write("systemd-run", '[ "$1 $2" = "--user --version" ] && { echo "systemd 255"; exit 0; }; exit 1');
  return bin;
}

test("the real context program runs as this account and reports what this machine has", () => {
  const bin = fakeTools({ sudoOk: true });
  try {
    const out = execFileSync("/bin/sh", ["-c", buildProgram("context")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const r = parseContextOutput(out);
    assert.equal(r.ok, true);
    assert.equal(r.uid, process.getuid());
    assert.equal(r.account, os.userInfo().username);
    assert.equal(r.home, process.env.HOME);
    assert.equal(r.accountHome, os.userInfo().homedir);
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    assert.equal(r.bootId, boot);
    assert.equal(r.namespaces.pid, fs.readlinkSync("/proc/self/ns/pid").replace(/\D/g, ""));
    assert.equal(r.sudo, process.getuid() === 0 ? "root" : "yes", "the fake sudo answers");
    assert.equal(r.tools.docker, true);
    assert.equal(r.tools.buildx, true);
    assert.equal(r.tools["systemd-run"], true);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("the real context program says 'no' for tools that are not on the PATH", () => {
  // Only what the program itself needs; perl, findmnt, docker, sudo and friends are missing.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-min-"));
  const need = ["sh", "base64", "id", "tr", "cut", "head", "awk", "cat", "readlink", "hostname", "timeout"];
  try {
    for (const name of need) {
      const real = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (real) fs.symlinkSync(real, path.join(bin, name));
    }
    const out = execFileSync("/bin/sh", ["-c", buildProgram("context")], { encoding: "utf8", env: { HOME: process.env.HOME, PATH: bin } });
    const r = parseContextOutput(out);
    assert.equal(r.ok, true);
    assert.equal(r.uid, process.getuid());
    for (const t of ["perl", "findmnt", "docker", "buildx", "systemd-run", "setsid", "flock"]) assert.equal(r.tools[t], false, t);
    assert.ok(!r.capabilities.some((c) => ["perl", "docker", "systemd-run", "sudo-n"].includes(c)));
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("transport and classification follow runProgram's choice", () => {
  assert.equal(transportOf({ isLocal: false }, () => "/host/proc/1/ns/mnt"), "ssh");
  assert.equal(transportOf({ isLocal: true }, () => "/host/proc/1/ns/mnt"), "nsenter");
  assert.equal(transportOf({ isLocal: true }, () => null), "local");
  assert.equal(classifyContext("ssh", { inContainer: true }), "ssh");
  assert.equal(classifyContext("nsenter", {}), "container-local");
  assert.equal(classifyContext("local", { inContainer: false }), "native-local");
  assert.equal(classifyContext("local", { inContainer: true }), "container-local", "a child process inside a container does not see the Spark's files");
});

test("supports(): features are offered or refused with a reason", () => {
  const ctx = (kind, caps, account = "me") => ({ kind, capabilities: caps, account });
  for (const f of ["analyse", "delete"]) assert.deepEqual(supports(f, null), { supported: true, reason: null }, f);
  assert.match(supports("docker", null).reason, /not been checked/);
  assert.equal(supports("docker", ctx("ssh", ["docker"])).supported, true);
  assert.match(supports("docker", ctx("ssh", [])).reason, /Docker is not installed/);
  assert.match(supports("docker-buildx", ctx("ssh", ["docker"])).reason, /buildx/);
  assert.equal(supports("admin-without-password", ctx("container-local", ["root"])).supported, true);
  assert.match(supports("admin-without-password", ctx("ssh", [])).reason, /asks for a password/);
  assert.equal(supports("verified-cancel", ctx("ssh", [])).supported, true);
  assert.equal(supports("verified-cancel", ctx("container-local", ["root", "host-pid-ns"])).supported, true);
  assert.match(supports("verified-cancel", ctx("container-local", ["root"])).reason, /best effort/);
  // Supervised jobs: never in a container, and never before a real transient-unit test exists.
  assert.match(supports("supervised-jobs", ctx("container-local", ["systemd-run", "linger"])).reason, /container/);
  assert.match(supports("supervised-jobs", ctx("ssh", ["systemd-run"], "zurih")).reason, /Lingering is off for zurih/);
  assert.match(supports("supervised-jobs", ctx("ssh", ["systemd-run", "linger"])).reason, /has not been tested/);
  assert.match(supports("nonsense", ctx("ssh", [])).reason, /Unknown feature/);
  assert.deepEqual(Object.keys(featureTable(null)), Object.keys(FEATURES));
});

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", isLocal: false, ssh: { user: "me", host: "10.0.0.5" } };

function manager({ answers, now, transport = () => "ssh" } = {}) {
  const calls = [];
  const clock = now ?? { t: 1_000_000 };
  const m = new StorageManager({
    run: async (_s, program) => {
      calls.push(program);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => clock.t,
    holdMs: 0,
    context: { transport },
  });
  return { m, calls, clock };
}

test("context() probes once, caches the answer, and contextOf() never probes", async () => {
  const { m, calls, clock } = manager({ answers: [answer(), answer()] });
  assert.equal(m.contextOf(spark), null);
  const [a, b] = await Promise.all([m.context(spark), m.context(spark)]);
  assert.equal(calls.length, 1, "concurrent callers share one probe");
  assert.equal(a, b);
  assert.equal(a.kind, "ssh");
  assert.equal(a.transport, "ssh");
  assert.equal(a.account, "me");
  assert.equal(m.contextOf(spark), a);
  clock.t += 9 * 60_000;
  await m.context(spark);
  assert.equal(calls.length, 1, "still fresh");
  clock.t += 2 * 60_000;
  assert.equal(m.contextOf(spark), null, "expired");
  await m.context(spark);
  assert.equal(calls.length, 2, "probed again after the TTL");
});

test("a failed probe is remembered only briefly", async () => {
  const down = Object.assign(new Error("ssh: connect timed out"), {});
  const { m, calls, clock } = manager({ answers: [down, answer()] });
  await assert.rejects(m.context(spark), (e) => e.status === 502 && e.code === "unreachable");
  await assert.rejects(m.context(spark), (e) => e.code === "unreachable");
  assert.equal(calls.length, 1, "the failure is reused for a few seconds");
  clock.t += 16_000;
  assert.equal((await m.context(spark)).account, "me");
  assert.equal(calls.length, 2);
});

test("a different account or host, a reboot, or an unreachable Spark drops the cached context", async () => {
  const status = (boot) => `RESULT=ok\nUSER=me\nBOOT_ID=${boot}\nSUDO=no\nDOCKER=ok\nDOCKER_ROOT=/var/lib/docker\n`;
  const other = "0b0b0b0b-1111-2222-3333-444444444444";
  const { m, calls } = manager({ answers: [answer(), answer({ ACCOUNT: "you" }), status(BOOT), status(other), answer({ BOOT_ID: other }), new Error("ssh: no route"), answer()] });
  await m.context(spark);
  const moved = { ...spark, ssh: { user: "you", host: "10.0.0.5" } };
  assert.equal(m.contextOf(moved), null, "cached for another account");
  assert.equal((await m.context(moved)).account, "you");
  assert.equal(calls.length, 2);
  // Same boot: the cache stays. New boot id: it is dropped.
  const s1 = await m.status(moved);
  assert.equal(s1.bootId, undefined, "the boot id stays on the server");
  assert.ok(m.contextOf(moved));
  await m.status(moved);
  assert.equal(m.contextOf(moved), null, "rebooted since the probe");
  assert.equal((await m.context(moved)).bootId, other);
  await assert.rejects(m.status(moved), (e) => e.code === "unreachable");
  assert.equal(m.contextOf(moved), null, "unreachable: probe again next time");
  await m.context(moved);
  assert.equal(calls.length, 7);
});

test("the local container path is classified as container-local", async () => {
  const local = { ...spark, isLocal: true };
  const { m } = manager({ answers: [answer({ UID: "0", ACCOUNT: "root", HOME: "/root", ACCOUNT_HOME: "/root", INIT_NS_PID: "4026531836" })], transport: () => "nsenter" });
  const ctx = await m.context(local);
  assert.equal(ctx.kind, "container-local");
  assert.equal(ctx.transport, "nsenter");
  assert.equal(ctx.hostPidNs, true);
  assert.equal(supports("verified-cancel", ctx).supported, true, "the container shares the host's PID namespace");
  assert.equal(supports("supervised-jobs", ctx).supported, false);
});

test("the context program is never run as administrator", async () => {
  const { m, calls } = manager({ answers: [answer()] });
  await m.context(spark);
  const lines = calls[0].split("\n");
  assert.ok(lines.includes('SUDO=""'));
  assert.ok(!lines.some((l) => l.startsWith('[ "$(id -u)" = 0 ] || SUDO=')), "no sudo prefix is ever set");
});

test("status() reads the boot id; docker images say whether a registry digest is recorded", () => {
  assert.equal(parseStatusOutput(`RESULT=ok\nUSER=me\nBOOT_ID=${BOOT}\n`).bootId, BOOT);
  assert.equal(parseStatusOutput("RESULT=ok\nUSER=me\n").bootId, null);
  const A = `sha256:${"a".repeat(64)}`;
  const B = `sha256:${"b".repeat(64)}`;
  const C = `sha256:${"c".repeat(64)}`;
  const r = parseDockerListOutput(["RESULT=ok", `IMG=${A}|30|2026-10-01T00:00:00Z|mine:dev|0`, `IMG=${B}|20|2026-10-01T00:00:00Z|nvcr.io/x:1,x:latest|2`, `IMG=${C}|10|2026-10-01T00:00:00Z|old:1`].join("\n"));
  assert.deepEqual(r.images.map((i) => [i.tags[0], i.registryDigest]), [["mine:dev", false], ["nvcr.io/x:1", true], ["old:1", null]]);
  assert.deepEqual(r.images[1].tags, ["nvcr.io/x:1", "x:latest"], "the new field does not leak into the tags");
});

test("GET /storage/context answers with the context and the feature table; a cached answer is not rate limited", async () => {
  let reads = 0;
  const { m, calls } = manager({ answers: [answer()] });
  const app = express();
  registerStorageRoutes(app, {
    manager: m,
    registry: { getSpark: (id) => ({ s1: spark, h1: { id: "h1", kind: "host" } })[id] },
    recordEvent: () => {},
    allowRead: () => (reads += 1) <= 2,
    allowChange: () => true,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    const first = await fetch(`${base}/s1/storage/context`);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.kind, "ssh");
    assert.equal(body.features.docker.supported, true);
    assert.equal(body.features["supervised-jobs"].supported, false);
    assert.ok(body.features["supervised-jobs"].reason);
    const again = await fetch(`${base}/s1/storage/context`);
    assert.equal(again.status, 200, "served from the cache without spending the limiter");
    assert.equal(calls.length, 1);
    assert.equal(reads, 1);
    assert.equal((await fetch(`${base}/h1/storage/context`)).status, 400, "hosts are not supported");
    assert.equal((await fetch(`${base}/s1/storage/context?refresh=1`)).status, 429, "a forced probe is limited");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
