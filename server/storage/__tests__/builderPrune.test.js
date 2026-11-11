// Docker build cache clean-up (Quick clean-up): the unit program runs against a fake `docker` on PATH that logs every
// call, so the exact command line is checked and nothing real is ever pruned. Also the request validation, the
// manager method, the route, and the containers' optional "finished at" field the age rule relies on.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { buildProgram, parseDockerListOutput } from "../commands.js";
import { parseBuilderPruneOutput, parseOlderThanDays, reclaimedNote } from "../builderPrune.js";
import { StorageManager } from "../StorageManager.js";
import { registerStorageRoutes } from "../routes.js";

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };

/**
 * A fake docker. MODE=buildx: `docker builder` is the buildx plugin (its help offers --builder); MODE=daemon: no
 * buildx. FAIL names steps that fail like a daemon error: info-down, info-denied, help, context, inspect, prune.
 * CTX: what `docker context show` prints. DRIVER: the inspected builder's driver.
 */
function fakeDocker() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakebuilder-"));
  const log = path.join(bin, "calls");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${log}"
fail() { case " $FAIL " in *" $1 "*) echo "Error response from daemon: $1 failed" >&2; exit 1 ;; esac; }
case "$1 $2" in
  "info --format")
    case " $FAIL " in *" info-denied "*) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1 ;; esac
    fail info-down; echo /var/lib/docker ;;
  "builder prune")
    case "$*" in
      *--help*)
        fail help
        if [ "$MODE" = buildx ]; then printf 'Usage:  docker buildx prune\\n      --builder string   Override the configured builder instance\\n'
        else printf 'Usage:  docker builder prune\\n  -a, --all   Remove all unused build cache\\n'; fi ;;
      *)
        fail prune
        if [ "$MODE" = buildx ]; then printf 'ID\\tRECLAIMABLE\\tSIZE\\nabc\\ttrue\\t1.5GB\\nTotal:\\t1.5GB\\n'
        else printf 'Deleted build cache objects:\\nabc\\n\\nTotal reclaimed space: 750MB\\n'; fi ;;
    esac ;;
  "context show") fail context; printf '%s\\n' "\${CTX-default}" ;;
  "buildx inspect") fail inspect; printf 'Name:          %s\\nDriver:        %s\\n' "$3" "\${DRIVER-docker}" ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  return {
    run: (args, env = {}) =>
      execFileSync("sh", ["-c", buildProgram("dockerBuilderPrune", { args })], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODE: "buildx", FAIL: "", ...env },
        encoding: "utf8",
      }),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    reset: () => fs.rmSync(log, { force: true }),
    cleanup: () => fs.rmSync(bin, { recursive: true, force: true }),
  };
}

/** The prune itself (not its --help). */
const pruneCalls = (calls) => calls.filter((c) => c.startsWith("docker builder prune") && !c.includes("--help"));

test("buildx: clears only the daemon's own builder, with exactly these flags, and nothing else is invoked", () => {
  const d = fakeDocker();
  try {
    const r = parseBuilderPruneOutput(d.run([7]));
    assert.deepEqual(r, { ok: true, adapter: "buildx", olderThanDays: 7, reclaimedBytes: 1_500_000_000 });
    assert.deepEqual(d.calls(), [
      "docker info --format {{.DockerRootDir}}",
      "docker builder prune --help",
      "docker context show",
      "docker buildx inspect default",
      "docker builder prune --builder default --force --all --filter until=168h",
    ]);
  } finally {
    d.cleanup();
  }
});

test("buildx: the builder is the one named after the current Docker context (the same daemon)", () => {
  const d = fakeDocker();
  try {
    parseBuilderPruneOutput(d.run([30], { CTX: "spark-ctx" }));
    assert.deepEqual(pruneCalls(d.calls()), ["docker builder prune --builder spark-ctx --force --all --filter until=720h"]);
    assert.ok(d.calls().includes("docker buildx inspect spark-ctx"));
  } finally {
    d.cleanup();
  }
});

test("without buildx: the daemon's own builder, no --builder, and no buildx or context calls", () => {
  const d = fakeDocker();
  try {
    const r = parseBuilderPruneOutput(d.run([1], { MODE: "daemon" }));
    assert.deepEqual(r, { ok: true, adapter: "daemon", olderThanDays: 1, reclaimedBytes: 750_000_000 });
    assert.deepEqual(d.calls(), ["docker info --format {{.DockerRootDir}}", "docker builder prune --help", "docker builder prune --force --all --filter until=24h"]);
  } finally {
    d.cleanup();
  }
});

