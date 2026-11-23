/**
 * "Remove agent junk": files and folders coding agents left behind in earlier sessions (worktrees, temporary
 * folders, session logs, editor servers, scratch scripts, backups and reports), with a smart guess of which are junk.
 *
 * The unit only finds and measures candidates (scripts/agent-junk.sh, read-only, never elevated, never takes the
 * Spark's busy slot or the unit lock). Everything that decides is here and pure: which rule a path matches, and how
 * its age, git state and contents move the guess. Removing goes through the ordinary bulk delete, so every delete
 * check, the administrator rules and "Needs attention" apply unchanged.
 */
import { parsePairs, programResult } from "./commands.js";
import { hasUnsafeName, parseAbsolutePath, protectedReason } from "./policy.js";

/** Seconds the unit may spend looking; the request waits a little longer for the answer to arrive. */
export const JUNK_BUDGET_SECONDS = 40;
const JUNK_TIMEOUT_MS = (JUNK_BUDGET_SECONDS + 30) * 1000;
/** Temporary folders looked in, besides the home folders. */
const TEMP_ROOTS = ["/tmp", "/var/tmp"];
const DAY = 86_400;

/** @typedef {"worktrees" | "temp" | "sessions" | "editors" | "scratch" | "caches"} JunkGroup */
/** @typedef {"junk" | "likely" | "review" | "keep"} JunkVerdict */

const TMP = String.raw`^/(?:var/)?tmp/`;
/** A place inside a home folder (wherever the home is). */
const homeRe = (rest) => {
  const re = new RegExp(String.raw`^/.+/${rest}$`);
  return (p) => re.test(p);
};
const nameRe = (re) => (p) => re.test(p.slice(p.lastIndexOf("/") + 1));

/**
 * What a candidate is, first match wins. `base`: how sure the rule alone is that it is junk (0..1), before age, git
 * state and contents move it. `files`: the rule is about loose files the person may have made too, so being tracked
 * by git takes it off the list and being untracked counts for it.
 * @type {readonly { id: string, group: JunkGroup, agent: string, base: number, type?: "d" | "f", files?: true, test: (p: string) => boolean }[]}
 */
