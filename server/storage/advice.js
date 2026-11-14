/**
 * The delete advisor: how careful to be before deleting a path, from evidence only. Pure functions, no I/O.
 *
 * Evidence comes from the Spark (scripts/advise.sh, parsed by parseAdviseOutput) and from what the dashboard already
 * keeps: its saved analyses, its model launchers and the LLM servers it watches. Every reason says what was seen,
 * where; nothing is guessed. A check that could not run is listed as not checked and never reads as "nothing found".
 *
 * Levels: "low" (nothing found and everything checked), "review" (something worth a look, or not fully checked),
 * "high" (in use now, unsaved work, credentials). Notes add context and never change the level, up or down.
 * RULES below is the one table of what each finding means; KNOWN_PATHS the one table of known places.
 */

/** @typedef {"low" | "review" | "high"} AdviceLevel */
/** @typedef {AdviceLevel | "note"} ReasonLevel */
/** @typedef {{ rule: string, level: ReasonLevel, text: string }} AdviceReason */
/** @typedef {{ rule: string, text: string }} AdviceUnchecked */

/** Entries changed within this many minutes count as changed recently. */
export const RECENT_MINUTES = 24 * 60;
/** Items smaller than this are not matched against other Sparks' analyses (same-size small files are common). */
export const COPY_MIN_BYTES = 1024 * 1024;

/** What each finding means. `level`: the least the item's level becomes when the rule fires ("note": unchanged). */
export const RULES = Object.freeze({
  // In use now (scripts/advise.sh: /proc and Docker).
  "in-use": { level: "high", what: "A program has it open, works in it, runs from it or has it mapped into memory" },
  "container-mount": { level: "high", what: "A running container mounts it, or something inside it" },
  "container-around": { level: "review", what: "It is inside a folder that a running container mounts" },
  // Work that exists only here (git).
  "git-uncommitted": { level: "high", what: "A git repository in it has changes that are not committed" },
  "git-unpushed": { level: "high", what: "A git repository in it has commits that no remote branch holds" },
  "git-stash": { level: "high", what: "A git repository in it has stashed changes" },
  "git-untracked": { level: "review", what: "A git repository in it has files git does not track" },
  "git-clean": { level: "note", what: "A git repository in it with nothing uncommitted or unpushed" },
  "git-history": { level: "review", what: "It is a git repository's history folder (.git)" },
  "in-repo-history": { level: "high", what: "It is part of a git repository's history folder (.git)" },
  "in-repo-uncommitted": { level: "high", what: "It is inside a git repository and has uncommitted changes" },
  "in-repo-untracked": { level: "review", what: "It is inside a git repository and git does not track it" },
  "in-repo-ignored": { level: "note", what: "It is inside a git repository that ignores it" },
  "in-repo-clean": { level: "note", what: "It is committed in a git repository with no uncommitted changes" },
  // Contents.
  credentials: { level: "high", what: "It holds what looks like a private key or a saved login" },
  "partial-download": { level: "review", what: "It holds what looks like a partial download (*.incomplete, *.part, ...)" },
  "recent-write": { level: "review", what: "Something in it changed recently" },
  "recent-analysis": { level: "review", what: "The analysis saw it change recently (it could not be checked again)" },
  // The dashboard's own references.
  "sparkdash-launcher": { level: "review", what: "A SparkDash model launcher uses it" },
  "sparkdash-llm": { level: "review", what: "An LLM server SparkDash watches reports it as its model" },
  // Known places (KNOWN_PATHS sets the level of each).
  "known-path": { level: "note", what: "A known place" },
  // Context only.
  "copy-elsewhere": { level: "note", what: "Another Spark's saved analysis lists an item with the same name and size" },
  age: { level: "note", what: "When it last changed, according to the analysis" },
  missing: { level: "note", what: "It is no longer on the Spark" },
});

/**
 * Known places, matched on the path itself or a folder above it; the most specific match wins. `home`: relative to a
 * home folder (any /home/<name>, /root, or the account's own home). `*` matches one name. `{name}` in the text is the
 * name `*` matched; `{model}` a Hugging Face model id.
 * @type {readonly { home?: string, abs?: string, level: ReasonLevel, text: string }[]}
 */
