/** The delete advisor's answer from the Spark (parseAdviseOutput): what it says, and that gaps read as unknown. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildProgram, parseAdviseOutput, scriptText } from "../commands.js";

const hex = (s) => Buffer.from(s, "utf8").toString("hex");

const FULL = [
  "RESULT=ok",
  "NOW=1800000000",
  "UID=1000",
  `HOME_HEX=${hex("/home/me")}`,
  `USE=1|4121|f|${hex("python3")}|${hex("/data/a/w.bin")}`,
  `USE=1|77|c|${hex("bash")}|${hex("/data/a")}`,
  "USES=1|3",
  `MNT=2|within|${hex("vllm")}|${hex("/data/b")}|${hex("/models")}`,
  "MNTS=2|1",
  "PROCS=own",
  "DOCKER=ok",
  "GIT=ok",
  "P=1|d",
  "WALK=1|0",
  `RECENT=1|4|1799999000|f|${hex("w.bin")}`,
  `PART=1|1|${hex("dl/x.incomplete")}`,
  `CRED=1|2|${hex(".cache/huggingface/token")}`,
  `REPO=1|${hex("proj")}|ok|3|1|2|1|0`,
  `REPO=1|${hex("other")}|refused|0|0|0|0|0`,
  "GITDIRS=1|2|1",
  "P=2|f",
  `INREPO=2|${hex("/data/repo")}|tree|ok|1|0|1|0`,
  "WALK=2|124",
  "P=3|-",
  "",
].join("\n");

test("a full answer", () => {
  const r = parseAdviseOutput(FULL, 3);
  assert.equal(r.ok, true);
  assert.equal(r.now, 1_800_000_000);
  assert.equal(r.uid, 1000);
  assert.equal(r.home, "/home/me");
  assert.equal(r.procs, "own");
  assert.equal(r.docker, "ok");
  assert.equal(r.git, "ok");
  const [a, b, c] = r.items;
  assert.equal(a.type, "dir");
  assert.equal(a.reported, true);
  assert.deepEqual(a.uses, [
    { pid: 4121, how: "open", program: "python3", target: "/data/a/w.bin" },
    { pid: 77, how: "cwd", program: "bash", target: "/data/a" },
  ]);
  assert.equal(a.useCount, 3);
  assert.equal(a.walk, "complete");
  assert.deepEqual(a.recent, { count: 4, newest: 1_799_999_000, sampleType: "file", sample: "w.bin" });
  assert.deepEqual(a.partial, { count: 1, sample: "dl/x.incomplete" });
  assert.deepEqual(a.credentials, { count: 2, sample: ".cache/huggingface/token" });
  assert.deepEqual(a.repos, [
    { top: "proj", state: "ok", changed: 3, untracked: 1, unpushed: 2, remotes: 1, stashes: 0 },
    { top: "other", state: "refused", changed: 0, untracked: 0, unpushed: 0, remotes: 0, stashes: 0 },
  ]);
  assert.deepEqual(a.gitDirs, { found: 2, checked: 1 });
  assert.equal(b.type, "file");
  assert.deepEqual(b.mounts, [{ relation: "within", container: "vllm", source: "/data/b", destination: "/models" }]);
  assert.equal(b.mountCount, 1);
  assert.deepEqual(b.inRepo, { top: "/data/repo", relation: "tree", state: "ok", changed: 1, untracked: 0, tracked: true, ignored: false });
  assert.equal(b.walk, "timeout");
  assert.equal(c.type, null, "not there");
  assert.equal(c.reported, true);
  assert.equal(c.walk, null);
});

test("lines that are cut off or missing read as unknown, never as nothing found", () => {
  // The answer stopped after the first path: the second was never reported.
  const cut = parseAdviseOutput("RESULT=ok\nNOW=1\nP=1|d\nWALK=1|0\n", 2);
  assert.equal(cut.items[0].reported, true);
  assert.equal(cut.items[1].reported, false);
  // Without the PROCS and DOCKER lines nothing counts as checked.
  assert.equal(cut.procs, "failed");
  assert.equal(cut.docker, "failed");
  assert.equal(cut.git, "missing");
  // An unknown walk code or a damaged line is dropped.
  const odd = parseAdviseOutput("RESULT=ok\nPROCS=everything\nDOCKER=maybe\nP=1|d\nWALK=1|7\nREPO=1|zz|ok|1|1|1|1|1\nREPO=1|61|weird|0|0|0|0|0\nINREPO=1|72|tree|ok|1|1|1|1\n", 1);
  assert.equal(odd.procs, "failed");
  assert.equal(odd.docker, "failed");
  assert.equal(odd.items[0].walk, null);
  assert.deepEqual(odd.items[0].repos, []);
  assert.equal(odd.items[0].inRepo, null, "a repository top that is not an absolute path");
});

test("positions outside the request and listed processes beyond five are ignored", () => {
  const lines = ["RESULT=ok", "PROCS=all", "DOCKER=missing", "P=0|d", "P=3|d", "P=x|d", "P=1|f"];
  for (let k = 0; k < 8; k++) lines.push(`USE=1|${k + 10}|m|${hex("p")}|${hex(`/a/${k}`)}`);
  const r = parseAdviseOutput(lines.join("\n"), 2);
  assert.equal(r.items[0].type, "file");
  assert.equal(r.items[1].reported, false);
  assert.equal(r.items[0].uses.length, 5);
  assert.equal(r.items[0].useCount, 5, "the count is at least what was listed");
});

test("names from the Spark are decoded and kept to one plain line", () => {
  const r = parseAdviseOutput(["RESULT=ok", `USE=1|5|f|${hex("evil\nRESULT=error")}|${hex("/a/b\u0007c")}`, `MNT=1|around|${hex("c\r")}|${hex("/a")}|`, `PART=1|1|${hex("x\ty.part")}`, "MNT=1|within|zz|61|", `USE=1|6|f|${hex("p")}|${hex("relative")}`, "HOME_HEX=7a"].join("\n"), 1);
  assert.equal(r.items[0].uses.length, 1);
  assert.equal(r.items[0].uses[0].program, "evil?RESULT=error");
  assert.equal(r.items[0].uses[0].target, "/a/b?c");
  assert.deepEqual(r.items[0].mounts, [{ relation: "around", container: "c?", source: "/a", destination: null }]);
  assert.equal(r.items[0].partial.sample, "x?y.part");
  assert.equal(r.home, null, "a home that is not an absolute path");
});

test("a refusal and an answer without RESULT", () => {
  assert.deepEqual(parseAdviseOutput("RESULT=error\nCODE=no-sh\nMSG=sh is not installed\n", 1).code, "no-sh");
  assert.equal(parseAdviseOutput("garbage", 1).code, "bad-output");
  assert.equal(parseAdviseOutput("", 1).ok, false);
});

test("the program is read-only: no sudo, no unit lock, arguments travel encoded", () => {
  const prog = buildProgram("advise", { args: [1440, 20, "/data/it's $(rm -rf ~)"] });
  // Not elevated (the sudo gate is a no-op with SUDO empty) and no unit lock.
  assert.match(prog, /^SUDO=""$/m);
  assert.doesNotMatch(prog, /SUDO="(sudo|spw_sudo)/);
  assert.doesNotMatch(prog, /sd_lock|sd_state_init/);
  assert.doesNotMatch(prog, /rm -rf ~/, "the path is never in the program text");
  const code = scriptText("advise")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // Nothing in the script removes, moves or writes files.
  assert.doesNotMatch(code, /(^|[\s;|&(])(rm|mv|cp|chmod|chown|mkdir|touch|tee|truncate|mktemp|ln)\s/m);
  assert.doesNotMatch(code, /(^|[^0-9&>])>{1,2}\s*["$][A-Za-z{]/m, "no output redirected into a file");
  // git is never told to trust a repository it would refuse.
  assert.doesNotMatch(code, /safe\.directory/);
});