export const JUNK_RULES = Object.freeze([
  { id: "claude-worktree", group: "worktrees", agent: "Claude Code", base: 0.8, type: "d", test: (p) => /\/\.claude\/worktrees\/[^/]+$/.test(p) },
  { id: "codex-worktree", group: "worktrees", agent: "Codex", base: 0.8, type: "d", test: (p) => /\/\.codex\/worktrees\/[^/]+$/.test(p) },
  { id: "agent-worktree", group: "worktrees", agent: "Agent", base: 0.6, type: "d", test: (p) => /\/\.worktrees\/[^/]+$/.test(p) },

  { id: "tmp-agent", group: "temp", agent: "Agent", base: 0.9, test: (p) => new RegExp(`${TMP}(?:claude|codex|aider|gemini|opencode|cursor|devin|openhands|goose|cline)[^/]*$`, "i").test(p) },
  { id: "tmp-browser", group: "temp", agent: "Browser tests", base: 0.85, test: (p) => new RegExp(`${TMP}(?:playwright|puppeteer|\\.org\\.chromium\\.|chrome_|chromium|\\.com\\.google\\.Chrome|lighthouse)[^/]*$`).test(p) },
  { id: "tmp-tool", group: "temp", agent: "Build & test tools", base: 0.7, test: (p) => new RegExp(`${TMP}(?:pytest-of-|tmp|npm-|pip-|uv-|vite|jiti$|node-compile-cache$|tsx-)[^/]*$`).test(p) },

  { id: "claude-sessions", group: "sessions", agent: "Claude Code", base: 0.6, type: "d", test: homeRe(String.raw`\.claude/projects/[^/]+`) },
  { id: "claude-state", group: "sessions", agent: "Claude Code", base: 0.85, type: "d", test: homeRe(String.raw`\.claude/(?:shell-snapshots|todos|debug|statsig|file-history|paste-cache|session-env|ide)`) },
  { id: "claude-logs", group: "sessions", agent: "Claude Code", base: 0.9, type: "d", test: homeRe(String.raw`\.cache/(?:claude-cli-nodejs|claude)`) },
  { id: "codex-sessions", group: "sessions", agent: "Codex", base: 0.65, type: "d", test: homeRe(String.raw`\.codex/(?:sessions|archived_sessions|log)`) },
  { id: "gemini-tmp", group: "sessions", agent: "Gemini CLI", base: 0.85, type: "d", test: homeRe(String.raw`\.gemini/tmp`) },
  { id: "opencode-logs", group: "sessions", agent: "opencode", base: 0.75, type: "d", test: homeRe(String.raw`\.local/share/opencode/(?:log|snapshot)`) },
  { id: "continue-sessions", group: "sessions", agent: "Continue", base: 0.6, type: "d", test: homeRe(String.raw`\.continue/sessions`) },

  { id: "editor-server", group: "editors", agent: "Editor", base: 0.8, test: homeRe(String.raw`\.(?:vscode|cursor|windsurf)-server/(?:bin(?:/linux-[a-z0-9]+)?|cli/servers)/(?:Stable-|Insiders-)?[0-9a-f]{7,}`) },
  { id: "editor-logs", group: "editors", agent: "Editor", base: 0.9, type: "d", test: homeRe(String.raw`\.(?:vscode|cursor|windsurf)-server/data/logs`) },

  { id: "aider-files", group: "scratch", agent: "Aider", base: 0.85, test: nameRe(/^\.aider\.(?:chat\.history\.md|input\.history|tags\.cache\.v\d+)$/) },
  { id: "scratch-script", group: "scratch", agent: "Agent", base: 0.7, type: "f", files: true, test: nameRe(/^(?:(?:test|debug|tmp|temp|scratch|fix|patch|check|quick|try|demo|repro|verify)[_-][^/]*\.(?:py|js|mjs|cjs|ts|sh)|(?:scratch|playground|untitled)[^/]*\.(?:py|js|ts|sh|txt|md))$/) },
  { id: "agent-report", group: "scratch", agent: "Agent", base: 0.65, type: "f", files: true, test: nameRe(/^[A-Z0-9_ -]*(?:SUMMARY|REPORT|IMPLEMENTATION|ANALYSIS|FINDINGS|PROGRESS|HANDOFF|INVESTIGATION|FIXES|_PLAN|_NOTES|_CHANGES)[A-Z0-9_ -]*\.(?:md|txt)$/) },
  { id: "backup-file", group: "scratch", agent: "Agent", base: 0.7, type: "f", files: true, test: nameRe(/(?:\.bak|\.bak[-.][^/]*|\.orig|\.rej|~|\.old|\.backup)$/) },
  { id: "core-dump", group: "scratch", agent: "Crashed program", base: 0.75, type: "f", files: true, test: nameRe(/^core(?:\.\d+)?$/) },
  { id: "stray-log", group: "scratch", agent: "Agent", base: 0.5, type: "f", files: true, test: nameRe(/^(?:nohup\.out|.*\.log)$/) },

  { id: "npx-cache", group: "caches", agent: "npx", base: 0.75, type: "d", test: homeRe(String.raw`\.npm/_npx`) },
  { id: "browser-cache", group: "caches", agent: "Browser tests", base: 0.5, type: "d", test: homeRe(String.raw`\.cache/(?:ms-playwright|puppeteer)`) },
  { id: "package-cache", group: "caches", agent: "pip / uv", base: 0.6, type: "d", test: homeRe(String.raw`\.cache/(?:pip|uv)`) },
]);

const RULE_BY_ID = new Map(JUNK_RULES.map((r) => [r.id, r]));

/** The rule a candidate matches, or null. */
export function matchRule(path, type) {
  for (const r of JUNK_RULES) if ((!r.type || r.type === type) && r.test(path)) return r;
  return null;
}

