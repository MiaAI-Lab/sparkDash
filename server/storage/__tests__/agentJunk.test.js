/**
 * Remove agent junk: the rules and the smart guess (pure), the unit program run as a unit runs it against a temporary
 * home and temporary folder (real git repositories, a worktree, tracked and untracked files), and the route.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { buildProgram } from "../commands.js";
import { classifyAll, classifyCandidate, matchRule, parseAgentJunkOutput } from "../agentJunk.js";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";

const NOW = 1_800_000_000;
const DAY = 86_400;
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const cand = (p, extra = {}) => ({ type: "d", bytes: 1000, modifiedAt: NOW - 40 * DAY, flags: "", path: p, ...extra });
const ctx = { now: NOW, homes: new Set(["/home/me"]) };

test("rules: each kind of leftover is recognised, and ordinary files are not", () => {
  const cases = [
    ["/home/me/proj/.claude/worktrees/fix-bug", "d", "claude-worktree"],
    ["/home/me/.codex/worktrees/abc", "d", "codex-worktree"],
    ["/tmp/claude-1000", "d", "tmp-agent"],
    ["/var/tmp/codex-xyz", "d", "tmp-agent"],
    ["/tmp/playwright_chromiumdev_profile-x", "d", "tmp-browser"],
    ["/tmp/tmpab12cd", "d", "tmp-tool"],
    ["/home/me/.claude/projects/-home-me-proj", "d", "claude-sessions"],
    ["/home/me/.claude/todos", "d", "claude-state"],
    ["/home/me/.cache/claude-cli-nodejs", "d", "claude-logs"],
    ["/home/me/.vscode-server/bin/0123abcd", "d", "editor-server"],
    ["/home/me/proj/.aider.chat.history.md", "f", "aider-files"],
    ["/home/me/proj/debug_parser.py", "f", "scratch-script"],
    ["/home/me/proj/IMPLEMENTATION_SUMMARY.md", "f", "agent-report"],
    ["/home/me/proj/docker-compose.yml.bak-key", "f", "backup-file"],
    ["/home/me/.npm/_npx", "d", "npx-cache"],
  ];
  for (const [p, type, id] of cases) assert.equal(matchRule(p, type)?.id, id, p);
  for (const p of ["/home/me/proj/README.md", "/home/me/proj/src/main.py", "/home/me/proj/CHANGELOG.md", "/tmp/systemd-private-x"]) {
    assert.equal(matchRule(p, "f"), null, p);
  }
  // Editor servers: only version folders, never the helper folders next to them.
  assert.equal(matchRule("/home/me/.cursor-server/bin/linux-arm64/0123abcdef", "d")?.id, "editor-server");
  assert.equal(matchRule("/home/me/.vscode-server/cli/servers/Stable-0123abcdef", "d")?.id, "editor-server");
  assert.equal(matchRule("/home/me/.cursor-server/bin/multiplex-server", "d"), null);
  assert.equal(matchRule("/home/me/.cursor-server/bin/linux-arm64", "d"), null);
  // A folder is never taken for a file rule, nor the other way round.
  assert.equal(matchRule("/home/me/proj/debug_x.py", "d"), null);
});

test("smart guess: old agent leftovers are junk; today's, dirty or memory-holding ones are not ticked", () => {
  assert.equal(classifyCandidate(cand("/tmp/claude-1000"), ctx).verdict, "junk");
  const today = classifyCandidate(cand("/tmp/claude-1000", { modifiedAt: NOW - 600 }), ctx);
  assert.equal(today.verdict, "review", "a session may still be using it");
  assert.ok(today.signals.some((s) => s.code === "recent"));
  const dirty = classifyCandidate(cand("/home/me/p/.claude/worktrees/w", { flags: "D" }), ctx);
  assert.equal(dirty.verdict, "review");
  assert.ok(dirty.signals.some((s) => s.code === "uncommitted"));
  const memory = classifyCandidate(cand("/home/me/.claude/projects/-home-me-p", { flags: "M" }), ctx);
  assert.equal(memory.verdict, "keep");
  const gone = classifyCandidate(cand("/home/me/.claude/projects/-home-me-p--claude-worktrees-x"), ctx);
  assert.equal(gone.verdict, "junk", "transcripts of a session in a removed worktree");
  // Unknown age is not taken as old.
  const unknown = classifyCandidate(cand("/tmp/tmpzz", { modifiedAt: null }), ctx);
  assert.notEqual(unknown.verdict, "junk");
  assert.equal(unknown.bytes, 1000);
});

test("smart guess: loose files lean on git, and tracked files are never offered", () => {
  const file = (p, flags) => cand(p, { type: "f", flags });
  assert.equal(classifyCandidate(file("/home/me/proj/debug_x.py", "T"), ctx), null, "tracked: part of the project");
  assert.equal(classifyCandidate(file("/home/me/proj/debug_x.py", "U"), ctx).verdict, "junk");
  assert.equal(classifyCandidate(file("/home/me/debug_x.py", ""), ctx).signals.some((s) => s.code === "home-root"), true);
  // Outside git a test_*.py is indistinguishable from a project's own test: left out.
  assert.equal(classifyCandidate(file("/home/me/other/test_api.py", ""), ctx), null);
  assert.equal(classifyCandidate(file("/home/me/other/notes.bak", ""), ctx).verdict, "likely", "outside git: never the sure pick");
  // In a tests folder, even untracked, it is to be checked first.
  assert.notEqual(classifyCandidate(file("/home/me/proj/tests/test_new.py", "U"), ctx).verdict, "junk");
  assert.notEqual(classifyCandidate(file("/home/me/proj/tests/cpu/test_new.py", "U"), ctx).verdict, "junk", "at any depth");
});

test("smart guess: protected paths are dropped, the editor server in use is kept, nested items go with their folder", () => {
  assert.equal(classifyCandidate(cand("/tmp"), ctx), null);
  assert.equal(classifyCandidate(cand("/home/me/.ssh/x.bak", { type: "f", flags: "U" }), ctx), null);
  const res = {
    now: NOW,
    home: "/home/me",
    walks: [],
    candidates: [
      cand("/home/me/.vscode-server/bin/00dd00dd0", { modifiedAt: NOW - 90 * DAY }),
      cand("/home/me/.vscode-server/bin/abcdef12", { modifiedAt: NOW - 5 * DAY }),
      cand("/home/me/p/.claude/worktrees/w"),
      cand("/home/me/p/.claude/worktrees/w/debug_x.py", { type: "f", flags: "U" }),
    ],
  };
  const items = classifyAll(res);
  const by = new Map(items.map((it) => [it.path, it]));
  assert.equal(by.get("/home/me/.vscode-server/bin/abcdef12").verdict, "keep");
  assert.equal(by.get("/home/me/.vscode-server/bin/00dd00dd0").verdict, "junk");
  assert.equal(by.has("/home/me/p/.claude/worktrees/w/debug_x.py"), false);
  assert.equal(items.at(-1).verdict, "keep", "keep sorts last");
});

test("parse: tolerant, unknown sizes stay null, an error answer passes through", () => {
  const out = [
    "RESULT=ok",
    `NOW=${NOW}`,
    `HOME_HEX=${hex("/home/me")}`,
    "GIT=ok",
    `WALK=${hex("/home/me")}|124`,
    `I=d|-|-|R|${hex("/tmp/claude-1")}`,
    `I=f|12|${NOW}|U|${hex("/home/me/p/fix_x.py")}`,
    "I=garbage",
    `I=x|1|1||${hex("/tmp/a")}`,
  ].join("\n");
  const res = parseAgentJunkOutput(out);
  assert.equal(res.ok, true);
  assert.equal(res.home, "/home/me");
  assert.deepEqual(res.walks, [{ home: "/home/me", complete: false }]);
  assert.equal(res.candidates.length, 2);
  assert.equal(res.candidates[0].bytes, null);
  assert.equal(res.candidates[0].modifiedAt, null);
  assert.equal(res.candidates[1].flags, "U");
  assert.equal(parseAgentJunkOutput("RESULT=error\nCODE=no-temp\nMSG=x").ok, false);
});

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const skip = process.platform !== "linux" ? "needs Linux" : !has("git") || !has("bash") ? "needs git and bash" : false;

test("the unit program finds leftovers in a real home and temporary folder", { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junk-"));
  try {
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const repo = path.join(home, "proj");
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "debug_tracked.py"), "x");
    fs.writeFileSync(path.join(repo, "main.py"), "x");
    git("add", ".");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
    fs.writeFileSync(path.join(repo, "debug_untracked.py"), "print(1)");
    fs.writeFileSync(path.join(repo, "SESSION_SUMMARY.md"), "# done");
    fs.writeFileSync(path.join(repo, "app.py.orig"), "x");
    git("worktree", "add", "-q", path.join(repo, ".claude", "worktrees", "task-1"));
    fs.mkdirSync(path.join(home, ".claude", "projects", "-proj", "memory"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "todos"), { recursive: true });
    fs.mkdirSync(path.join(home, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(home, "node_modules", "pkg", "debug_x.py"), "skipped tree");
    fs.mkdirSync(path.join(tmp, "claude-1000", "scratch"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "claude-1000", "scratch", "f"), "x".repeat(5000));
    fs.mkdirSync(path.join(tmp, "systemd-private-abc"));

    const r = spawnSync("sh", ["-c", buildProgram("agentJunk", { args: [30, tmp] })], { encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    const res = parseAgentJunkOutput(r.stdout);
    assert.equal(res.ok, true, r.stdout + r.stderr);
    assert.equal(res.home, home);
    const by = new Map(res.candidates.map((c) => [c.path, c]));
    const rel = (p) => path.join(home, p);
    assert.ok(by.has(path.join(tmp, "claude-1000")), "the agent's temporary folder");
    assert.ok(by.get(path.join(tmp, "claude-1000")).bytes >= 5000, "measured");
    assert.ok(!by.has(path.join(tmp, "systemd-private-abc")), "not an agent's");
    assert.equal(by.get(rel("proj/debug_untracked.py"))?.flags, "U");
    assert.ok(!by.has(rel("proj/debug_tracked.py")), "tracked files are not reported");
    assert.ok(by.has(rel("proj/SESSION_SUMMARY.md")));
    assert.ok(by.has(rel("proj/app.py.orig")));
    assert.ok(by.has(rel("proj/.claude/worktrees/task-1")), "the worktree");
    assert.match(by.get(rel(".claude/projects/-proj")).flags, /M/, "saved memory noticed");
    assert.ok(by.has(rel(".claude/todos")));
    assert.ok(![...by.keys()].some((p) => p.includes("node_modules")), "big trees are skipped");
    assert.ok(res.walks.every((w) => w.complete));

    const items = classifyAll(res);
    assert.equal(items.find((it) => it.path === rel(".claude/projects/-proj")).verdict, "keep");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /storage/agent-junk answers the classified items; refused for an unsupported unit before anything runs", async () => {
  let ran = 0;
  const run = async (_spark, _program, { name }) => {
    ran += 1;
    assert.equal(name, "agentJunk");
    return ["RESULT=ok", `NOW=${NOW}`, `HOME_HEX=${hex("/home/me")}`, "GIT=ok", `I=d|2048|${NOW - 50 * DAY}||${hex("/tmp/claude-1000")}`].join("\n");
  };
  const app = express();
  app.use(express.json());
  const known = { s1: { id: "s1", name: "S1", kind: "spark" }, w: { id: "w", name: "W", kind: "host", platform: "windows" } };
  registerStorageRoutes(app, {
    manager: new StorageManager({ run, holdMs: 0 }),
    registry: { getSpark: (id) => known[id] },
    recordEvent: () => {},
    allowRead: () => true,
    allowChange: () => true,
    rejectLimited: (res, msg) => res.status(429).json({ error: msg }),
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
    const ok = await (await fetch(`${base}/s1/storage/agent-junk`)).json();
    assert.equal(ok.items.length, 1);
    assert.equal(ok.items[0].verdict, "junk");
    assert.equal(ok.items[0].bytes, 2048);
    assert.equal(ok.complete, true);
    const refused = await fetch(`${base}/w/storage/agent-junk`);
    assert.equal(refused.status, 400);
    assert.equal(ran, 1);
  } finally {
    server.close();
  }
});
