import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProgram,
  isContainerId,
  isImageId,
  parseDockerListOutput,
  parseDockerRemoveOutput,
  parseDockerSize,
  parseFilesystems,
  parsePairs,
  parseScanOutput,
  parseScanRequest,
  parseStatusOutput,
  parseSudoPassword,
  programResult,
  totalsFromAtoms,
} from "../commands.js";

const isRoot = process.getuid?.() === 0;

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
  fs.mkdirSync(path.join(root, "a/b/c"), { recursive: true });
  fs.mkdirSync(path.join(root, "d"));
  fs.mkdirSync(path.join(root, "we ird dir"));
  fs.writeFileSync(path.join(root, "a/b/big.bin"), Buffer.alloc(3_000_000));
  fs.writeFileSync(path.join(root, "a/b/c/mid.bin"), Buffer.alloc(500_000));
  fs.writeFileSync(path.join(root, "d/small"), Buffer.alloc(20_000));
  fs.writeFileSync(path.join(root, "we ird dir/x y"), Buffer.alloc(100_000));
  fs.symlinkSync(path.join(root, "a"), path.join(root, "link"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A home of its own: delete v2 keeps its staging folder and recovery records under ~/.local/state/sparkdash.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "storage-home-"));
process.on("exit", () => fs.rmSync(testHome, { recursive: true, force: true }));
const sh = (program, env = {}) => execFileSync("sh", ["-c", program], { encoding: "utf8", maxBuffer: 16 << 20, env: { ...process.env, HOME: testHome, ...env } });

test("scan lists sizes biggest first with types, including names with spaces and symlinks", () => {
  const t = tempTree();
  try {
    const out = sh(buildProgram("scan", { args: [t.root, 3, 60, 100] }));
    const r = parseScanOutput(out, t.root);
    assert.equal(r.ok, true);
    assert.equal(r.unreadable, 0);
    assert.equal(r.timedOut, false);
    const byPath = new Map(r.rows.map((x) => [x.path.replace(t.root, ""), x]));
    assert.equal(byPath.get("").type, "dir");
    assert.equal(byPath.get("/a/b/big.bin").type, "file");
    assert.equal(byPath.get("/link").type, "link");
    assert.equal(byPath.get("/we ird dir/x y").type, "file");
    assert.ok(byPath.get("/a/b/big.bin").bytes >= 3_000_000);
    assert.deepEqual(r.rows.map((x) => x.bytes), [...r.rows.map((x) => x.bytes)].sort((p, q) => q - p), "sorted biggest first");
  } finally {
    t.cleanup();
  }
});

test("scan depth limits how far down it reports and the row cap keeps only the biggest", () => {
  const t = tempTree();
  try {
    const shallow = parseScanOutput(sh(buildProgram("scan", { args: [t.root, 1, 60, 100] })), t.root);
    assert.ok(!shallow.rows.some((x) => x.path.endsWith("/a/b")));
    assert.ok(shallow.rows.some((x) => x.path.endsWith("/a")));
    const capped = parseScanOutput(sh(buildProgram("scan", { args: [t.root, 3, 60, 3] })), t.root);
    assert.equal(capped.rows.length, 3);
  } finally {
    t.cleanup();
  }
});

test("scan of a missing folder is a clean error, not a crash", () => {
  const out = sh(buildProgram("scan", { args: ["/nonexistent-folder-xyz", 2, 60, 10] }));
  const r = parseScanOutput(out, "/nonexistent-folder-xyz");
  assert.equal(r.ok, false);
  assert.equal(r.code, "not-found");
});

test("scan counts folders it was not allowed to read", { skip: isRoot && "root can read everything" }, () => {
  const t = tempTree();
  const locked = path.join(t.root, "locked");
  try {
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "secret"), "x");
    fs.chmodSync(locked, 0o000);
    const r = parseScanOutput(sh(buildProgram("scan", { args: [t.root, 3, 60, 100] })), t.root);
    assert.equal(r.ok, true);
    assert.ok(r.unreadable >= 1);
  } finally {
    fs.chmodSync(locked, 0o700);
    t.cleanup();
  }
});

