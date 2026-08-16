/**
 * Origin projector (U2): source session rows → per-Spark conversation lists.
 *
 * Pure function — no HTTP, no clocks, no engine /slots joins.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { projectConversations } from "../sessionProjector.js";

function spark(overrides = {}) {
  return {
    id: "spark-local",
    lanIp: "192.168.4.51",
    isLocal: true,
    llmPorts: [8888],
    role: "standalone",
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    source: "openclaw",
    handle: "topic-a",
    originHost: "192.168.4.51",
    originPort: 8888,
    midTurn: true,
    ...overrides,
  };
}

function rowsFor(result, sparkId) {
  assert.equal(sparkId in result, true, `expected key ${sparkId}`);
  return result[sparkId];
}

test("AE1: mid-turn + origin match is generating; midTurn false is stalled", () => {
  const sparks = [spark()];
  const generating = projectConversations([row({ handle: "chat-a", midTurn: true })], sparks);
  assert.deepEqual(rowsFor(generating, "spark-local"), [
    { id: "openclaw:8888:chat-a", source: "openclaw", handle: "chat-a", badge: "generating", port: 8888 },
  ]);

  const stalled = projectConversations([row({ handle: "chat-a", midTurn: false })], sparks);
  assert.deepEqual(rowsFor(stalled, "spark-local"), [
    { id: "openclaw:8888:chat-a", source: "openclaw", handle: "chat-a", badge: "stalled", port: 8888 },
  ]);
});

test("AE2: one mid-turn sibling generating, the other stalled", () => {
  const result = projectConversations(
    [
      row({ handle: "chat-a", midTurn: true }),
      row({ handle: "chat-b", midTurn: false }),
    ],
    [spark()]
  );
  const list = rowsFor(result, "spark-local");
  const byHandle = Object.fromEntries(list.map((r) => [r.handle, r]));
  assert.equal(byHandle["chat-a"].badge, "generating");
  assert.equal(byHandle["chat-b"].badge, "stalled");
  assert.equal(list.length, 2);
});

test("AE3: midTurn unknown is unknown, never generating", () => {
  const result = projectConversations(
    [row({ handle: "chat-u", midTurn: "unknown" })],
    [spark()]
  );
  assert.deepEqual(rowsFor(result, "spark-local"), [
    { id: "openclaw:8888:chat-u", source: "openclaw", handle: "chat-u", badge: "unknown", port: 8888 },
  ]);
});

test("cloud api.openai.com origin matches no Spark", () => {
  const result = projectConversations(
    [
      row({
        handle: "cloud-chat",
        originHost: "api.openai.com",
        originPort: 443,
        midTurn: true,
      }),
    ],
    [spark(), spark({ id: "spark-b", lanIp: "192.168.4.52", isLocal: false, llmPorts: [8888] })]
  );
  assert.deepEqual(result, {});
});

test("two Sparks, same model id, different ports: row only on matching port", () => {
  const sparks = [
    spark({ id: "spark-a", lanIp: "192.168.4.51", isLocal: false, llmPorts: [4000], modelId: "same-model" }),
    spark({ id: "spark-b", lanIp: "192.168.4.52", isLocal: false, llmPorts: [4001], modelId: "same-model" }),
  ];
  const result = projectConversations(
    [
      row({
        handle: "shared-model-chat",
        originHost: "192.168.4.52",
        originPort: 4001,
        midTurn: true,
      }),
    ],
    sparks
  );
  assert.equal("spark-a" in result, false);
  assert.deepEqual(rowsFor(result, "spark-b"), [
    { id: "openclaw:4001:shared-model-chat", source: "openclaw", handle: "shared-model-chat", badge: "generating", port: 4001 },
  ]);
});

test("local Spark matches loopback origin; non-local Spark with other lanIp does not", () => {
  const localSpark = spark({
    id: "spark-local",
    lanIp: "192.168.4.51",
    isLocal: true,
    llmPorts: [8888],
  });
  const remoteSpark = spark({
    id: "spark-remote",
    lanIp: "192.168.4.99",
    isLocal: false,
    llmPorts: [8888],
  });
  const result = projectConversations(
    [row({ handle: "loopback-chat", originHost: "127.0.0.1", originPort: 8888, midTurn: true })],
    [localSpark, remoteSpark]
  );
  assert.deepEqual(rowsFor(result, "spark-local"), [
    { id: "openclaw:8888:loopback-chat", source: "openclaw", handle: "loopback-chat", badge: "generating", port: 8888 },
  ]);
  assert.equal("spark-remote" in result, false);
});

test("recency-only is_active does not mint generating", () => {
  const result = projectConversations(
    [
      row({
        handle: "recent-chat",
        midTurn: "unknown",
        is_active: true,
        isActive: true,
      }),
      row({
        source: "hermes",
        handle: "recency-only",
        midTurn: undefined,
        is_active: true,
        isActive: true,
      }),
    ],
    [spark()]
  );
  const list = rowsFor(result, "spark-local");
  for (const conversation of list) {
    assert.equal(conversation.badge, "unknown");
    assert.notEqual(conversation.badge, "generating");
  }
  assert.equal(list.length, 2);
});

test("projected JSON has no Date.now-like changing field", () => {
  const rows = [
    row({ handle: "chat-a", midTurn: true }),
    row({ source: "hermes", handle: "chat-b", midTurn: false }),
  ];
  const sparks = [spark()];
  const first = projectConversations(rows, sparks);
  const second = projectConversations(rows, sparks);
  const json1 = JSON.stringify(first);
  const json2 = JSON.stringify(second);
  const jsonAgain = JSON.stringify(first);
  assert.equal(json1, json2);
  assert.equal(json1, jsonAgain);
  assert.equal(/\d{13}/.test(json1), false, "must not embed millisecond timestamps");
  for (const conversation of first["spark-local"]) {
    assert.deepEqual(Object.keys(conversation).sort(), ["badge", "handle", "id", "port", "source"]);
  }
});

test("localhost and bracketed ::1 match an isLocal Spark", () => {
  const local = spark({ id: "spark-local", isLocal: true, llmPorts: [8888] });
  const localhostHit = projectConversations(
    [row({ handle: "lh", originHost: "localhost", originPort: 8888 })],
    [local]
  );
  const v6Hit = projectConversations(
    [row({ handle: "v6", originHost: "[::1]", originPort: 8888 })],
    [local]
  );
  assert.equal(rowsFor(localhostHit, "spark-local")[0].handle, "lh");
  assert.equal(rowsFor(v6Hit, "spark-local")[0].handle, "v6");
});

test("worker with empty llmPorts gets no rows even when lanIp matches", () => {
  const worker = spark({
    id: "spark-worker",
    lanIp: "192.168.4.51",
    isLocal: false,
    llmPorts: [],
    role: "worker",
    workerNode: true,
  });
  const result = projectConversations([row({ midTurn: true })], [worker]);
  assert.deepEqual(result, {});
});

test("list is capped at 20; generating rows survive ahead of stalled siblings", () => {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const n = String(20 - i).padStart(2, "0");
    rows.push(row({ source: "hermes", handle: `h-${n}`, midTurn: false }));
  }
  rows.push(row({ source: "openclaw", handle: "z-last", originPort: 8888, midTurn: true }));
  const list = rowsFor(projectConversations(rows, [spark()]), "spark-local");
  assert.equal(list.length, 20);
  assert.equal(list[0].badge, "generating");
  assert.equal(list[0].handle, "z-last");
  const stalled = list.slice(1);
  const keys = stalled.map((r) => `${r.source}\0${r.handle}\0${r.port}`);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test("duplicate handles keep distinct ids from native session identity", () => {
  const result = projectConversations(
    [
      row({ id: "sess-a", handle: "World Cup", midTurn: true }),
      row({ id: "sess-b", handle: "World Cup", midTurn: false }),
    ],
    [spark()]
  );
  const list = rowsFor(result, "spark-local");
  assert.deepEqual(
    list.map((r) => r.id).sort(),
    ["sess-a", "sess-b"]
  );
  assert.equal(list.every((r) => r.handle === "World Cup"), true);
});

test("origin hostname matching the Spark name binds even when lanIp differs", () => {
  const named = spark({
    id: "spark-john",
    name: "john",
    lanIp: "100.120.26.16",
    isLocal: true,
    llmPorts: [8888],
  });
  const result = projectConversations(
    [row({ source: "hermes", handle: "cli-chat", originHost: "john", originPort: 8888, midTurn: "unknown" })],
    [named]
  );
  assert.deepEqual(rowsFor(result, "spark-john"), [
    { id: "hermes:8888:cli-chat", source: "hermes", handle: "cli-chat", badge: "unknown", port: 8888 },
  ]);
});

test("duplicate Spark names do not bind origin hostnames", () => {
  const sparks = [
    spark({ id: "a", name: "john", lanIp: "10.0.0.1", isLocal: false, llmPorts: [8888] }),
    spark({ id: "b", name: "john", lanIp: "10.0.0.2", isLocal: false, llmPorts: [8888] }),
  ];
  const result = projectConversations(
    [row({ source: "hermes", handle: "cli-chat", originHost: "john", originPort: 8888 })],
    sparks
  );
  assert.equal("a" in result, false);
  assert.equal("b" in result, false);
});

test("a Spark name that matches another Spark ssh.host does not steal that origin", () => {
  const sparks = [
    spark({ id: "named", name: "john", lanIp: "10.0.0.1", isLocal: false, llmPorts: [8888] }),
    spark({
      id: "sshed",
      name: "ofus",
      lanIp: "10.0.0.2",
      isLocal: false,
      llmPorts: [8888],
      ssh: { host: "john" },
    }),
  ];
  const result = projectConversations(
    [row({ source: "hermes", handle: "cli-chat", originHost: "john", originPort: 8888 })],
    sparks
  );
  assert.equal("named" in result, false);
  assert.equal(rowsFor(result, "sshed")[0].handle, "cli-chat");
});
