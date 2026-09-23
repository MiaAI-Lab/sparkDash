# Worker 3B Pre-Gate Self-Review — Requests Aggregation + Topology Model

## Expected inputs / outputs (restated)

**`aggregateRequests(snapshots)`**
- Input: `Record<nodeId, NodeAgentSnapshot>` from the fleet connection manager
  (cached per-node `/telemetry` responses). `snapshot.requests` is
  `RequestStats | null` per `shared/types.ts` / `shared/api.schema.json`
  (RequestStats.null = "not available").
- Output: `FleetSnapshot["requests"]` = `{ byModel, byEngine, byMachine }`,
  each `Record<key, RequestStat[]>`.
- Why it matters: the dashboard's `/api/fleet` payload and the frontend
  (`src/api/types.ts` FleetSnapshot) consume this shape verbatim; a crash here
  kills the whole fleet fan-out, and a garbage key poisons the UI.

**`buildTopology(nodes)`**
- Input: `NodeRecord[]` from the node registry (id, role, rank, groupId,
  headId, links).
- Output: `FleetSnapshot["topology"]` = `{ nodes: TopologyInfo[], links: RoceLink[] }`
  with links deduplicated as undirected pairs.
- Why it matters: the frontend renders the RoCE graph from `links`; duplicates
  (A→B + B→A) would double-draw every link, and a missing `links` field on a
  registry record would otherwise crash or render `undefined`.

## Findings

1. **Inputs that endanger PROJECT goal — handled?**
   Yes. `aggregateRequests(null | undefined | non-object)` → three empty
   Records (`aggregate.js:61-63`; test "empty snapshots"). `buildTopology(null
   | undefined | "nope")` → `{nodes: [], links: []}` (`topology.js:57`; test
   "empty nodes"). A fleet that is entirely down therefore yields an
   empty-but-valid FleetSnapshot section, never a 500.

2. **Inputs that break THIS code — handled?**
   Yes. `requests: null` / missing / `"garbage"` / `stats: "not-an-array"` /
   null snapshot values / null+numeric stat entries → all skipped, no throw
   (test "node with null requests is skipped", "malformed stat entries").
   Links: null entries, missing/empty `from`, null/empty `to`, non-array
   `node.links`, null node entries → all skipped (test "malformed link
   entries"). Keys are only created for non-empty strings, so no
   `"undefined"`/`"42"` keys ever reach the UI (`groupInto`, `aggregate.js:22-25`).

3. **Outputs detrimental to PROJECT — prevented?**
   Yes. Values pass through untouched (stats pushed by reference, links by
   reference) — no mutation of inputs, no rounding, no unit conversion. The
   known-answer test pins exact values (queued 2 / running 1 / finished 10,
   speedMbps 200000) and proves reference identity
   (`assert.equal(r.byModel["glm-5.3"][0], snapshots.n2.requests.stats[0])`).
   Output shape matches `FleetSnapshot` in `shared/types.ts` exactly
   (byModel/byEngine/byMachine; nodes/links).

4. **Outputs that break NEXT package — prevented?**
   Yes. Output is plain JSON-serializable data (verified via the JSON.stringify
   sample in the verification report) — no Map/Set/Symbol leaks. `links` is a
   plain array (`Array.from(seenLinks.values())`), so the orchestrator can
   spread/clone/serialize it freely. `rank ?? null` normalization means
   TopologyInfo fields are `number | null` as the type declares, never
   `undefined`.

5. **Optimal input → optimal output — confirmed?**
   Yes. Known-answer tests on both sides: two-node aggregate snapshot
   (exact key sets + values + reference identity) and three-node tp2 group
   (exact TopologyInfo[] and deduped links `[n1→n2, n3→n1]` with
   first-seen-wins direction). Sample-output run confirmed the shapes render
   as intended.

6. **Degenerate input — prevents bad output?**
   Yes. Empty input → empty Records/arrays (never `null` values, never
   missing top-level keys). A node with zero links contributes a valid
   TopologyInfo with `links: []`. A stat missing `modelId` degrades per view
   (kept in byEngine/byMachine, dropped from byModel) instead of either
   crashing or polluting byModel with a garbage key.

7. **Out-of-bounds input — reasonable error BEFORE crashing?**
   No crash possible by design: every dereference is guarded
   (`snapshot?.requests`, `stat == null` checks, `typeof` guards on keys,
   `Array.isArray` before iteration). Non-object `snapshots` and non-array
   `nodes` are treated as empty rather than throwing — documented in JSDoc.
   This is a pure data-assembly function; throwing on a malformed registry
   entry would take the whole dashboard down, so "skip + degrade" is the
   correct fail mode (same posture as SparkMonitor's collection guards).

## Design decisions (noted for orchestrator)

- **byMachine key**: `stat.nodeId` with fallback to the snapshot key
  (schema says stat.nodeId is always present; fallback is pure defense).
- **Link dedup key**: undirected pair `{from,to}` sorted, NUL-joined
  (collision-proof for ids like `"a"+"bc"` vs `"ab"+""`). Spec says A↔B are
  one link; transport/speed differences between two reports of the same pair
  are NOT deduped — first seen wins. If a future batch needs multiple
  parallel links per pair, the key must gain a transport/speed dimension
  (spec-gap flag, not a defect today: v1 registry stores one manual link
  per pair, E11).
- **Stats/links pushed by reference**, not cloned: inputs are fresh per poll
  cycle from the fleet connection manager's cache; cloning would add GC
  pressure to the 2s fan-out loop for no correctness gain.
- **`role` passed through unvalidated**: NodeRecord.role comes from the
  registry which already normalizes it; inventing a fallback role would
  fabricate topology.

## Test coverage

15 tests, 15 pass (`node --test server/fleet/__tests__/*.test.js`):
- aggregate: 3-node aggregation, empty/null/undefined input, null requests,
  same-model ×2, same-engine ×2, same-nodeId ×2 (multi-port), known-answer,
  malformed stat entries.
- topology: 3-node head+2 workers, empty input, undefined links → [],
  A↔B dedup, known-answer, malformed link entries, triple-report collapse.

Red-then-green witness: first run 14/15 (malformed-stats expectation was wrong
in the test — stat with missing modelId correctly still counts in
byEngine/byMachine; expectation corrected from 1→2); re-run 15/15.

## Note for orchestrator

`package.json` `test:server` glob currently lists only
`server/collectors/__tests__/*.test.js` and `server/sparks/__tests__/*.test.js`.
Batch 3 wiring should add `server/fleet/__tests__/*.test.js` to that glob.
(Out of scope for this worker: do not edit `server/index.js` or
`src/api/types.ts`.)
