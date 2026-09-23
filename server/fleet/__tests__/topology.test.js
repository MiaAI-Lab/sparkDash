import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopology } from "../topology.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
// Mock NodeRecord entries simulate node-registry output.

function link(from, to, speedMbps = 200000, transport = "roce", up = true) {
  return { from, to, speedMbps, transport, up };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("buildTopology: 3 nodes (head + 2 workers) → TopologyInfo[] + RoceLink[]", () => {
  const nodes = [
    {
      id: "n1",
      role: "head",
      rank: 0,
      groupId: "tp2",
      headId: null,
      links: [link("n1", "n2")],
    },
    {
      id: "n2",
      role: "worker",
      rank: 1,
      groupId: "tp2",
      headId: "n1",
      links: [link("n2", "n1")],
    },
    {
      id: "n3",
      role: "worker",
      rank: 2,
      groupId: "tp2",
      headId: "n1",
      links: [link("n3", "n1")],
    },
  ];
  const r = buildTopology(nodes);

  // One TopologyInfo per node, in input order
  assert.equal(r.nodes.length, 3);
  assert.deepEqual(r.nodes[0], {
    nodeId: "n1",
    role: "head",
    rank: 0,
    groupId: "tp2",
    headId: null,
    links: [link("n1", "n2")],
  });
  assert.equal(r.nodes[1].nodeId, "n2");
  assert.equal(r.nodes[1].headId, "n1");
  assert.equal(r.nodes[2].rank, 2);

  // Links: n1↔n2 reported twice (n1→n2 and n2→n1) collapses to one;
  // n1↔n3 appears once. Two unique links total.
  assert.equal(r.links.length, 2);
  const pairs = r.links.map((l) => [l.from, l.to].sort().join("-")).sort();
  assert.deepEqual(pairs, ["n1-n2", "n1-n3"]);
});

test("buildTopology: empty nodes → {nodes: [], links: []}", () => {
  assert.deepEqual(buildTopology([]), { nodes: [], links: [] });
  assert.deepEqual(buildTopology(null), { nodes: [], links: [] });
  assert.deepEqual(buildTopology(undefined), { nodes: [], links: [] });
  assert.deepEqual(buildTopology("nope"), { nodes: [], links: [] });
});

test("buildTopology: node with undefined links → uses []", () => {
  const nodes = [
    { id: "x", role: "standalone", rank: null, groupId: null, headId: null },
    { id: "y", role: "standalone" }, // also missing rank/groupId/headId
  ];
  const r = buildTopology(nodes);
  assert.equal(r.nodes.length, 2);
  assert.deepEqual(r.nodes[0].links, []);
  assert.deepEqual(r.nodes[1].links, []);
  // Undefined rank/groupId/headId normalize to null (TopologyInfo `| null`)
  assert.equal(r.nodes[0].rank, null);
  assert.equal(r.nodes[1].groupId, null);
  assert.equal(r.nodes[1].headId, null);
  assert.deepEqual(r.links, []);
});

test("buildTopology: A→B and B→A deduplicate to a single link", () => {
  const nodes = [
    {
      id: "a",
      role: "head",
      rank: 0,
      groupId: "g",
      headId: null,
      links: [link("a", "b", 100)],
    },
    {
      id: "b",
      role: "worker",
      rank: 1,
      groupId: "g",
      headId: "a",
      links: [link("b", "a", 100)],
    },
  ];
  const r = buildTopology(nodes);
  assert.equal(r.links.length, 1);
  // First-seen direction wins
  assert.equal(r.links[0].from, "a");
  assert.equal(r.links[0].to, "b");
});

test("buildTopology: known-answer", () => {
  const l12 = link("n1", "n2");
  const l21 = link("n2", "n1");
  const l31 = link("n3", "n1");
  const nodes = [
    { id: "n1", role: "head", rank: 0, groupId: "tp2", headId: null, links: [l12] },
    { id: "n2", role: "worker", rank: 1, groupId: "tp2", headId: "n1", links: [l21] },
    { id: "n3", role: "worker", rank: 2, groupId: "tp2", headId: "n1", links: [l31] },
  ];
  const r = buildTopology(nodes);
  const expected = {
    nodes: [
      { nodeId: "n1", role: "head", rank: 0, groupId: "tp2", headId: null, links: [l12] },
      { nodeId: "n2", role: "worker", rank: 1, groupId: "tp2", headId: "n1", links: [l21] },
      { nodeId: "n3", role: "worker", rank: 2, groupId: "tp2", headId: "n1", links: [l31] },
    ],
    links: [l12, l31], // l21 collapses into l12 (undirected pair n1↔n2)
  };
  assert.deepEqual(r, expected);
  // Ground truth: the two surviving links carry their reported speed/transport
  assert.equal(r.links[0].speedMbps, 200000);
  assert.equal(r.links[0].transport, "roce");
  assert.equal(r.links[0].up, true);
  assert.equal(r.links[1].from, "n3");
  assert.equal(r.links[1].to, "n1");
});

test("buildTopology: malformed link entries degrade without crashing", () => {
  const nodes = [
    {
      id: "n1",
      role: "head",
      rank: 0,
      groupId: "g",
      headId: null,
      links: [
        null,
        42,
        { to: "n2", speedMbps: 100, transport: "roce", up: true }, // missing from
        { from: "", to: "n2", speedMbps: 100, transport: "roce", up: true }, // empty from
        { from: "n1", to: null, speedMbps: 100, transport: "roce", up: true }, // null to
        link("n1", "n2", 50), // the only valid one
      ],
    },
    null, // null node entry
    "garbage", // non-object node entry
  ];
  const r = buildTopology(nodes);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].from, "n1");
  assert.equal(r.links[0].to, "n2");
  assert.equal(r.links[0].speedMbps, 50);
});

test("buildTopology: identical pair reported 3× across nodes collapses to 1", () => {
  // Three nodes all naming the same n1↔n2 connection (e.g. stale registry
  // copies) must not fan out into three links.
  const nodes = [
    { id: "n1", role: "head", rank: 0, groupId: "g", headId: null, links: [link("n1", "n2")] },
    { id: "n2", role: "worker", rank: 1, groupId: "g", headId: "n1", links: [link("n2", "n1")] },
    { id: "n3", role: "standalone", rank: null, groupId: null, headId: null, links: [link("n1", "n2")] },
  ];
  const r = buildTopology(nodes);
  assert.equal(r.links.length, 1);
  assert.deepEqual([r.links[0].from, r.links[0].to].sort(), ["n1", "n2"]);
});
