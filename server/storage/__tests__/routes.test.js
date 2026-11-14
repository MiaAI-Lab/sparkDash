import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";

const ID_A = `sha256:${"a".repeat(64)}`;

async function withApp({ run, allow = () => true, sparks, remoteAddr, headers, plain = false }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  // Test hook: pretend the browser connected from another machine.
  if (remoteAddr) app.use((req, _res, next) => { Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddr, configurable: true }); next(); });
  if (headers) app.use((req, _res, next) => { Object.assign(req.headers, headers); next(); });
  const known = sparks ?? { s1: { id: "s1", name: "S1", kind: "spark" }, h1: { id: "h1", name: "H1", kind: "host" } };
  const manager = new StorageManager({ run, holdMs: 0 });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => known[id] },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
    allowPlainPassword: () => plain,
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, events, manager);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const scan = (rows) => ["RESULT=ok\n" + rows.map(([b, t, p]) => `${b}\t${t}\t${p}`).join("\0"), "@@RC=0", "@@UNREADABLE=0", ""].join("\0");

test("status carries whether a typed password would be accepted from here", async () => {
  const run = async () => "RESULT=ok\nUSER=me\nSUDO=no\nFS=/dev/nvme0n1p2 ext4 1000 400 600 40% /\nDOCKER=ok\nDOCKER_ROOT=/var/lib/docker\n";
  await withApp({ run }, async (base) => {
    const body = await (await fetch(`${base}/s1/storage`)).json();
    assert.equal(body.sudo, "no");
    assert.equal(body.passwordAllowed, true, "loopback peer");
    assert.equal(body.filesystems[0].mount, "/");
  });
  await withApp({ run, remoteAddr: "192.168.1.20" }, async (base) => {
    assert.equal((await (await fetch(`${base}/s1/storage`)).json()).passwordAllowed, false);
  });
});

test("scan: start, poll, then read the result", async () => {
  await withApp({ run: async () => scan([[100, "d", "/"], [60, "d", "/home"]]) }, async (base, _e, manager) => {
    const start = await fetch(`${base}/s1/storage/scan`, json("POST", { path: "/", depth: 2 }));
    assert.equal(start.status, 202);
    assert.equal((await start.json()).job.state, "running");
    await manager.settled("s1");
    const done = await (await fetch(`${base}/s1/storage/scan`)).json();
    assert.equal(done.job.state, "done");
    assert.equal(done.session.entries.length, 2);
    const same = await (await fetch(`${base}/s1/storage/scan?since=${done.revision}`)).json();
    assert.equal(same.session, null);
    const stop = await fetch(`${base}/s1/storage/scan`, json("DELETE"));
    assert.equal(stop.status, 200);
  });
});

test("a typed sudo password is refused on a plain-http connection from another machine", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return "RESULT=ok\n"; };
  await withApp({ run, remoteAddr: "192.168.1.20" }, async (base) => {
    for (const [url, body] of [
      ["/s1/storage/scan", { sudo: true, sudoPassword: "pw" }],
      ["/s1/storage/delete", { path: "/home/me/x", sudo: true, sudoPassword: "pw" }],
      ["/s1/storage/docker", { sudo: true, sudoPassword: "pw" }],
      ["/s1/storage/docker/remove-images", { ids: [ID_A], sudo: true, sudoPassword: "pw" }],
    ]) {
      const res = await fetch(`${base}${url}`, json("POST", body));
      assert.equal(res.status, 400, url);
      assert.equal((await res.json()).code, "insecure-transport");
    }
    assert.equal(ran, 0);
  });
  // The same request over https (as a proxy reports it) is fine.
  await withApp({ run, remoteAddr: "192.168.1.20", headers: { "x-forwarded-proto": "https" } }, async (base) => {
    const res = await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/x", sudo: true, sudoPassword: "pw" }));
    assert.equal(res.status, 200);
  });
});

