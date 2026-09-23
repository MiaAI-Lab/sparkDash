// Tests for server/fleet/registry.js — run with `node --test`.
//
// The registry's only I/O boundary is the fs module, so these tests point it
// at real files in a fresh OS temp dir per test (the spec's "mock fs to
// simulate config/nodes.json", done behaviorally) and, for the atomic-write
// witness, instrument fs.writeFileSync/renameSync by reference (the ESM
// default import of a CJS built-in is the shared module.exports object).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  loadNodes,
  saveNodes,
  getNode,
  listNodes,
  addNode,
  updateNode,
  removeNode,
  registryPath,
} from "../registry.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot = null;

function freshDir(name) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, name + "-"));
  return dir;
}

/** @returns {string} a nodes.json path inside a fresh dir (module state reset) */
function freshNodesPath(name = "reg") {
  const dir = freshDir(name);
  const p = path.join(dir, "nodes.json");
  loadNodes(p); // reset module state to an empty registry at this path
  return p;
}

function record(over = {}) {
  return {
    id: "gx10-1c2c",
    name: "Node 1",
    endpoint: "192.168.50.226:30091",
    lanIp: "192.168.50.226",
    role: "head",
    rank: 0,
    groupId: "tp2",
    headId: null,
    links: [
      {
        from: "gx10-1c2c",
        to: "gx10-102c",
        fromIf: "enp1s0f1np1",
        toIf: "enp1s0f0np0",
        speedMbps: 200000,
        transport: "roce",
        up: true,
      },
    ],
    agentPort: 30091,
    isLocal: false,
    ...over,
  };
}

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-registry-test-"));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── loadNodes ──────────────────────────────────────────────────────────────

test("loadNodes: valid file → NodeRecord[] with defaults filled in", () => {
  const p = freshNodesPath("load-valid");
  const full = record();
  const partial = { id: "gx10-102c" }; // bare-bones record
  fs.writeFileSync(
    p,
    JSON.stringify({ nodes: [full, partial] }, null, 2) + "\n"
  );

  const loaded = loadNodes(p);
  assert.equal(loaded.length, 2);

  // Ground truth: full record round-trips.
  assert.deepEqual(loaded[0], full);

  // Ground truth: partial record gets every default.
  const got = loaded[1];
  assert.equal(got.id, "gx10-102c");
  assert.equal(got.name, "gx10-102c"); // name falls back to id
  assert.equal(got.endpoint, "");
  assert.equal(got.lanIp, "");
  assert.equal(got.role, "standalone");
  assert.equal(got.rank, null);
  assert.equal(got.groupId, null);
  assert.equal(got.headId, null);
  assert.deepEqual(got.links, []);
  assert.equal(got.agentPort, 30091); // documented default
  assert.equal(got.isLocal, false);
});

test("loadNodes: missing file → [] (graceful degradation, no throw)", () => {
  const p = freshNodesPath("load-missing");
  assert.ok(!fs.existsSync(p));
  const loaded = loadNodes(p);
  assert.deepEqual(loaded, []);
  // The file is NOT created as a side effect of loading.
  assert.ok(!fs.existsSync(p));
});

test("loadNodes: corrupt JSON → [] with warning, does not crash", () => {
  const p = freshNodesPath("load-corrupt");
  fs.writeFileSync(p, "{ not json !!!");
  assert.deepEqual(loadNodes(p), []);
});

test("loadNodes: non-array `nodes` key → [] (no crash)", () => {
  const p = freshNodesPath("load-shape");
  fs.writeFileSync(p, JSON.stringify({ nodes: { broken: true } }));
  assert.deepEqual(loadNodes(p), []);
});

test("loadNodes: duplicate ids in file → first occurrence wins", () => {
  const p = freshNodesPath("load-dup");
  fs.writeFileSync(
    p,
    JSON.stringify({
      nodes: [{ id: "a", name: "first" }, { id: "a", name: "second" }, { id: "b" }],
    })
  );
  const loaded = loadNodes(p);
  assert.deepEqual(
    loaded.map((n) => [n.id, n.name]),
    [["a", "first"], ["b", "b"]]
  );
});

