import test from "node:test";
import assert from "node:assert/strict";
import {
  registerHeadlessRoutes,
  makeHeadlessProgram,
  parseHeadlessResult,
  parseHeadlessUnits,
  restoreProgram,
  HEADLESS_STATE_FILE,
} from "../headless/actions.js";
import { HEADLESS_UNITS } from "../collectors/HeadlessProbe.js";

const RESTORE_PROGRAM = restoreProgram();

function setup({ run = async () => "", spark = {}, found = true } = {}) {
  const handlers = {};
  const unit = { id: "s1", kind: "spark", platform: "linux", headlessMonitoring: true, ...spark };
  registerHeadlessRoutes(
    {
      get: (path, fn) => {
        handlers[`GET ${path}`] = fn;
      },
      post: (path, fn) => {
        handlers[`POST ${path}`] = fn;
      },
    },
    { registry: { getSpark: () => (found ? unit : undefined) }, allowChange: () => true, rejectLimited() {}, run }
  );
  const call = async (method, path, body, headers = {}) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    await handlers[`${method} ${path}`]({ body, params: { id: "s1" }, headers, socket: { remoteAddress: "127.0.0.1" } }, res);
    return res;
  };
  return { call, spark: unit };
}

const MAKE = "/api/sparks/:id/headless/make";
const RESTORE = "/api/sparks/:id/headless/restore";
const FLAGS = "/api/sparks/:id/headless/flags";

test("make requires confirmation, a desktop-stop confirmation, a Linux unit and opt-in monitoring", async () => {
  let calls = 0;
  const { call, spark } = setup({ run: async () => { calls++; return ""; } });
  assert.equal((await call("POST", MAKE, {})).statusCode, 400);
  assert.equal((await call("POST", MAKE, { confirm: true })).statusCode, 400);
  spark.kind = "mac";
  assert.equal((await call("POST", MAKE, { confirm: true, stopDesktopConfirmed: true })).statusCode, 400);
  spark.kind = "spark";
  spark.platform = "windows";
  assert.equal((await call("POST", MAKE, { confirm: true, stopDesktopConfirmed: true })).statusCode, 400);
  spark.platform = "linux";
  spark.headlessMonitoring = false;
  assert.equal((await call("POST", MAKE, { confirm: true, stopDesktopConfirmed: true })).statusCode, 400);
  assert.equal(calls, 0);
});

test("restore requires confirmation and opt-in monitoring", async () => {
  let calls = 0;
  const { call, spark } = setup({ run: async () => { calls++; return ""; } });
  assert.equal((await call("POST", RESTORE, {})).statusCode, 400);
  spark.headlessMonitoring = false;
  assert.equal((await call("POST", RESTORE, { confirm: true })).statusCode, 400);
  assert.equal(calls, 0);
});

test("a unit outside the allow-list is refused, not dropped", async () => {
  let calls = 0;
  const { call } = setup({ run: async () => { calls++; return ""; } });
  for (const units of [["snapd.service"], ["NetworkManager.service"], ["cups.service", "ssh.service"], "cups.service"]) {
    const res = await call("POST", MAKE, { confirm: true, stopDesktopConfirmed: true, units });
    assert.equal(res.statusCode, 400, JSON.stringify(units));
    assert.match(res.body.error, /Unknown service|list of service names/);
  }
  assert.equal(calls, 0);
});

test("make runs the program and returns the parsed result", async () => {
  let program;
  const { call } = setup({
    run: async (_spark, p) => {
      program = p;
      return [
        "headless-result mem_before=4620288",
        "headless-result mem_after=5242880",
        "headless-result default_before=graphical.target",
        "headless-result default_after=multi-user.target",
        "headless-result stopped_display_manager=1",
        "headless-result disabled=cups.service",
        "headless-result failed=",
        `headless-result state_file=${HEADLESS_STATE_FILE}`,
      ].join("\n");
    },
  });
  const res = await call("POST", MAKE, { confirm: true, stopDesktopConfirmed: true, units: ["cups.service"] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.result, {
    mode: null,
    memBeforeKib: 4620288,
    memAfterKib: 5242880,
    defaultBefore: "graphical.target",
    defaultAfter: "multi-user.target",
    stoppedDisplayManager: true,
    startedDisplayManager: false,
    disabled: ["cups.service"],
    restored: [],
    failed: [],
    stateFile: HEADLESS_STATE_FILE,
  });
  assert.match(program, /for u in cups\.service; do/);
  assert.match(program, /systemctl disable --now "\$u"/);
  assert.ok(!program.includes("bluetooth.service"));
});

test("the make program records the previous state before it changes anything", () => {
  const program = makeHeadlessProgram(["cups.service", "bluetooth.service"]);
  const record = program.indexOf(`> "$1/state"`);
  const setDefault = program.indexOf("systemctl set-default multi-user.target");
  const stopDm = program.indexOf("systemctl stop display-manager.service");
  const disable = program.indexOf('systemctl disable --now "$u"');
  assert.ok(record > 0, "writes the state file");
  assert.ok(record < setDefault, "records before changing the boot default");
  assert.ok(setDefault < stopDm, "changes the boot default before stopping the desktop");
  assert.ok(stopDm < disable, "stops the desktop before disabling optional services");
  assert.match(program, /default_target=\$prev_default/);
  assert.match(program, /display_manager=\$dm_state/);
  assert.match(program, /unit \$u \$ufs \$as/);
  // An empty systemd answer is recorded as "-", so the restore never reads it as a state.
  assert.match(program, /\[ -n "\$ufs" \] \|\| ufs=-/);
  assert.match(program, /\[ -n "\$as" \] \|\| as=-/);
  assert.match(program, /mem_available/);
  assert.ok(program.indexOf("before=$(mem_available)") < record);
  assert.ok(program.indexOf("after=$(mem_available)") > disable);
});

test("the make program touches only the ticked allow-listed units", () => {
  const program = makeHeadlessProgram(["cups.socket"]);
  assert.match(program, /for u in cups\.socket; do/);
  for (const unit of HEADLESS_UNITS.filter((u) => u !== "cups.socket")) {
    assert.ok(!program.includes(unit), unit);
  }
  // No ticked units: nothing is disabled, and the record still holds the boot default.
  const bare = makeHeadlessProgram([]);
  assert.ok(!bare.includes("for u in "));
  assert.match(bare, /default_target=\$prev_default/);
});

test("the restore program restores the recorded target and only allow-listed units", () => {
  assert.match(RESTORE_PROGRAM, /systemctl set-default "\$target"/);
  assert.match(RESTORE_PROGRAM, /systemctl start display-manager\.service/);
  assert.match(RESTORE_PROGRAM, /graphical\.target\|multi-user\.target/);
  for (const unit of HEADLESS_UNITS) assert.ok(RESTORE_PROGRAM.includes(unit), unit);
  // A record naming anything else is skipped by the case pattern.
  assert.match(RESTORE_PROGRAM, /\)\s*;;\s*\*\)\s*continue/);
  // With no record, only the boot default goes back.
  assert.match(RESTORE_PROGRAM, /mode=default-only/);
  assert.match(RESTORE_PROGRAM, /systemctl set-default graphical\.target/);
});