for (const [why, env, code] of [
  ["Docker is not running", { FAIL: "info-down" }, "docker-down"],
  ["Docker refuses this account", { FAIL: "info-denied" }, "docker-denied"],
  ["the builder's help cannot be read", { FAIL: "help" }, "builder-unknown"],
  ["the Docker context cannot be read", { FAIL: "context" }, "builder-unknown"],
  ["the builder cannot be inspected", { FAIL: "inspect" }, "builder-unknown"],
  ["the builder is a container, not the daemon's own", { DRIVER: "docker-container" }, "builder-unknown"],
  ["the builder is remote", { DRIVER: "remote" }, "builder-unknown"],
  ["the context name is odd", { CTX: "a;b" }, "builder-unknown"],
  ["the context name is empty", { CTX: "" }, "builder-unknown"],
]) {
  test(`fails closed when ${why}: nothing is pruned`, () => {
    const d = fakeDocker();
    try {
      const r = parseBuilderPruneOutput(d.run([7], env));
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.deepEqual(pruneCalls(d.calls()), []);
    } finally {
      d.cleanup();
    }
  });
}

test("a prune Docker refuses is reported as a failure with Docker's reason", () => {
  const d = fakeDocker();
  try {
    const r = parseBuilderPruneOutput(d.run([7], { FAIL: "prune" }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "prune-failed");
    assert.match(r.message, /prune failed/);
  } finally {
    d.cleanup();
  }
});

test("the age travels base64 and the program accepts only a whole number of days from 1 to 365", () => {
  const d = fakeDocker();
  try {
    for (const bad of ["0", "366", "1000", "007", "7.5", "-1", "abc", "", "7 days", "7; touch /nonexistent/x", "$(id)"]) {
      d.reset();
      const r = parseBuilderPruneOutput(d.run([bad]));
      assert.equal(r.code, "bad-args", JSON.stringify(bad));
      assert.deepEqual(d.calls(), [], `${JSON.stringify(bad)}: docker is never called`);
    }
    const program = buildProgram("dockerBuilderPrune", { args: ["7; touch /nonexistent/x"] });
    assert.ok(!program.includes("touch /nonexistent"), "the argument is never script text");
    for (const ok of ["1", "365"]) {
      d.reset();
      assert.equal(parseBuilderPruneOutput(d.run([ok])).ok, true, ok);
    }
  } finally {
    d.cleanup();
  }
});

test("parseOlderThanDays takes a whole number from 1 to 365 and nothing else", () => {
  assert.equal(parseOlderThanDays(1), 1);
  assert.equal(parseOlderThanDays(365), 365);
  for (const bad of [0, 366, 1.5, -7, "7", null, undefined, NaN, Infinity, [7], {}]) {
    assert.throws(() => parseOlderThanDays(bad), (e) => e.status === 400 && e.code === "bad-days", String(bad));
  }
});

test("parseBuilderPruneOutput: Docker's own figure, unknown when it did not say", () => {
  assert.equal(parseBuilderPruneOutput("RESULT=ok\nADAPTER=buildx\nDAYS=7\nRECLAIMED=0B\n").reclaimedBytes, 0);
  assert.deepEqual(parseBuilderPruneOutput("RESULT=ok\nADAPTER=odd\nRECLAIMED=\n"), { ok: true, adapter: null, olderThanDays: null, reclaimedBytes: null });
  assert.equal(parseBuilderPruneOutput("RESULT=error\nCODE=builder-unknown\nMSG=no\n").code, "builder-unknown");
  assert.equal(parseBuilderPruneOutput("garbage").code, "bad-output");
  assert.equal(reclaimedNote(1_500_000_000), " (Docker reports 1.5 GB reclaimed)");
  assert.equal(reclaimedNote(null), "");
});

function make(run) {
  const programs = [];
  const m = new StorageManager({
    run: async (_s, program, o) => {
      programs.push({ program, ...o });
      return run(program, o);
    },
    holdMs: 0,
  });
  return { m, programs };
}

test("pruneBuilderCache validates before anything runs, takes the unit lock and passes the days on", async () => {
  const { m, programs } = make(() => "RESULT=ok\nADAPTER=buildx\nDAYS=7\nRECLAIMED=2.5GB\n");
  for (const olderThanDays of [0, 366, 1.5, "7", undefined, null]) {
    await assert.rejects(m.pruneBuilderCache(spark, { olderThanDays }), (e) => e.status === 400 && e.code === "bad-days", String(olderThanDays));
  }
  assert.equal(programs.length, 0);
  const out = await m.pruneBuilderCache(spark, { olderThanDays: 7, sudo: true });
  assert.deepEqual(out, { olderThanDays: 7, adapter: "buildx", reclaimedBytes: 2_500_000_000 });
  assert.equal(programs.length, 1);
  assert.deepEqual(programs[0].args, [7]);
  assert.equal(programs[0].name, "dockerBuilderPrune");
  assert.match(programs[0].program, /sd_lock/, "a change takes the unit lock");
});

test("pruneBuilderCache shares the per-Spark busy lock with the other Docker changes, and keeps the unit's reason", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = make(async () => { await gate; return "RESULT=ok\n"; });
  const first = slow.m.removeContainers(spark, { ids: ["a".repeat(64)] });
  await assert.rejects(slow.m.pruneBuilderCache(spark, { olderThanDays: 7 }), (e) => e.code === "busy");
  release();
  await first;
  const refused = make(() => "RESULT=error\nCODE=builder-unknown\nMSG=Could not tell which Docker builder holds this build cache\n");
  await assert.rejects(refused.m.pruneBuilderCache(spark, { olderThanDays: 7 }), (e) => e.status === 409 && e.code === "builder-unknown");
  const denied = make(() => "RESULT=error\nCODE=docker-denied\nMSG=Docker needs administrator rights for this account\n");
  await assert.rejects(denied.m.pruneBuilderCache(spark, { olderThanDays: 7 }), (e) => e.status === 403 && e.code === "docker-denied");
});

