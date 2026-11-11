/**
 * The delete advisor's rules (advice.js): every rule, the level each finding gives, boundaries, and unknowns. An
 * unknown must never read as "nothing found", and no wording may claim more than was observed.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  COPY_MIN_BYTES,
  KNOWN_PATHS,
  RECENT_MINUTES,
  RULES,
  adviseItem,
  ageReasons,
  ago,
  copyReasons,
  credentialKind,
  evidenceReasons,
  homeRelative,
  hubModelId,
  knownPathReason,
  levelOf,
  overallLevel,
  referenceReasons,
} from "../advice.js";

const NOW = 1_800_000_000;
const UNIT = { now: NOW, procs: "all", docker: "ok", git: "ok" };

/** Evidence for one path where every check ran and found nothing. */
const clean = (over = {}) => ({
  type: "dir",
  reported: true,
  uses: [],
  useCount: 0,
  mounts: [],
  mountCount: 0,
  walk: "complete",
  recent: null,
  partial: null,
  credentials: null,
  repos: [],
  gitDirs: { found: 0, checked: 0 },
  inRepo: null,
  ...over,
});
const rulesOf = (r) => r.reasons.map((x) => x.rule);
const item = (evidence, unit = UNIT, extra = {}) => adviseItem("/data/models/x", { evidence, unit, nowMs: NOW * 1000, ...extra });

test("nothing found and everything checked is low and complete", () => {
  const r = item(clean());
  assert.equal(r.level, "low");
  assert.equal(r.complete, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.unchecked, []);
});

test("in use now is high, with the processes named and the space caveat", () => {
  const r = item(clean({ uses: [{ pid: 41, how: "open", program: "python3", target: "/data/models/x/a.bin" }, { pid: 7, how: "mapped", program: "llama-server", target: "/data/models/x/m.gguf" }], useCount: 4 }));
  assert.equal(r.level, "high");
  assert.deepEqual(rulesOf(r), ["in-use"]);
  assert.match(r.reasons[0].text, /open in python3 \(process 41\)/);
  assert.match(r.reasons[0].text, /loaded into memory by llama-server \(process 7\)/);
  assert.match(r.reasons[0].text, /and 2 more processes/);
  assert.match(r.reasons[0].text, /Space held by open files comes back only after/);
  // Only a working folder: no claim about space held.
  const cwd = item(clean({ uses: [{ pid: 9, how: "cwd", program: "bash", target: "/data/models/x" }], useCount: 1 }));
  assert.equal(cwd.level, "high");
  assert.match(cwd.reasons[0].text, /the working folder of bash \(process 9\)/);
  assert.doesNotMatch(cwd.reasons[0].text, /Space held/);
  // A process whose name could not be read is still named by its number.
  assert.match(item(clean({ uses: [{ pid: 3, how: "program", program: null, target: "/data/models/x/bin" }], useCount: 1 })).reasons[0].text, /the running program a program \(process 3\)/);
});

test("only this account's processes seen: not fully checked, at least review", () => {
  const r = item(clean(), { ...UNIT, procs: "own" });
  assert.equal(r.level, "review");
  assert.equal(r.complete, false);
  assert.deepEqual(r.unchecked.map((u) => u.rule), ["processes-others"]);
  assert.match(r.unchecked[0].text, /needs administrator rights/);
  // The process check itself ran out of time.
  const failed = item(clean(), { ...UNIT, procs: "failed" });
  assert.equal(failed.level, "review");
  assert.deepEqual(failed.unchecked.map((u) => u.rule), ["processes"]);
  // Something found and something unknown: the finding's level stands.
  const both = item(clean({ uses: [{ pid: 1, how: "open", program: "x", target: "/data/models/x/a" }], useCount: 1 }), { ...UNIT, procs: "own" });
  assert.equal(both.level, "high");
  assert.equal(both.complete, false);
});