test("delete validates, records an Activity event and reports the path", async () => {
  await withApp({ run: async () => "RESULT=ok\n" }, async (base, events) => {
    for (const path of ["/", "/etc", "/home/me/.ssh", "nope"]) {
      const res = await fetch(`${base}/s1/storage/delete`, json("POST", { path }));
      assert.ok([400, 403].includes(res.status), path);
    }
    assert.equal(events.length, 0);

    const ok = await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/old model", sudo: true }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, path: "/home/me/old model" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "storage.delete");
    assert.match(events[0].message, /Deleted \/home\/me\/old model on S1 \(as administrator\)/);
  });
});

test("a permission failure answers 403 with a code and whether anything was removed", async () => {
  await withApp({ run: async () => "RESULT=error\nCODE=permission\nMSG=Permission denied\nREMAINS=1\n" }, async (base, events) => {
    const res = await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/x" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Permission denied", code: "permission", partial: true });
    assert.equal(events.length, 0, "nothing is logged as deleted");
  });
});

test("docker: overview, and removing images logs one event", async () => {
  const answers = [
    `RESULT=ok\nROOT=/var/lib/docker\nIMG=${ID_A}|100|2026-10-01T00:00:00Z|x:1\n`,
    `REMOVED=${ID_A}\nRESULT=ok\n`,
    `SKIPPED=${ID_A}|in-use\nRESULT=ok\n`,
  ];
  let n = 0;
  await withApp({ run: async () => answers[n++] }, async (base, events) => {
    const o = await (await fetch(`${base}/s1/storage/docker`, json("POST", {}))).json();
    assert.equal(o.images.length, 1);
    const r = await fetch(`${base}/s1/storage/docker/remove-images`, json("POST", { ids: [ID_A] }));
    assert.deepEqual(await r.json(), { success: true, removed: [ID_A], skipped: [], failed: [] });
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Removed 1 unused Docker image on S1/);
    const skipped = await fetch(`${base}/s1/storage/docker/remove-images`, json("POST", { ids: [ID_A] }));
    assert.equal((await skipped.json()).skipped.length, 1);
    assert.equal(events.length, 1, "nothing removed, nothing logged");
  });
});