async function withApp({ run, allow = () => true, remoteAddr }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  if (remoteAddr) app.use((req, _res, next) => { Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddr, configurable: true }); next(); });
  const manager = new StorageManager({ run, holdMs: 0 });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => (id === "s1" ? spark : null) },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/sparks/s1/storage/docker/prune-builder-cache`, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("route: clears, answers Docker's figure and records one Activity event", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return "RESULT=ok\nADAPTER=daemon\nDAYS=7\nRECLAIMED=1.2GB\n"; };
  await withApp({ run }, async (url, events) => {
    const res = await fetch(url, post({ olderThanDays: 7 }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, olderThanDays: 7, adapter: "daemon", reclaimedBytes: 1_200_000_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "storage.docker.builder-cache");
    assert.match(events[0].message, /Cleared Docker build cache not used for 7 days on Spark One \(Docker reports 1\.2 GB reclaimed\)/);
    const bad = await fetch(url, post({ olderThanDays: 400 }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "bad-days");
    assert.equal(ran, 1);
  });
  // Nothing reclaimed: nothing to record.
  await withApp({ run: async () => "RESULT=ok\nADAPTER=buildx\nDAYS=1\nRECLAIMED=0B\n" }, async (url, events) => {
    assert.equal((await fetch(url, post({ olderThanDays: 1 }))).status, 200);
    assert.equal(events.length, 0);
  });
});

test("route: rate limits and a typed password over plain http are refused before anything runs", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return "RESULT=ok\n"; };
  await withApp({ run, allow: () => false }, async (url) => {
    assert.equal((await fetch(url, post({ olderThanDays: 7 }))).status, 429);
  });
  await withApp({ run, remoteAddr: "192.168.1.20" }, async (url) => {
    const res = await fetch(url, post({ olderThanDays: 7, sudo: true, sudoPassword: "pw" }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "insecure-transport");
  });
  assert.equal(ran, 0);
});

test("docker-list: a container's finish time is read when Docker reports a real one, never invented", () => {
  const ID = `sha256:${"a".repeat(64)}`;
  const C = (c) => c.repeat(64);
  const r = parseDockerListOutput(
    [
      "RESULT=ok",
      `IMG=${ID}|1|2026-01-01T00:00:00Z|a:1|1`,
      `CTR=${ID}|/done|exited|${C("1")}|2026-09-01T00:00:00Z|2026-09-02T10:11:12.123456789Z`,
      `CTR=${ID}|/never|created|${C("2")}|2026-09-01T00:00:00Z|0001-01-01T00:00:00Z`,
      `CTR=${ID}|/old-unit|exited|${C("3")}|2026-09-01T00:00:00Z`,
      `CTR=${ID}|/odd|exited|${C("4")}|2026-09-01T00:00:00Z|yesterday`,
      `CTR=${ID}|/offset|dead|${C("5")}|2026-09-01T00:00:00Z|2026-09-03T01:02:03+02:00`,
      "IMAGES=ok",
      "CONTAINERS=ok",
    ].join("\n")
  );
  const byName = Object.fromEntries(r.containers.map((c) => [c.name, c]));
  assert.equal(byName.done.finishedAt, "2026-09-02T10:11:12.123456789Z");
  assert.equal(byName.offset.finishedAt, "2026-09-03T01:02:03+02:00");
  for (const name of ["never", "old-unit", "odd"]) assert.equal("finishedAt" in byName[name], false, name);
});

test("docker-list asks Docker for the finish time", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const log = path.join(bin, "calls");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> "${log}"\ncase "$1 $2" in "info --format") echo /var/lib/docker ;; "ps -aq") echo ${"1".repeat(64)} ;; esac\n`, { mode: 0o755 });
  try {
    execFileSync("sh", ["-c", buildProgram("dockerList", { args: ["light"] })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    const inspect = fs.readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("docker container inspect"));
    assert.ok(inspect?.includes("|{{.State.FinishedAt}}"), inspect);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
