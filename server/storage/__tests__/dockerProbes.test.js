// B4: every Docker query that fails must leave things "unknown" and untouched, never "unused" or removable.
// The real programs run against a fake `docker` on PATH that fails the step named in $FAIL.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseDockerListOutput, parseDockerRemoveOutput } from "../commands.js";

const IMG_A = `sha256:${"a".repeat(64)}`; // used by a stopped container
const IMG_B = `sha256:${"b".repeat(64)}`; // used by nothing
const CTR_1 = "1".repeat(64);

function fakeDocker() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const log = path.join(bin, "calls");
  // $FAIL names the query that fails like a daemon error: info, df, image-ls, image-inspect, ps, container-inspect.
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >> "${log}"
fail() { case " $FAIL " in *" $1 "*) echo "Error response from daemon: $1 failed" >&2; exit 1 ;; esac; }
case "$1 $2" in
  "info "*|"info --format") fail info; echo /var/lib/docker ;;
  "system df") fail df; echo "DF=Images|2|1|2GB|1GB (50%)" ;;
  "image ls") fail image-ls; echo ${IMG_A}; echo ${IMG_B} ;;
  "image inspect") fail image-inspect; echo "IMG=${IMG_A}|1000|2026-10-01T00:00:00Z|app:1|1"; echo "IMG=${IMG_B}|2000|2026-10-02T00:00:00Z|old:1|0" ;;
  "ps -aq") fail ps; echo ${CTR_1} ;;
  "container inspect")
    fail container-inspect
    case "$*" in
      *"CTR="*) echo "CTR=${IMG_A}|/job|exited|${CTR_1}|2026-10-03T00:00:00Z" ;;
      *)
        case "$5" in
          ${"2".repeat(64)}) echo "Error: No such container: $5" >&2; exit 1 ;;
          ${"3".repeat(64)}) echo weird ;;
          ${"4".repeat(64)}) echo dead ;;
          *) echo exited ;;
        esac ;;
    esac ;;
  "container rm") echo "$3" ;;
  "image rm") echo "Deleted: $4" ;;
esac
`,
    { mode: 0o755 }
  );
  return {
    run: (name, args, fail = "") =>
      execFileSync("sh", ["-c", buildProgram(name, { args })], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAIL: fail }, encoding: "utf8" }),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
    reset: () => fs.rmSync(log, { force: true }),
    cleanup: () => fs.rmSync(bin, { recursive: true, force: true }),
  };
}

test("docker-list: with every query answering, an image no container uses is unused", () => {
  const d = fakeDocker();
  try {
    const r = parseDockerListOutput(d.run("dockerList", []));
    assert.deepEqual(r.listing, { images: "ok", containers: "ok" });
    assert.deepEqual(Object.fromEntries(r.images.map((i) => [i.id, i.status])), { [IMG_A]: "stopped", [IMG_B]: "unused" });
  } finally {
    d.cleanup();
  }
});

for (const fail of ["ps", "container-inspect"]) {
  test(`docker-list: a failed container query (${fail}) makes every image "unknown", never "unused"`, () => {
    const d = fakeDocker();
    try {
      const out = d.run("dockerList", [], fail);
      assert.match(out, /^CONTAINERS=failed$/m);
      const r = parseDockerListOutput(out);
      assert.equal(r.listing.containers, "failed");
      assert.ok(r.images.length > 0);
      for (const img of r.images) assert.equal(img.status, img.usedBy.length > 0 ? "stopped" : "unknown", img.id);
      assert.ok(!r.images.some((i) => i.status === "unused"));
    } finally {
      d.cleanup();
    }
  });
}

test("docker-list: failed image queries are reported, not shown as an empty Docker", () => {
  const d = fakeDocker();
  try {
    let r = parseDockerListOutput(d.run("dockerList", [], "image-ls"));
    assert.equal(r.listing.images, "failed");
    assert.deepEqual(r.images, []);
    r = parseDockerListOutput(d.run("dockerList", [], "image-inspect"));
    assert.equal(r.listing.images, "partial");
    // Disk-use totals failing only leaves them out; Docker being down is an error.
    r = parseDockerListOutput(d.run("dockerList", [], "df"));
    assert.deepEqual(r.usage, {});
    assert.equal(parseDockerListOutput(d.run("dockerList", [], "info")).code, "docker-down");
  } finally {
    d.cleanup();
  }
});

test("docker-list: an answer cut off before the listing's status line is treated as unknown", () => {
  const r = parseDockerListOutput(`RESULT=ok\nIMG=${IMG_B}|2000|2026-10-02T00:00:00Z|old:1|0\n`);
  assert.equal(r.images[0].status, "unknown");
  assert.deepEqual(r.listing, { images: "failed", containers: "failed" });
});

test("docker-remove: when the usage check fails the image is skipped, never removed", () => {
  const d = fakeDocker();
  try {
    const r = parseDockerRemoveOutput(d.run("dockerRemove", [IMG_B], "ps"));
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.skipped, [{ id: IMG_B, reason: "check-failed" }]);
    assert.ok(!d.calls().includes("image rm"));
  } finally {
    d.cleanup();
  }
});

test("docker-rm: only a container Docker says is stopped goes; a failed or odd answer leaves it alone", () => {
  const d = fakeDocker();
  const C = (c) => c.repeat(64);
  try {
    let r = parseDockerRemoveOutput(d.run("dockerRemoveContainers", [C("5")], "container-inspect"));
    assert.deepEqual(r.skipped, [{ id: C("5"), reason: "check-failed" }], "a daemon error is not 'gone'");
    assert.ok(!d.calls().includes("container rm"));
    d.reset();
    r = parseDockerRemoveOutput(d.run("dockerRemoveContainers", [C("2"), C("3"), C("4"), C("6")]));
    assert.deepEqual(r.skipped, [{ id: C("2"), reason: "gone" }, { id: C("3"), reason: "check-failed" }]);
    assert.deepEqual(r.removed, [C("4"), C("6")]);
    assert.ok(!d.calls().includes(`container rm ${C("3")}`));
  } finally {
    d.cleanup();
  }
});

test("a container in an unexpected state is never offered for removal, and its image is not unused", () => {
  const r = parseDockerListOutput(
    [`RESULT=ok`, `IMG=${IMG_A}|1|x|a:1|1`, `CTR=${IMG_A}|/odd|weird|${CTR_1}|2026-10-03T00:00:00Z`, "IMAGES=ok", "CONTAINERS=ok"].join("\n")
  );
  assert.equal(r.containers[0].removable, false);
  assert.equal(r.images[0].status, "stopped");
  for (const state of ["exited", "created", "dead"]) {
    const ok = parseDockerListOutput([`RESULT=ok`, `CTR=${IMG_A}|/c|${state}|${CTR_1}|x`, "CONTAINERS=ok"].join("\n"));
    assert.equal(ok.containers[0].removable, true, state);
  }
});