export const KNOWN_PATHS = Object.freeze([
  { home: ".cache/huggingface/hub/models--*", level: "note", text: "A model downloaded from Hugging Face ({model}). It can be downloaded again while its repository is still available." },
  { home: ".cache/huggingface/hub/datasets--*", level: "note", text: "A dataset downloaded from Hugging Face. It can be downloaded again while its repository is still available." },
  { home: ".cache/huggingface", level: "note", text: "The Hugging Face download cache. Downloads in it can be fetched again while their repositories are available; a login saved here is lost." },
  { home: ".cache", level: "note", text: "A cache folder: programs usually re-create what they need, though large downloads take time to fetch again." },
  { home: ".gnupg", level: "high", text: "GnuPG keys and trust settings. A private key deleted here cannot be recovered." },
  { home: ".aws", level: "high", text: "AWS command-line settings and access keys." },
  { home: ".kube", level: "high", text: "Kubernetes cluster settings and credentials." },
  { home: ".docker", level: "review", text: "Docker client settings, which can hold registry logins." },
  { home: ".config", level: "review", text: "Settings of the programs this account uses." },
  { home: ".config/*", level: "review", text: "Settings of {name} for this account." },
  { home: ".local/share", level: "review", text: "Data that programs keep for this account." },
  { home: ".local/share/*", level: "review", text: "Data that {name} keeps for this account." },
  { home: ".local/bin", level: "review", text: "Programs installed for this account: commands that use them stop working." },
  { home: ".ollama", level: "review", text: "Ollama's downloaded models and its key." },
  { home: ".bashrc", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: ".bash_profile", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: ".bash_aliases", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: ".profile", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: ".zshrc", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: ".zprofile", level: "review", text: "Shell start-up settings: deleting it changes how terminals and logins behave." },
  { home: "miniconda3", level: "review", text: "Conda Python environments: programs that use them stop working." },
  { home: "anaconda3", level: "review", text: "Conda Python environments: programs that use them stop working." },
  { home: "miniforge3", level: "review", text: "Conda Python environments: programs that use them stop working." },
  { home: ".conda", level: "review", text: "Conda Python environments: programs that use them stop working." },
  { home: ".vscode-server", level: "note", text: "An editor's remote helper; the editor installs it again the next time it connects." },
  { home: ".cursor-server", level: "note", text: "An editor's remote helper; the editor installs it again the next time it connects." },
  { home: ".nv", level: "note", text: "NVIDIA's cache of compiled GPU code; it is rebuilt when needed (the first runs after are slower)." },
  { home: ".triton", level: "note", text: "Triton's cache of compiled GPU kernels; it is rebuilt when needed (the first runs after are slower)." },
  { abs: "/var/log/*", level: "note", text: "System logs: deleting them loses their history. A program still writing one keeps its space until it reopens the file." },
  { abs: "/var/cache/*", level: "note", text: "A system cache, usually re-created when needed." },
  { abs: "/var/lib/*", level: "review", text: "Data that a system service keeps ({name}): databases, package or service state." },
  { abs: "/tmp/*", level: "note", text: "Temporary files." },
  { abs: "/var/tmp/*", level: "note", text: "Temporary files." },
  { abs: "/opt/*", level: "review", text: "Software installed outside the package manager ({name})." },
  { abs: "/usr/local/*", level: "review", text: "Software installed by hand for the whole Spark." },
  { abs: "/usr/share/*", level: "review", text: "Shared files of installed packages. Use the package manager to remove software." },
]);

const LEVEL_RANK = { low: 0, review: 1, high: 2 };
const higher = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1) || p;
const isInside = (p, root) => p === root || p.startsWith(`${root}/`);
const quoted = (s) => `“${s}”`;
const capital = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

/**
 * How long ago `then` was, from `now` (both in whole seconds by one clock): "just now", "1 minute ago", "12 minutes ago",
 * "3 hours ago", "yesterday", "5 days ago", "4 months ago", "2 years ago".
 */
export function ago(then, now) {
  const s = Math.max(0, now - then);
  if (s < 60) return "just now";
  if (s < 3600) return `${plural(Math.floor(s / 60), "minute")} ago`;
  if (s < 86_400) return `${plural(Math.floor(s / 3600), "hour")} ago`;
  const days = Math.floor(s / 86_400);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  // Whole calendar months (UTC): the 27th to the 27th is a month whatever its length.
  const [a, b] = [new Date(Math.min(then, now) * 1000), new Date(now * 1000)];
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
  if (months < 12) return `${plural(Math.max(1, months), "month")} ago`;
  return `${plural(Math.floor(months / 12), "year")} ago`;
}