test("containers: a mount of it or inside it is high, a mount around it is review, unknown Docker is not checked", () => {
  const within = item(clean({ mounts: [{ relation: "within", container: "vllm", source: "/data/models/x", destination: "/models" }], mountCount: 1 }));
  assert.equal(within.level, "high");
  assert.match(within.reasons[0].text, /Mounted into the running container “vllm” \(as \/models\)/);
  const around = item(clean({ mounts: [{ relation: "around", container: "app", source: "/data", destination: "/data" }], mountCount: 1 }));
  assert.equal(around.level, "review");
  assert.deepEqual(rulesOf(around), ["container-around"]);
  for (const docker of ["denied", "down", "failed"]) {
    const r = item(clean(), { ...UNIT, docker });
    assert.equal(r.level, "review", docker);
    assert.deepEqual(r.unchecked.map((u) => u.rule), ["containers"], docker);
  }
  // No Docker at all: nothing to check, nothing unknown.
  assert.equal(item(clean(), { ...UNIT, docker: "missing" }).level, "low");
});

test("credentials are high, worded by what the file looks like", () => {
  const r = item(clean({ credentials: { count: 2, sample: ".cache/huggingface/token" } }));
  assert.equal(r.level, "high");
  assert.match(r.reasons[0].text, /looks like a Hugging Face access token: \.cache\/huggingface\/token \(and 1 more such file\)/);
  assert.match(item(clean({ type: "file", credentials: { count: 1, sample: "" } })).reasons[0].text, /^This looks like a private key or saved login\./);
  assert.equal(credentialKind("keys/id_ed25519"), "an SSH private key");
  assert.equal(credentialKind("id_ecdsa_sk"), "an SSH private key");
  assert.equal(credentialKind("a/.aws/credentials"), "AWS access keys");
  assert.equal(credentialKind(".docker/config.json"), "Docker registry logins");
  assert.equal(credentialKind(".kube/config"), "Kubernetes credentials");
  assert.equal(credentialKind(".config/gh/hosts.yml"), "the GitHub CLI login");
  assert.equal(credentialKind(".netrc"), "saved logins (.netrc)");
  assert.equal(credentialKind(".git-credentials"), "saved git passwords");
  assert.equal(credentialKind(".pgpass"), "saved PostgreSQL passwords");
  assert.equal(credentialKind(".gnupg/private-keys-v1.d"), "GnuPG private keys");
});

test("partial downloads and recent changes are review", () => {
  const p = item(clean({ partial: { count: 3, sample: "blobs/abc.incomplete" } }));
  assert.equal(p.level, "review");
  assert.match(p.reasons[0].text, /Holds what looks like a partial download: blobs\/abc\.incomplete \(and 2 more\)\. A download may still be running, or one was interrupted\./);
  assert.match(item(clean({ type: "file", partial: { count: 1, sample: "" } })).reasons[0].text, /^This looks like a partial download\./);
  const r = item(clean({ recent: { count: 1, newest: NOW - 600, sampleType: "file", sample: "model.safetensors" } }));
  assert.equal(r.level, "review");
  assert.equal(r.reasons[0].text, "Changed recently: model.safetensors was written 10 minutes ago.");
  const many = item(clean({ recent: { count: 5, newest: NOW - 3 * 3600, sampleType: "dir", sample: "logs" } }));
  assert.match(many.reasons[0].text, /the folder logs changed 3 hours ago \(something in it was added, removed or renamed\), and 4 other items in it changed in the last 24 hours/);
  const self = item(clean({ type: "file", recent: { count: 1, newest: NOW - 30, sampleType: "file", sample: "" } }));
  assert.equal(self.reasons[0].text, "Changed recently: it was written just now.");
  // The unit's clock missing: the window is named instead of a time.
  assert.match(evidenceReasons(clean({ recent: { count: 1, newest: NOW, sampleType: "file", sample: "a" } }), { ...UNIT, now: null }).reasons[0].text, /in the last 24 hours/);
});

