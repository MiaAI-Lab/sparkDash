/**
 * Delete v2 on the dashboard side: what the delete program is given, how its new answers reach the page,
 * the Needs-attention API and the per-Spark acknowledgement for administrator folder deletes.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElevatedDeleteAcks } from "../ackStore.js";
import { parseQuarantineOutput } from "../commands.js";
import { PROTECTED_ROOTS, PROTECTED_TREE_ROOTS, protectedReason } from "../policy.js";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";

const spark = { id: "s1", name: "Spark One", kind: "spark", platform: "linux", ssh: { user: "me", host: "10.0.0.5" } };
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const QID = "0b6f1c2e-6a0e-4c1f-9d55-4a1e7a3c2b10";

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delv2-api-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function make(answer, opts = {}) {
  const calls = [];
  const m = new StorageManager({
    run: async (_s, program, o) => {
      calls.push({ program, ...o });
      return typeof answer === "function" ? answer(o, calls.length) : answer;
    },
    holdMs: 0,
    acks: new ElevatedDeleteAcks({ file: null }),
    ...opts,
  });
  return { m, calls };
}

test("a delete hands the unit an operation id, the acknowledgement flag and the protected list", async () => {
  const { m, calls } = make("RESULT=ok\nSTAGED=home\n");
  await m.delete(spark, { path: "/home/me/models" });
  const [p, id, ack, prot] = calls[0].args;
  assert.equal(calls[0].name, "delete");
  assert.equal(p, "/home/me/models");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(ack, "0");
  assert.deepEqual(prot.split("\n"), PROTECTED_ROOTS);
  assert.ok(prot.includes("/var/lib/docker"));
  // The flag is only ever set for an administrator delete on a Spark whose owner acknowledged it.
  m.acknowledgeElevatedDelete(spark, { confirm: true, user: "me" });
  await m.delete(spark, { path: "/home/me/a" });
  assert.equal(calls[1].args[2], "0", "not elevated: no flag");
  await m.delete(spark, { path: "/home/me/b", sudo: true });
  assert.equal(calls[2].args[2], "1");
  m.revokeElevatedDelete(spark);
  await m.delete(spark, { path: "/home/me/c", sudo: true });
  assert.equal(calls[3].args[2], "0", "revoked");
  // The dashboard's own folders are added to the list.
  const own = make("RESULT=ok\n", { protectedPaths: ["/opt/sparkdash/config", "relative/ignored"] });
  await own.m.delete(spark, { path: "/home/me/d" });
  assert.deepEqual(own.calls[0].args[3].split("\n"), [...PROTECTED_ROOTS, "/opt/sparkdash/config"]);
});

test("delete v2 refusals map to statuses, keep the Needs-attention id, and offer the manual command as administrator", async () => {
  const cases = [
    ["protected-descendant", 403, false],
    ["protected", 403, false],
    ["staging-unavailable", 409, true],
    ["tree-writable-by-others", 409, true],
    ["no-ack", 409, true],
    ["changed", 409, false],
    ["no-perl", 409, false],
    ["mountpoint", 409, false],
  ];
  for (const [code, status, manual] of cases) {
    const { m } = make(`RESULT=error\nCODE=${code}\nMSG=Not deleted\n`);
    await assert.rejects(m.delete(spark, { path: "/home/me/it's", sudo: true }), (e) => {
      assert.equal(e.status, status, code);
      assert.equal(e.code, code);
      assert.equal(e.partial, false);
      assert.equal(e.command, manual ? "sudo rm -rf --one-file-system -- '/home/me/it'\\''s'" : undefined, code);
      return true;
    });
    // As the account itself there is nothing to run by hand.
    await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.command === undefined);
  }
  const { m } = make(`RESULT=error\nCODE=protected-descendant\nMSG=Not deleted; it is kept under Needs attention.\nREMAINS=0\nQID=${QID}\n`);
  await assert.rejects(m.delete(spark, { path: "/home/me/x" }), (e) => e.quarantineId === QID && e.partial === false);
  const bad = make("RESULT=error\nCODE=rm-failed\nMSG=x\nQID=../../etc\n");
  await assert.rejects(bad.m.delete(spark, { path: "/home/me/x" }), (e) => e.quarantineId === undefined);
});

test("SparkDash's own staging folders and records are locked in the page, like SSH keys", () => {
  for (const p of [
    "/home/me/.local/state/sparkdash",
    `/home/me/.local/state/sparkdash/staging/${QID}`,
    `/home/me/.local/state/sparkdash/quarantine/${QID}.json`,
    "/mnt/disk/.sparkdash-staging-1000",
    `/mnt/disk/.sparkdash-staging-1000/${QID}/x`,
  ]) {
    assert.match(protectedReason(p), /Needs attention/, p);
  }
  assert.equal(protectedReason("/home/me/.local/state/other"), null);
  assert.equal(protectedReason("/mnt/disk/sparkdash-staging"), null);
});

test("parseQuarantineOutput decodes records and drops malformed ones", () => {
  const out = [
    "RESULT=ok",
    `ITEM=${QID}|conflict|1|d|1761480000|${hex("/data/my models")}|${hex("/home/me/.local/state/sparkdash/staging/" + QID)}|${hex("Its name is in use again")}`,
    `ITEM=aaaaaaaa-0000-0000-0000-000000000000|gone|0|f|1761470000|${hex("/tmp/x")}|${hex("/s/x")}|`,
    `ITEM=../evil|staged|0|d|1|${hex("/x")}|${hex("/y")}|`,
    `ITEM=${QID}|weird|0|d|1|${hex("/x")}|${hex("/y")}|`,
    `ITEM=${QID}|staged|0|d|1|zz|${hex("/y")}|`,
  ].join("\n");
  const r = parseQuarantineOutput(out);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [
    { id: QID, state: "conflict", elevated: true, type: "dir", createdAt: 1761480000000, path: "/data/my models", stagedPath: `/home/me/.local/state/sparkdash/staging/${QID}`, reason: "Its name is in use again" },
    { id: "aaaaaaaa-0000-0000-0000-000000000000", state: "gone", elevated: false, type: "file", createdAt: 1761470000000, path: "/tmp/x", stagedPath: "/s/x", reason: null },
  ]);
  assert.equal(parseQuarantineOutput("RESULT=error\nCODE=quarantine-unavailable\nMSG=no\n").code, "quarantine-unavailable");
});

/** A unit whose Needs-attention list holds one item that came from `original`. */
const listed = (original, answers = {}) => (o) =>
  o.name === "quarantineList" ? `RESULT=ok\nITEM=${QID}|staged|0|d|1|${hex(original)}|${hex(`/h/s/${QID}`)}|\n` : answers[o.args[0]] ?? "RESULT=ok\n";

