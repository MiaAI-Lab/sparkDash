import { beforeEach, test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sshCommandSpec } from "../ssh.js";

beforeEach((t) => {
  for (const name of ["SSH_CONTROL_PERSIST_SECONDS", "SSH_CONTROL_PERSIST", "SSH_IDENTITY_FILE"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
});

const controlOptions = (spec) => spec.args.filter((arg) => /^Control/.test(arg));
const controlPath = (spec) => spec.args.find((arg) => arg.startsWith("ControlPath="));

const keySpark = {
  id: "s1",
  lanIp: "192.168.1.143",
  ssh: { host: "192.168.1.143", user: "mia", auth: "key" },
};

test("sshCommandSpec: key auth uses BatchMode and destination after --", () => {
  const spec = sshCommandSpec(keySpark, { remoteArgv: ["echo ok"] });
  assert.equal(spec.file, "ssh");
  assert.equal(spec.targetHost, "192.168.1.143");
  assert.ok(spec.args.includes("BatchMode=yes"));
  const dash = spec.args.indexOf("--");
  assert.ok(dash >= 0);
  assert.equal(spec.args[dash + 1], "mia@192.168.1.143");
  assert.equal(spec.args[dash + 2], "echo ok");
  assert.equal(spec.env.SSHPASS, undefined);
});

test("sshCommandSpec: extraSshArgs land before destination (tunnel flags)", () => {
  const spec = sshCommandSpec(keySpark, {
    extraSshArgs: ["-N", "-L", "127.0.0.1:9:127.0.0.1:8888"],
  });
  const dash = spec.args.indexOf("--");
  const n = spec.args.indexOf("-N");
  const l = spec.args.indexOf("-L");
  assert.ok(n >= 0 && n < dash);
  assert.ok(l >= 0 && l < dash);
  assert.equal(spec.args[l + 1], "127.0.0.1:9:127.0.0.1:8888");
  assert.equal(spec.args[dash + 1], "mia@192.168.1.143");
  assert.equal(spec.args.length, dash + 2);
});

test("sshCommandSpec: missing user throws", () => {
  assert.throws(
    () => sshCommandSpec({ id: "s", lanIp: "192.168.1.1", ssh: { auth: "key" } }),
    /SSH config missing/
  );
});

test("sshCommandSpec: commands use the private socket and persistence from their readiness config", () => {
  const spec = sshCommandSpec(keySpark, { remoteArgv: ["cat /proc/uptime"] });
  const dash = spec.args.indexOf("--");
  const master = spec.args.indexOf("ControlMaster=auto");
  const controlPath = spec.args.find((a) => a.startsWith("ControlPath="));
  const persist = spec.args.find((a) => a.startsWith("ControlPersist="));
  assert.ok(master >= 0 && master < dash);
  // Include OpenSSH's temporary socket suffix and the terminating NUL in
  // macOS's 104-byte limit. A long per-user TMPDIR must not affect this path.
  const cpValue = controlPath?.slice("ControlPath=".length);
  assert.ok(cpValue && cpValue.startsWith("/tmp/sparkdash-"), `controlPath: ${controlPath}`);
  assert.ok(!cpValue.includes("%"));
  assert.ok(Buffer.byteLength(cpValue) + 18 <= 104, `control path too long: ${cpValue.length}`);
  assert.equal(fs.statSync(path.dirname(cpValue)).mode & 0o777, 0o700);
  assert.equal(persist, "ControlPersist=60");
  assert.deepEqual(controlOptions(spec), spec.multiplex.args.filter((arg) => /^Control/.test(arg)));
  const next = sshCommandSpec(keySpark, { remoteArgv: ["cat /proc/meminfo"] });
  assert.deepEqual(controlOptions(next), controlOptions(spec));
});

test("sshCommandSpec: multiplex:false opts out (tunnels own their connection)", () => {
  const spec = sshCommandSpec(keySpark, { multiplex: false, extraSshArgs: ["-N"] });
  assert.ok(spec.args.includes("ControlMaster=no"));
  assert.ok(spec.args.includes("ControlPath=none"));
  assert.ok(!spec.args.includes("ControlMaster=auto"));
  assert.equal(spec.multiplex, null);
});

test("sshCommandSpec: documented zero persistence disables both reuse and the readiness probe", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "0";
  process.env.SSH_CONTROL_PERSIST = "300";
  const spec = sshCommandSpec(keySpark);
  assert.deepEqual(controlOptions(spec), ["ControlMaster=no", "ControlPath=none"]);
  assert.equal(spec.multiplex, null);
});

test("sshCommandSpec: configured persistence reaches the actual SSH command", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "120";
  process.env.SSH_CONTROL_PERSIST = "300";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=120"));
  assert.equal(spec.multiplex.persistSeconds, 120);
});