test("a path with shell metacharacters is data, never script", () => {
  const t = tempTree();
  const evil = path.join(t.root, "x'; touch PWNED; echo '$(touch PWNED2)`touch PWNED3`");
  try {
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, "f"), "data");
    const r = parseScanOutput(sh(buildProgram("scan", { args: [evil, 2, 60, 10] })), evil);
    assert.equal(r.ok, true);
    assert.ok(r.rows.some((x) => x.path === `${evil}/f`));
    for (const f of ["PWNED", "PWNED2", "PWNED3"]) assert.equal(fs.existsSync(path.join(t.root, f)), false);
    const del = programResult(sh(buildProgram("delete", { args: [evil] })));
    assert.equal(del.ok, true);
    assert.equal(fs.existsSync(evil), false);
    assert.equal(fs.readdirSync(t.root).some((n) => n.startsWith("PWNED")), false);
  } finally {
    t.cleanup();
  }
});

test("delete removes a folder tree and reports a missing item", () => {
  const t = tempTree();
  try {
    const target = path.join(t.root, "a");
    assert.equal(programResult(sh(buildProgram("delete", { args: [target] }))).ok, true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(t.root, "d/small")), true, "siblings are untouched");
    const again = programResult(sh(buildProgram("delete", { args: [target] })));
    assert.equal(again.ok, false);
    assert.equal(again.code, "not-found");
  } finally {
    t.cleanup();
  }
});

test("delete of a symlink removes only the link", () => {
  const t = tempTree();
  try {
    assert.equal(programResult(sh(buildProgram("delete", { args: [path.join(t.root, "link")] }))).ok, true);
    assert.equal(fs.existsSync(path.join(t.root, "link")), false);
    assert.equal(fs.existsSync(path.join(t.root, "a/b/big.bin")), true, "the target is untouched");
  } finally {
    t.cleanup();
  }
});

test("delete refuses a path that reaches its target through a symlinked folder", () => {
  const t = tempTree();
  try {
    const viaLink = path.join(t.root, "link/b/big.bin");
    const r = programResult(sh(buildProgram("delete", { args: [viaLink] })));
    assert.equal(r.ok, false);
    assert.equal(r.code, "symlinked-path");
    assert.equal(fs.existsSync(path.join(t.root, "a/b/big.bin")), true);
  } finally {
    t.cleanup();
  }
});

test("delete reports permission trouble with a code the page can act on, and what is left", { skip: isRoot && "root is never refused" }, () => {
  const t = tempTree();
  const dir = path.join(t.root, "readonly");
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep"), "x");
    fs.chmodSync(dir, 0o555);
    const r = programResult(sh(buildProgram("delete", { args: [dir] })));
    assert.equal(r.ok, false);
    assert.equal(r.code, "permission");
    assert.equal(r.values.REMAINS, "1");
  } finally {
    fs.chmodSync(dir, 0o755);
    t.cleanup();
  }
});

// A stand-in for sudo: `-S` reads a password line and compares it, `-n` refuses, anything else runs the command.
function fakeSudoDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakesudo-"));
  fs.writeFileSync(
    path.join(dir, "sudo"),
    `#!/bin/sh
mode=none
while [ $# -gt 0 ]; do
  case "$1" in
    -n) mode=nopass; shift ;;
    -k) shift ;;
    -S) mode=stdin; shift ;;
    -p) shift 2 ;;
    *) break ;;
  esac
done
if [ "$mode" = stdin ]; then
  IFS= read -r given
  [ "$given" = "$FAKE_SUDO_PW" ] || { echo "Sorry, try again." >&2; exit 1; }
elif [ "$mode" = nopass ]; then
  [ -n "\${FAKE_SUDO_NOPASSWD-}" ] || { echo "sudo: a password is required" >&2; exit 1; }
fi
echo "ran-with-sudo" >> "$FAKE_SUDO_LOG"
exec "$@"
`,
    { mode: 0o755 }
  );
  return dir;
}

test("elevated programs: a missing password, a wrong one and the right one", { skip: isRoot && "root never calls sudo" }, () => {
  const bin = fakeSudoDir();
  const t = tempTree();
  const log = path.join(bin, "log");
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_SUDO_PW: "s3cret", FAKE_SUDO_LOG: log };
  try {
    const target = path.join(t.root, "d");

    // No password and no NOPASSWD: the page is told to ask for one.
    let r = programResult(sh(buildProgram("delete", { args: [target], elevate: true }), env));
    assert.equal(r.code, "no-sudo");
    assert.equal(fs.existsSync(target), true);

    // Wrong password.
    r = programResult(sh(buildProgram("delete", { args: [target], elevate: true, password: true }), { ...env, SPARKDASH_SUDO_PW: "nope" }));
    assert.equal(r.code, "bad-password");
    assert.equal(fs.existsSync(target), true);

    // Right password: sudo ran the delete, and the password never appears in the program text.
    const program = buildProgram("delete", { args: [target], elevate: true, password: true });
    assert.ok(!program.includes("s3cret"));
    r = programResult(sh(program, { ...env, SPARKDASH_SUDO_PW: "s3cret" }));
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(target), false);
    assert.ok(fs.readFileSync(log, "utf8").includes("ran-with-sudo"));

    // Passwordless sudo.
    const second = path.join(t.root, "we ird dir");
    r = programResult(sh(buildProgram("delete", { args: [second], elevate: true }), { ...env, FAKE_SUDO_NOPASSWD: "1" }));
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(second), false);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    t.cleanup();
  }
});