test("restore, delete and forget from Needs attention: validated, exclusive, and the outcome is reported", async () => {
  const { m, calls } = make(listed("/data/x", { restore: "RESULT=ok\nOUTCOME=restored\n", delete: "RESULT=ok\nOUTCOME=deleted\n", forget: "RESULT=ok\nOUTCOME=forgotten\n" }));
  assert.deepEqual(await m.resolveQuarantined(spark, QID, "restore", {}), { id: QID, outcome: "restored" });
  // The record is read first; the unit restores only to the path checked here, never into a protected tree.
  assert.deepEqual(calls.map((c) => c.name), ["quarantineList", "quarantine"]);
  assert.deepEqual(calls[1].args.slice(0, 3), ["restore", QID, "0"]);
  assert.equal(calls[1].args[4], "/data/x");
  assert.deepEqual(calls[1].args[5].split("\n"), PROTECTED_TREE_ROOTS);
  assert.deepEqual(await m.resolveQuarantined(spark, QID, "delete", { sudo: true }), { id: QID, outcome: "deleted" });
  assert.deepEqual(calls[2].args.slice(4), ["", ""]);
  assert.deepEqual(await m.resolveQuarantined(spark, QID, "forget", {}), { id: QID, outcome: "forgotten" });
  assert.equal(calls[3].args[0], "forget");
  await assert.rejects(m.resolveQuarantined(spark, "../x", "restore", {}), (e) => e.status === 400);
  await assert.rejects(m.resolveQuarantined(spark, QID, "rename", {}), (e) => e.status === 400);
  assert.equal(calls.length, 4);

  const present = make("RESULT=error\nCODE=payload-present\nMSG=Something is in the staging folder for this item\n");
  await assert.rejects(present.m.resolveQuarantined(spark, QID, "forget", {}), (e) => e.status === 409 && e.code === "payload-present");
  const badRecord = make("RESULT=error\nCODE=bad-record\nMSG=This record points outside SparkDash's staging folders\n");
  await assert.rejects(badRecord.m.resolveQuarantined(spark, QID, "delete", {}), (e) => e.status === 409 && e.code === "bad-record");

  const conflict = make(listed("/data/x", { restore: "RESULT=error\nCODE=restore-conflict\nMSG=Something new is now at /data/x.\n" }));
  await assert.rejects(conflict.m.resolveQuarantined(spark, QID, "restore", {}), (e) => e.status === 409 && e.code === "restore-conflict");
  const list = make(`RESULT=ok\nITEM=${QID}|staged|0|d|1|${hex("/a")}|${hex("/b")}|\n`);
  // A restore into a protected place is refused here, before the unit is asked; so is a record that is gone.
  for (const original of ["/etc/cron.d/job", "/home/me/.ssh/authorized_keys", "/var/lib/docker/x", "/home/me/.local/state/sparkdash/staging/y", "/home/me/a/../b"]) {
    const p = make(listed(original));
    await assert.rejects(p.m.resolveQuarantined(spark, QID, "restore", {}), (e) => (e.code === "protected" && e.status === 403) || e.code === "bad-record", original);
    assert.deepEqual(p.calls.map((c) => c.name), ["quarantineList"], original);
  }
  const gone = make("RESULT=ok\n");
  await assert.rejects(gone.m.resolveQuarantined(spark, QID, "restore", {}), (e) => e.status === 404);
  assert.equal((await list.m.quarantine(spark)).items[0].path, "/a");
  assert.equal(list.calls[0].name, "quarantineList", "the read-only list does not wait for the unit lock");
});

