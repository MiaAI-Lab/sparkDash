/**
 * Delete v2 with real mounts and real root (roadmap §5.1, §9.3), without privileges: each test runs in a user
 * and mount namespace (`unshare -Urm`) inside a small chroot whose `/` is a tmpfs this test owns, so bind
 * mounts, tmpfs mounts, cross-device renames and root's own checks are the real thing.
 *
 * The lane probes whether the kernel allows it (Ubuntu can restrict unprivileged user namespaces through
 * AppArmor). Where it does not, these tests are skipped here with that reason; the roadmap requires this lane
 * to pass somewhere (a CI runner or VM that allows it) before the slice is accepted.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parsePairs, programResult, scriptText } from "../commands.js";

const HELPER = new URL("../scripts/sdhelper.pl", import.meta.url).pathname;
const NR = { arm64: 276, x64: 316 }[process.arch] ?? null;

const lane = (() => {
  if (process.platform !== "linux") return "Linux only";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delv2-probe-"));
  try {
    const r = spawnSync("unshare", ["-Urm", "sh", "-c", `mount -t tmpfs probe "${dir}" && mount --bind /usr "${dir}" && chroot "${dir}" /bin/true && echo ok`], { encoding: "utf8" });
    if (r.error || !r.stdout.includes("ok")) return `user namespaces with mounts are not available here (unshare -Urm: ${(r.stderr || r.error?.message || "").trim().slice(0, 120)})`;
    if (spawnSync("perl", ["-e", "1"]).status !== 0) return "perl is not installed";
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
if (lane) console.log(`# deleteV2 mount lane skipped: ${lane}`);

/**
 * Run `script` (sh) as root in a fresh chroot: / is a tmpfs, /usr /etc /dev /proc /sys are bound from the
 * host, /data and /home/acct are empty. `files` are copied to /work first. Returns stdout.
 */
