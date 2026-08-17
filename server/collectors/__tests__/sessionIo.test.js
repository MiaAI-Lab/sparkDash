/**
 * Shared session I/O helpers: host-root remap, URL fetch guards.
 * Run: node --test server/collectors/__tests__/sessionIo.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  expandTilde,
  remapHostRoot,
  resolveStateDir,
  defaultFetchJson,
  sanitizeProbeError,
  parseSessionTime,
  sessionLastUsedAt,
} from "../sessionIo.js";

test("expandTilde maps ~ and ~/path against injected home", () => {
  assert.equal(expandTilde("~", "/home/op"), "/home/op");
  assert.equal(expandTilde("~/.openclaw", "/home/op"), "/home/op/.openclaw");
  assert.equal(expandTilde("/abs/openclaw", "/home/op"), "/abs/openclaw");
});

test("remapHostRoot returns expanded when already readable", () => {
  const readable = new Set(["/home/op/.openclaw"]);
  const mapped = remapHostRoot("/home/op/.openclaw", {
    hostRoot: "/host/root",
    isReadable: (p) => readable.has(p),
  });
  assert.equal(mapped, "/home/op/.openclaw");
});

test("remapHostRoot joins HOST_ROOT when expanded is unreadable", () => {
  const readable = new Set(["/host/root", "/host/root/home/op/.openclaw"]);
  const mapped = remapHostRoot("/home/op/.openclaw", {
    hostRoot: "/host/root",
    isReadable: (p) => readable.has(p),
  });
  assert.equal(mapped, "/host/root/home/op/.openclaw");
});

test("remapHostRoot keeps expanded when remap target is also unreadable", () => {
  const mapped = remapHostRoot("/home/op/.openclaw", {
    hostRoot: "/host/root",
    isReadable: () => false,
  });
  assert.equal(mapped, "/home/op/.openclaw");
});

test("resolveStateDir remaps state-dir paths the same as local conventional paths", () => {
  const readable = new Set(["/host/root", "/host/root/opt/openclaw"]);
  const deps = {
    homedir: "/home/op",
    hostRoot: "/host/root",
    isReadable: (p) => readable.has(p),
  };
  const fromStateDir = resolveStateDir(
    { mode: "state-dir", stateDir: "/opt/openclaw" },
    deps,
    "~/.openclaw"
  );
  const fromLocal = resolveStateDir({ mode: "local" }, deps, "/opt/openclaw");
  assert.equal(fromStateDir, "/host/root/opt/openclaw");
  assert.equal(fromLocal, "/host/root/opt/openclaw");
});

test("resolveStateDir does not fall back to conventional when state-dir is blank", () => {
  const deps = { homedir: "/home/op", hostRoot: "", isReadable: () => true };
  assert.equal(resolveStateDir({ mode: "state-dir", stateDir: "" }, deps, "~/.openclaw"), "");
  assert.equal(resolveStateDir({ mode: "state-dir" }, deps, "/opt/openclaw"), "");
});

test("defaultFetchJson rejects file: protocol, userinfo, and disallowed IPs before fetch", async () => {
  await assert.rejects(
    () => defaultFetchJson("file:///etc/passwd"),
    /protocol/i
  );
  const userinfoUrl = new URL("http://127.0.0.1:18789/");
  userinfoUrl.username = "review-user";
  userinfoUrl.password = "review-pass";
  await assert.rejects(
    () => defaultFetchJson(userinfoUrl.toString()),
    /userinfo/i
  );
  await assert.rejects(
    () => defaultFetchJson("http://169.254.169.254/latest/meta-data/"),
    /disallowed host/i
  );
});

test("sanitizeProbeError strips paths and maps auth / connect codes", () => {
  const missing = new Error("ENOENT: no such file or directory, open '/secret/path/sessions.json'");
  missing.code = "ENOENT";
  assert.equal(sanitizeProbeError(missing), "State files not found");
  assert.equal(String(sanitizeProbeError(missing)).includes("/secret/"), false);

  const auth = new Error("HTTP 401");
  auth.status = 401;
  assert.equal(sanitizeProbeError(auth), "HTTP 401 (auth failed)");

  const refused = new Error("connect ECONNREFUSED 127.0.0.1:8787");
  refused.code = "ECONNREFUSED";
  assert.equal(sanitizeProbeError(refused), "Connection refused");

  const html = new Error("Unexpected token '<', \"<!doctype \"... is not valid JSON");
  assert.equal(sanitizeProbeError(html), "Not a JSON session list");

  const denied = new Error("EACCES: permission denied, open '/home/op/.hermes/sessions.json'");
  denied.code = "EACCES";
  assert.equal(sanitizeProbeError(denied), "Permission denied");
  assert.equal(String(sanitizeProbeError(denied)).includes("/home/op"), false);

  const mystery = new Error("ENOENT-looking path /secret/layout in a generic failure");
  assert.equal(sanitizeProbeError(mystery), "Request failed");
  assert.equal(String(sanitizeProbeError(mystery)).includes("/secret/"), false);
});

test("parseSessionTime accepts ms, seconds, and ISO strings", () => {
  assert.equal(parseSessionTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseSessionTime(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseSessionTime("2024-01-15T12:00:00.000Z"), Date.parse("2024-01-15T12:00:00.000Z"));
  assert.equal(parseSessionTime(""), null);
  assert.equal(parseSessionTime(0), null);
  assert.equal(sessionLastUsedAt({ updatedAt: 1_700_000_000_000, createdAt: 1 }), 1_700_000_000_000);
  assert.equal(sessionLastUsedAt({ created_at: "2024-01-15T12:00:00.000Z" }), Date.parse("2024-01-15T12:00:00.000Z"));
  assert.equal(sessionLastUsedAt({ preview: "secret" }), null);
});
