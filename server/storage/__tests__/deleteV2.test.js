/**
 * Delete v2 on a real filesystem (roadmap §5.1, §9.3): the programs are run exactly as a unit runs them, in a
 * temporary folder with a temporary home. Races and crashes are injected by a stand-in `perl` (or `rm`) first
 * in PATH that does something at one exact step and then runs the real one. Mount and root behaviour is in
 * deleteV2.mounts.test.js (user namespaces).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseQuarantineOutput, programResult } from "../commands.js";
import { StorageManager } from "../StorageManager.js";

const isRoot = process.getuid?.() === 0;
const REAL_PERL = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v perl"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
const HELPER = new URL("../scripts/sdhelper.pl", import.meta.url).pathname;
const skip = !REAL_PERL ? "perl is not installed" : isRoot ? "runs as an ordinary account" : false;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delv2-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const bin = path.join(root, "bin");
  for (const d of [home, data, bin]) fs.mkdirSync(d, { mode: 0o755 });
  fs.chmodSync(data, 0o755);
  const state = path.join(home, ".local/state/sparkdash");
  return {
    root,
    home,
    data,
    bin,
    staging: path.join(state, "staging"),
    records: path.join(state, "quarantine"),
    cleanup() {
      spawnSync("chmod", ["-R", "u+rwx", root]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run a program as the unit would. A program killed on purpose returns what it printed before. */
function run(sb, name, args, env = {}) {
  const r = spawnSync("sh", ["-c", buildProgram(name, { args })], {
    encoding: "utf8",
    // TMPDIR: a killed program cannot remove its temporary file; keep those in the sandbox.
    env: { ...process.env, HOME: sb.home, TMPDIR: sb.root, ...env },
    maxBuffer: 16 << 20,
  });
  return { out: r.stdout, status: r.status, res: programResult(r.stdout) };
}
const del = (sb, p, extra = [], env) => run(sb, "delete", [p, ...extra], env);
const list = (sb, env) => parseQuarantineOutput(run(sb, "quarantineList", ["list"], env).out);
/** Restore gets the original path the dashboard checked (as StorageManager passes it), read from the list. */
const resolve = (sb, action, id, env, trees = "") =>
  run(sb, "quarantine", action === "restore" ? [action, id, "0", "", list(sb).items.find((i) => i.id === id)?.path ?? "", trees] : [action, id], env);

/**
 * Shell code: `kill_program` kills the program's shell (argv[3] is "sparkdash-storage", see buildProgram) and
 * its subshells with SIGKILL, like a crash or power loss at that exact step.
 */
const KILL_PROGRAM = `kill_program() {
  p=$$
  victims=''
  while [ "$p" -gt 1 ]; do
    [ "$(tr '\\n\\0' ' \\n' < /proc/$p/cmdline 2>/dev/null | sed -n 4p)" = sparkdash-storage ] && victims="$victims $p"
    p=$(awk '{print $4}' /proc/$p/stat)
  done
  kill -9 $victims
  exit 137
}`;

/** A stand-in perl: on call number `n` of helper op `op` it runs `snippet` (sh) before or after the real perl. */
function perlShim(sb, { op, n = 1, when = "before", snippet }) {
  const file = path.join(sb.bin, "perl");
  fs.writeFileSync(
    file,
    `#!/bin/sh
${KILL_PROGRAM}
c="${sb.bin}/count-$4"
k=$(( $(cat "$c" 2>/dev/null || echo 0) + 1 ))
echo "$k" > "$c"
if [ "$4" = "${op}" ] && [ "$k" = "${n}" ]; then
  if [ "${when}" = before ]; then
    ${snippet}
  else
    "${REAL_PERL}" "$@"
    rc=$?
    ${snippet}
    exit $rc
  fi
fi
exec "${REAL_PERL}" "$@"
`,
    { mode: 0o755 }
  );
  return { PATH: `${sb.bin}:${process.env.PATH}` };
}

const ino = (p) => fs.lstatSync(p).ino;
const ctime = (p) => fs.lstatSync(p).ctimeMs;
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const ls = (p) => (exists(p) ? fs.readdirSync(p) : []);
const records = (sb) => ls(sb.records).filter((n) => n.endsWith(".json"));

function tree(sb, name = "proj") {
  const top = path.join(sb.data, name);
  fs.mkdirSync(path.join(top, "sub/deep"), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(top, "sub/deep/model.bin"), "weights");
  fs.writeFileSync(path.join(top, "readme"), "hi");
  return top;
}

