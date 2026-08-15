/**
 * Dashboard occupancy poller (U5): collect once, project onto Sparks.
 * Never throws. Does not read showcase/bench. Disabled sources skip I/O.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pollOccupancy } from "../occupancyPoller.js";

function spark(overrides = {}) {
  return {
    id: "spark-local",
    lanIp: "127.0.0.1",
    isLocal: true,
    llmPorts: [8888],
    role: "standalone",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    source: "openclaw",
    handle: "chat-a",
    originHost: "127.0.0.1",
    originPort: 8888,
    midTurn: false,
    ...overrides,
  };
}

function sources({ openclaw = false, hermes = false } = {}) {
  return {
    openclaw: { enabled: openclaw, mode: "local", url: "", stateDir: "" },
    hermes: { enabled: hermes, mode: "local", url: "", stateDir: "" },
  };
}

test("AE4: empty sources skip collect and return {}", async () => {
  let called = 0;
  const collect = async () => {
    called += 1;
    throw new Error("should not collect");
  };
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources(),
    tokens: {},
    collectOpenClaw: collect,
    collectHermes: collect,
  });
  assert.deepEqual(result, {});
  assert.equal(called, 0);
});

test("AE4: occupancy throw returns {} and does not throw", async () => {
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: true }),
    tokens: {},
    collectOpenClaw: async () => {
      throw new Error("gateway down");
    },
    collectHermes: async () => {
      throw new Error("hermes down");
    },
  });
  assert.deepEqual(result, {});
});

test("disabled sources: collect fns not called", async () => {
  let openclaw = 0;
  let hermes = 0;
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: false, hermes: false }),
    collectOpenClaw: async () => {
      openclaw += 1;
      return [row()];
    },
    collectHermes: async () => {
      hermes += 1;
      return [row({ source: "hermes", handle: "ha" })];
    },
  });
  assert.deepEqual(result, {});
  assert.equal(openclaw, 0);
  assert.equal(hermes, 0);
});

test("AE6: showcase running flag does not mint generating", async () => {
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: true }),
    tokens: {},
    collectOpenClaw: async () => [
      row({ handle: "stalled-chat", midTurn: false }),
      row({ handle: "unknown-chat", midTurn: "unknown" }),
    ],
    collectHermes: async () => [],
    showcaseRunning: true,
    decodeBenchRunning: true,
  });
  const list = result["spark-local"];
  assert.ok(Array.isArray(list));
  const byHandle = Object.fromEntries(list.map((r) => [r.handle, r]));
  assert.equal(byHandle["stalled-chat"].badge, "stalled");
  assert.equal(byHandle["unknown-chat"].badge, "unknown");
  assert.notEqual(byHandle["stalled-chat"].badge, "generating");
  assert.notEqual(byHandle["unknown-chat"].badge, "generating");
});

test("per-source catch: throwing source contributes [] and sibling still projects", async () => {
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: true, hermes: true }),
    collectOpenClaw: async () => {
      throw new Error("openclaw boom");
    },
    collectHermes: async () => [
      row({ source: "hermes", handle: "agent-1", midTurn: "unknown" }),
    ],
  });
  assert.deepEqual(result["spark-local"], [
    { source: "hermes", handle: "agent-1", badge: "unknown", port: 8888 },
  ]);
});