test("a walk that did not finish leaves its parts not checked", () => {
  for (const [walk, words] of [
    ["partial", /could not be read/],
    ["timeout", /Ran out of time before looking through everything/],
    ["skipped", /Ran out of time before looking inside/],
    [null, /Ran out of time before looking inside/],
  ]) {
    const r = item(clean({ walk }));
    assert.equal(r.level, "review", String(walk));
    assert.equal(r.complete, false);
    assert.match(r.unchecked[0].text, words);
  }
});

test("git: uncommitted, unpushed, no remote and stashes are high; untracked is review; clean is a note", () => {
  const repo = (o) => ({ top: "proj", state: "ok", changed: 0, untracked: 0, unpushed: 0, remotes: 1, stashes: 0, ...o });
  const one = (o) => item(clean({ repos: [repo(o)], gitDirs: { found: 1, checked: 1 } }));
  const dirty = one({ changed: 3, untracked: 2 });
  assert.equal(dirty.level, "high");
  assert.deepEqual(rulesOf(dirty), ["git-uncommitted"]);
  assert.equal(dirty.reasons[0].text, "The git repository proj inside it has 3 changed files not committed; 2 files git does not track.");
  const ahead = one({ unpushed: 2 });
  assert.deepEqual(rulesOf(ahead), ["git-unpushed"]);
  assert.match(ahead.reasons[0].text, /2 commits that no remote branch holds \(as of its last fetch\)/);
  const local = one({ unpushed: 1, remotes: 0 });
  assert.equal(local.level, "high");
  assert.match(local.reasons[0].text, /no remote, so its 1 commit exists only on this Spark/);
  assert.deepEqual(rulesOf(one({ stashes: 1 })), ["git-stash"]);
  const untracked = one({ untracked: 4 });
  assert.equal(untracked.level, "review");
  assert.deepEqual(rulesOf(untracked), ["git-untracked"]);
  const tidy = one({});
  assert.equal(tidy.level, "low");
  assert.deepEqual(rulesOf(tidy), ["git-clean"]);
  assert.match(tidy.reasons[0].text, /as of its last fetch/);
  // The path itself is the repository.
  assert.match(item(clean({ repos: [repo({ top: ".", changed: 1 })] })).reasons[0].text, /^This git repository has 1 changed file/);
  // The path is a .git folder: its history.
  const history = item(clean({ repos: [repo({ top: "" })] }));
  assert.equal(history.level, "review");
  assert.deepEqual(rulesOf(history).sort(), ["git-clean", "git-history"]);
});

test("git that could not look is not checked, never clean", () => {
  const repo = (state) => ({ top: "proj", state, changed: 0, untracked: 0, unpushed: 0, remotes: 0, stashes: 0 });
  for (const [state, unit, words] of [
    ["refused", UNIT, /belongs to another account/],
    ["timeout", UNIT, /Ran out of time checking/],
    ["error", UNIT, /git could not read/],
    ["skipped", { ...UNIT, git: "missing" }, /git is not installed/],
    ["skipped", { ...UNIT, git: "old" }, /older than 2\.35\.2/],
    ["skipped", UNIT, /no time was left/],
  ]) {
    const r = item(clean({ repos: [repo(state)], gitDirs: { found: 1, checked: 0 } }), unit);
    assert.equal(r.level, "review", state);
    assert.equal(r.complete, false, state);
    assert.deepEqual(r.reasons, [], state);
    assert.match(r.unchecked[0].text, words, state);
  }
  // More repositories found than reported.
  const more = item(clean({ repos: [repo("ok")], gitDirs: { found: 14, checked: 10 } }));
  assert.match(more.unchecked[0].text, /13 more git repositories inside were not checked/);
});