test("a delete is staged in a private folder, checked, deleted, and leaves no record behind", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const r = del(sb, top);
    assert.equal(r.res.ok, true, r.out);
    assert.equal(r.res.values.STAGED, "home");
    assert.equal(r.res.values.RENAME, "perl");
    assert.equal(exists(top), false);
    assert.deepEqual(ls(sb.staging), [], "nothing left in staging");
    assert.deepEqual(records(sb), [], "the record is removed once the delete is done");
    assert.equal(fs.statSync(sb.staging).mode & 0o777, 0o700, "staging is private");
    assert.equal(fs.statSync(sb.records).mode & 0o777, 0o700, "records are private");
    assert.deepEqual(list(sb).items, []);
    // A single file goes the same way.
    const f = path.join(sb.data, "one.txt");
    fs.writeFileSync(f, "x");
    assert.equal(del(sb, f).res.ok, true);
    assert.equal(exists(f), false);
  } finally {
    sb.cleanup();
  }
});

test("without renameat2, mv -n --no-copy -T is used after its self-test", { skip }, () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.bin, "uname"), "#!/bin/sh\necho mystery-cpu\n", { mode: 0o755 });
    const top = tree(sb);
    const r = del(sb, top, [], { PATH: `${sb.bin}:${process.env.PATH}` });
    assert.equal(r.res.ok, true, r.out);
    assert.equal(r.res.values.RENAME, "mv");
    assert.equal(exists(top), false);
  } finally {
    sb.cleanup();
  }
});

test("the no-replace rename refuses an occupied name and changes nothing", { skip }, () => {
  const sb = sandbox();
  try {
    const nr = { arm64: 276, aarch64: 276, x64: 316 }[process.arch];
    if (!nr) return;
    fs.writeFileSync(path.join(sb.data, "a"), "A");
    fs.writeFileSync(path.join(sb.data, "b"), "B");
    const r = spawnSync(REAL_PERL, [HELPER, "rn", String(nr), ".", "a", ".", "b"], { cwd: sb.data, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), "EEXIST");
    assert.equal(fs.readFileSync(path.join(sb.data, "a"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(sb.data, "b"), "utf8"), "B");
    const ok = spawnSync(REAL_PERL, [HELPER, "rn", String(nr), ".", "a", ".", "c"], { cwd: sb.data, encoding: "utf8" });
    assert.equal(ok.status, 0);
    assert.equal(fs.readFileSync(path.join(sb.data, "c"), "utf8"), "A");
    assert.equal(exists(path.join(sb.data, "a")), false);
    assert.equal(spawnSync(REAL_PERL, [HELPER, "selftest", String(nr)], { cwd: sb.data }).status, 0);
    assert.deepEqual(ls(sb.data).sort(), ["b", "c"], "the self-test cleans up after itself");
  } finally {
    sb.cleanup();
  }
});

test("a folder with SSH keys anywhere inside is refused after staging and put back unchanged", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    fs.mkdirSync(path.join(top, "sub/deep/.ssh"));
    fs.writeFileSync(path.join(top, "sub/deep/.ssh/id_ed25519"), "key");
    const before = ino(top);
    const r = del(sb, top);
    assert.equal(r.res.ok, false);
    assert.equal(r.res.code, "protected-descendant");
    assert.match(r.res.message, /SSH keys \(sub\/deep\/\.ssh\)/);
    assert.equal(r.res.values.REMAINS, undefined, "nothing was deleted");
    assert.equal(ino(top), before, "the same folder is back at its place");
    assert.equal(fs.readFileSync(path.join(top, "sub/deep/.ssh/id_ed25519"), "utf8"), "key");
    assert.deepEqual(ls(sb.staging), []);
    assert.deepEqual(records(sb), []);
  } finally {
    sb.cleanup();
  }
});