/** A Hugging Face hub folder name (`models--org--name`) as the model id (`org/name`), or null. */
export function hubModelId(name) {
  const m = /^models--(.+)$/.exec(name);
  return m ? m[1].split("--").join("/") : null;
}

/** The part of `p` after a home folder (`/home/<name>`, `/root`, or one of `homes`), or null when not in one. */
export function homeRelative(p, homes = []) {
  const roots = [...homes.filter((h) => typeof h === "string" && h.startsWith("/") && h.length > 1)];
  const m = /^(\/home\/[^/]+|\/root)(\/.*)?$/.exec(p);
  if (m) roots.push(m[1]);
  let best = null;
  for (const root of roots) {
    if (p.startsWith(`${root}/`) && (best == null || root.length > best.length)) best = root;
  }
  return best == null ? null : p.slice(best.length + 1);
}

/**
 * Pattern names match path names one by one: "*" matches any one name, "prefix*" a name that starts with the prefix
 * (and has more after it), anything else only itself. Returns the names the wildcards matched, or null.
 */
function matchPrefix(names, pattern) {
  const want = pattern.split("/");
  if (names.length < want.length) return null;
  const caught = [];
  for (let k = 0; k < want.length; k++) {
    const [w, n] = [want[k], names[k]];
    if (w === "*") caught.push(n);
    else if (w.endsWith("*")) {
      const pre = w.slice(0, -1);
      if (!n.startsWith(pre) || n.length === pre.length) return null;
      caught.push(n);
    } else if (n !== w) return null;
  }
  return caught;
}

/**
 * The known place `p` is, or is inside, as a reason (the most specific match), or null.
 * @param {string} p
 * @param {string[]} homes extra home folders (the account's own, as the Spark reported it)
 * @returns {AdviceReason | null}
 */
export function knownPathReason(p, homes = []) {
  const rel = homeRelative(p, homes);
  let best = null;
  for (const k of KNOWN_PATHS) {
    const names = k.home != null ? (rel == null ? null : rel.split("/")) : p.split("/").slice(1);
    const pattern = k.home ?? k.abs.slice(1);
    if (!names) continue;
    const caught = matchPrefix(names, pattern);
    if (!caught) continue;
    const depth = pattern.split("/").length;
    if (best && best.depth >= depth) continue;
    const name = caught[caught.length - 1] ?? "";
    const text = k.text.replace("{name}", name).replace("{model}", hubModelId(name) ?? name);
    best = { depth, reason: { rule: "known-path", level: k.level, text } };
  }
  return best?.reason ?? null;
}

const HOW_WORDS = {
  open: (prog, pid) => `open in ${prog} (process ${pid})`,
  mapped: (prog, pid) => `loaded into memory by ${prog} (process ${pid})`,
  program: (prog, pid) => `the running program ${prog} (process ${pid})`,
  cwd: (prog, pid) => `the working folder of ${prog} (process ${pid})`,
};

/** What a file name that looks like a key or a saved login is. */
export function credentialKind(sample) {
  const name = baseName(sample);
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(name)) return "an SSH private key";
  if (name === ".netrc") return "saved logins (.netrc)";
  if (name === ".git-credentials") return "saved git passwords";
  if (name === ".pgpass") return "saved PostgreSQL passwords";
  if (/(^|\/)\.aws\/credentials$/.test(sample)) return "AWS access keys";
  if (/(^|\/)\.docker\/config\.json$/.test(sample)) return "Docker registry logins";
  if (/(^|\/)\.kube\/config$/.test(sample)) return "Kubernetes credentials";
  if (/(^|\/)gh\/hosts\.yml$/.test(sample)) return "the GitHub CLI login";
  if (/(^|\/)huggingface\/(token|stored_tokens)$/.test(sample)) return "a Hugging Face access token";
  if (/(^|\/)\.gnupg\/private-keys-v1\.d$/.test(sample)) return "GnuPG private keys";
  return "a private key or saved login";
}