test("the sudo password is not left in the environment of what the program starts", { skip: isRoot && "root never calls sudo" }, () => {
  const bin = fakeSudoDir();
  const t = tempTree();
  const marker = path.join(t.root, "env-dump");
  // Replace the real fake with one that dumps its environment.
  const dumper = fs.readFileSync(path.join(bin, "sudo"), "utf8").replace('exec "$@"', `env > ${marker}\nexec "$@"`);
  fs.writeFileSync(path.join(bin, "sudo"), dumper, { mode: 0o755 });
  try {
    const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_SUDO_PW: "s3cret", FAKE_SUDO_LOG: path.join(bin, "log"), SPARKDASH_SUDO_PW: "s3cret" };
    sh(buildProgram("scan", { args: [t.root, 1, 60, 10], elevate: true, password: true }), env);
    const dump = fs.readFileSync(marker, "utf8");
    assert.ok(!dump.includes("SPARKDASH_SUDO_PW"));
    assert.ok(dump.includes("FAKE_SUDO_PW=s3cret"), "the stand-in's own variable is there, so the dump is real");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    t.cleanup();
  }
});

test("buildProgram refuses unknown programs and NUL bytes", () => {
  assert.throws(() => buildProgram("rm-everything"));
  assert.throws(() => buildProgram("delete", { args: ["/a\0b"] }));
});

test("parseSudoPassword takes one plain line", () => {
  assert.equal(parseSudoPassword(undefined), null);
  assert.equal(parseSudoPassword(""), null);
  assert.equal(parseSudoPassword("hunter2"), "hunter2");
  for (const bad of ["a\nb", "a\u0000b", "x".repeat(257), 12, {}]) assert.throws(() => parseSudoPassword(bad), (e) => e.status === 400);
});