test("a protected location inside the item is refused before anything moves, also through a symlink", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const keep = path.join(top, "sub/keep");
    fs.mkdirSync(keep);
    // As the dashboard passes them: one protected path per line. The second is a symlink to the first.
    const alias = path.join(sb.root, "keep-link");
    fs.symlinkSync(keep, alias);
    const was = ctime(top);
    for (const prot of [keep, `/nonexistent\n${alias}`]) {
      const r = del(sb, top, ["", "0", prot]);
      assert.equal(r.res.code, "protected-descendant", r.out);
      assert.equal(ctime(top), was, "never renamed, not even for a moment");
    }
    const self = del(sb, keep, ["", "0", alias]);
    assert.equal(self.res.code, "protected");
    assert.equal(exists(keep), true);
    // The account's own SSH keys and SparkDash's state are protected without being listed.
    const sshHome = path.join(sb.home, ".ssh");
    fs.mkdirSync(sshHome);
    assert.equal(del(sb, sshHome).res.code, "protected");
    fs.mkdirSync(path.dirname(sb.staging), { recursive: true });
    assert.equal(del(sb, path.join(sb.home, ".local")).res.code, "protected-descendant");
    assert.equal(exists(sshHome), true);
  } finally {
    sb.cleanup();
  }
});

test("symlink swap: replacing the parent with a symlink after it was opened cannot redirect the delete", { skip }, () => {
  const sb = sandbox();
  try {
    const par = path.join(sb.data, "par");
    fs.mkdirSync(par);
    fs.writeFileSync(path.join(par, "item"), "mine");
    const victim = path.join(sb.data, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "item"), "precious");
    // Right after the program opened the parent: move it away and put a symlink to the victim in its place.
    const env = perlShim(sb, { op: "id", n: 1, snippet: `mv "${par}" "${par}-moved" && ln -s "${victim}" "${par}"` });
    const r = del(sb, path.join(par, "item"), [], env);
    assert.equal(r.res.ok, true, r.out);
    assert.equal(fs.readFileSync(path.join(victim, "item"), "utf8"), "precious", "the symlink's target is untouched");
    assert.equal(exists(path.join(`${par}-moved`, "item")), false, "the item that was opened is the one deleted");
    // And a path that already goes through a symlink is refused outright.
    const r2 = del(sb, path.join(par, "item"));
    assert.equal(r2.res.code, "symlinked-path");
    assert.equal(fs.readFileSync(path.join(victim, "item"), "utf8"), "precious");
  } finally {
    sb.cleanup();
  }
});

test("staged root identity: an item swapped in just before the rename is not deleted, and stays staged", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const env = perlShim(sb, { op: "rn", n: 1, snippet: `mv "${top}" "${top}-orig" && mkdir "${top}" && echo new > "${top}/new"` });
    const r = del(sb, top, [], env);
    assert.equal(r.res.code, "changed", r.out);
    // What was staged is not the item that was checked, so it is never put at the original path unverified.
    const qid = r.res.values.QID;
    assert.equal(fs.readFileSync(path.join(sb.staging, qid, "new"), "utf8"), "new\n", "kept, not deleted");
    assert.equal(exists(top), false);
    assert.equal(fs.readFileSync(path.join(`${top}-orig`, "readme"), "utf8"), "hi");
    assert.equal(list(sb).items[0].state, "unknown");
  } finally {
    sb.cleanup();
  }
});

test("put back re-checks the staged entry: a substitute swapped in during the check stays staged", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    fs.mkdirSync(path.join(top, ".ssh"));
    // The check refuses (SSH keys); right after it, the staged entry is replaced by something else.
    const env = perlShim(sb, {
      op: "check",
      n: 1,
      when: "after",
      snippet: 'd=$(pwd -P); mv "$d/$5" "$d/$5-real" && mkdir "$d/$5" && echo sub > "$d/$5/sub"',
    });
    const r = del(sb, top, [], env);
    assert.equal(r.res.code, "protected-descendant", r.out);
    const qid = r.res.values.QID;
    assert.match(qid, /^[0-9a-f-]{36}$/);
    assert.equal(exists(top), false, "the substitute was not put at the original path");
    assert.equal(fs.readFileSync(path.join(sb.staging, qid, "sub"), "utf8"), "sub\n", "the substitute stays staged");
    assert.equal(fs.readFileSync(path.join(sb.staging, `${qid}-real`, "readme"), "utf8"), "hi");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.records, `${qid}.json`), "utf8")).state, "conflict");
    assert.equal(list(sb).items[0].state, "unknown");
  } finally {
    sb.cleanup();
  }
});