/**
 * Reasons and unchecked parts from the Spark's evidence about one path.
 * @param {import("./commands.js").AdviseEvidence} ev
 * @param {{ now: number | null, procs: string, docker: string, git: string }} unit
 * @param {{ recentMinutes?: number }} [opts]
 * @returns {{ reasons: AdviceReason[], unchecked: AdviceUnchecked[] }}
 */
export function evidenceReasons(ev, unit, { recentMinutes = RECENT_MINUTES } = {}) {
  /** @type {AdviceReason[]} */
  const reasons = [];
  /** @type {AdviceUnchecked[]} */
  const unchecked = [];
  const add = (rule, text, level = RULES[rule].level) => reasons.push({ rule, level, text });
  const skip = (rule, text) => unchecked.push({ rule, text });
  if (!ev.reported) {
    skip("not-reported", "The Spark's answer stopped before this item, so nothing about it was checked.");
    return { reasons, unchecked };
  }
  if (ev.type == null) {
    add("missing", "It is no longer on the Spark: it was deleted or moved since the analysis.");
    return { reasons, unchecked };
  }
  const isDir = ev.type === "dir";

  // In use now.
  if (ev.useCount > 0) {
    const list = ev.uses.map((u) => HOW_WORDS[u.how](u.program || "a program", u.pid));
    const more = ev.useCount - ev.uses.length;
    const holds = ev.uses.some((u) => u.how !== "cwd");
    add(
      "in-use",
      `In use right now: ${list.join("; ")}${more > 0 ? `; and ${plural(more, "more process", "more processes")}` : ""}.${
        holds ? " Space held by open files comes back only after those programs let go of them, and they may fail." : " Programs working in it may fail."
      }`
    );
  }
  if (unit.procs === "own") skip("processes-others", "Programs of other accounts (root, services) were not checked: that needs administrator rights.");
  else if (unit.procs !== "all") skip("processes", "Ran out of time while checking which programs use it.");

  const within = ev.mounts.filter((m) => m.relation === "within");
  const around = ev.mounts.filter((m) => m.relation === "around");
  const mountWords = (m) => `${quoted(m.container)}${m.destination ? ` (as ${m.destination})` : ""}`;
  if (within.length > 0) {
    const more = ev.mountCount - ev.mounts.length;
    add("container-mount", `Mounted into the running container ${within.map(mountWords).join(", ")}${more > 0 ? ` and ${more} more` : ""}. The container may fail or lose data.`);
  }
  if (around.length > 0) {
    add("container-around", `Inside ${around[0].source}, which the running container ${mountWords(around[0])} mounts${around.length > 1 ? ` (and ${plural(around.length - 1, "other mount")})` : ""}: the container can read and change it.`);
  }
  if (unit.docker === "denied") skip("containers", "Docker refused this account, so running containers were not checked.");
  else if (unit.docker === "down") skip("containers", "Docker did not answer, so running containers were not checked.");
  else if (unit.docker === "failed") skip("containers", "Running containers could not be listed in full, so they were not all checked.");

  // Contents.
  if (ev.credentials && ev.credentials.count > 0) {
    const c = ev.credentials;
    const kind = credentialKind(c.sample);
    const where = c.sample === "" ? `This looks like ${kind}.` : `Holds what looks like ${kind}: ${c.sample}${c.count > 1 ? ` (and ${c.count - 1} more such ${c.count === 2 ? "file" : "files"})` : ""}.`;
    add("credentials", `${where} Deleting it can lock you out of a service until you log in or set it up again.`);
  }
  if (ev.partial && ev.partial.count > 0) {
    const p = ev.partial;
    add("partial-download", `${p.sample === "" ? "This looks like a partial download" : `Holds what looks like a partial download: ${p.sample}${p.count > 1 ? ` (and ${p.count - 1} more)` : ""}`}. A download may still be running, or one was interrupted.`);
  }
  if (ev.recent && ev.recent.count > 0) {
    const r = ev.recent;
    const hours = `${Math.round(recentMinutes / 60)} hours`;
    const when = r.newest != null && unit.now != null ? ago(r.newest, unit.now) : `in the last ${hours}`;
    const folderNote = "(something in it was added, removed or renamed)";
    const what =
      r.sample === ""
        ? isDir
          ? `the folder itself changed ${when} ${folderNote}`
          : `it was written ${when}`
        : r.sampleType === "dir"
          ? `the folder ${r.sample} changed ${when} ${folderNote}`
          : `${r.sample} was written ${when}`;
    const others = r.count - 1;
    add("recent-write", `Changed recently: ${what}${others > 0 ? `, and ${plural(others, "other item")} in it changed in the last ${hours}` : ""}.`);
  }
  if (ev.walk === "partial") skip("walk", "Some of what is inside could not be read, so those parts were not checked for recent changes, downloads, keys or git repositories.");
  else if (ev.walk === "timeout") skip("walk", "Ran out of time before looking through everything inside it.");
  else if (ev.walk === "skipped" || ev.walk == null) skip("walk", "Ran out of time before looking inside it.");

  // Git.
  for (const repo of ev.repos) {
    const history = repo.top === "";
    const name = history ? "the repository this history folder (.git) belongs to" : repo.top === "." ? "this git repository" : `the git repository ${repo.top} inside it`;
    if (history) add("git-history", "This is a git repository's history folder (.git): deleting it leaves the files without their history, and whatever is not on a remote is lost.");
    if (repo.state !== "ok") {
      const why = {
        refused: `git refused to look at ${name}: it belongs to another account.`,
        timeout: `Ran out of time checking ${name}.`,
        error: `git could not read ${name}.`,
        skipped:
          unit.git === "missing"
            ? `git is not installed on this Spark, so ${name} was not checked.`
            : unit.git === "old"
              ? `git on this Spark is older than 2.35.2 (it does not refuse repositories of other accounts), so ${name} was not checked.`
              : `${capital(name)} was not checked: no time was left.`,
      }[repo.state];
      skip("git", why);
      continue;
    }
    const facts = [];
    let rule = null;
    if (repo.changed > 0) {
      facts.push(`${plural(repo.changed, "changed file")} not committed`);
      rule ??= "git-uncommitted";
    }
    if (repo.unpushed > 0) {
      const n = plural(repo.unpushed, "commit");
      facts.push(repo.remotes === 0 ? `no remote, so its ${n} ${repo.unpushed === 1 ? "exists" : "exist"} only on this Spark` : `${n} that no remote branch holds (as of its last fetch)`);
      rule ??= "git-unpushed";
    }
    if (repo.stashes > 0) {
      facts.push(`${plural(repo.stashes, "stashed change")}, kept only in this copy`);
      rule ??= "git-stash";
    }
    if (rule) {
      if (repo.untracked > 0) facts.push(`${plural(repo.untracked, "file")} git does not track`);
      add(rule, `${capital(name)} has ${facts.join("; ")}.`);
    } else if (repo.untracked > 0) {
      add("git-untracked", `${capital(name)} has ${plural(repo.untracked, "file")} that git does not track, so git has no copy of ${repo.untracked === 1 ? "it" : "them"}.`);
    } else {
      add("git-clean", `${capital(name)}: git found no uncommitted changes and no commit missing from its remote (as of its last fetch).`);
    }
  }
  if (ev.gitDirs && ev.gitDirs.found > ev.repos.length) {
    const left = ev.gitDirs.found - ev.repos.length;
    skip("git", `${plural(left, "more git repository", "more git repositories")} inside ${left === 1 ? "was" : "were"} not checked.`);
  }
  if (ev.inRepo) {
    const r = ev.inRepo;
    if (r.relation === "history") add("in-repo-history", `Part of the history folder (.git) of the git repository at ${r.top}. Deleting it can break the repository.`);
    else if (r.state !== "ok") {
      skip(
        "git",
        r.state === "refused"
          ? `It is inside the git repository at ${r.top}, which belongs to another account, so git refused to check it.`
          : r.state === "timeout"
            ? `Ran out of time checking the git repository at ${r.top} it is in.`
            : r.state === "skipped"
              ? `It is inside the git repository at ${r.top}, which was not checked${unit.git === "ok" ? " (no time was left)" : unit.git === "old" ? " (git on this Spark is too old to check it safely)" : " (git is not installed)"}.`
              : `git could not read the repository at ${r.top} it is in.`
      );
    } else if (r.changed > 0) add("in-repo-uncommitted", `Inside the git repository at ${r.top}: ${plural(r.changed, "file")} in it ${r.changed === 1 ? "has" : "have"} changes that are not committed.`);
    else if (r.untracked > 0) add("in-repo-untracked", `Inside the git repository at ${r.top}: ${plural(r.untracked, "file")} in it ${r.untracked === 1 ? "is" : "are"} not tracked, so git has no copy of ${r.untracked === 1 ? "it" : "them"}.`);
    else if (r.ignored) add("in-repo-ignored", `The git repository at ${r.top} ignores it (by the repository's own rules, usually build output or caches).`);
    else if (r.tracked) add("in-repo-clean", `Committed in the git repository at ${r.top}, with no uncommitted changes in it: git can restore it. Files git ignores are not counted.`);
  }
  return { reasons, unchecked };
}