test("parseScanRequest defaults, validates and bounds", () => {
  assert.deepEqual(parseScanRequest({}), { path: "/", depth: 3, mode: "new" });
  assert.deepEqual(parseScanRequest({ path: "/var/lib", depth: 2, mode: "drill" }), { path: "/var/lib", depth: 2, mode: "drill" });
  for (const bad of [{ path: "var" }, { depth: 0 }, { depth: 99 }, { depth: 1.5 }, { depth: "3" }, { mode: "everything" }, { path: "/a/../b" }]) {
    assert.throws(() => parseScanRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("parseScanOutput ignores rows outside the scanned folder and reads the trailer", () => {
  const out = ["RESULT=ok\n10\td\t/data", "5\tf\t/data/a", "9\tf\t/etc/passwd", "oops", "x\td\t/data/b", "@@RC=124", "@@UNREADABLE=7", ""].join("\0");
  const r = parseScanOutput(out, "/data");
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.path), ["/data", "/data/a"]);
  assert.equal(r.unreadable, 7);
  assert.equal(r.timedOut, true);
  assert.equal(parseScanOutput("garbage", "/").code, "bad-output");
});

test("parseScanOutput normalizes the doubled slash du prints for /", () => {
  const r = parseScanOutput("RESULT=ok\n10\td\t/\0" + "4\td\t//var\0", "/");
  assert.deepEqual(r.rows.map((x) => x.path), ["/", "/var"]);
});

test("parseFilesystems keeps real disks once and drops pseudo filesystems", () => {
  const pairs = parsePairs([
    "FS=tmpfs tmpfs 100 1 99 1% /run",
    "FS=/dev/nvme0n1p2 ext4 1000 400 600 40% /",
    "FS=/dev/nvme0n1p2 ext4 1000 400 600 40% /etc/hosts",
    "FS=/dev/nvme0n1p1 vfat 50 5 45 10% /boot/efi",
    "FS=overlay overlay 1 1 0 100% /var/lib/docker/overlay2/x/merged",
    "FS=/dev/sda1 ext4 abc 1 1 1% /broken",
  ].join("\n"));
  const fs = parseFilesystems(pairs);
  assert.deepEqual(fs.map((f) => [f.source, f.mount, f.totalBytes, f.usedBytes, f.availBytes]), [
    ["/dev/nvme0n1p2", "/", 1000, 400, 600],
    ["/dev/nvme0n1p1", "/boot/efi", 50, 5, 45],
  ]);
});

test("parseStatusOutput", () => {
  const r = parseStatusOutput(["RESULT=ok", "USER=zurih", "SUDO=yes", "FS=/dev/nvme0n1p2 ext4 1000 400 600 40% /", "DOCKER=denied", "DOCKER_ROOT="].join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.sudo, "yes");
  assert.equal(r.docker.state, "denied");
  assert.equal(r.filesystems.length, 1);
  assert.equal(parseStatusOutput("nonsense").ok, false);
});

const ID_A = `sha256:${"a".repeat(64)}`;
const ID_B = `sha256:${"b".repeat(64)}`;
const ID_C = `sha256:${"c".repeat(64)}`;

test("docker sizes use decimal units like docker prints them", () => {
  assert.equal(parseDockerSize("83.09GB"), 83_090_000_000);
  assert.equal(parseDockerSize("570.4MB"), 570_400_000);
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("76.03GB (91%)"), 76_030_000_000);
  assert.equal(parseDockerSize("N/A"), null);
});

test("parseDockerListOutput marks images running, stopped or unused and sorts biggest first", () => {
  const out = [
    "RESULT=ok", "ROOT=/var/lib/docker",
    "DF=Images|44|23|83.09GB|76.03GB (91%)", "DF=Containers|24|22|570.4MB|559.1MB (98%)", "DF=Local Volumes|36|6|17.15GB|344.7MB (2%)", "DF=Build Cache|321|0|7.976GB|5.543GB",
    `IMG=${ID_A}|1000|2026-10-26T03:48:09Z|app:latest,app:v1`,
    `IMG=${ID_B}|9000|2026-10-25T03:48:09Z|`,
    `IMG=${ID_C}|5000|2026-10-24T03:48:09Z|old:1`,
    `CTR=${ID_A}|/web|running`, `CTR=${ID_C}|/job|exited`, `CTR=sha256:unknown|/x|running`,
    "IMAGES=ok", "CONTAINERS=ok",
  ].join("\n");
  const r = parseDockerListOutput(out);
  assert.equal(r.ok, true);
  assert.equal(r.rootDir, "/var/lib/docker");
  assert.deepEqual(r.images.map((i) => [i.id, i.status]), [[ID_B, "unused"], [ID_C, "stopped"], [ID_A, "running"]]);
  assert.deepEqual(r.images[0].tags, [], "an untagged image has no tags");
  assert.deepEqual(r.images[2].tags, ["app:latest", "app:v1"]);
  assert.deepEqual(r.images[2].usedBy, [{ name: "web", state: "running" }]);
  assert.deepEqual(r.usage.images, { count: 44, active: 23, sizeBytes: 83_090_000_000, reclaimableBytes: 76_030_000_000 });
  assert.equal(r.usage.buildCache.reclaimableBytes, 5_543_000_000);
  assert.equal(parseDockerListOutput("RESULT=error\nCODE=docker-down\nMSG=Docker is not running on this Spark").code, "docker-down");
});

test("parseDockerRemoveOutput", () => {
  const r = parseDockerRemoveOutput([`REMOVED=${ID_A}`, `SKIPPED=${ID_B}|in-use`, `FAILED=${ID_C}|conflict`, "RESULT=ok"].join("\n"));
  assert.deepEqual(r, { ok: true, removed: [ID_A], skipped: [{ id: ID_B, reason: "in-use" }], failed: [{ id: ID_C, message: "conflict" }] });
});

test("isImageId accepts only full sha256 IDs", () => {
  assert.equal(isImageId(ID_A), true);
  for (const bad of ["", "sha256:abc", `${ID_A};ls`, `sha256:${"G".repeat(64)}`, 5, null, "latest"]) assert.equal(isImageId(bad), false);
});

test("docker-remove skips an image that a container uses, and only removes what is free", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const log = path.join(bin, "calls");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> ${log}
case "$1" in
  ps) case "$*" in *ancestor=${ID_B}*) echo containerid ;; esac ;;
  image)
    case "$2" in
      inspect)
        case "$*" in
          *"{{.Id}}"*) exit 1 ;;
          *) for last; do :; done; echo "img-$(echo "$last" | cut -c8)" ;;
        esac ;;
      rm) [ "$3" = "img-c" ] && { echo "Error: conflict" >&2; exit 1; }; echo "Untagged: $3" ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  try {
    const out = sh(buildProgram("dockerRemove", { args: [ID_A, ID_B, ID_C, "not-an-id"] }), { PATH: `${bin}:${process.env.PATH}` });
    const r = parseDockerRemoveOutput(out);
    assert.deepEqual(r.removed, [ID_A]);
    assert.deepEqual(r.skipped, [{ id: ID_B, reason: "in-use" }, { id: "not-an-id", reason: "invalid" }]);
    assert.equal(r.failed.length, 1);
    const calls = fs.readFileSync(log, "utf8");
    assert.ok(!calls.includes("--force"), "never forced");
    assert.ok(!calls.includes(`inspect --format {{range .RepoTags}}{{println .}}{{end}} ${ID_B}`), "an in-use image is never touched");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

const CID = (c) => c.repeat(64);

test("parseDockerListOutput lists containers with their image, stopped ones first", () => {
  const out = [
    "RESULT=ok",
    `IMG=${ID_A}|1000|2026-10-26T03:48:09Z|app:1`,
    `CTR=${ID_A}|/web|running|${CID("1")}|2026-10-20T00:00:00Z`,
    `CTR=${ID_A}|/old-job|exited|${CID("2")}|2026-09-01T00:00:00Z`,
    `CTR=${ID_A}|/new-job|created|${CID("3")}|2026-10-01T00:00:00Z`,
    `CTR=${ID_A}|/no-id|exited`,
    "IMAGES=ok", "CONTAINERS=ok",
  ].join("\n");
  const r = parseDockerListOutput(out);
  assert.deepEqual(r.containers.map((c) => [c.name, c.state, c.removable]), [["new-job", "created", true], ["old-job", "exited", true], ["web", "running", false]]);
  assert.equal(r.containers[0].imageId, ID_A);
  assert.equal(r.containers[0].id, CID("3"));
  assert.equal(r.images[0].status, "running");
});

test("isContainerId accepts only full container IDs", () => {
  assert.equal(isContainerId(CID("a")), true);
  for (const bad of ["", "abc", `${CID("a")};ls`, CID("G"), "my-container", null]) assert.equal(isContainerId(bad), false);
});

test("docker-rm removes stopped containers and never a running one", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const log = path.join(bin, "calls");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> ${log}
case "$1 $2" in
  "container inspect")
    case "$5" in
      ${CID("1")}) echo running ;;
      ${CID("3")}) echo paused ;;
      ${CID("9")}) echo "Error: No such container: $5" >&2; exit 1 ;;
      *) echo exited ;;
    esac ;;
  "container rm") [ "$3" = "${CID("4")}" ] && { echo "Error: removal of container is already in progress" >&2; exit 1; }; echo "$3" ;;