test("restore re-checks the staged entry right before renaming it back", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    del(sb, top, [], perlShim(sb, { op: "rn", n: 1, when: "after", snippet: "kill_program" }));
    const [item] = list(sb).items;
    assert.equal(item.state, "staged");
    for (const f of fs.readdirSync(sb.bin)) fs.rmSync(path.join(sb.bin, f));
    // After the restore's first check (in its rename self-test), the staged entry is swapped.
    const env = perlShim(sb, {
      op: "selftest",
      n: 1,
      when: "after",
      snippet: `d=$(pwd -P); mv "$d/${item.id}" "$d/${item.id}-real" && mkdir "$d/${item.id}" && echo sub > "$d/${item.id}/sub"`,
    });
    const r = resolve(sb, "restore", item.id, env);
    assert.equal(r.res.code, "changed", r.out);
    assert.equal(exists(top), false, "nothing was put at the original path");
    assert.equal(fs.readFileSync(path.join(sb.staging, item.id, "sub"), "utf8"), "sub\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.records, `${item.id}.json`), "utf8")).state, "conflict");
  } finally {
    sb.cleanup();
  }
});

test("rename-back conflict: the payload stays staged, is listed, and can be restored once the name is free", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    fs.mkdirSync(path.join(top, ".ssh"));
    // After the staged tree was checked (and refused), something new takes the name.
    const env = perlShim(sb, { op: "check", n: 1, when: "after", snippet: `mkdir "${top}" && echo squatter > "${top}/s"` });
    const r = del(sb, top, [], env);
    assert.equal(r.res.code, "protected-descendant", r.out);
    assert.match(r.res.message, /Needs attention/);
    const qid = r.res.values.QID;
    assert.match(qid, /^[0-9a-f-]{36}$/);
    assert.equal(fs.readFileSync(path.join(sb.staging, qid, "readme"), "utf8"), "hi", "the payload is preserved");
    const record = JSON.parse(fs.readFileSync(path.join(sb.records, `${qid}.json`), "utf8"));
    assert.equal(record.state, "conflict");
    assert.equal(record.original, top);

    const { items } = list(sb);
    assert.equal(items.length, 1);
    assert.deepEqual(
      { id: items[0].id, state: items[0].state, path: items[0].path, stagedPath: items[0].stagedPath, type: items[0].type, elevated: items[0].elevated },
      { id: qid, state: "conflict", path: top, stagedPath: path.join(sb.staging, qid), type: "dir", elevated: false }
    );
    assert.match(items[0].reason, /in use again/);

    // Deleting it from there runs the same checks: SSH keys inside, so no.
    assert.equal(resolve(sb, "delete", qid).res.code, "protected-descendant");
    // And it is never deleted around its record, through the file browser.
    assert.equal(del(sb, path.join(sb.staging, qid)).res.code, "protected");
    assert.equal(del(sb, path.join(sb.records, `${qid}.json`)).res.code, "protected");
    assert.equal(exists(path.join(sb.staging, qid, "readme")), true);
    // Putting it back never replaces what is there now.
    const busy = resolve(sb, "restore", qid);
    assert.equal(busy.res.code, "restore-conflict");
    assert.equal(fs.readFileSync(path.join(top, "s"), "utf8"), "squatter\n");
    fs.rmSync(top, { recursive: true });
    const back = resolve(sb, "restore", qid);
    assert.equal(back.res.ok, true, back.out);
    assert.equal(back.res.values.OUTCOME, "restored");
    assert.equal(fs.readFileSync(path.join(top, "readme"), "utf8"), "hi");
    assert.deepEqual(list(sb).items, []);
    assert.deepEqual(ls(sb.staging), []);
  } finally {
    sb.cleanup();
  }
});

test("crash between writing the record and the staging rename: the item never moved, the record only needs dismissing", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const env = perlShim(sb, { op: "rn", n: 1, snippet: "kill_program" });
    const r = del(sb, top, [], env);
    assert.notEqual(r.status, 0, "the program was killed");
    assert.equal(fs.readFileSync(path.join(top, "readme"), "utf8"), "hi");
    const [rec] = records(sb);
    assert.ok(rec, "the record was written (and fsynced) before the rename");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.records, rec), "utf8")).state, "staging");
    const { items } = list(sb);
    assert.equal(items[0].state, "in-place");
    // Dismissing drops the record only; the item stays where it is.
    const out = resolve(sb, "forget", items[0].id);
    assert.equal(out.res.values.OUTCOME, "forgotten", out.out);
    assert.equal(fs.readFileSync(path.join(top, "readme"), "utf8"), "hi", "a dismissed record never touches the original");
    assert.deepEqual(list(sb).items, []);
  } finally {
    sb.cleanup();
  }
});