/**
 * The dashboard's own references to `p`: its model launchers (their folders) and the LLM servers it watches (the
 * model path or Hugging Face model id they report). `hubNames`: Hugging Face model folders the saved analysis lists
 * at or under `p` (so deleting a whole cache finds the models in it).
 * @param {string} p
 * @param {{ launchers?: { name: string, dir: string, startScript?: string }[], llm?: { port: number, modelId?: string | null,
 *   modelPath?: string | null, models?: string[] }[], home?: string | null, hubNames?: string[] }} refs
 * @returns {AdviceReason[]}
 */
export function referenceReasons(p, { launchers = [], llm = [], home = null, hubNames = [] } = {}) {
  const out = [];
  const add = (rule, text) => out.push({ rule, level: RULES[rule].level, text });
  for (const l of launchers) {
    if (typeof l?.dir !== "string") continue;
    const dir = l.dir.startsWith("~/") ? (home ? `${home}/${l.dir.slice(2)}`.replace(/\/+$/, "") : null) : l.dir.replace(/\/+$/, "") || "/";
    if (!dir) continue;
    const name = quoted(l.name || baseName(dir));
    if (dir === p) add("sparkdash-launcher", `SparkDash's model launcher ${name} starts from this folder (${l.startScript || "start.sh"}).`);
    else if (isInside(dir, p)) add("sparkdash-launcher", `Holds the folder of SparkDash's model launcher ${name} (${dir}).`);
    else if (isInside(p, dir)) add("sparkdash-launcher", `Inside the folder of SparkDash's model launcher ${name}: its start script or model files may be here.`);
  }
  const ids = (s) => [s.modelId, ...(Array.isArray(s.models) ? s.models : [])].filter((x) => typeof x === "string" && x.includes("/"));
  for (const s of llm) {
    if (!s) continue;
    const port = Number.isInteger(s.port) ? ` on port ${s.port}` : "";
    const mp = typeof s.modelPath === "string" && s.modelPath.startsWith("/") ? s.modelPath.replace(/\/+$/, "") : null;
    if (mp && (isInside(mp, p) || isInside(p, mp))) {
      add("sparkdash-llm", `The LLM server${port} that SparkDash watches reports its model at ${mp}.`);
      continue;
    }
    const want = new Set(ids(s).map((x) => x.toLowerCase()));
    if (want.size === 0) continue;
    // This path is, or is inside, a hub folder of a served model; or it holds one (from the saved analysis).
    const own = p.split("/").map(hubModelId).find((id) => id && want.has(id.toLowerCase()));
    if (own) {
      add("sparkdash-llm", `The LLM server${port} that SparkDash watches serves ${own}, the model in this Hugging Face download (matched by name).`);
      continue;
    }
    const held = hubNames.map(hubModelId).find((id) => id && want.has(id.toLowerCase()));
    if (held) add("sparkdash-llm", `Holds the Hugging Face download of ${held}, which the LLM server${port} that SparkDash watches serves (matched by name).`);
  }
  return out;
}