// ─── saveNodes ──────────────────────────────────────────────────────────────

test("saveNodes: writes atomically (temp file + rename) and round-trips", () => {
  const p = freshNodesPath("save-atomic");
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  /** @type {Array<{tmp: string, content: string}>} */
  const writeCalls = [];
  /** @type {Array<{from: string, to: string}>} */
  const renameCalls = [];
  fs.writeFileSync = (tmp, content, opts) => {
    writeCalls.push({ tmp: String(tmp), content: String(content) });
    return origWrite(tmp, content, opts);
  };
  fs.renameSync = (from, to) => {
    renameCalls.push({ from: String(from), to: String(to) });
    return origRename(from, to);
  };
  try {
    saveNodes([record({ id: "node-a" })], p);
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }

  // WITNESS: exactly one write, to a sibling temp file, then one rename onto
  // the target — the crash-safety shape SparkRegistry relies on.
  assert.equal(writeCalls.length, 1);
  assert.ok(writeCalls[0].tmp.endsWith(".tmp"), "temp file name ends with .tmp");
  assert.equal(path.dirname(writeCalls[0].tmp), path.dirname(p), "temp in same dir");
  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0].from, writeCalls[0].tmp);
  assert.equal(renameCalls[0].to, p);

  // No temp litter left behind.
  const dirFiles = fs.readdirSync(path.dirname(p));
  assert.equal(dirFiles.length, 1, "only the final nodes.json remains");
  assert.equal(dirFiles[0], "nodes.json");

  // Content round-trips.
  const back = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(back.nodes.map((n) => n.id), ["node-a"]);
  assert.equal(back.nodes[0].agentPort, 30091);
});

test("saveNodes: rejects non-array input", () => {
  const p = freshNodesPath("save-bad");
  assert.throws(() => saveNodes(null, p), /must be an array/);
  assert.throws(() => saveNodes({ nodes: [] }, p), /must be an array/);
});

test("saveNodes: rejects duplicate ids", () => {
  const p = freshNodesPath("save-dup");
  assert.throws(
    () => saveNodes([record({ id: "x" }), record({ id: "x" })], p),
    /duplicate node id x/
  );
  assert.ok(!fs.existsSync(p), "nothing written on failure");
});

// ─── getNode / listNodes ────────────────────────────────────────────────────

test("getNode: valid id → NodeRecord; missing id → null", () => {
  const p = freshNodesPath("get");
  addNode(record());
  const got = getNode("gx10-1c2c");
  assert.equal(got.id, "gx10-1c2c");
  assert.equal(got.rank, 0);
  assert.equal(got.role, "head");
  assert.equal(getNode("no-such-node"), null);
});

test("getNode returns a copy — mutation does not leak into registry", () => {
  const p = freshNodesPath("get-copy");
  addNode(record({ id: "gx10-a" }));
  const got = getNode("gx10-a");
  got.name = "MUTATED";
  got.links.push({ from: "gx10-a", to: "gx10-b", speedMbps: null, transport: "roce", up: false });
  assert.equal(getNode("gx10-a").name, "Node 1");
  assert.equal(getNode("gx10-a").links.length, 1);
});

test("listNodes: 3 nodes → 3 records, persisted order", () => {
  const p = freshNodesPath("list");
  addNode(record({ id: "n1" }));
  addNode(record({ id: "n2", name: "Second" }));
  addNode(record({ id: "n3", name: "Third" }));
  const list = listNodes();
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((n) => n.id),
    ["n1", "n2", "n3"]
  );
  assert.equal(list[1].name, "Second");
});

// ─── addNode ────────────────────────────────────────────────────────────────

