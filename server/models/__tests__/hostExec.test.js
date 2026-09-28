import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunTarget, spawnOnTarget, buildScriptCommand, shQuote } from "../hostExec.js";
import { sshCommandSpec } from "../../collectors/ssh.js";

// ─── resolveRunTarget: the model's Spark is the machine ───
const SPARK = {
  id: "spark1-lan",
  name: "spark1.lan",
  lanIp: "10.0.0.100",
  isLocal: false,
  ssh: { host: "10.0.0.100", user: "pavelkubicek", auth: "pass", password: "hunter2" },
};

const getSpark = (id) => (id === SPARK.id ? SPARK : null);

test("a model with no sparkId is refused before any traffic", () => {
  const t = resolveRunTarget({ id: "glm" }, getSpark);
  assert.equal(t.kind, null);
  assert.match(t.error, /has no Spark assigned/);
});

test("a sparkId pointing at a removed Spark is refused with a fixable message", () => {
  const t = resolveRunTarget({ id: "glm", sparkId: "gone" }, getSpark);
  assert.equal(t.kind, null);
  assert.match(t.error, /not registered/);
});

test("an SSH-configured Spark resolves to the ssh transport — even on its own machine", () => {
  const t = resolveRunTarget({ id: "glm", sparkId: SPARK.id }, getSpark);
  assert.equal(t.kind, "ssh");
  assert.equal(t.key, `ssh:${SPARK.id}`);
  assert.match(t.label, /pavelkubicek@10\.0\.0\.100/);
  assert.equal(t.spark, SPARK, "the resolver passes the secret-bearing spark through");
});

test("a local Spark without SSH config keeps the nsenter transport", () => {
  const get = (id) => (id === "me" ? { id: "me", name: "me", isLocal: true } : null);
  const t = resolveRunTarget({ id: "glm", sparkId: "me" }, get);
  assert.equal(t.kind, "local");
  assert.match(t.key, /^local:/);
});

test("a Spark that is neither SSH-configured nor local is refused", () => {
  const get = (id) => (id === "ghost" ? { id: "ghost", isLocal: false } : null);
  const t = resolveRunTarget({ id: "glm", sparkId: "ghost" }, get);
  assert.equal(t.kind, null);
  assert.match(t.error, /no SSH host\/user/);
});

// ─── sshCommandSpec: argv/env contract ─────────────────
test("key auth: bare ssh, BatchMode, `--` then user@host and the raw command", () => {
  const spark = { id: "s", ssh: { host: "10.0.0.5", user: "mia", auth: "key" } };
  const { file, args, env } = sshCommandSpec(spark, { remoteArgv: ["echo ok"] });
  assert.equal(file, "ssh");
  assert.ok(args.includes("BatchMode=yes"));
  assert.deepEqual(args.slice(-3), ["--", "mia@10.0.0.5", "echo ok"]);
  assert.equal(env.SSHPASS, undefined, "no password env on the key path");
});

test("password auth: sshpass -e, password ONLY in env — never argv", () => {
  const spark = { id: "s", ssh: { host: "10.0.0.5", user: "mia", auth: "pass", password: "sekret" } };
  let inv;
  try {
    inv = sshCommandSpec(spark, { remoteArgv: ["echo ok"] });
  } catch (err) {
    // Host without sshpass installed: the guard itself is the contract.
    assert.match(err.message, /sshpass is not installed/);
    return;
  }
  assert.equal(inv.file, "sshpass");
  assert.deepEqual(inv.args.slice(0, 2), ["-e", "ssh"]);
  assert.ok(!inv.args.some((a) => String(a).includes("sekret")), "password not on the command line");
  assert.equal(inv.env.SSHPASS, "sekret");
});

test("missing host/user config throws with the spark id", () => {
  assert.throws(
    () => sshCommandSpec({ id: "broken", ssh: {} }, { remoteArgv: ["ls"] }),
    /broken/
  );
  assert.throws(
    () =>
      sshCommandSpec(
        { id: "s", ssh: { host: "10.0.0.5", user: "u", auth: "pass" } },
        { remoteArgv: ["ls"] }
      ),
    /no password is set/
  );
});

// ─── spawnOnTarget: unresolved targets settle as errors ────
test("an unresolved target resolves to a non-spawned error result", async () => {
  const res = await spawnOnTarget({ kind: null, error: "boom" }, "anything");
  assert.equal(res.spawned, false);
  assert.equal(res.error, "boom");
});

// ─── command shape stays single-quote-shielded on both transports ───
test("buildScriptCommand quotes dir/script so config values cannot be shell syntax", () => {
  const cmd = buildScriptCommand({ dir: "/x/it's here", script: "start.sh", args: ["--flag=; rm -rf /"] });
  assert.ok(cmd.includes(shQuote("/x/it's here"))); // shQuote round-trip
  assert.ok(cmd.endsWith("exec bash './start.sh' '--flag=; rm -rf /'"));
});

test("shQuote neutralises the full quote", () => {
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
});