test("crash right after the staging rename: the payload is listed as staged and can be restored", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const env = perlShim(sb, { op: "rn", n: 1, when: "after", snippet: "kill_program" });
    del(sb, top, [], env);
    assert.equal(exists(top), false, "it was moved");
    const { items } = list(sb);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, "staged");
    assert.equal(fs.readFileSync(path.join(items[0].stagedPath, "readme"), "utf8"), "hi");
    const back = resolve(sb, "restore", items[0].id);
    assert.equal(back.res.values.OUTCOME, "restored", back.out);
    assert.equal(fs.readFileSync(path.join(top, "sub/deep/model.bin"), "utf8"), "weights");
    assert.deepEqual(list(sb).items, []);
  } finally {
    sb.cleanup();
  }
});

test("crash between the checks and rm: the staged payload can be deleted from Needs attention", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const env = perlShim(sb, { op: "check", n: 1, when: "after", snippet: "kill_program" });
    del(sb, top, [], env);
    const { items } = list(sb);
    assert.equal(items[0].state, "staged");
    const gone = resolve(sb, "delete", items[0].id);
    assert.equal(gone.res.values.OUTCOME, "deleted", gone.out);
    assert.equal(exists(items[0].stagedPath), false);
    assert.equal(exists(top), false);
    assert.deepEqual(list(sb).items, []);
  } finally {
    sb.cleanup();
  }
});

test("crash in the middle of rm: listed as interrupted, and what is left can be put back", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    // A stand-in rm that removes one file of the staged tree, then the program dies.
    fs.writeFileSync(
      path.join(sb.bin, "rm"),
      `#!/bin/sh
${KILL_PROGRAM}
case " $* " in
  *" --one-file-system "*)
    for a; do t=$a; done
    /bin/rm -f "$t/readme"
    kill_program ;;
esac
exec /bin/rm "$@"
`,
      { mode: 0o755 }
    );
    del(sb, top, [], { PATH: `${sb.bin}:${process.env.PATH}` });
    const { items } = list(sb);
    assert.equal(items[0].state, "interrupted");
    const back = resolve(sb, "restore", items[0].id);
    assert.equal(back.res.values.OUTCOME, "restored", back.out);
    assert.equal(exists(path.join(top, "readme")), false, "what rm removed stays removed");
    assert.equal(fs.readFileSync(path.join(top, "sub/deep/model.bin"), "utf8"), "weights");
  } finally {
    sb.cleanup();
  }
});

test("crash after rm, before the record is removed: the record says it is gone and is dismissed", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    const env = perlShim(sb, { op: "mrm", n: 1, snippet: "kill_program" });
    del(sb, top, [], env);
    const { items } = list(sb);
    assert.equal(items[0].state, "gone");
    assert.equal(resolve(sb, "forget", items[0].id).res.values.OUTCOME, "forgotten");
    assert.deepEqual(list(sb).items, []);
  } finally {
    sb.cleanup();
  }
});

test("staging ancestor swap after validation: the delete still acts on the pinned staging folder", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    // Prepare the state folders, then (just before the rename) swap their parent for a decoy with a canary.
    assert.equal(del(sb, path.join(sb.data, "missing")).res.code, "not-found");
    const state = path.dirname(sb.staging);
    fs.mkdirSync(sb.staging, { recursive: true, mode: 0o700 });
    const env = perlShim(sb, {
      op: "rn",
      n: 1,
      snippet: `mv "${state}" "${state}-moved" && mkdir -p "${sb.staging}" && echo canary > "${sb.staging}/canary"`,
    });
    const r = del(sb, top, [], env);
    assert.equal(r.res.ok, true, r.out);
    assert.equal(exists(top), false);
    assert.deepEqual(ls(sb.staging), ["canary"], "nothing was staged into, or deleted from, the decoy");
    assert.deepEqual(ls(path.join(`${state}-moved`, "staging")), [], "the pinned folder was used and is empty again");
  } finally {
    sb.cleanup();
  }
});

