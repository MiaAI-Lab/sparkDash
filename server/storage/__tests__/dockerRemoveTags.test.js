import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseDockerRemoveOutput } from "../commands.js";

const ID = (c) => `sha256:${c.repeat(64)}`;

/**
 * A small stateful Docker: images live as files holding their tags; `image rm` on a tag untags it (and drops the
 * image with its last tag), `image rm` on an ID refuses an image that still has several tags, like the real thing
 * does without --force. `--force` is rejected outright so a regression is loud.
 */
function statefulDocker(images, { busy = [], failRmTag = [], inspectFails = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
  const state = path.join(dir, "images");
  fs.mkdirSync(state);
  for (const [id, tags] of Object.entries(images)) fs.writeFileSync(path.join(state, id.slice(7, 9)), tags.join("\n") + (tags.length ? "\n" : ""));
  const log = path.join(dir, "calls");
  fs.writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh
echo "docker $*" >> "${log}"
S="${state}"
key() { echo "$1" | cut -c8-9; }
case "$*" in *--force*|*" -f "*) echo "force is not allowed" >&2; exit 99 ;; esac
case "$1 $2" in
  "ps -aq")
    for a; do case "$a" in ancestor=*) id=\${a#ancestor=}; for b in ${busy.map((b) => `"${b}"`).join(" ")}; do [ "$b" = "$id" ] && echo "cafe$id"; done ;; esac; done ;;
  "image inspect")
    for last; do :; done
    for f in ${inspectFails.map((b) => `"${b}"`).join(" ")}; do [ "$f" = "$last" ] && { echo "Error response from daemon: boom" >&2; exit 1; }; done
    [ -f "$S/$(key "$last")" ] || { echo "Error response from daemon: No such image: $last" >&2; exit 1; }
    case "$*" in *"{{.Id}}"*) echo "$last" ;; *) cat "$S/$(key "$last")" ;; esac ;;
  "image rm")
    t="$3"
    case "$t" in
      sha256:*)
        f="$S/$(key "$t")"
        [ -f "$f" ] || { echo "Error: No such image" >&2; exit 1; }
        [ "$(grep -c . "$f")" -gt 1 ] && { echo "Error: image is referenced in multiple repositories" >&2; exit 1; }
        rm -f "$f"; echo "Deleted: $t" ;;
      *)
        for x in ${failRmTag.map((b) => `"${b}"`).join(" ")}; do [ "$x" = "$t" ] && { echo "Error: conflict: unable to remove repository reference" >&2; exit 1; }; done
        for f in "$S"/*; do
          [ -f "$f" ] || continue
          if grep -qx "$t" "$f"; then
            grep -vx "$t" "$f" > "$f.n"; mv "$f.n" "$f"
            [ "$(grep -c . "$f")" = 0 ] && rm -f "$f"
            echo "Untagged: $t"; exit 0
          fi
        done
        echo "Error: No such image: $t" >&2; exit 1 ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  return {
    run: (args) => parseDockerRemoveOutput(execFileSync("sh", ["-c", buildProgram("dockerRemove", { args })], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" })),
    calls: () => fs.readFileSync(log, "utf8").trim().split("\n"),
    has: (id) => fs.existsSync(path.join(state, id.slice(7, 9))),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("an image with several tags is removed tag by tag, never forced", () => {
  const d = statefulDocker({ [ID("a")]: ["app:1", "app:latest", "registry/app:1"] });
  try {
    const r = d.run([ID("a")]);
    assert.deepEqual(r.removed, [ID("a")]);
    assert.equal(d.has(ID("a")), false);
    const rms = d.calls().filter((c) => c.startsWith("docker image rm"));
    assert.deepEqual(rms, ["docker image rm app:1", "docker image rm app:latest", "docker image rm registry/app:1"]);
    assert.ok(!d.calls().join("\n").includes("--force"));
  } finally {
    d.cleanup();
  }
});

test("an untagged (dangling) image is removed by its ID", () => {
  const d = statefulDocker({ [ID("b")]: [] });
  try {
    const r = d.run([ID("b")]);
    assert.deepEqual(r.removed, [ID("b")]);
    assert.ok(d.calls().includes(`docker image rm ${ID("b")}`));
  } finally {
    d.cleanup();
  }
});

test("a container created in between makes Docker refuse the tag, and that is reported, not forced", () => {
  const d = statefulDocker({ [ID("c")]: ["web:1", "web:2"] }, { failRmTag: ["web:2"] });
  try {
    const r = d.run([ID("c")]);
    assert.deepEqual(r.removed, []);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].id, ID("c"));
    assert.match(r.failed[0].message, /conflict/);
    assert.equal(d.has(ID("c")), true, "the image is still there");
  } finally {
    d.cleanup();
  }
});

test("an image a container uses is skipped before anything is untagged", () => {
  const d = statefulDocker({ [ID("d")]: ["db:1"] }, { busy: [ID("d")] });
  try {
    const r = d.run([ID("d")]);
    assert.deepEqual(r.skipped, [{ id: ID("d"), reason: "in-use" }]);
    assert.ok(!d.calls().some((c) => c.startsWith("docker image rm")));
    assert.equal(d.has(ID("d")), true);
  } finally {
    d.cleanup();
  }
});

test("an image that is already gone is skipped, and an inspect that fails for another reason is unknown, never removed", () => {
  const d = statefulDocker({ [ID("e")]: ["x:1"] }, { inspectFails: [ID("e")] });
  try {
    const r = d.run([ID("f"), ID("e")]);
    assert.deepEqual(r.skipped, [
      { id: ID("f"), reason: "gone" },
      { id: ID("e"), reason: "check-failed" },
    ]);
    assert.ok(!d.calls().some((c) => c.startsWith("docker image rm")));
  } finally {
    d.cleanup();
  }
});