function inChroot(script, files = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "delv2-ns-"));
  const root = path.join(work, "root");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(work, "files"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(work, "files", name), text, { mode: 0o755 });
  fs.writeFileSync(path.join(work, "files", "test.sh"), `export HOME=/home/acct PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C\n${script}\n`);
  const boot = `set -e
umask 022
R="${root}"
mount -t tmpfs -o mode=755 root "$R"
for d in usr etc dev proc sys; do mkdir "$R/$d"; mount --rbind "/$d" "$R/$d"; done
for l in bin lib lib64 lib32 sbin; do if [ -L "/$l" ]; then ln -s "$(readlink "/$l")" "$R/$l"; fi; done
mkdir -m 1777 "$R/tmp"
mkdir -p "$R/home/acct" "$R/data" "$R/work" "$R/mnt"
cp "${work}/files/"* "$R/work/"
set +e
chroot "$R" /bin/sh /work/test.sh
`;
  try {
    const r = spawnSync("unshare", ["-Urm", "sh", "-c", boot], { encoding: "utf8", maxBuffer: 16 << 20 });
    if (r.status !== 0 && !r.stdout) throw new Error(`namespace run failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    spawnSync("chmod", ["-R", "u+rwx", work]);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Sections printed as "@@name" lines, each followed by the output of one step. */
function sections(out) {
  const res = {};
  let cur = null;
  for (const line of out.split("\n")) {
    const m = /^@@(\S+)$/.exec(line);
    if (m) {
      cur = m[1];
      res[cur] = "";
    } else if (cur) res[cur] += `${line}\n`;
  }
  return res;
}
const facts = (text) => Object.fromEntries(parsePairs(text));

/** A delete as the namespace's root account (the program's own account part runs first, as on a unit). */
const rootDelete = (p, extra = []) => buildProgram("delete", { args: [p, ...extra] });
/** The delete script run as root for account 4242: an administrator delete through sudo. */
const sudoDelete = (p, ack) => `sh -c "$(cat /work/delete.body)" sparkdash-storage 4242 4242 /home/acct '${p}' '' ${ack} ''`;

test("a bind mount or tmpfs inside the item is refused and nothing moves", { skip: lane }, () => {
  const out = inChroot(
    `mkdir -p /data/proj/sub /data/proj/fast /data/other
echo theirs > /data/other/f
mount --bind /data/other /data/proj/sub
mount -t tmpfs fast /data/proj/fast
echo @@bind; sh /work/p1.sh
echo @@after; [ -f /data/proj/sub/f ] && echo SUB=1; [ -f /data/other/f ] && echo OTHER=1; mountpoint -q /data/proj/fast && echo FAST=1
umount /data/proj/sub
echo @@tmpfs; sh /work/p1.sh
umount /data/proj/fast
echo @@plain; sh /work/p1.sh; [ -e /data/proj ] || echo GONE=1; [ -f /data/other/f ] && echo OTHER=1`,
    { "p1.sh": rootDelete("/data/proj") }
  );
  const s = sections(out);
  assert.equal(programResult(s.bind).code, "mountpoint", out);
  assert.match(programResult(s.bind).message, /separate disk or mount point/);
  assert.deepEqual(facts(s.after), { SUB: "1", OTHER: "1", FAST: "1" });
  assert.equal(programResult(s.tmpfs).code, "mountpoint");
  assert.equal(programResult(s.plain).ok, true, s.plain);
  assert.deepEqual(facts(s.plain).GONE, "1");
  assert.deepEqual(facts(s.plain).OTHER, "1", "the former bind source is untouched");
});

test("a bind mount that appears after staging is found on the staged tree, and the tree is put back", { skip: lane }, () => {
  // A stand-in perl mounts into the staged tree right before the staged-tree check runs.
  const shim = `#!/bin/sh
if [ "$4" = check ]; then mount --bind /data/other "$PWD/$5/sub"; fi
exec /usr/bin/perl "$@"
`;
  const out = inChroot(
    `mkdir -p /data/proj/sub /data/other /work/bin; echo theirs > /data/other/f; echo mine > /data/proj/readme
cp /work/perl /work/bin/perl
echo @@del; PATH=/work/bin:$PATH sh /work/p1.sh
echo @@after; [ -f /data/proj/readme ] && echo BACK=1; mountpoint -q /data/proj/sub && echo MOUNT_CAME_BACK=1; [ -f /data/other/f ] && echo OTHER=1
ls -A /home/acct/.local/state/sparkdash/staging | wc -l | sed 's/^/STAGED=/'`,
    { "p1.sh": rootDelete("/data/proj"), perl: shim }
  );
  const s = sections(out);
  assert.equal(programResult(s.del).code, "mountpoint", out);
  assert.deepEqual(facts(s.after), { BACK: "1", MOUNT_CAME_BACK: "1", OTHER: "1", STAGED: "0" });
});

test("cross-device: the no-replace rename and mv --no-copy both refuse with EXDEV and copy nothing", { skip: lane || (!NR && "no renameat2 number for this CPU") }, () => {
  const out = inChroot(
    `mkdir /mnt/other; mount -t tmpfs other /mnt/other
echo data > /data/a
echo @@perl; perl /work/sdhelper.pl rn ${NR} . /data/a . /mnt/other/a; echo "RC=$?"
echo @@mv; mv -n --no-copy -T /data/a /mnt/other/a 2>&1; echo "RC=$?"
echo @@after; [ -f /data/a ] && echo SOURCE=1; [ -e /mnt/other/a ] && echo COPIED=1; echo DONE=1`,
    { "sdhelper.pl": fs.readFileSync(HELPER, "utf8") }
  );
  const s = sections(out);
  assert.match(s.perl, /^EXDEV$/m, out);
  assert.match(s.perl, /RC=1/);
  assert.match(s.mv, /cross-device/);
  assert.deepEqual(facts(s.after), { SOURCE: "1", DONE: "1" });
});

test("an item on another filesystem is staged at that filesystem's top, never copied to the home disk", { skip: lane }, () => {
  const out = inChroot(
    `mkdir /mnt/disk; mount -t tmpfs -o mode=755 disk /mnt/disk
mkdir -p /mnt/disk/proj/sub; echo x > /mnt/disk/proj/sub/f
echo @@del; sh /work/p1.sh
echo @@after; [ -e /mnt/disk/proj ] || echo GONE=1; stat -c 'MODE=%a' /mnt/disk/.sparkdash-staging-0; ls -A /mnt/disk/.sparkdash-staging-0 | wc -l | sed 's/^/LEFT=/'
ls -A /home/acct/.local/state/sparkdash/quarantine | wc -l | sed 's/^/RECORDS=/'`,
    { "p1.sh": rootDelete("/mnt/disk/proj") }
  );
  const s = sections(out);
  const r = programResult(s.del);
  assert.equal(r.ok, true, out);
  assert.equal(r.values.STAGED, "topdir");
  assert.deepEqual(facts(s.after), { GONE: "1", MODE: "700", LEFT: "0", RECORDS: "0" });
});

test("as root, a delete where no private staging folder can exist is refused, not done in place", { skip: lane }, () => {
  const out = inChroot(
    `mkdir /mnt/shared; mount -t tmpfs -o mode=777 shared /mnt/shared
mkdir -p /mnt/shared/proj; echo x > /mnt/shared/proj/f
echo @@del; sh /work/p1.sh
echo @@after; [ -f /mnt/shared/proj/f ] && echo KEPT=1; [ -e /mnt/shared/.sparkdash-staging-0 ] && echo MADE=1; echo DONE=1`,
    { "p1.sh": rootDelete("/mnt/shared/proj") }
  );
  const s = sections(out);
  const r = programResult(s.del);
  assert.equal(r.code, "staging-unavailable", out);
  assert.match(r.message, /can be changed by other accounts/);
  assert.deepEqual(facts(s.after), { KEPT: "1", DONE: "1" });
});

test("administrator delete for an account: acknowledgement first, then nobody else may be able to write in the tree", { skip: lane }, () => {
  const out = inChroot(
    `mkdir -p /data/proj/sub /data/proj/drop; echo x > /data/proj/sub/f
echo @@noack; ${sudoDelete("/data/proj", 0)}
echo @@open; chmod 777 /data/proj/drop; ${sudoDelete("/data/proj", 1)}
echo @@back; [ -f /data/proj/sub/f ] && echo BACK=1; stat -c 'OWNER=%u MODE=%a' /home/acct/.local/state/sparkdash/staging
echo @@ok; chmod 755 /data/proj/drop; ${sudoDelete("/data/proj", 1)}
echo @@after; [ -e /data/proj ] || echo GONE=1; ls -A /home/acct/.local/state/sparkdash/staging | wc -l | sed 's/^/LEFT=/'
echo x > /data/file
echo @@file; ${sudoDelete("/data/file", 0)}`,
    { "delete.body": scriptText("delete") }
  );
  const s = sections(out);
  assert.equal(programResult(s.noack).code, "no-ack", out);
  const open = programResult(s.open);
  assert.equal(open.code, "tree-writable-by-others");
  assert.match(open.message, /drop can be changed by other accounts/);
  // The staging folder is root's here (the namespace cannot hand it to an unmapped account): a root-owned
  // staging parent does not make a tree that others can write to acceptable.
  assert.match(s.back, /BACK=1/);
  assert.match(s.back, /OWNER=0 MODE=700/);
  assert.equal(programResult(s.ok).ok, true, s.ok);
  assert.deepEqual(facts(s.after), { GONE: "1", LEFT: "0" });
  assert.equal(programResult(s.file).ok, true, "a single file needs no acknowledgement");
});

test("restore never puts an item into a protected folder reached through a bind mount", { skip: lane }, () => {
  const id = "33333333-4444-4555-8666-777777777777";
  const st = "/home/acct/.local/state/sparkdash";
  const out = inChroot(
    `mkdir -p /data/system/conf /data/view ${st}/staging/${id} ${st}/quarantine; chmod 700 ${st}/staging ${st}/quarantine
echo payload > ${st}/staging/${id}/f
mount --bind /data/system /data/view
H=/work/sdhelper.pl
SDI=$(perl $H id ${st}/staging | cut -f1); TID=$(perl $H id ${st}/staging/${id} | cut -f1)
(cd ${st}/quarantine && perl $H mput ${id}.json 0 0 version=1 id=${id} state=staged original=/data/view/conf/evil stagingDir=${st}/staging stagingDevIno=$SDI targetDevIno=$TID type=d elevated=false createdAt=1)
echo @@restore; sh /work/p1.sh
echo @@after; [ -e /data/system/conf/evil ] || echo NOT_PUT=1; [ -f ${st}/staging/${id}/f ] && echo STILL_STAGED=1`,
    {
      "sdhelper.pl": fs.readFileSync(HELPER, "utf8"),
      "p1.sh": buildProgram("quarantine", { args: ["restore", id, "0", "", "/data/view/conf/evil", "/data/system"] }),
    }
  );
  const s = sections(out);
  const r = programResult(s.restore);
  assert.equal(r.code, "protected", out);
  assert.match(r.message, /\/data\/view\/conf is inside \/data\/system/);
  assert.deepEqual(facts(s.after), { NOT_PUT: "1", STILL_STAGED: "1" });
});
