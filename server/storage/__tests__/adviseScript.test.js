/**
 * The delete advisor's unit program (scripts/advise.sh) run exactly as a unit runs it, against real files in a
 * temporary folder with a temporary home: real processes holding files open, real git repositories, partial
 * downloads, key-like files, unreadable folders and the time budget. Docker is a stand-in first in PATH (the real one
 * is never asked), and so is git where a refusal has to be shown.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseAdviseOutput } from "../commands.js";

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const isRoot = process.getuid?.() === 0;
const skip = process.platform !== "linux" ? "needs Linux /proc" : !has("git") ? "git is not installed" : false;
const MAWK = spawnSync("sh", ["-c", "command -v mawk"], { encoding: "utf8" }).stdout.trim();

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advise-"));
  const dirs = { home: path.join(root, "home"), data: path.join(root, "data"), bin: path.join(root, "bin") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { mode: 0o755 });
  // Docker: no running containers, unless a test writes the answers into these files.
  fs.writeFileSync(
    path.join(dirs.bin, "docker"),
    `#!/bin/sh
case "$1" in
  ps) [ -f "${root}/docker-ps" ] && cat "${root}/docker-ps"; exit "$(cat "${root}/docker-ps-rc" 2>/dev/null || echo 0)" ;;
  inspect) [ -f "${root}/docker-inspect" ] && cat "${root}/docker-inspect"; exit 0 ;;
esac
exit 1
`,
    { mode: 0o755 }
  );
  const kids = [];
  return {
    root,
    ...dirs,
    /** A process that stays until the test ends. */
    hold(opts) {
      const child = spawn("sleep", ["120"], opts);
      kids.push(child);
      return child;
    },
    cleanup() {
      for (const k of kids) k.kill("SIGKILL");
      spawnSync("chmod", ["-R", "u+rwx", root]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const ENV = (sb, extra = {}) => ({ ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, GIT_CONFIG_NOSYSTEM: "1", TMPDIR: sb.root, ...extra });

function advise(sb, paths, { budget = 20, minutes = 1440, env = {} } = {}) {
  const t0 = Date.now();
  const r = spawnSync("sh", ["-c", buildProgram("advise", { args: [minutes, budget, ...paths] })], { encoding: "utf8", env: ENV(sb, env), maxBuffer: 16 << 20 });
  return { ...parseAdviseOutput(r.stdout, paths.length), raw: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

function git(sb, cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: ENV(sb) });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Every file under a folder, for "nothing was written". */
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);

test("programs holding a file open, working in a folder, or running from it are found; others are not", { skip }, async () => {
  const sb = sandbox();
  try {
    const held = path.join(sb.data, "held");
    const cwd = path.join(sb.data, "cwd");
    const idle = path.join(sb.data, "idle");
    const real = path.join(sb.data, "real");
    for (const d of [held, cwd, idle, real]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(held, "weights.bin"), "x");
    fs.writeFileSync(path.join(real, "f.bin"), "x");
    fs.writeFileSync(path.join(idle, "f.bin"), "x");
    // A path reached through a symbolic link to its folder is matched by where it really is.
    fs.symlinkSync(real, path.join(sb.data, "via"));
    const opener = sb.hold({ stdio: [fs.openSync(path.join(held, "weights.bin"), "r"), "ignore", "ignore"] });
    const worker = sb.hold({ cwd, stdio: "ignore" });
    const viaLink = sb.hold({ stdio: [fs.openSync(path.join(real, "f.bin"), "r"), "ignore", "ignore"] });
    // A link to a held folder: deleting the link leaves the folder alone, so the link is not "in use".
    fs.symlinkSync(cwd, path.join(sb.data, "link-to-cwd"));
    await new Promise((r) => setTimeout(r, 300));
    const before = listing(sb.home);
    const res = advise(sb, [held, cwd, idle, path.join(sb.data, "via", "f.bin"), path.join(sb.data, "link-to-cwd"), path.join(held, "weights.bin")]);
    assert.equal(res.ok, true, res.raw);
    assert.ok(["all", "own"].includes(res.procs), res.raw);
    const [h, c, i, v, l, f] = res.items;
    assert.ok(h.uses.some((u) => u.pid === opener.pid && u.how === "open" && u.program === "sleep" && u.target === path.join(held, "weights.bin")), JSON.stringify(h));
    assert.ok(c.uses.some((u) => u.pid === worker.pid && u.how === "cwd" && u.target === cwd), JSON.stringify(c));
    assert.equal(i.useCount, 0, JSON.stringify(i));
    assert.ok(v.uses.some((u) => u.pid === viaLink.pid), JSON.stringify(v));
    assert.equal(l.type, "link");
    assert.equal(l.useCount, 0, JSON.stringify(l));
    assert.ok(f.uses.some((u) => u.pid === opener.pid), "a file itself");
    assert.deepEqual(listing(sb.home), before, "nothing written to the home folder");
    assert.ok(!fs.existsSync(path.join(sb.home, ".local")), "no state folder created");
  } finally {
    sb.cleanup();
  }
});

test("git: uncommitted, unpushed, no remote, stashed, clean; inside a work tree; the history folder", { skip }, () => {
  const sb = sandbox();
  try {
    const projects = path.join(sb.data, "projects");
    fs.mkdirSync(projects);
    const remote = path.join(sb.root, "remote.git");
    git(sb, sb.root, "init", "-q", "--bare", remote);
    const make = (name, { push = false, remoteToo = push } = {}) => {
      const dir = path.join(projects, name);
      fs.mkdirSync(dir);
      git(sb, dir, "init", "-q");
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      git(sb, dir, "add", "a.txt");
      git(sb, dir, "commit", "-qm", "one");
      if (remoteToo) git(sb, dir, "remote", "add", "origin", remote);
      if (push) git(sb, dir, "push", "-q", "origin", `HEAD:refs/heads/${name}`), git(sb, dir, "fetch", "-q", "origin");
      return dir;
    };
    const clean = make("clean", { push: true });
    const ahead = make("ahead", { push: true });
    fs.writeFileSync(path.join(ahead, "b.txt"), "two\n");
    git(sb, ahead, "add", "b.txt");
    git(sb, ahead, "commit", "-qm", "two");
    const dirty = make("dirty", { push: true });
    fs.appendFileSync(path.join(dirty, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(dirty, "new.txt"), "new\n");
    const local = make("local");
    const stash = make("stash", { push: true });
    fs.appendFileSync(path.join(stash, "a.txt"), "wip\n");
    git(sb, stash, "stash", "-q");

    const res = advise(sb, [projects, path.join(dirty, "a.txt"), path.join(clean, "a.txt"), path.join(local, ".git"), path.join(local, ".git", "objects"), path.join(dirty, "new.txt")]);
    assert.equal(res.ok, true, res.raw);
    assert.equal(res.git, "ok");
    const repos = Object.fromEntries(res.items[0].repos.map((r) => [r.top, r]));
    assert.deepEqual(Object.keys(repos).sort(), ["ahead", "clean", "dirty", "local", "stash"]);
    assert.deepEqual(repos.clean, { top: "clean", state: "ok", changed: 0, untracked: 0, unpushed: 0, remotes: 1, stashes: 0 });
    assert.equal(repos.ahead.unpushed, 1);
    assert.equal(repos.ahead.changed, 0);
    assert.equal(repos.dirty.changed, 1);
    assert.equal(repos.dirty.untracked, 1);
    assert.deepEqual([repos.local.remotes, repos.local.unpushed], [0, 1], "no remote: its commit exists only here");
    assert.equal(repos.stash.stashes, 1);
    assert.equal(repos.stash.changed, 0);
    assert.deepEqual(res.items[0].gitDirs, { found: 5, checked: 5 });
    assert.deepEqual(res.items[1].inRepo, { top: dirty, relation: "tree", state: "ok", changed: 1, untracked: 0, tracked: true, ignored: false });
    assert.deepEqual(res.items[2].inRepo, { top: clean, relation: "tree", state: "ok", changed: 0, untracked: 0, tracked: true, ignored: false });
    // The .git folder itself: reported as its repository's history (top "").
    assert.deepEqual(res.items[3].repos.map((r) => [r.top, r.state, r.unpushed, r.remotes]), [["", "ok", 1, 0]]);
    assert.equal(res.items[3].inRepo, null);
    assert.equal(res.items[4].inRepo.relation, "history");
    assert.equal(res.items[4].inRepo.top, local);
    assert.deepEqual([res.items[5].inRepo.untracked, res.items[5].inRepo.tracked], [1, false]);
  } finally {
    sb.cleanup();
  }
});

test("repository names with spaces and wildcard characters are taken literally", { skip }, () => {
  const sb = sandbox();
  try {
    const base = path.join(sb.data, "src");
    const odd = path.join(base, "my *repo? [x]");
    fs.mkdirSync(odd, { recursive: true });
    git(sb, odd, "init", "-q");
    fs.writeFileSync(path.join(odd, "f.txt"), "x\n");
    // A folder a wildcard would match, which must not be reported instead.
    fs.mkdirSync(path.join(base, "my zrepoq x"));
    const res = advise(sb, [base]);
    assert.deepEqual(res.items[0].repos.map((r) => [r.top, r.state, r.untracked]), [["my *repo? [x]", "ok", 1]], res.raw);
  } finally {
    sb.cleanup();
  }
});

test("a repository git refuses (owned by another account) is reported as refused, never overridden", { skip }, () => {
  const sb = sandbox();
  try {
    const repo = path.join(sb.data, "theirs");
    fs.mkdirSync(repo);
    git(sb, repo, "init", "-q");
    // Stand-in git: answers "status" the way git does for a repository of another account.
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(sb.bin, "git"),
      `#!/bin/sh
for a in "$@"; do
  if [ "$a" = status ]; then echo "fatal: detected dubious ownership in repository at '${repo}'" >&2; exit 128; fi
done
exec ${realGit} "$@"
`,
      { mode: 0o755 }
    );
    const res = advise(sb, [sb.data]);
    assert.deepEqual(res.items[0].repos.map((r) => [r.top, r.state]), [["theirs", "refused"]], res.raw);
  } finally {
    sb.cleanup();
  }
});

for (const awk of ["default", ...(MAWK ? ["mawk"] : [])]) {
  test(`partial downloads, key-like files and recent changes (${awk} awk)`, { skip }, () => {
    const sb = sandbox();
    try {
      let env = {};
      if (awk === "mawk") {
        fs.symlinkSync(MAWK, path.join(sb.bin, "awk"));
        env = { PATH: `${sb.bin}:${process.env.PATH}` };
      }
      const hf = path.join(sb.data, ".cache", "huggingface");
      const blobs = path.join(hf, "hub", "models--org--name", "blobs");
      fs.mkdirSync(blobs, { recursive: true });
      fs.writeFileSync(path.join(blobs, "abc.incomplete"), "x");
      fs.writeFileSync(path.join(hf, "token"), "hf_x");
      const old = path.join(sb.data, "old");
      fs.mkdirSync(old);
      fs.writeFileSync(path.join(old, "weights.bin"), "x");
      fs.writeFileSync(path.join(old, "id_ed25519.pub"), "public half only");
      const longAgo = new Date(Date.now() - 3 * 86400_000);
      fs.utimesSync(path.join(old, "weights.bin"), longAgo, longAgo);
      fs.utimesSync(path.join(old, "id_ed25519.pub"), longAgo, longAgo);
      fs.utimesSync(old, longAgo, longAgo);
      const res = advise(sb, [hf, old, path.join(hf, "token"), path.join(sb.data, "missing")], { minutes: 60, env });
      assert.equal(res.ok, true, res.raw);
      const [h, o, t, m] = res.items;
      assert.equal(h.walk, "complete");
      assert.deepEqual(h.partial, { count: 1, sample: "hub/models--org--name/blobs/abc.incomplete" });
      assert.deepEqual(h.credentials, { count: 1, sample: "token" });
      assert.ok(h.recent && h.recent.count >= 5, JSON.stringify(h.recent));
      assert.ok(Math.abs(h.recent.newest - res.now) < 120, "the newest change is a time on the unit's clock");
      assert.equal(o.walk, "complete");
      assert.equal(o.recent, null, "nothing changed within the hour");
      assert.equal(o.credentials, null, "a public key is not a private one");
      assert.equal(o.partial, null);
      assert.deepEqual(t.credentials, { count: 1, sample: "" }, "the path itself");
      assert.equal(t.type, "file");
      assert.equal(m.type, null);
      assert.equal(m.walk, null);
      assert.equal(m.reported, true);
    } finally {
      sb.cleanup();
    }
  });
}

test("a folder inside that cannot be read leaves the walk partial", { skip: skip || (isRoot ? "root reads everything" : false) }, () => {
  const sb = sandbox();
  try {
    const top = path.join(sb.data, "top");
    fs.mkdirSync(path.join(top, "locked"), { recursive: true });
    fs.chmodSync(path.join(top, "locked"), 0o000);
    const res = advise(sb, [top]);
    assert.equal(res.items[0].walk, "partial", res.raw);
  } finally {
    sb.cleanup();
  }
});

test("running containers: a mount of the path or inside it, and a mount around it", { skip }, () => {
  const sb = sandbox();
  try {
    const models = path.join(sb.data, "models");
    fs.mkdirSync(path.join(models, "qwen"), { recursive: true });
    fs.mkdirSync(path.join(sb.data, "elsewhere"));
    const id = "a".repeat(64);
    fs.writeFileSync(path.join(sb.root, "docker-ps"), `${id}\n`);
    fs.writeFileSync(path.join(sb.root, "docker-inspect"), `D\t/vllm\tbind\t${path.join(models, "qwen")}\t/models\tvolume\t/var/lib/docker/volumes/v/_data\t/cache\n`);
    const res = advise(sb, [models, path.join(models, "qwen", "config.json"), path.join(sb.data, "elsewhere")]);
    assert.equal(res.docker, "ok", res.raw);
    assert.deepEqual(res.items[0].mounts, [{ relation: "within", container: "vllm", source: path.join(models, "qwen"), destination: "/models" }]);
    assert.deepEqual(res.items[1].mounts.map((m) => m.relation), ["around"]);
    assert.equal(res.items[2].mountCount, 0);
    // Docker refuses this account.
    fs.writeFileSync(path.join(sb.root, "docker-ps"), "permission denied while trying to connect to the Docker daemon socket\n");
    fs.writeFileSync(path.join(sb.root, "docker-ps-rc"), "1");
    const denied = advise(sb, [models]);
    assert.equal(denied.docker, "denied");
    assert.equal(denied.items[0].mountCount, 0);
    fs.writeFileSync(path.join(sb.root, "docker-ps"), "Cannot connect to the Docker daemon. Is the docker daemon running?\n");
    assert.equal(advise(sb, [models]).docker, "down");
  } finally {
    sb.cleanup();
  }
});

test("the time budget is kept: a walk that takes too long is cut and reported, later paths still get a turn", { skip }, () => {
  const sb = sandbox();
  try {
    const realFind = spawnSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).stdout.trim();
    // Stand-in find: the /proc steps run for real; looking through a slow folder never ends.
    fs.writeFileSync(
      path.join(sb.bin, "find"),
      `#!/bin/sh
case "$1" in
  /proc/*) exec ${realFind} "$@" ;;
  */slow) exec sleep 60 ;;
esac
exec ${realFind} "$@"
`,
      { mode: 0o755 }
    );
    const slow = path.join(sb.data, "slow");
    const quick = path.join(sb.data, "quick");
    fs.mkdirSync(slow);
    fs.mkdirSync(quick);
    const res = advise(sb, [slow, quick], { budget: 4 });
    assert.ok(res.ms < 4000 + 4000, `took ${res.ms} ms`);
    assert.equal(res.items[0].walk, "timeout", res.raw);
    assert.equal(res.items[1].reported, true, "the next path is still reported");
    assert.ok(["complete", "skipped", "timeout"].includes(res.items[1].walk));
  } finally {
    sb.cleanup();
  }
});