const fromHex = (h) => (/^(?:[0-9a-f]{2})+$/.test(h ?? "") ? Buffer.from(h, "hex").toString("utf8") : null);
const count = (v) => (/^\d{1,16}$/.test(v ?? "") ? Number(v) : null);

/**
 * What agent-junk.sh reported. Tolerant: a line that does not parse is dropped; a size or date that could not be
 * measured stays null (never 0).
 * @param {string} out
 */
export function parseAgentJunkOutput(out) {
  const r = programResult(out);
  if (!r.ok) return r;
  const res = { ok: true, now: null, home: null, git: "missing", walks: [], more: false, candidates: [] };
  for (const [k, v] of parsePairs(out)) {
    if (k === "NOW") res.now = count(v);
    else if (k === "HOME_HEX") res.home = fromHex(v) || null;
    else if (k === "GIT") res.git = v === "ok" ? "ok" : "missing";
    else if (k === "MORE") res.more = true;
    else if (k === "WALK") {
      const [h, code] = v.split("|");
      const home = fromHex(h);
      if (home) res.walks.push({ home, complete: code === "0" });
    } else if (k === "I") {
      const f = v.split("|");
      if (f.length !== 5 || (f[0] !== "d" && f[0] !== "f")) continue;
      const path = fromHex(f[4]);
      if (!path) continue;
      res.candidates.push({ type: f[0], bytes: count(f[1]), modifiedAt: count(f[2]), flags: f[3].replace(/[^TUDMR]/g, ""), path });
    }
  }
  return res;
}

/**
 * The smart guess for one candidate, or null when it is not offered at all (no rule, tracked by git, or a path the
 * Storage Manager never deletes).
 * @param {{ type: "d" | "f", bytes: number | null, modifiedAt: number | null, flags: string, path: string }} c
 * @param {{ now: number, newestEditor?: ReadonlySet<string>, homes?: ReadonlySet<string> }} ctx  `newestEditor`: the editor
 *   server folders that are the newest of their kind (the one the editor uses now); `homes`: the home folders looked in.
 */
export function classifyCandidate(c, { now, newestEditor = new Set(), homes = new Set() }) {
  let path;
  try {
    path = parseAbsolutePath(c.path);
  } catch {
    return null;
  }
  if (path === "/" || hasUnsafeName(path) || protectedReason(path)) return null;
  const rule = matchRule(path, c.type);
  if (!rule) return null;
  const flags = c.flags ?? "";
  // A file git tracks is part of a project, whatever its name says.
  if (rule.files && flags.includes("T")) return null;

  /** @type {{ code: string, days?: number }[]} */
  const signals = [];
  let score = rule.base;
  let cap = 1;
  let keep = false;

  const age = c.modifiedAt != null && now != null ? Math.max(0, Math.floor((now - c.modifiedAt) / DAY)) : null;
  if (age == null) {
    signals.push({ code: "age-unknown" });
    score -= 0.1;
  } else if (now - c.modifiedAt < DAY) {
    // Changed today: it may belong to a session that is still going.
    signals.push({ code: "recent" });
    cap = 0.45;
  } else {
    signals.push({ code: "age", days: age });
    if (age < 3) score -= 0.15;
    else if (age >= 90) score += 0.15;
    else if (age >= 30) score += 0.1;
  }
  if (rule.files) {
    const loose = homes.has(path.slice(0, path.lastIndexOf("/")));
    if (flags.includes("U")) {
      // Inside a git project but never added to it: what an agent leaves after a session.
      signals.push({ code: "untracked" });
      score += 0.05;
    } else if (loose) {
      signals.push({ code: "home-root" });
    } else {
      // Outside git, the name is all there is: a project's own test_*.py or check_*.sh looks the same.
      if (rule.id === "scratch-script" && /^(?:test|check|verify)[_-]/.test(path.slice(path.lastIndexOf("/") + 1))) return null;
      signals.push({ code: "no-git" });
      score -= 0.2;
    }
  }
  if (flags.includes("D")) {
    signals.push({ code: "uncommitted" });
    cap = Math.min(cap, 0.45);
  }
  if (flags.includes("M")) {
    signals.push({ code: "memory" });
    keep = true;
  }
  if (rule.id === "scratch-script" && /\/(?:tests?|__tests__|spec)\//.test(path)) {
    signals.push({ code: "tests-folder" });
    score -= 0.3;
  }
  if (rule.id === "claude-sessions" && /-claude-worktrees-[^/]+$/.test(path)) {
    // Transcripts of a session that ran in a throwaway worktree.
    signals.push({ code: "worktree-session" });
    score += 0.2;
  }
  if (rule.id === "editor-server" && newestEditor.has(path)) {
    signals.push({ code: "current-version" });
    keep = true;
  }
  if (flags.includes("R")) signals.push({ code: "size-partial" });

  score = Math.round(Math.max(0, Math.min(cap, score)) * 100) / 100;
  /** @type {JunkVerdict} */
  const verdict = keep ? "keep" : score >= 0.8 ? "junk" : score >= 0.6 ? "likely" : "review";
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    type: c.type,
    bytes: c.bytes,
    modifiedAt: c.modifiedAt,
    rule: rule.id,
    group: rule.group,
    agent: rule.agent,
    verdict,
    score,
    signals,
  };
}