/**
 * Items with the same name, type and size in other Sparks' saved analyses (at most three Sparks).
 * @param {{ path: string, bytes: number, type: string }} entry this item, as this Spark's analysis lists it
 * @param {{ sparkId: string, name: string, analysedAt: number, entries: Iterable<{ path: string, bytes: number, type: string }> }[]} others
 * @param {number} nowMs the dashboard's clock
 * @returns {AdviceReason[]}
 */
export function copyReasons(entry, others, nowMs) {
  if (!entry || !(entry.bytes >= COPY_MIN_BYTES)) return [];
  const name = baseName(entry.path);
  const out = [];
  for (const o of others) {
    if (out.length >= 3) break;
    let match = null;
    for (const e of o.entries) {
      if (e.bytes === entry.bytes && e.type === entry.type && baseName(e.path) === name) {
        match = e;
        break;
      }
    }
    if (!match) continue;
    const what = entry.type === "dir" ? "A folder" : entry.type === "file" ? "A file" : "An item";
    const when = Number.isFinite(o.analysedAt) && o.analysedAt > 0 ? `, analysed ${ago(Math.floor(o.analysedAt / 1000), Math.floor(nowMs / 1000))}` : "";
    out.push({ rule: "copy-elsewhere", level: "note", text: `${what} with the same name and size is in the saved analysis of ${o.name} (${match.path}${when}). Same name and size does not prove the contents are the same.` });
  }
  return out;
}