test("addNode: new node → added, returned, persisted to disk", () => {
  const p = freshNodesPath("add");
  const added = addNode(record());
  assert.equal(added.id, "gx10-1c2c");
  assert.equal(added.agentPort, 30091);
  // Persisted: reload from a clean module state and find it on disk.
  const reloaded = loadNodes(p);
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0], added);
});

test("addNode: duplicate id → throws, state unchanged", () => {
  const p = freshNodesPath("add-dup");
  addNode(record({ id: "solo" }));
  assert.throws(() => addNode(record({ id: "solo", name: "other" })), /already exists/);
  assert.equal(listNodes().length, 1);
  assert.equal(listNodes()[0].name, "Node 1");
});

// ─── updateNode ─────────────────────────────────────────────────────────────

test("updateNode: merges updates, preserves id and untouched fields", () => {
  const p = freshNodesPath("update");
  addNode(record({ id: "u1" }));
  const updated = updateNode("u1", { name: "Renamed", role: "worker", headId: "u1" });
  assert.equal(updated.id, "u1");
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.role, "worker");
  assert.equal(updated.headId, null); // self-headId normalizes to null
  // Untouched fields survive the merge.
  assert.equal(updated.endpoint, "192.168.50.226:30091");
  assert.equal(updated.rank, 0);
  assert.equal(updated.agentPort, 30091);
  // Persisted.
  assert.equal(loadNodes(p)[0].name, "Renamed");
});

test("updateNode: cannot change id via updates", () => {
  const p = freshNodesPath("update-id");
  addNode(record({ id: "keep" }));
  const updated = updateNode("keep", { id: "hijack", name: "x" });
  assert.equal(updated.id, "keep");
  assert.equal(getNode("hijack"), null);
  assert.equal(listNodes().length, 1);
});

test("updateNode: missing id → throws, no state change", () => {
  const p = freshNodesPath("update-missing");
  addNode(record({ id: "present" }));
  assert.throws(() => updateNode("ghost", { name: "x" }), /ghost not found/);
  assert.equal(listNodes().length, 1);
});

// ─── removeNode ─────────────────────────────────────────────────────────────

test("removeNode: valid id → removed, returned, persisted", () => {
  const p = freshNodesPath("remove");
  addNode(record({ id: "r1" }));
  addNode(record({ id: "r2" }));
  const removed = removeNode("r1");
  assert.equal(removed.id, "r1");
  assert.deepEqual(listNodes().map((n) => n.id), ["r2"]);
  assert.equal(loadNodes(p).length, 1); // persisted
});

test("removeNode: missing id → null, no state change", () => {
  const p = freshNodesPath("remove-missing");
  addNode(record({ id: "stay" }));
  assert.equal(removeNode("ghost"), null);
  assert.equal(listNodes().length, 1);
});

// ─── id validation ──────────────────────────────────────────────────────────

for (const bad of [
  "UPPER", // uppercase not allowed
  "-lead", // must start with [a-z0-9]
  ".lead",
  "has space",
  "semi;colon",
  "a".repeat(65), // too long (65)
  "", // empty
  42, // non-string
]) {
  test(`addNode: invalid id ${JSON.stringify(bad).slice(0, 40)} → throws BEFORE any state change`, () => {
    const p = freshNodesPath("id-bad");
    addNode(record({ id: "valid-base" }));
    assert.throws(
      () => addNode({ ...record(), id: bad }),
      /Invalid node id/
    );
    // Ground truth: registry untouched by the failed add.
    assert.deepEqual(listNodes().map((n) => n.id), ["valid-base"]);
  });
}

test("addNode: 64-char id (boundary) is accepted", () => {
  const p = freshNodesPath("id-boundary");
  const id64 = "a".repeat(64);
  const added = addNode(record({ id: id64 }));
  assert.equal(added.id.length, 64);
  assert.equal(getNode(id64).id, id64);
});

test("registryPath: reflects the path most recently loaded", () => {
  const p = freshNodesPath("path");
  assert.equal(registryPath(), p);
});