test("staging refused (home not private): an ordinary delete falls back to the pinned parent", { skip }, () => {
  const sb = sandbox();
  try {
    fs.chmodSync(sb.home, 0o777);
    const top = tree(sb);
    fs.mkdirSync(path.join(top, ".ssh"));
    // The fallback still checks the tree in place.
    assert.equal(del(sb, top).res.code, "protected-descendant");
    fs.rmdirSync(path.join(top, ".ssh"));
    const r = del(sb, top);
    assert.equal(r.res.ok, true, r.out);
    assert.equal(r.res.values.STAGED, "none");
    assert.equal(exists(top), false);
    assert.equal(exists(path.join(sb.home, ".local")), false, "nothing was created in a home other accounts can change");
  } finally {
    sb.cleanup();
  }
});

test("a folder the account may not move falls back to deleting in place and reports what is left", { skip }, () => {
  const sb = sandbox();
  const ro = path.join(sb.data, "ro");
  try {
    fs.mkdirSync(ro);
    fs.writeFileSync(path.join(ro, "keep"), "x");
    fs.chmodSync(ro, 0o555);
    const r = del(sb, ro);
    assert.equal(r.res.code, "permission");
    assert.equal(r.res.values.REMAINS, "1");
    assert.deepEqual(records(sb), []);
  } finally {
    sb.cleanup();
  }
});

/** The staged-tree check as root sees it, run directly against the real helper (account = `acct`). */
function check(dir, name, acct) {
  const nr = { arm64: 9, aarch64: 9, x64: 192 }[process.arch] ?? "";
  const id = execFileSync(REAL_PERL, [HELPER, "id", name], { cwd: dir, encoding: "utf8" }).split("\t")[0];
  return execFileSync(REAL_PERL, [HELPER, "check", name, id, "1", String(acct), String(nr)], { cwd: dir, encoding: "utf8", input: "" }).trim();
}

test("as root, a tree another account can write to is refused: owner, world-writable, group, ACL", { skip }, () => {
  const sb = sandbox();
  try {
    const me = process.getuid();
    const top = tree(sb);
    assert.equal(check(sb.data, "proj", me), "OK");
    assert.match(check(sb.data, "proj", me + 1), /^REFUSE\ttree-writable-by-others\tThe item belongs to another account/);

    fs.chmodSync(path.join(top, "sub"), 0o777);
    assert.match(check(sb.data, "proj", me), /^REFUSE\ttree-writable-by-others\tsub can be changed by other accounts \(it is world-writable\)/);
    fs.chmodSync(path.join(top, "sub"), 0o755);

    // Group-writable is fine for a group only this account is in, not for one with other members.
    fs.chmodSync(path.join(top, "sub"), 0o775);
    assert.equal(check(sb.data, "proj", me), "OK", "the account's own private group");
    const shared = execFileSync("sh", ["-c", "for g in $(id -G); do getent group $g; done"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.split(":"))
      .find((f) => f.length >= 4 && f[2] !== String(process.getgid()) && f[3].split(",").some((m) => m && m !== os.userInfo().username));
    if (shared) {
      fs.chownSync(path.join(top, "sub"), -1, Number(shared[2]));
      assert.match(check(sb.data, "proj", me), /group-writable/);
      fs.chownSync(path.join(top, "sub"), -1, process.getgid());
    }
    fs.chmodSync(path.join(top, "sub"), 0o755);

    const acl = spawnSync("setfacl", ["-m", "u:4242:rwx", path.join(top, "sub/deep")]);
    if (acl.status === 0) {
      assert.match(check(sb.data, "proj", me), /^REFUSE\ttree-writable-by-others\tsub\/deep has an access list \(ACL\)/);
      spawnSync("setfacl", ["-m", "u:4242:r-x", path.join(top, "sub/deep")]);
      assert.equal(check(sb.data, "proj", me), "OK", "an ACL that only lets someone read is fine");
    }
  } finally {
    sb.cleanup();
  }
});

test("administrator folder delete: refused without the acknowledgement, checked for other writers with it", { skip }, () => {
  // Real root is in deleteV2.mounts.test.js. Here a stand-in `id -u` says 0 for the program itself only (the
  // account part before "sudo" still sees the real account), so the order of the checks can be seen as is.
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.bin, "id"), `#!/bin/sh\n[ "$1" = -u ] && [ -n "$FAKE_ROOT" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n`, { mode: 0o755 });
    const asRoot = (args) => {
      const program = buildProgram("delete", { args }).replace('$SUDO sh -c "$BODY"', 'FAKE_ROOT=1 sh -c "$BODY"');
      assert.ok(program.includes("FAKE_ROOT=1"));
      const r = spawnSync("sh", ["-c", program], { encoding: "utf8", env: { ...process.env, HOME: sb.home, PATH: `${sb.bin}:${process.env.PATH}` } });
      return programResult(r.stdout);
    };
    const top = tree(sb);
    const was = ctime(top);
    const refused = asRoot([top, "", "0"]);
    assert.equal(refused.code, "no-ack");
    assert.equal(ctime(top), was, "refused before anything moved");

    fs.chmodSync(path.join(top, "sub"), 0o777);
    const writable = asRoot([top, "", "1"]);
    assert.equal(writable.code, "tree-writable-by-others");
    assert.match(writable.message, /sub can be changed by other accounts/);
    assert.equal(fs.readFileSync(path.join(top, "readme"), "utf8"), "hi", "put back");
    fs.chmodSync(path.join(top, "sub"), 0o755);

    const done = asRoot([top, "", "1"]);
    assert.equal(done.ok, true);
    assert.equal(exists(top), false);
    // A single file needs no acknowledgement.
    const f = path.join(sb.data, "f");
    fs.writeFileSync(f, "x");
    assert.equal(asRoot([f, "", "0"]).ok, true);
  } finally {
    sb.cleanup();
  }
});