test("inside a repository: history is high, uncommitted high, untracked review, ignored and committed are notes", () => {
  const inside = (o) => item(clean({ type: "file", inRepo: { top: "/src/proj", relation: "tree", state: "ok", changed: 0, untracked: 0, tracked: false, ignored: false, ...o } }));
  assert.equal(inside({ relation: "history" }).level, "high");
  assert.deepEqual(rulesOf(inside({ relation: "history" })), ["in-repo-history"]);
  assert.equal(inside({ changed: 1 }).level, "high");
  assert.match(inside({ changed: 2 }).reasons[0].text, /2 files in it have changes that are not committed/);
  assert.equal(inside({ untracked: 1 }).level, "review");
  assert.equal(inside({ ignored: true }).level, "low");
  assert.deepEqual(rulesOf(inside({ ignored: true })), ["in-repo-ignored"]);
  assert.deepEqual(rulesOf(inside({ tracked: true })), ["in-repo-clean"]);
  assert.match(inside({ tracked: true }).reasons[0].text, /Files git ignores are not counted/);
  for (const state of ["refused", "timeout", "skipped", "error"]) {
    const r = inside({ state });
    assert.equal(r.level, "review", state);
    assert.equal(r.unchecked[0].rule, "git", state);
  }
});

test("missing and unreported items", () => {
  const gone = item(clean({ type: null }));
  assert.equal(gone.level, "low");
  assert.deepEqual(rulesOf(gone), ["missing"]);
  const cut = item(clean({ reported: false }));
  assert.equal(cut.level, "review");
  assert.equal(cut.complete, false);
  assert.equal(cut.unchecked[0].rule, "not-reported");
  assert.deepEqual(cut.reasons, []);
});

test("known places: the most specific match, home folders anywhere, notes never change the level", () => {
  assert.equal(homeRelative("/home/me/.cache/x"), ".cache/x");
  assert.equal(homeRelative("/root/.config"), ".config");
  assert.equal(homeRelative("/data/users/me/.ssh2", ["/data/users/me"]), ".ssh2");
  assert.equal(homeRelative("/home/me"), null);
  assert.equal(homeRelative("/data/x"), null);
  assert.equal(hubModelId("models--Qwen--Qwen3-8B"), "Qwen/Qwen3-8B");
  assert.equal(hubModelId("datasets--x"), null);
  const model = knownPathReason("/home/me/.cache/huggingface/hub/models--Qwen--Qwen3-8B/blobs");
  assert.equal(model.level, "note");
  assert.match(model.text, /\(Qwen\/Qwen3-8B\)/);
  assert.equal(knownPathReason("/home/me/.cache/huggingface/hub/models--").level, "note", "a bare prefix falls back to the cache");
  assert.match(knownPathReason("/home/me/.cache/huggingface/hub/models--").text, /download cache/);
  assert.equal(knownPathReason("/root/.gnupg/pubring.kbx").level, "high");
  assert.equal(knownPathReason("/home/me/.config").level, "review");
  assert.match(knownPathReason("/home/me/.config/Code/User").text, /Settings of Code/);
  assert.equal(knownPathReason("/home/me/.bashrc").level, "review");
  assert.equal(knownPathReason("/data/u/.bashrc", ["/data/u"]).level, "review");
  assert.equal(knownPathReason("/data/u/.bashrc"), null, "not a home folder");
  assert.match(knownPathReason("/var/lib/mysql/ibdata1").text, /\(mysql\)/);
  assert.equal(knownPathReason("/var/log/syslog.1").level, "note");
  assert.equal(knownPathReason("/opt/nvidia").level, "review");
  assert.equal(knownPathReason("/data/models"), null);
  // Every table entry is reachable and well formed.
  for (const k of KNOWN_PATHS) {
    assert.ok(["note", "review", "high"].includes(k.level), JSON.stringify(k));
    assert.ok((k.home != null) !== (k.abs != null), JSON.stringify(k));
    const sample = k.home != null ? `/home/me/${k.home.replaceAll("*", "x1")}` : k.abs.replaceAll("*", "x1");
    assert.ok(knownPathReason(sample), sample);
  }
  // A cache note alongside nothing else: still low.
  assert.equal(adviseItem("/home/me/.cache/pip", { evidence: clean(), unit: UNIT, nowMs: NOW * 1000 }).level, "low");
  // A high known place raises the level.
  assert.equal(adviseItem("/home/me/.aws", { evidence: clean(), unit: UNIT, nowMs: NOW * 1000 }).level, "high");
});