const VERDICT_ORDER = { junk: 0, likely: 1, review: 2, keep: 3 };

/** The editor server folders (…-server/bin/<id>, …/cli/servers/<id>) that are the newest in their folder. */
export function newestEditorServers(candidates) {
  const best = new Map();
  for (const c of candidates) {
    if (matchRule(c.path, c.type)?.id !== "editor-server") continue;
    const parent = c.path.slice(0, c.path.lastIndexOf("/"));
    const have = best.get(parent);
    if (!have || (c.modifiedAt ?? -1) > (have.modifiedAt ?? -1)) best.set(parent, c);
  }
  return new Set([...best.values()].map((c) => c.path));
}

/**
 * Every candidate classified: nested ones dropped (the outer item goes with what is inside it), sorted by verdict and
 * then size.
 * @param {ReturnType<typeof parseAgentJunkOutput> & { ok: true }} res
 */
export function classifyAll(res) {
  const now = res.now ?? Math.floor(Date.now() / 1000);
  const newestEditor = newestEditorServers(res.candidates);
  const homes = new Set([res.home, ...res.walks.map((w) => w.home)].filter(Boolean));
  const items = [];
  const seen = new Set();
  for (const c of res.candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const item = classifyCandidate(c, { now, newestEditor, homes });
    if (item) items.push(item);
  }
  const outer = items.filter((it) => !items.some((o) => o !== it && o.type === "d" && it.path.startsWith(`${o.path}/`)));
  return outer.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path));
}

/** One look per Spark at a time: a second request while one runs gets the same answer. */
const inFlight = new WeakMap();

/**
 * Look for agent junk on a Spark. Read-only, as the dashboard's account.
 * @param {object} manager the StorageManager (its `_exec` and `_fail`)
 * @param {object} spark
 * @param {{ assertSupported: (spark: object) => void, now?: () => number }} deps
 */
export async function findAgentJunk(manager, spark, { assertSupported, now = Date.now }) {
  assertSupported(spark);
  let mine = inFlight.get(manager);
  if (!mine) inFlight.set(manager, (mine = new Map()));
  const running = mine.get(spark.id);
  if (running) return running;
  const promise = (async () => {
    const out = await manager._exec(spark, "agentJunk", { args: [JUNK_BUDGET_SECONDS, ...TEMP_ROOTS], timeoutMs: JUNK_TIMEOUT_MS, maxBuffer: 8 << 20 });
    const res = parseAgentJunkOutput(out);
    if (!res.ok) throw manager._fail(res);
    const items = classifyAll(res);
    return {
      checkedAt: now(),
      home: res.home,
      git: res.git,
      complete: !res.more && res.walks.every((w) => w.complete),
      more: res.more,
      items,
    };
  })();
  mine.set(spark.id, promise);
  try {
    return await promise;
  } finally {
    mine.delete(spark.id);
  }
}

export { RULE_BY_ID };