test("dismissing a record never deletes: forget is refused once something is staged again (gone, then staged)", { skip }, () => {
  const sb = sandbox();
  try {
    const top = tree(sb);
    del(sb, top, [], perlShim(sb, { op: "rn", n: 1, when: "after", snippet: "kill_program" }));
    const [item] = list(sb).items;
    assert.equal(item.state, "staged");
    // Moved away by hand: the record now says gone, and the page offers Dismiss.
    const away = path.join(sb.root, "away");
    fs.renameSync(item.stagedPath, away);
    assert.equal(list(sb).items[0].state, "gone");
    // Before the click lands it is back.
    fs.renameSync(away, item.stagedPath);
    const r = resolve(sb, "forget", item.id);
    assert.equal(r.res.code, "payload-present", r.out);
    assert.equal(fs.readFileSync(path.join(item.stagedPath, "readme"), "utf8"), "hi", "nothing was deleted");
    assert.equal(list(sb).items[0].state, "staged", "the record is kept");
    // Anything at all at that place blocks it, even something unrelated.
    fs.renameSync(item.stagedPath, away);
    fs.writeFileSync(item.stagedPath, "other");
    assert.equal(resolve(sb, "forget", item.id).res.code, "payload-present");
    fs.rmSync(item.stagedPath);
    assert.equal(resolve(sb, "forget", item.id).res.values.OUTCOME, "forgotten");
    assert.deepEqual(list(sb).items, []);
    assert.equal(fs.readFileSync(path.join(away, "readme"), "utf8"), "hi");
  } finally {
    sb.cleanup();
  }
});

/** Write a record by hand, as a damaged or crafted one would look (through the helper's own writer). */
function craftRecord(sb, fields) {
  fs.mkdirSync(sb.records, { recursive: true, mode: 0o700 });
  for (let d = sb.records; d !== sb.home; d = path.dirname(d)) fs.chmodSync(d, 0o700);
  const id = fields.id;
  const kv = Object.entries({ version: 1, state: "staged", type: "d", elevated: "false", createdAt: 1, ...fields }).map(([k, v]) => `${k}=${v}`);
  execFileSync(REAL_PERL, [HELPER, "mput", `${id}.json`, String(process.getuid()), String(process.getgid()), ...kv], { cwd: sb.records });
  return id;
}
const idOf = (p) => execFileSync(REAL_PERL, [HELPER, "id", p], { encoding: "utf8" }).split("\t")[0];

test("a record that points outside SparkDash's staging folders is refused for restore and delete", { skip }, () => {
  const sb = sandbox();
  try {
    const elsewhere = path.join(sb.data, "elsewhere");
    const id = "11111111-2222-4333-8444-555555555555";
    fs.mkdirSync(path.join(elsewhere, id), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, id, "precious"), "keep");
    craftRecord(sb, { id, original: path.join(sb.data, "restored"), stagingDir: elsewhere, stagingDevIno: idOf(elsewhere), targetDevIno: idOf(path.join(elsewhere, id)) });
    for (const action of ["restore", "delete"]) {
      const r = resolve(sb, action, id);
      assert.equal(r.res.code, "bad-record", `${action}: ${r.out}`);
    }
    // A name that looks like a staging folder but is not at the top of a filesystem is refused too.
    const fake = path.join(sb.data, `.sparkdash-staging-${process.getuid()}`);
    fs.mkdirSync(path.join(fake, id), { recursive: true, mode: 0o700 });
    craftRecord(sb, { id, original: path.join(sb.data, "restored"), stagingDir: fake, stagingDevIno: idOf(fake), targetDevIno: idOf(path.join(fake, id)) });
    assert.equal(resolve(sb, "delete", id).res.code, "bad-record");
    assert.equal(fs.readFileSync(path.join(elsewhere, id, "precious"), "utf8"), "keep");
    assert.equal(exists(path.join(fake, id)), true);
    assert.equal(exists(path.join(sb.data, "restored")), false);
  } finally {
    sb.cleanup();
  }
});