test("SparkDash's launchers and watched LLM servers", () => {
  const launchers = [{ name: "Qwen", dir: "~/llm/qwen", startScript: "go.sh" }, { name: "Abs", dir: "/srv/models/abs/" }];
  const refs = { launchers, home: "/home/me" };
  assert.match(referenceReasons("/home/me/llm/qwen", refs)[0].text, /“Qwen” starts from this folder \(go\.sh\)/);
  assert.match(referenceReasons("/home/me/llm", refs)[0].text, /Holds the folder of SparkDash's model launcher “Qwen” \(\/home\/me\/llm\/qwen\)/);
  assert.match(referenceReasons("/srv/models/abs/weights.bin", refs)[0].text, /Inside the folder of SparkDash's model launcher “Abs”/);
  assert.deepEqual(referenceReasons("/home/me/other", refs), []);
  assert.deepEqual(referenceReasons("/home/me/llm/qwen", { launchers, home: null }), [], "~ is not guessed");
  assert.deepEqual(referenceReasons("/home/me/llm/qwen2", refs), [], "a name that only starts the same is not inside");
  const llm = [{ port: 8000, modelPath: "/models/x.gguf", modelId: "x" }, { port: 8001, modelId: "Qwen/Qwen3-8B", models: [] }];
  assert.match(referenceReasons("/models", { llm })[0].text, /on port 8000 that SparkDash watches reports its model at \/models\/x\.gguf/);
  const hub = referenceReasons("/home/me/.cache/huggingface/hub/models--qwen--qwen3-8b/snapshots", { llm });
  assert.equal(hub.length, 1);
  assert.match(hub[0].text, /serves qwen\/qwen3-8b, the model in this Hugging Face download \(matched by name\)/);
  const holds = referenceReasons("/home/me/.cache/huggingface", { llm, hubNames: ["models--Qwen--Qwen3-8B", "models--other--m"] });
  assert.match(holds[0].text, /Holds the Hugging Face download of Qwen\/Qwen3-8B, which the LLM server on port 8001/);
  assert.equal(adviseItem("/home/me/llm/qwen", { evidence: clean(), unit: UNIT, refs, nowMs: NOW * 1000 }).level, "review");
});

test("same name and size on other Sparks is a note, worded as such, from 1 MiB", () => {
  const entry = { path: "/data/m.gguf", bytes: 5 * COPY_MIN_BYTES, type: "file" };
  const others = [
    { sparkId: "s2", name: "Spark Two", analysedAt: (NOW - 2 * 86400) * 1000, entries: [{ path: "/home/x/m.gguf", bytes: entry.bytes, type: "file" }] },
    { sparkId: "s3", name: "Spark Three", analysedAt: 0, entries: [{ path: "/data/m.gguf", bytes: entry.bytes + 1, type: "file" }] },
    { sparkId: "s4", name: "Spark Four", analysedAt: 0, entries: [{ path: "/data/m.gguf", bytes: entry.bytes, type: "dir" }] },
  ];
  const r = copyReasons(entry, others, NOW * 1000);
  assert.equal(r.length, 1);
  assert.equal(r[0].level, "note");
  assert.equal(r[0].text, "A file with the same name and size is in the saved analysis of Spark Two (/home/x/m.gguf, analysed 2 days ago). Same name and size does not prove the contents are the same.");
  assert.deepEqual(copyReasons({ ...entry, bytes: COPY_MIN_BYTES - 1 }, [{ ...others[0], entries: [{ ...others[0].entries[0], bytes: COPY_MIN_BYTES - 1 }] }], NOW * 1000), [], "below 1 MiB");
  assert.equal(copyReasons({ ...entry, bytes: COPY_MIN_BYTES }, [{ ...others[0], entries: [{ ...others[0].entries[0], bytes: COPY_MIN_BYTES }] }], NOW * 1000).length, 1, "exactly 1 MiB");
  assert.deepEqual(copyReasons(null, others, NOW * 1000), []);
  const many = Array.from({ length: 5 }, (_, k) => ({ ...others[0], sparkId: `s${k}`, name: `S${k}` }));
  assert.equal(copyReasons(entry, many, NOW * 1000).length, 3, "at most three Sparks");
  // A copy never lowers the level.
  const busy = adviseItem("/data/m.gguf", { evidence: clean({ type: "file", useCount: 1, uses: [{ pid: 1, how: "open", program: "x", target: "/data/m.gguf" }] }), unit: UNIT, entry, others, nowMs: NOW * 1000 });
  assert.equal(busy.level, "high");
  assert.deepEqual(rulesOf(busy), ["in-use", "copy-elsewhere"]);
});

test("last changed from the analysis: a note, or review when it was recent and could not be checked again", () => {
  const session = { analysedAt: (NOW - 3600) * 1000 };
  assert.deepEqual(ageReasons({ modifiedAt: NOW - 200 * 86400 }, session, NOW, NOW * 1000, true).map((r) => [r.rule, r.level, r.text]), [
    ["age", "note", "Last changed 6 months ago, according to the analysis from 1 hour ago."],
  ]);
  const recent = ageReasons({ modifiedAt: NOW - 3600 }, session, NOW, NOW * 1000, false);
  assert.equal(recent[0].rule, "recent-analysis");
  assert.equal(recent[0].level, "review");
  // Boundary: exactly the window counts as recent; one second past does not.
  assert.equal(ageReasons({ modifiedAt: NOW - RECENT_MINUTES * 60 }, session, NOW, NOW * 1000, false)[0].rule, "recent-analysis");
  assert.equal(ageReasons({ modifiedAt: NOW - RECENT_MINUTES * 60 - 1 }, session, NOW, NOW * 1000, false)[0].rule, "age");
  // Checked again now: the live check speaks for recent changes; the analysis only adds the date.
  assert.equal(ageReasons({ modifiedAt: NOW - 60 }, session, NOW, NOW * 1000, true)[0].rule, "age");
  assert.deepEqual(ageReasons({}, session, NOW, NOW * 1000, true), [], "no date: nothing said");
  assert.deepEqual(ageReasons({ modifiedAt: 100 }, session, NOW, NOW * 1000, true), [], "placeholder dates are ignored");
  assert.match(ageReasons({ modifiedAt: NOW - 86400 * 400 }, null, NOW, NOW * 1000, true)[0].text, /1 year ago, according to the analysis\.$/);
});

test("levels: notes never count, unknowns make review, the highest item wins", () => {
  assert.deepEqual(levelOf([{ rule: "age", level: "note", text: "" }], []), { level: "low", complete: true });
  assert.deepEqual(levelOf([], [{ rule: "walk", text: "" }]), { level: "review", complete: false });
  assert.deepEqual(levelOf([{ rule: "in-use", level: "high", text: "" }], [{ rule: "walk", text: "" }]), { level: "high", complete: false });
  assert.deepEqual(overallLevel([{ level: "low", complete: true }, { level: "high", complete: true }, { level: "review", complete: false }]), { level: "high", complete: false });
  assert.deepEqual(overallLevel([{ level: "low", complete: true }]), { level: "low", complete: true });
  // A recent change the Spark just saw: the analysis's date is not repeated.
  const fresh = item(clean({ recent: { count: 1, newest: NOW - 60, sampleType: "file", sample: "a" } }), UNIT, { entry: { path: "/data/models/x", bytes: 1, type: "dir", modifiedAt: NOW - 60 } });
  assert.deepEqual(rulesOf(fresh), ["recent-write"]);
  // Reasons come highest first, notes last.
  const r = item(clean({ partial: { count: 1, sample: "a.part" }, credentials: { count: 1, sample: "id_rsa" } }), UNIT, { entry: { path: "/data/models/x", bytes: 1, type: "dir", modifiedAt: NOW - 400 * 86400 } });
  assert.deepEqual(r.reasons.map((x) => x.level), ["high", "review", "note"]);
});

test("every rule has a level and a description, and wording never claims more than was seen", () => {
  for (const [id, rule] of Object.entries(RULES)) {
    assert.ok(["note", "review", "high"].includes(rule.level), id);
    assert.ok(rule.what.length > 10, id);
  }
  const texts = [];
  const evs = [
    clean({ uses: [{ pid: 1, how: "open", program: "p", target: "/x" }], useCount: 1, mounts: [{ relation: "within", container: "c", source: "/x", destination: "/y" }, { relation: "around", container: "c", source: "/", destination: "/" }], mountCount: 2 }),
    clean({ credentials: { count: 1, sample: "id_rsa" }, partial: { count: 1, sample: "a.part" }, recent: { count: 2, newest: NOW, sampleType: "dir", sample: "a" } }),
    clean({ repos: [{ top: "", state: "ok", changed: 1, untracked: 1, unpushed: 1, remotes: 0, stashes: 1 }, { top: "b", state: "refused", changed: 0, untracked: 0, unpushed: 0, remotes: 0, stashes: 0 }], gitDirs: { found: 5, checked: 2 } }),
    clean({ inRepo: { top: "/r", relation: "tree", state: "ok", changed: 0, untracked: 0, tracked: true, ignored: false } }),
    clean({ walk: "partial", type: null }),
    clean({ reported: false }),
  ];
  for (const ev of evs) {
    for (const unit of [UNIT, { ...UNIT, procs: "own", docker: "denied", git: "old" }]) {
      const r = adviseItem("/home/me/.cache/huggingface", { evidence: ev, unit, entry: { path: "/home/me/.cache/huggingface", bytes: 9e9, type: "dir", modifiedAt: NOW }, others: [{ sparkId: "b", name: "B", analysedAt: 1, entries: [{ path: "/z/huggingface", bytes: 9e9, type: "dir" }] }], nowMs: NOW * 1000 });
      texts.push(...r.reasons.map((x) => x.text), ...r.unchecked.map((x) => x.text));
    }
  }
  for (const k of KNOWN_PATHS) texts.push(k.text);
  assert.ok(texts.length > 30);
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(safe|safely|identical|harmless|guaranteed)\b/i, t);
    assert.ok(t.endsWith("."), t);
  }
});