test("the acknowledgement: stored per Spark and account, shown in status, revocable, never implied by a password", async () => {
  const t = tempDir();
  try {
    const file = path.join(t.dir, "acks.json");
    let now = 1000;
    const acks = new ElevatedDeleteAcks({ file, now: () => now });
    const { m } = make("RESULT=ok\nUSER=me\nSUDO=no\nDOCKER=ok\n", { acks });
    assert.equal((await m.status(spark)).elevatedDeleteAck, null);
    assert.throws(() => m.acknowledgeElevatedDelete(spark, {}), (e) => e.status === 400);
    assert.throws(() => m.acknowledgeElevatedDelete(spark, { confirm: "yes" }), (e) => e.status === 400);
    assert.deepEqual(m.acknowledgeElevatedDelete(spark, { confirm: true, user: "me" }), { user: "me", acknowledgedAt: 1000 });
    assert.deepEqual((await m.status(spark)).elevatedDeleteAck, { user: "me", acknowledgedAt: 1000 });
    // Another account on the same host, or another Spark, is not covered.
    assert.equal(m.elevatedDeleteAck({ ...spark, ssh: { user: "other", host: "10.0.0.5" } }), null);
    assert.equal(m.elevatedDeleteAck({ ...spark, id: "s2" }), null);
    // Kept across a restart, private on disk.
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    now = 2000;
    const again = make("RESULT=ok\n", { acks: new ElevatedDeleteAcks({ file }) });
    assert.deepEqual(again.m.elevatedDeleteAck(spark), { user: "me", acknowledgedAt: 1000 });
    assert.deepEqual(again.m.revokeElevatedDelete(spark), { revoked: true });
    assert.deepEqual(again.m.revokeElevatedDelete(spark), { revoked: false });
    assert.equal(new ElevatedDeleteAcks({ file }).get("s1", "me@10.0.0.5:22"), null, "revoking is saved");
  } finally {
    t.cleanup();
  }
});

