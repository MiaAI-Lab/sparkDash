/**
 * Dashboard occupancy poller (U5): collect once, project onto Sparks.
 * Never throws. Does not read showcase/bench. Disabled sources skip I/O.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOccupancyLoop, pollOccupancy } from "../occupancyPoller.js";

const MODULE_PATH = fileURLToPath(new URL("../occupancyPoller.js", import.meta.url));

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

test("occupancy poll iterates registry kinds, not a local openclaw/hermes pair", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.match(src, /sessionSourceIds|sessionSourceKinds/);
  assert.match(src, /sessionSourceRegistry/);
  assert.equal(/\[["']openclaw["']\s*,\s*["']hermes["']\]/.test(src), false);
});

test("enabled kinds not in the registry do not trigger occupancy I/O", async () => {
  let called = 0;
  const collect = async () => {
    called += 1;
    return [row()];
  };
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: {
      ...sources(),
      opencode: { enabled: true, mode: "local", url: "", stateDir: "" },
    },
    collectOpenClaw: collect,
    collectHermes: collect,
  });
  assert.deepEqual(result, {});
  assert.equal(called, 0);
});

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

test("AE6: occupancy poller does not read showcase or DecodeBench state", async () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/ShowcaseManager/.test(src), false);
  assert.equal(/DecodeBench/.test(src), false);
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: true }),
    tokens: {},
    collectOpenClaw: async () => [
      row({ handle: "stalled-chat", midTurn: false }),
      row({ handle: "unknown-chat", midTurn: "unknown" }),
    ],
    collectHermes: async () => [],
  });
  const list = result["spark-local"];
  assert.ok(Array.isArray(list));
  const byHandle = Object.fromEntries(list.map((r) => [r.handle, r]));
  assert.equal(byHandle["stalled-chat"].badge, "stalled");
  assert.equal(byHandle["unknown-chat"].badge, "unknown");
});

test("projector throw returns {} and does not throw", async () => {
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: sources({ openclaw: true }),
    collectOpenClaw: async () => [row({ midTurn: true })],
    collectHermes: async () => [],
    project: () => {
      throw new Error("projector boom");
    },
  });
  assert.deepEqual(result, {});
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
    { id: "hermes:8888:agent-1", source: "hermes", handle: "agent-1", badge: "unknown", port: 8888 },
  ]);
});

test("collects every enabled attach of the same product", async () => {
  const seen = [];
  const result = await pollOccupancy({
    sparks: [spark()],
    sources: {
      openclaw: { enabled: false, mode: "local", url: "", stateDir: "" },
      hermes: [
        { id: "hermes", enabled: true, mode: "url", url: "http://127.0.0.1:8787", stateDir: "" },
        { id: "hermes-2", enabled: true, mode: "url", url: "http://10.0.0.2:9119", stateDir: "" },
      ],
    },
    tokens: { hermes: "a", "hermes-2": "b" },
    collectOpenClaw: async () => [],
    collectHermes: async (attach, deps) => {
      seen.push({ id: attach.id, token: deps.token, url: attach.url });
      return [
        row({
          source: "hermes",
          handle: attach.id,
          midTurn: "unknown",
        }),
      ];
    },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen, [
    { id: "hermes", token: "a", url: "http://127.0.0.1:8787" },
    { id: "hermes-2", token: "b", url: "http://10.0.0.2:9119" },
  ]);
  assert.deepEqual(
    result["spark-local"].map((r) => r.handle).sort(),
    ["hermes", "hermes-2"]
  );
});

function loopHarness(overrides = {}) {
  const applied = [];
  const sparks = [spark()];
  let currentSources = sources({ openclaw: true });
  const loop = createOccupancyLoop({
    intervalMs: 60_000,
    getSparks: () => sparks,
    getSources: () => currentSources,
    getTokens: () => ({}),
    apply: (bySpark) => applied.push(bySpark),
    poll: async () => ({ "spark-local": [{ source: "openclaw", handle: "chat-a", badge: "generating", port: 8888 }] }),
    ...overrides,
  });
  return {
    loop,
    applied,
    setSources(next) {
      currentSources = next;
    },
  };
}

test("occupancy loop: disabled sources apply {} without polling", async () => {
  let polls = 0;
  const { loop, applied } = loopHarness({
    getSources: () => sources(),
    poll: async () => {
      polls += 1;
      return { "spark-local": [] };
    },
  });
  await loop.tick();
  assert.equal(polls, 0);
  assert.deepEqual(applied, [{}]);
});

test("occupancy loop: skip a second tick while a poll is in flight", async () => {
  let polls = 0;
  let release;
  const hanging = new Promise((resolve) => {
    release = resolve;
  });
  const { loop, applied } = loopHarness({
    poll: async () => {
      polls += 1;
      await hanging;
      return { "spark-local": [{ source: "openclaw", handle: "chat-a", badge: "generating", port: 8888 }] };
    },
  });
  const first = loop.tick();
  await loop.tick();
  release();
  await first;
  assert.equal(polls, 1);
  assert.equal(applied.length, 1);
});

test("occupancy loop: disable during poll applies {} not the hung result", async () => {
  const { loop, applied, setSources } = loopHarness({
    poll: async () => {
      setSources(sources());
      return { "spark-local": [{ source: "openclaw", handle: "chat-a", badge: "generating", port: 8888 }] };
    },
  });
  await loop.tick();
  assert.deepEqual(applied, [{}]);
});

test("occupancy loop: source URL change during poll discards the stale result", async () => {
  const { loop, applied, setSources } = loopHarness({
    poll: async () => {
      setSources({
        openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:9", stateDir: "" },
        hermes: { enabled: false, mode: "local", url: "", stateDir: "" },
      });
      return { "spark-local": [{ source: "openclaw", handle: "stale", badge: "generating", port: 8888 }] };
    },
  });
  await loop.tick();
  assert.deepEqual(applied, []);
});

test("occupancy loop: stop clears the timer so later ticks are caller-driven only", async () => {
  const { loop } = loopHarness();
  loop.start();
  loop.stop();
  loop.start();
  loop.stop();
});