test("a restore destination in a protected place is refused: by the dashboard's policy, and on the unit", { skip }, async () => {
  const sb = sandbox();
  try {
    // A real staged payload in the real staging folder, with a crafted original path.
    fs.mkdirSync(sb.staging, { recursive: true, mode: 0o700 });
    for (let d = sb.staging; d !== sb.home; d = path.dirname(d)) fs.chmodSync(d, 0o700);
    const id = "22222222-3333-4444-8555-666666666666";
    fs.mkdirSync(path.join(sb.staging, id));
    fs.writeFileSync(path.join(sb.staging, id, "authorized_keys"), "ssh-ed25519 AAAA attacker");
    const sshHome = path.join(sb.home, ".ssh");
    fs.mkdirSync(sshHome);
    const record = (original) => craftRecord(sb, { id, original, stagingDir: sb.staging, stagingDevIno: idOf(sb.staging), targetDevIno: idOf(path.join(sb.staging, id)) });

    // Through the dashboard: refused by the policy before the unit is asked to restore anything.
    record(path.join(sshHome, "keys"));
    const names = [];
    const m = new StorageManager({
      holdMs: 0,
      run: async (_s, program, o) => {
        names.push(`${o.name}:${o.args?.[0] ?? ""}`);
        return spawnSync("sh", ["-c", program], { encoding: "utf8", env: { ...process.env, HOME: sb.home, TMPDIR: sb.root } }).stdout;
      },
    });
    const spark = { id: "local", name: "Local", kind: "spark", platform: "linux", isLocal: true };
    await assert.rejects(m.resolveQuarantined(spark, id, "restore", {}), (e) => e.status === 403 && e.code === "protected" && /SSH keys/.test(e.message));
    assert.deepEqual(names, ["quarantineList:list"], "the restore program never ran");
    assert.equal(exists(path.join(sshHome, "keys")), false);

    // On the unit itself (whatever the caller checked): SSH folders, SparkDash's state, and protected trees,
    // also when the tree is named through a symlink.
    assert.equal(resolve(sb, "restore", id).res.code, "protected");
    record(path.join(sb.home, ".local/state/sparkdash/quarantine/x"));
    assert.equal(resolve(sb, "restore", id).res.code, "protected");
    const tree = path.join(sb.data, "system");
    fs.mkdirSync(path.join(tree, "conf"), { recursive: true });
    const alias = path.join(sb.root, "system-link");
    fs.symlinkSync(tree, alias);
    record(path.join(tree, "conf", "evil"));
    const r = resolve(sb, "restore", id, undefined, `/nonexistent\n${alias}`);
    assert.equal(r.res.code, "protected", r.out);
    assert.match(r.res.message, /is inside/);
    assert.equal(exists(path.join(tree, "conf", "evil")), false);
    // A restore whose path differs from what the dashboard checked is refused too.
    record(path.join(sb.data, "fine"));
    assert.equal(run(sb, "quarantine", ["restore", id, "0", "", path.join(sb.data, "other"), ""]).res.code, "changed");
    assert.equal(fs.readFileSync(path.join(sb.staging, id, "authorized_keys"), "utf8"), "ssh-ed25519 AAAA attacker", "still staged");

    // And an ordinary destination goes through the dashboard all the way.
    names.length = 0;
    assert.deepEqual(await m.resolveQuarantined(spark, id, "restore", {}), { id, outcome: "restored" });
    assert.deepEqual(names, ["quarantineList:list", "quarantine:restore"]);
    assert.equal(fs.readFileSync(path.join(sb.data, "fine", "authorized_keys"), "utf8"), "ssh-ed25519 AAAA attacker");
  } finally {
    sb.cleanup();
  }
});