test("an acknowledgement file the dashboard cannot read is left alone and nothing in it counts", () => {
  const t = tempDir();
  try {
    const file = path.join(t.dir, "acks.json");
    const future = JSON.stringify({ version: 9, acks: { "s1|me@10.0.0.5:22": { sparkId: "s1", account: "me@10.0.0.5:22", acknowledgedAt: 1, wording: 1 } } });
    fs.writeFileSync(file, future);
    const acks = new ElevatedDeleteAcks({ file });
    assert.equal(acks.get("s1", "me@10.0.0.5:22"), null);
    assert.throws(() => acks.set("s1", "me@10.0.0.5:22", "me"), (e) => e.code === "ack-store-broken");
    assert.equal(fs.readFileSync(file, "utf8"), future, "preserved as it was");
    // An acknowledgement of older wording no longer counts.
    fs.writeFileSync(file, JSON.stringify({ version: 1, acks: { k: { sparkId: "s1", account: "me@10.0.0.5:22", acknowledgedAt: 1, wording: 0 } } }));
    assert.equal(new ElevatedDeleteAcks({ file }).get("s1", "me@10.0.0.5:22"), null);
  } finally {
    t.cleanup();
  }
});

async function withApp(run, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  const manager = new StorageManager({ run, holdMs: 0, acks: new ElevatedDeleteAcks({ file: null }) });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => (id === "s1" ? spark : null) },
    recordEvent: (e) => events.push(e),
    allowRead: () => true,
    allowChange: () => true,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/sparks/s1/storage`, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("routes: delete refusals carry quarantineId and command; Needs attention list, restore, delete; acknowledgement", async () => {
  let answer = "";
  await withApp(async (_s, _p, o) => (typeof answer === "function" ? answer(o) : answer), async (base, events) => {
    answer = `RESULT=error\nCODE=tree-writable-by-others\nMSG=drop can be changed by other accounts\nREMAINS=0\nQID=${QID}\n`;
    let res = await fetch(`${base}/delete`, json("POST", { path: "/data/x", sudo: true }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "drop can be changed by other accounts",
      code: "tree-writable-by-others",
      quarantineId: QID,
      command: "sudo rm -rf --one-file-system -- '/data/x'",
    });

    answer = `RESULT=ok\nITEM=${QID}|conflict|0|d|1761480000|${hex("/data/x")}|${hex("/h/s/" + QID)}|${hex("taken")}\n`;
    res = await fetch(`${base}/quarantine`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].state, "conflict");

    answer = listed("/data/x", { restore: "RESULT=ok\nOUTCOME=restored\n" });
    res = await fetch(`${base}/quarantine/${QID}/restore`, json("POST", {}));
    assert.deepEqual(await res.json(), { success: true, id: QID, outcome: "restored" });
    answer = "RESULT=ok\nOUTCOME=gone\n";
    res = await fetch(`${base}/quarantine/${QID}/delete`, json("POST", {}));
    assert.deepEqual(await res.json(), { success: true, id: QID, outcome: "gone" });
    answer = "RESULT=error\nCODE=payload-present\nMSG=Something is in the staging folder for this item, so its record was kept.\n";
    res = await fetch(`${base}/quarantine/${QID}/forget`, json("POST", {}));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "payload-present");
    answer = "RESULT=ok\nOUTCOME=forgotten\n";
    res = await fetch(`${base}/quarantine/${QID}/forget`, json("POST", {}));
    assert.deepEqual(await res.json(), { success: true, id: QID, outcome: "forgotten" });
    assert.deepEqual(events.map((e) => e.type), ["storage.quarantine.restore"], "dropping a stale record is not logged as a delete");
    res = await fetch(`${base}/quarantine/not-an-id/delete`, json("POST", {}));
    assert.equal(res.status, 400);

    res = await fetch(`${base}/elevated-delete-ack`, json("POST", { confirm: true, user: "me" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ack.user, "me");
    answer = "RESULT=ok\nUSER=me\nSUDO=no\nDOCKER=ok\n";
    assert.equal((await (await fetch(base)).json()).elevatedDeleteAck.user, "me");
    res = await fetch(`${base}/elevated-delete-ack`, json("DELETE"));
    assert.deepEqual(await res.json(), { success: true, revoked: true });
    assert.equal((await (await fetch(base)).json()).elevatedDeleteAck, null);
    assert.deepEqual(events.map((e) => e.type).slice(1), ["storage.elevated-delete.ack", "storage.elevated-delete.revoke"]);
  });
});