test("ago", () => {
  assert.equal(ago(NOW, NOW), "just now");
  assert.equal(ago(NOW + 50, NOW), "just now", "a clock ahead reads as now");
  assert.equal(ago(NOW - 59, NOW), "just now");
  assert.equal(ago(NOW - 60, NOW), "1 minute ago");
  assert.equal(ago(NOW - 3599, NOW), "59 minutes ago");
  assert.equal(ago(NOW - 3600, NOW), "1 hour ago");
  assert.equal(ago(NOW - 86_399, NOW), "23 hours ago");
  assert.equal(ago(NOW - 86_400, NOW), "yesterday");
  assert.equal(ago(NOW - 29 * 86_400, NOW), "29 days ago");
  assert.equal(ago(NOW - 31 * 86_400, NOW), "1 month ago");
  assert.equal(ago(NOW - 800 * 86_400, NOW), "2 years ago");
  // Calendar months: two years to the day is two years, not "1 year" from 30-day months.
  const day = (iso) => Math.floor(Date.parse(iso) / 1000);
  assert.equal(ago(day("2024-10-27T12:00:00Z"), day("2026-10-27T12:00:00Z")), "2 years ago");
  assert.equal(ago(day("2026-01-31T12:00:00Z"), day("2026-03-01T12:00:00Z")), "29 days ago");
  assert.equal(ago(day("2026-01-31T12:00:00Z"), day("2026-03-02T12:00:00Z")), "1 month ago");
  assert.equal(ago(day("2026-01-15T12:00:00Z"), day("2026-03-14T12:00:00Z")), "1 month ago");
  assert.equal(ago(day("2025-11-02T12:00:00Z"), day("2026-10-27T12:00:00Z")), "11 months ago");
});