test("sshCommandSpec: legacy persistence is a fallback for the documented setting", () => {
  process.env.SSH_CONTROL_PERSIST = "180";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=180"));
  assert.equal(spec.multiplex.persistSeconds, 180);
});

test("sshCommandSpec: persistence bounds apply to the command as well as readiness", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "99999";
  const spec = sshCommandSpec(keySpark);
  assert.ok(spec.args.includes("ControlPersist=3600"));
  assert.equal(spec.multiplex.persistSeconds, 3600);
  process.env.SSH_CONTROL_PERSIST_SECONDS = "invalid";
  assert.ok(sshCommandSpec(keySpark).args.includes("ControlPersist=60"));
});

test("sshCommandSpec: changing the key identity changes the socket passed to SSH", () => {
  process.env.SSH_IDENTITY_FILE = "/example/first-key";
  const first = sshCommandSpec(keySpark);
  process.env.SSH_IDENTITY_FILE = "/example/second-key";
  const second = sshCommandSpec(keySpark);
  assert.notEqual(controlPath(first), controlPath(second));
  assert.ok(first.args.includes("/example/first-key"));
  assert.ok(second.args.includes("/example/second-key"));
});

test("sshCommandSpec: password changes select a different socket without exposing the password", (t) => {
  const existsSync = fs.existsSync;
  const statSync = fs.statSync;
  t.mock.method(fs, "existsSync", (p) => p === "/usr/bin/sshpass" || existsSync(p));
  t.mock.method(fs, "statSync", (p) => p === "/usr/bin/sshpass" ? { isFile: () => true } : statSync(p));
  const spark = { ...keySpark, ssh: { ...keySpark.ssh, auth: "pass", password: "test-password-one" } };
  const first = sshCommandSpec(spark);
  const second = sshCommandSpec({ ...spark, ssh: { ...spark.ssh, password: "test-password-two" } });
  assert.equal(first.file, "sshpass");
  assert.equal(first.env.SSHPASS, "test-password-one");
  assert.equal(second.env.SSHPASS, "test-password-two");
  assert.notEqual(controlPath(first), controlPath(second));
  assert.ok(!first.args.join(" ").includes("test-password-one"));
  assert.ok(!second.args.join(" ").includes("test-password-two"));
});

test("sshCommandSpec: different records and authentication modes do not share a socket", (t) => {
  const existsSync = fs.existsSync;
  const statSync = fs.statSync;
  t.mock.method(fs, "existsSync", (p) => p === "/usr/bin/sshpass" || existsSync(p));
  t.mock.method(fs, "statSync", (p) => p === "/usr/bin/sshpass" ? { isFile: () => true } : statSync(p));
  const key = sshCommandSpec(keySpark);
  const otherRecord = sshCommandSpec({ ...keySpark, id: "other-record" });
  const password = sshCommandSpec({ ...keySpark, ssh: { ...keySpark.ssh, auth: "pass", password: "test-only" } });
  assert.notEqual(controlPath(key), controlPath(otherRecord));
  assert.notEqual(controlPath(key), controlPath(password));
});

test("sshCommandSpec: the legacy global switch still disables reuse", () => {
  const moduleUrl = new URL("../ssh.js", import.meta.url).href;
  const script = `
    import { sshCommandSpec } from ${JSON.stringify(moduleUrl)};
    const spec = sshCommandSpec(${JSON.stringify(keySpark)});
    console.log(JSON.stringify({ args: spec.args, multiplex: spec.multiplex }));
  `;
  const spec = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, SSH_MULTIPLEX: "0", SSH_CONTROL_PERSIST_SECONDS: "60" },
    encoding: "utf8",
  }));
  assert.deepEqual(controlOptions(spec), ["ControlMaster=no", "ControlPath=none"]);
  assert.equal(spec.multiplex, null);
});