/**
 * When it last changed, according to this Spark's saved analysis. When the Spark could not check recent changes
 * again now, a change within `recentMinutes` before the analysis is a reason to look (else a note).
 * @param {{ modifiedAt?: number } | null | undefined} entry
 * @param {{ analysedAt?: number, dated?: boolean } | null | undefined} session
 * @param {number} unitNow the Spark's clock, seconds
 * @param {number} nowMs the dashboard's clock
 * @param {boolean} rechecked the Spark looked through it now (recent changes are known)
 */
export function ageReasons(entry, session, unitNow, nowMs, rechecked, { recentMinutes = RECENT_MINUTES } = {}) {
  const t = entry?.modifiedAt;
  // 1980-01-01: anything earlier is a placeholder date, not a real one.
  if (!Number.isSafeInteger(t) || t < 315_532_800) return [];
  const analysed = Number.isFinite(session?.analysedAt) && session.analysedAt > 0 ? `the analysis from ${ago(Math.floor(session.analysedAt / 1000), Math.floor(nowMs / 1000))}` : "the analysis";
  if (!rechecked && unitNow - t <= recentMinutes * 60) {
    return [{ rule: "recent-analysis", level: RULES["recent-analysis"].level, text: `Changed ${ago(t, unitNow)}, according to ${analysed}. It could not be checked again now.` }];
  }
  return [{ rule: "age", level: "note", text: `Last changed ${ago(t, unitNow)}, according to ${analysed}.` }];
}

/**
 * The level of one item from its reasons and unchecked parts. Anything not checked makes it at least "review":
 * an unknown never reads as "nothing found".
 * @param {AdviceReason[]} reasons
 * @param {AdviceUnchecked[]} unchecked
 * @returns {{ level: AdviceLevel, complete: boolean }}
 */
export function levelOf(reasons, unchecked) {
  let level = "low";
  for (const r of reasons) if (r.level !== "note") level = higher(level, r.level);
  if (unchecked.length > 0) level = higher(level, "review");
  return { level, complete: unchecked.length === 0 };
}

const REASON_ORDER = { high: 0, review: 1, note: 2 };

/**
 * One item's advice: every reason (highest first, notes last), what was not checked, and the level.
 * @returns {{ path: string, level: AdviceLevel, complete: boolean, reasons: AdviceReason[], unchecked: AdviceUnchecked[] }}
 */
export function adviseItem(path, { evidence, unit, homes = [], refs = {}, entry = null, session = null, others = [], nowMs = Date.now(), recentMinutes = RECENT_MINUTES }) {
  const { reasons, unchecked } = evidenceReasons(evidence, unit, { recentMinutes });
  if (evidence.reported && evidence.type != null) {
    const known = knownPathReason(path, homes);
    if (known) reasons.push(known);
    reasons.push(...referenceReasons(path, refs));
    reasons.push(...copyReasons(entry, others, nowMs));
    const unitNow = unit.now ?? Math.floor(nowMs / 1000);
    // The Spark just saw a recent change: the analysis's date would only repeat it.
    if (!reasons.some((r) => r.rule === "recent-write")) reasons.push(...ageReasons(entry, session, unitNow, nowMs, evidence.walk === "complete", { recentMinutes }));
  }
  reasons.sort((a, b) => REASON_ORDER[a.level] - REASON_ORDER[b.level]);
  return { path, ...levelOf(reasons, unchecked), reasons, unchecked };
}

/**
 * The whole request: the highest item level, and whether every item was fully checked.
 * @param {{ level: AdviceLevel, complete: boolean }[]} items
 */
export function overallLevel(items) {
  let level = "low";
  for (const it of items) level = higher(level, it.level);
  return { level, complete: items.every((it) => it.complete) };
}