esac
`,
    { mode: 0o755 }
  );
  try {
    const out = sh(buildProgram("dockerRemoveContainers", { args: [CID("1"), CID("2"), CID("3"), CID("4"), CID("9"), "web"] }), { PATH: `${bin}:${process.env.PATH}` });
    const r = parseDockerRemoveOutput(out);
    assert.deepEqual(r.removed, [CID("2")]);
    assert.deepEqual(r.skipped, [{ id: CID("1"), reason: "running" }, { id: CID("3"), reason: "running" }, { id: CID("9"), reason: "gone" }, { id: "web", reason: "invalid" }]);
    assert.equal(r.failed.length, 1);
    const calls = fs.readFileSync(log, "utf8");
    assert.ok(!calls.includes(`container rm ${CID("1")}`) && !calls.includes(`container rm ${CID("3")}`), "an active container is never removed");
    assert.ok(!/ -f| --force| -v/.test(calls.split("\n").filter((l) => l.includes("container rm")).join("\n")), "no force, and volumes are kept");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

const hasPerl = (() => { try { execFileSync("perl", ["-e", "1"]); return true; } catch { return false; } })();

test("the parallel scan reports the same sizes as the serial one", { skip: !hasPerl && "perl is not installed" }, () => {
  const t = tempTree();
  try {
    // Many small files in one folder (thinned into "smaller items" by the unit) and a deeper chain.
    fs.mkdirSync(path.join(t.root, "d/many"));
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(t.root, "d/many", `f${i}`), Buffer.alloc(3000));
    fs.mkdirSync(path.join(t.root, "a/b/c/deeper/deepest"), { recursive: true });
    fs.writeFileSync(path.join(t.root, "a/b/c/deeper/deepest/x"), Buffer.alloc(200_000));
    for (const depth of [1, 2, 3, 4]) {
      const serial = parseScanOutput(sh(buildProgram("scan", { args: [t.root, depth, 60, 1000, 1] })), t.root);
      const par = parseScanOutput(sh(buildProgram("scan", { args: [t.root, depth, 60, 1000, 4] })), t.root);
      assert.equal(serial.mode, "serial");
      assert.equal(par.mode, "parallel", `depth ${depth} used the parallel scan`);
      const P = new Map(par.rows.map((x) => [x.path, x]));
      // Every folder and every file of 1 MiB or more (the unit sums smaller files into their folder) agrees exactly.
      for (const row of serial.rows) {
        if (row.type !== "dir" && row.bytes < 1_048_576) continue;
        assert.equal(P.get(row.path)?.bytes, row.bytes, `depth ${depth}: ${row.path}`);
        assert.equal(P.get(row.path)?.type, row.type, `depth ${depth}: type of ${row.path}`);
      }
    }
  } finally {
    t.cleanup();
  }
});

test("the parallel scan falls back to one scan when there is nothing to split, and says which it used", { skip: !hasPerl && "perl is not installed" }, () => {
  const t = tempTree();
  try {
    assert.equal(parseScanOutput(sh(buildProgram("scan", { args: [t.root, 3, 60, 100, 1] })), t.root).mode, "serial");
    assert.equal(parseScanOutput(sh(buildProgram("scan", { args: [t.root, 3, 60, 100, 8] })), t.root).mode, "parallel");
  } finally {
    t.cleanup();
  }
});

test("totalsFromAtoms adds own sizes up through every folder above, once", () => {
  const atoms = [
    { path: "/r", bytes: 4096, type: "dir" },
    { path: "/r/a", bytes: 4096, type: "dir" },
    { path: "/r/a/big.bin", bytes: 5_000_000, type: "file" },
    { path: "/r/a/b", bytes: 1_000_000, type: "dir" }, // a whole folder measured by du -s (a "T" atom)
    { path: "/r/a", bytes: 30_000, type: null }, // small files in /r/a, summed (an "S" atom)
    { path: "/r/z", bytes: 2_000, type: "dir" },
  ];
  const rows = new Map(totalsFromAtoms(atoms, "/r", 100).map((x) => [x.path, x]));
  assert.equal(rows.get("/r/a/b").bytes, 1_000_000);
  assert.equal(rows.get("/r/a").bytes, 4096 + 5_000_000 + 1_000_000 + 30_000);
  assert.equal(rows.get("/r").bytes, 4096 + 4096 + 5_000_000 + 1_000_000 + 30_000 + 2_000);
  assert.equal(rows.get("/r/a/big.bin").type, "file");
  assert.equal(rows.get("/r/a").type, "dir");
  // The cap keeps the biggest, and the folder itself always stays.
  const capped = totalsFromAtoms(atoms, "/r", 2).map((x) => x.path);
  assert.equal(capped.length, 2);
  assert.ok(capped.includes("/r"));
});

test("parallel records are read back, including a path with a tab in it, and records outside the folder are dropped", () => {
  const out = "RESULT=ok\n" + [
    "A\td\t4096\t/data", "A\tf\t3000000\t/data/a\tb.bin", "T\t7000\t/data/sub", "S\t900\t/data", "A\tf\t9\t/etc/passwd", "A\tq\t9\t/data/x", "T\tNaN\t/data/y",
    "@@MODE=parallel", "@@RC=0", "@@UNREADABLE=2", "",
  ].join("\0");
  const r = parseScanOutput(out, "/data");
  assert.equal(r.mode, "parallel");
  assert.equal(r.unreadable, 2);
  const by = new Map(r.rows.map((x) => [x.path, x]));
  assert.equal(by.get("/data/a\tb.bin").bytes, 3_000_000);
  assert.equal(by.get("/data/sub").type, "dir");
  assert.equal(by.get("/data").bytes, 4096 + 3_000_000 + 7000 + 900);
  assert.ok(!by.has("/etc/passwd") && !by.has("/data/x") && !by.has("/data/y"));
});
