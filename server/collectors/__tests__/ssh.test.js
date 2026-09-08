import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sshCommandSpec } from "../ssh.js";

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

test("sshCommandSpec: commands share one master connection", () => {
  const spec = sshCommandSpec(keySpark, { remoteArgv: ["cat /proc/uptime"] });
  const dash = spec.args.indexOf("--");
  const master = spec.args.indexOf("ControlMaster=auto");
  const controlPath = spec.args.find((a) => a.startsWith("ControlPath="));
  const persist = spec.args.find((a) => a.startsWith("ControlPersist="));
  assert.ok(master >= 0 && master < dash);
  // The literal must be a SHORT already-expanded path: execFile hands the
  // value to ssh without shell/template expansion, and the LOCAL socket name
  // must fit sun_path (~104 bytes on macOS). %C stays expanded-by-hand.
  const cpValue = controlPath?.slice("ControlPath=".length);
  assert.ok(cpValue && cpValue.startsWith("/tmp/sparkdash-"), `controlPath: ${controlPath}`);
  assert.ok(!cpValue.includes("%"));
  assert.ok(cpValue.length < 104, `control path too long: ${cpValue.length}`);
  assert.equal(persist, "ControlPersist=300");
});

test("sshCommandSpec: multiplex:false opts out (tunnels own their connection)", () => {
  const spec = sshCommandSpec(keySpark, { multiplex: false, extraSshArgs: ["-N"] });
  assert.ok(spec.args.includes("ControlMaster=no"));
  assert.ok(spec.args.includes("ControlPath=none"));
  assert.ok(!spec.args.includes("ControlMaster=auto"));
});
