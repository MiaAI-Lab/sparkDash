/**
 * POST /api/sparks/:id/storage/advise: validation, the read limiter, an offline Spark, that it never waits for or
 * takes the Spark's busy slot, and the merge with what the dashboard keeps (saved analyses of this and other Sparks,
 * its launchers and watched LLM servers). Saved analyses live in a temporary folder.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerStorageRoutes } from "../routes.js";
import { StorageManager } from "../StorageManager.js";
import { MAX_BULK_DELETE_PATHS } from "../StorageManager.js";

const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const NOW_S = 1_800_000_000;

/** A unit answer: every check ran, nothing found, for `n` folders (optionally with extra lines). */
const cleanAnswer = (n, extra = []) =>
  ["RESULT=ok", `NOW=${NOW_S}`, "UID=1000", `HOME_HEX=${hex("/home/me")}`, "PROCS=all", "DOCKER=ok", "GIT=ok", ...Array.from({ length: n }, (_, k) => [`P=${k + 1}|d`, `WALK=${k + 1}|0`, `GITDIRS=${k + 1}|0|0`]).flat(), ...extra, ""].join("\n");

async function withApp({ run, allowRead = () => true, allowChange = () => true, sparks, scansFile = null, adviceRefs }, fn) {
  const app = express();
  app.use(express.json());
  const known = sparks ?? { s1: { id: "s1", name: "Spark One", kind: "spark" }, s2: { id: "s2", name: "Spark Two", kind: "spark" }, h1: { id: "h1", name: "H1", kind: "host" } };
  const manager = new StorageManager({ run, holdMs: 0, scansFile, now: () => NOW_S * 1000 });
  registerStorageRoutes(app, {
    manager,
    registry: { getSpark: (id) => known[id] },
    recordEvent: () => {},
    allowRead,
    allowChange,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
    ...(adviceRefs ? { adviceRefs } : {}),
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, manager);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("advise runs the read-only program with the paths and answers per item with a level", async () => {
  const calls = [];
  const run = async (_spark, program, o) => {
    calls.push({ program, ...o });
    return cleanAnswer(2);
  };
  await withApp({ run }, async (base) => {
    const res = await post(`${base}/s1/storage/advise`, { paths: ["/data/a", "/data/b", "/data/a/inner"] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.level, "low");
    assert.equal(body.complete, true);
    assert.deepEqual(body.items.map((i) => [i.path, i.level, i.complete]), [
      ["/data/a", "low", true],
      ["/data/b", "low", true],
    ]);
    assert.deepEqual(body.covered, ["/data/a/inner"], "a path inside another is covered by it");
    assert.equal(body.recentMinutes, 1440);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "advise");
    assert.deepEqual(calls[0].args, [1440, 20, "/data/a", "/data/b"]);
    assert.equal(calls[0].input, null, "never a password");
    assert.match(calls[0].program, /^SUDO=""$/m);
  });
});

test("paths are checked as a delete checks them", async () => {
  let ran = 0;
  const run = async () => {
    ran += 1;
    return cleanAnswer(1);
  };
  await withApp({ run }, async (base) => {
    for (const [body, status, code] of [
      [{}, 400, "bad-paths"],
      [{ paths: [] }, 400, "bad-paths"],
      [{ paths: "/data/a" }, 400, "bad-paths"],
      [{ paths: Array.from({ length: MAX_BULK_DELETE_PATHS + 1 }, (_, k) => `/data/f${k}`) }, 400, "bad-paths"],
      [{ paths: ["data/a"] }, 400, "bad-path"],
      [{ paths: ["/data/../etc"] }, 400, "bad-path"],
      [{ paths: ["/data/a\nb"] }, 400, "bad-path"],
      [{ paths: ["/etc/passwd"] }, 403, "protected"],
      [{ paths: ["/home/me/.ssh/id_rsa"] }, 403, "protected"],
      [{ paths: ["/home/me"] }, 403, "protected"],
    ]) {
      const res = await post(`${base}/s1/storage/advise`, body);
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
      assert.equal((await res.json()).code, code, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(ran, 0, "nothing reached the Spark");
    assert.equal((await post(`${base}/nope/storage/advise`, { paths: ["/data/a"] })).status, 404);
    assert.equal((await post(`${base}/h1/storage/advise`, { paths: ["/data/a"] })).status, 400, "not a Spark");
  });
});

test("advise uses the read limiter, not the change limiter", async () => {
  const run = async () => cleanAnswer(1);
  await withApp({ run, allowRead: () => false }, async (base) => {
    assert.equal((await post(`${base}/s1/storage/advise`, { paths: ["/data/a"] })).status, 429);
  });
  await withApp({ run, allowChange: () => false }, async (base) => {
    assert.equal((await post(`${base}/s1/storage/advise`, { paths: ["/data/a"] })).status, 200);
  });
});

test("an offline Spark answers 502 unreachable; a bad answer 502 bad-output", async () => {
  await withApp({ run: async () => { throw new Error("ssh: connect to host 10.0.0.9 port 22: No route to host"); } }, async (base) => {
    const res = await post(`${base}/s1/storage/advise`, { paths: ["/data/a"] });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.code, "unreachable");
    assert.match(body.error, /Could not reach Spark One/);
  });
  await withApp({ run: async () => "not the format" }, async (base) => {
    const res = await post(`${base}/s1/storage/advise`, { paths: ["/data/a"] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "bad-output");
  });
});

test("advise neither waits for nor takes the Spark's busy slot", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const run = async (_s, _p, o) => {
    if (o.name === "advise") {
      await gate;
      return cleanAnswer(1);
    }
    return "RESULT=ok\n";
  };
  await withApp({ run }, async (base, manager) => {
    // A change holds the Spark: advice is still given.
    const ticket = manager._admission.admit("s1", { kind: "mutation", label: "change" });
    const pending = post(`${base}/s1/storage/advise`, { paths: ["/data/a"] });
    // While advice is being gathered, the Spark's slot is free for others.
    await new Promise((r) => setTimeout(r, 50));
    ticket.release();
    assert.equal(manager._admission.holder("s1"), null, "advise holds no slot");
    const del = await post(`${base}/s1/storage/delete`, { path: "/data/b" });
    assert.equal(del.status, 200, "a delete can start while advice is gathered");
    release();
    assert.equal((await pending).status, 200);
  });
});

test("the dashboard's own data: this Spark's analysis, other Sparks' analyses, launchers and LLM servers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advise-route-"));
  try {
    const scansFile = path.join(dir, "storage-scans.json");
    const big = 5 * 1024 * 1024;
    const session = (root, entries, analysedAt) => ({ revision: 1, root, scannedAt: analysedAt, analysedAt, elevated: false, unreadable: 0, timedOut: false, hardlinks: "exact", dated: true, entries });
    fs.writeFileSync(
      scansFile,
      JSON.stringify({
        version: 1,
        revision: 3,
        sessions: {
          s1: session("/data", [
            { path: "/data", bytes: 3 * big, type: "dir", expanded: true, modifiedAt: NOW_S - 3600 },
            { path: "/data/m.gguf", bytes: big, type: "file", expanded: false, modifiedAt: NOW_S - 400 * 86400 },
            { path: "/data/hub", bytes: 2 * big, type: "dir", expanded: true, modifiedAt: NOW_S - 10 * 86400 },
            { path: "/data/hub/models--Qwen--Qwen3-8B", bytes: 2 * big, type: "dir", expanded: false, modifiedAt: NOW_S - 10 * 86400 },
          ], (NOW_S - 7200) * 1000),
          s2: session("/srv", [{ path: "/srv", bytes: big, type: "dir", expanded: true }, { path: "/srv/m.gguf", bytes: big, type: "file", expanded: false }], (NOW_S - 86400 * 3) * 1000),
          // A Spark no longer configured: its analysis is not quoted.
          gone: session("/x", [{ path: "/x", bytes: big, type: "dir", expanded: true }, { path: "/x/m.gguf", bytes: big, type: "file", expanded: false }], 1),
        },
      })
    );
    const run = async () => cleanAnswer(3);
    const adviceRefs = (spark) => {
      assert.equal(spark.id, "s1");
      return { launchers: [{ name: "Qwen", dir: "~/llm/qwen" }], llm: [{ port: 8000, modelId: "Qwen/Qwen3-8B", models: [] }] };
    };
    await withApp({ run, scansFile, adviceRefs }, async (base) => {
      const body = await (await post(`${base}/s1/storage/advise`, { paths: ["/data/m.gguf", "/data/hub", "/home/me/llm"] })).json();
      const [m, hub, llm] = body.items;
      assert.equal(m.level, "low", "notes do not raise the level");
      assert.deepEqual(m.reasons.map((r) => r.rule), ["copy-elsewhere", "age"]);
      assert.match(m.reasons[0].text, /same name and size is in the saved analysis of Spark Two \(\/srv\/m\.gguf, analysed 3 days ago\)/);
      assert.doesNotMatch(JSON.stringify(body), /\/x\/m\.gguf/, "an unconfigured Spark is not quoted");
      assert.equal(m.reasons[1].text, "Last changed 1 year ago, according to the analysis from 2 hours ago.");
      assert.equal(hub.level, "review");
      assert.match(hub.reasons.map((r) => r.text).join(" "), /Holds the Hugging Face download of Qwen\/Qwen3-8B, which the LLM server on port 8000/);
      assert.equal(llm.level, "review");
      assert.match(llm.reasons[0].text, /Holds the folder of SparkDash's model launcher “Qwen” \(\/home\/me\/llm\/qwen\)/, "~ resolved with the home the Spark reported");
      assert.equal(body.level, "review");
    });
    // The references could not be read: said so, never treated as none.
    await withApp({ run: async () => cleanAnswer(1), scansFile, adviceRefs: () => { throw new Error("boom"); } }, async (base) => {
      const body = await (await post(`${base}/s1/storage/advise`, { paths: ["/data/other"] })).json();
      assert.equal(body.items[0].level, "review");
      assert.equal(body.items[0].complete, false);
      assert.deepEqual(body.items[0].unchecked.map((u) => u.rule), ["references"]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence from the Spark is turned into reasons and the highest item level wins", async () => {
  const run = async () =>
    cleanAnswer(2, [`USE=1|42|f|${hex("python3")}|${hex("/data/a/x.bin")}`, "USES=1|1", "PROCS=own"]).replace("PROCS=all\n", "");
  await withApp({ run }, async (base) => {
    const body = await (await post(`${base}/s1/storage/advise`, { paths: ["/data/a", "/data/b"] })).json();
    assert.equal(body.level, "high");
    assert.equal(body.complete, false);
    assert.equal(body.items[0].level, "high");
    assert.match(body.items[0].reasons[0].text, /open in python3 \(process 42\)/);
    assert.equal(body.items[1].level, "review", "only own processes seen: not fully checked");
    assert.deepEqual(body.items[1].unchecked.map((u) => u.rule), ["processes-others"]);
  });
});