test("host units, unknown units and rate-limited callers are refused before anything runs", async () => {
  let ran = 0;
  const run = async () => { ran += 1; return "RESULT=ok\n"; };
  await withApp({ run }, async (base) => {
    assert.equal((await fetch(`${base}/h1/storage`)).status, 400);
    assert.equal((await fetch(`${base}/h1/storage/delete`, json("POST", { path: "/home/me/x" }))).status, 400);
    assert.equal((await fetch(`${base}/nope/storage`)).status, 404);
    assert.equal(ran, 0);
  });
  await withApp({ run, allow: () => false }, async (base) => {
    assert.equal((await fetch(`${base}/s1/storage`)).status, 429);
    assert.equal((await fetch(`${base}/s1/storage/scan`, json("POST", {}))).status, 429);
    assert.equal((await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/x" }))).status, 429);
    assert.equal((await fetch(`${base}/s1/storage/docker`, json("POST", {}))).status, 429);
    assert.equal(ran, 0);
  });
});

test("unexpected errors stay generic", async () => {
  await withApp({ run: async () => "RESULT=ok\n" }, async (base, _e, manager) => {
    manager.snapshot = () => { throw new Error("internal detail /secret/path"); };
    const res = await fetch(`${base}/s1/storage/scan`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, "Storage action failed");
  });
});

test("Settings can allow a typed sudo password over plain http, and the status says so", async () => {
  const seen = [];
  const run = async (_s, _p, o) => { seen.push(o.input); return "RESULT=ok\nUSER=me\nSUDO=no\nDOCKER=ok\n"; };
  await withApp({ run, remoteAddr: "192.168.1.20", plain: true }, async (base) => {
    const status = await (await fetch(`${base}/s1/storage`)).json();
    assert.equal(status.passwordAllowed, true);
    assert.equal(status.plainPasswordAllowed, true);
    const res = await fetch(`${base}/s1/storage/delete`, json("POST", { path: "/home/me/x", sudo: true, sudoPassword: "pw" }));
    assert.equal(res.status, 200);
    assert.ok(seen.includes("pw"));
  });
  await withApp({ run, remoteAddr: "192.168.1.20", plain: false }, async (base) => {
    const status = await (await fetch(`${base}/s1/storage`)).json();
    assert.equal(status.passwordAllowed, false);
    assert.equal(status.plainPasswordAllowed, false);
  });
});

test("removing containers records one Activity event and is refused for a typed password over plain http", async () => {
  const C = "a".repeat(64);
  await withApp({ run: async () => `REMOVED=${C}\nRESULT=ok\n` }, async (base, events) => {
    const res = await fetch(`${base}/s1/storage/docker/remove-containers`, json("POST", { ids: [C] }));
    assert.deepEqual(await res.json(), { success: true, removed: [C], skipped: [], failed: [] });
    assert.match(events[0].message, /Removed 1 stopped Docker container on S1/);
    assert.equal((await fetch(`${base}/s1/storage/docker/remove-containers`, json("POST", { ids: ["web"] }))).status, 400);
  });
  await withApp({ run: async () => "RESULT=ok\n", remoteAddr: "192.168.1.20" }, async (base) => {
    const res = await fetch(`${base}/s1/storage/docker/remove-containers`, json("POST", { ids: [C], sudo: true, sudoPassword: "pw" }));
    assert.equal((await res.json()).code, "insecure-transport");
  });
});

test("the status says whether a sudo password is remembered, and DELETE forgets it", async () => {
  const { SudoVault } = await import("../sudoVault.js");
  const vault = new SudoVault({ file: null, encrypt: (p) => `e:${p}`, decrypt: (b) => b.slice(2) });
  // The route builds its own manager; pass ours through a tiny wrapper app.
  const app = express();
  app.use(express.json());
  const manager = new StorageManager({ run: async () => "RESULT=ok\nUSER=me\nSUDO=no\nDOCKER=ok\n", vault, holdMs: 0 });
  const spark = { id: "s1", name: "S1", kind: "spark", ssh: { user: "me", host: "10.0.0.5" } };
  registerStorageRoutes(app, { manager, registry: { getSpark: () => spark }, recordEvent: () => {}, allowRead: () => true, allowChange: () => true, rejectLimited: (res) => res.status(429).json({}) });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks/s1/storage`;
  try {
    assert.equal((await (await fetch(base)).json()).sudoSaved, false);
    vault.set("me@10.0.0.5:22", "pw");
    const status = await (await fetch(base)).json();
    assert.equal(status.sudoSaved, true);
    assert.ok(!JSON.stringify(status).includes("pw\""), "the password itself never leaves the server");
    assert.deepEqual(await (await fetch(`${base}/sudo-password`, { method: "DELETE" })).json(), { success: true, forgotten: true });
    assert.equal((await (await fetch(base)).json()).sudoSaved, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("folders: lists the folders inside one folder, nothing else", async () => {
  let program = "";
  const run = async (_s, p) => {
    program = p;
    return "RESULT=ok\nD=zeta\nD=alpha\nD=bad\u0001name\nD=alpha\nD=with space\n";
  };
  await withApp({ run }, async (base) => {
    const res = await fetch(`${base}/s1/storage/folders?path=${encodeURIComponent("/home/me")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: "/home/me", dirs: ["alpha", "with space", "zeta"], more: false });
    assert.ok(!program.includes("/home/me"), "the path travels base64, never as script text");
    assert.equal((await fetch(`${base}/s1/storage/folders?path=${encodeURIComponent("/a/../b")}`)).status, 400);
    assert.equal((await fetch(`${base}/s1/storage/folders?path=relative`)).status, 400);
  });
});

test("folders: a missing or closed folder is a clear refusal", async () => {
  await withApp({ run: async () => "RESULT=error\nCODE=not-found\nMSG=That folder does not exist on the Spark\n" }, async (base) => {
    const res = await fetch(`${base}/s1/storage/folders?path=/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not-found");
  });
});