test("a typed password travels on stdin, never in the program, and is redacted from errors", async () => {
  let args;
  const { call } = setup({
    run: async (...a) => {
      args = a;
      throw new Error("sudo password was rejected");
    },
  });
  const res = await call("POST", RESTORE, { confirm: true, sudoPassword: "hunter2" });
  assert.equal(res.statusCode, 502);
  assert.equal(args[2].input, "hunter2");
  assert.ok(!args[1].includes("hunter2"));
  assert.match(res.body.error, /sudo password was rejected/);

  const leaky = setup({
    run: async () => {
      throw new Error("failed while using hunter2");
    },
  });
  const leaked = await leaky.call("POST", RESTORE, { confirm: true, sudoPassword: "hunter2" });
  assert.equal(leaked.statusCode, 502);
  assert.ok(!leaked.body.error.includes("hunter2"));
  assert.match(leaked.body.error, /\[redacted\]/);
});

test("a password is refused on a relayed plain-HTTP connection", async () => {
  let calls = 0;
  const { call } = setup({ run: async () => { calls++; return ""; } });
  const res = await call("POST", RESTORE, { confirm: true, sudoPassword: "secret" }, { "x-forwarded-for": "10.0.0.2" });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("a malformed password is refused before anything runs", async () => {
  let calls = 0;
  const { call } = setup({ run: async () => { calls++; return ""; } });
  const res = await call("POST", RESTORE, { confirm: true, sudoPassword: "two\nlines" });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("a second change on the same unit is refused while the first runs", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { call } = setup({ run: () => gate });
  const first = call("POST", RESTORE, { confirm: true });
  const second = await call("POST", RESTORE, { confirm: true });
  assert.equal(second.statusCode, 409);
  release("");
  assert.equal((await first).statusCode, 200);
});

test("an unknown unit is a 404", async () => {
  const { call } = setup({ found: false });
  assert.equal((await call("POST", RESTORE, { confirm: true })).statusCode, 404);
  assert.equal((await call("GET", FLAGS)).statusCode, 404);
});

test("the flags route says whether a typed password would be accepted", async () => {
  const { call } = setup();
  const local = await call("GET", FLAGS);
  assert.deepEqual(local.body, { passwordAllowed: true, plainPasswordAllowed: false });
  const relayed = await call("GET", FLAGS, undefined, { "x-forwarded-for": "10.0.0.2" });
  assert.deepEqual(relayed.body, { passwordAllowed: false, plainPasswordAllowed: false });
});

test("parseHeadlessUnits accepts the allow-list and refuses anything else", () => {
  assert.deepEqual(parseHeadlessUnits(undefined), { units: [] });
  assert.deepEqual(parseHeadlessUnits(["cups.service", "cups.service"]), { units: ["cups.service"] });
  assert.match(parseHeadlessUnits("cups.service").error, /list of service names/);
  assert.match(parseHeadlessUnits([42]).error, /Unknown service/);
  assert.match(parseHeadlessUnits(["cups.service; rm -rf /"]).error, /Unknown service/);
});

test("parseHeadlessResult leaves missing fields unknown", () => {
  assert.deepEqual(parseHeadlessResult(""), {
    mode: null,
    memBeforeKib: null,
    memAfterKib: null,
    defaultBefore: null,
    defaultAfter: null,
    stoppedDisplayManager: false,
    startedDisplayManager: false,
    disabled: [],
    restored: [],
    failed: [],
    stateFile: null,
  });
  const restored = parseHeadlessResult(
    [
      "headless-result mode=recorded",
      "headless-result mem_before=5242880",
      "headless-result mem_after=4620288",
      "headless-result started_display_manager=1",
      "headless-result restored=cups.service,bluetooth.service",
      "headless-result failed=fwupd-refresh.timer",
    ].join("\n")
  );
  assert.equal(restored.mode, "recorded");
  assert.equal(restored.startedDisplayManager, true);
  assert.deepEqual(restored.restored, ["cups.service", "bluetooth.service"]);
  assert.deepEqual(restored.failed, ["fwupd-refresh.timer"]);
  assert.equal(restored.memAfterKib, 4620288);
});
