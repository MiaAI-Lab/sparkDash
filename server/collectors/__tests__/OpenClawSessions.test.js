/**
 * OpenClaw conversation collector (U3): sessions + provider origins → projector rows.
 *
 * Fixture JSON only. Injected loaders — no live gateway, no host ~/.openclaw.
 * Run: node --test server/collectors/__tests__/OpenClawSessions.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mapOpenClawSessions,
  collectOpenClawSessions,
  diagnoseOpenClawSessions,
} from "../OpenClawSessions.js";

const MODULE_PATH = fileURLToPath(new URL("../OpenClawSessions.js", import.meta.url));

const SPARK_PROVIDERS = {
  spark: { baseUrl: "http://127.0.0.1:4000/v1" },
};

function session(overrides = {}) {
  return {
    key: "agent:main:telegram:topic:1",
    label: "World Cup",
    modelProvider: "spark",
    hasActiveRun: true,
    ...overrides,
  };
}

function expectedRow(overrides = {}) {
  return {
    source: "openclaw",
    id: "agent:main:telegram:topic:1",
    handle: "World Cup",
    originHost: "127.0.0.1",
    originPort: 4000,
    midTurn: true,
    agent: "main",
    ...overrides,
  };
}

test("hasActiveRun true + baseUrl http://127.0.0.1:4000 maps origin and midTurn true", () => {
  const rows = mapOpenClawSessions([session({ hasActiveRun: true })], SPARK_PROVIDERS);
  assert.deepEqual(rows, [expectedRow({ midTurn: true })]);
});

test("hasActiveRun false is midTurn false", () => {
  const rows = mapOpenClawSessions([session({ hasActiveRun: false })], SPARK_PROVIDERS);
  assert.deepEqual(rows, [expectedRow({ midTurn: false })]);
});

test("missing occupancy field is midTurn unknown", () => {
  const rows = mapOpenClawSessions(
    [session({ hasActiveRun: undefined, status: undefined })],
    SPARK_PROVIDERS
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].midTurn, "unknown");
});

test("status running is midTurn true when hasActiveRun is absent", () => {
  const { hasActiveRun: _omit, ...rest } = session();
  const rows = mapOpenClawSessions([{ ...rest, status: "running" }], SPARK_PROVIDERS);
  assert.equal(rows[0].midTurn, true);
});

test("hasActiveRun false wins over status running", () => {
  const rows = mapOpenClawSessions(
    [session({ hasActiveRun: false, status: "running" })],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].midTurn, false);
});

test("updatedAt is lastUsedAt and is not a transcript", () => {
  const rows = mapOpenClawSessions(
    [session({ updatedAt: 1_700_000_000_000, lastMessage: "secret" })],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].lastUsedAt, 1_700_000_000_000);
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});

test("totalTokens and contextTokens become contextUsed and contextWindow", () => {
  const rows = mapOpenClawSessions(
    [session({ totalTokens: 12_345, contextTokens: 128_000, lastMessage: "secret" })],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].contextUsed, 12345);
  assert.equal(rows[0].contextWindow, 128000);
  assert.equal("contextApprox" in rows[0], false);
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});

test("stale totalTokens is contextApprox; zero tokens are omitted", () => {
  const stale = mapOpenClawSessions(
    [session({ totalTokens: 99, contextTokens: 200_000, totalTokensFresh: false })],
    SPARK_PROVIDERS
  );
  assert.equal(stale[0].contextUsed, 99);
  assert.equal(stale[0].contextApprox, true);
  const empty = mapOpenClawSessions([session({ totalTokens: 0, contextTokens: 0 })], SPARK_PROVIDERS);
  assert.equal("contextUsed" in empty[0], false);
  assert.equal("contextWindow" in empty[0], false);
});

test("handle comes from label, never lastMessage / preview / transcript", () => {
  const rows = mapOpenClawSessions(
    [
      session({
        label: "Topic A",
        lastMessage: "secret transcript body",
        preview: "preview text",
        transcript: "full transcript",
      }),
    ],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].handle, "Topic A");
  const json = JSON.stringify(rows);
  assert.equal(json.includes("secret transcript body"), false);
  assert.equal(json.includes("preview text"), false);
  assert.equal(json.includes("full transcript"), false);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "agent",
    "handle",
    "id",
    "midTurn",
    "originHost",
    "originPort",
    "source",
  ]);
});

test("handle falls back to key, never a transcript field", () => {
  const rows = mapOpenClawSessions(
    [
      session({
        label: "",
        displayName: "",
        key: "agent:main:discord:ch1",
        lastMessage: "hello world transcript",
        preview: "sneaky preview",
      }),
    ],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].handle, "agent:main:discord:ch1");
  assert.equal(JSON.stringify(rows).includes("hello world transcript"), false);
  assert.equal(JSON.stringify(rows).includes("sneaky preview"), false);
});

test("handle falls back to displayName when label is empty", () => {
  const rows = mapOpenClawSessions(
    [session({ label: "  ", displayName: "Agent Main" })],
    SPARK_PROVIDERS
  );
  assert.equal(rows[0].handle, "Agent Main");
});

test("cloud provider https://api.openai.com/v1 still emits a row", () => {
  const rows = mapOpenClawSessions(
    [session({ modelProvider: "openai", label: "cloud-chat" })],
    { openai: { baseUrl: "https://api.openai.com/v1" } }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "api.openai.com");
  assert.equal(rows[0].originPort, 443);
  assert.equal(rows[0].handle, "cloud-chat");
  assert.equal(rows[0].source, "openclaw");
});

test("session without provider baseUrl is omitted", () => {
  const rows = mapOpenClawSessions(
    [session({ modelProvider: "missing" }), session({ hasActiveRun: true })],
    SPARK_PROVIDERS
  );
  assert.deepEqual(rows, [expectedRow()]);
});

test("store map without hasActiveRun is unknown unless status running", () => {
  const store = {
    "sess-a": { modelProvider: "spark", label: "A" },
    "sess-b": { modelProvider: "spark", label: "B", status: "running" },
  };
  const rows = mapOpenClawSessions(store, SPARK_PROVIDERS);
  const byHandle = Object.fromEntries(rows.map((r) => [r.handle, r]));
  assert.equal(byHandle.A.midTurn, "unknown");
  assert.equal(byHandle.B.midTurn, true);
  assert.equal(byHandle.A.originPort, 4000);
});

test("wrapped { sessions: [...] } list is accepted", () => {
  const rows = mapOpenClawSessions({ sessions: [session({ hasActiveRun: false })] }, SPARK_PROVIDERS);
  assert.equal(rows[0].midTurn, false);
});

test("disabled attach returns [] and does not load", async () => {
  let loaded = false;
  const rows = await collectOpenClawSessions(
    { enabled: false, mode: "local" },
    {
      readFile: async () => {
        loaded = true;
        throw new Error("should not read");
      },
      fetchJson: async () => {
        loaded = true;
        throw new Error("should not fetch");
      },
    }
  );
  assert.deepEqual(rows, []);
  assert.equal(loaded, false);
});

test("unreachable / throwing loader returns [] and does not throw", async () => {
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:18789" },
    {
      fetchJson: async () => {
        throw new Error("ECONNREFUSED");
      },
    }
  );
  assert.deepEqual(rows, []);
});

test("url 404 returns []", async () => {
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:18789" },
    {
      fetchJson: async () => {
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.deepEqual(rows, []);
});

test("url mode unwraps a top-level sessions array plus providers", async () => {
  const payload = [session({ hasActiveRun: false })];
  payload.models = { providers: SPARK_PROVIDERS };
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:18789" },
    { fetchJson: async () => payload }
  );
  assert.deepEqual(rows, [expectedRow({ midTurn: false })]);
});

test("url mode unwraps models.providers and nested sessions; token from deps", async () => {
  let seenToken;
  const rows = await collectOpenClawSessions(
    {
      enabled: true,
      mode: "url",
      url: "http://127.0.0.1:18789",
      token: "from-attach",
    },
    {
      token: "from-deps",
      fetchJson: async (url, opts) => {
        assert.equal(url, "http://127.0.0.1:18789");
        seenToken = opts.token;
        return {
          sessions: { sessions: [session({ hasActiveRun: false })] },
          models: { providers: SPARK_PROVIDERS },
        };
      },
    }
  );
  assert.equal(seenToken, "from-deps");
  assert.deepEqual(rows, [expectedRow({ midTurn: false })]);
});

test("url mode prefers gatewayRpc over fetchJson and stamps attach id", async () => {
  let fetched = false;
  const rows = await collectOpenClawSessions(
    {
      id: "openclaw",
      enabled: true,
      mode: "url",
      url: "http://127.0.0.1:18789",
      label: "theshop",
    },
    {
      token: "rpc-token",
      fetchJson: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
      gatewayRpc: async (url, token) => {
        assert.equal(url, "http://127.0.0.1:18789");
        assert.equal(token, "rpc-token");
        return { sessions: [session({ hasActiveRun: false })], providers: SPARK_PROVIDERS };
      },
    }
  );
  assert.equal(fetched, false);
  assert.equal(rows[0].id, "openclaw:agent:main:telegram:topic:1");
  assert.equal(rows[0].gateway, "theshop");
  assert.equal(rows[0].handle, "World Cup");
});

test("state-dir reads openclaw.json + sessions.json via injected readFile", async () => {
  const dir = "/tmp/openclaw-fixture";
  const files = {
    [`${dir}/openclaw.json`]: JSON.stringify({ models: { providers: SPARK_PROVIDERS } }),
    [`${dir}/sessions.json`]: JSON.stringify({ sessions: [session({ hasActiveRun: true })] }),
  };
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "state-dir", stateDir: dir },
    {
      readFile: async (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
    }
  );
  assert.deepEqual(rows, [expectedRow({ midTurn: true })]);
});

test("local mode reads conventional state dir files", async () => {
  const dir = "/opt/openclaw-home";
  const files = {
    [`${dir}/openclaw.json`]: JSON.stringify({ models: { providers: SPARK_PROVIDERS } }),
    [`${dir}/sessions.json`]: JSON.stringify({
      "agent:main:telegram:topic:1": {
        modelProvider: "spark",
        label: "World Cup",
      },
    }),
  };
  const seen = [];
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: dir,
      hostRoot: "",
      readFile: async (filePath) => {
        seen.push(filePath);
        if (!(filePath in files)) throw new Error(`missing ${filePath}`);
        return files[filePath];
      },
    }
  );
  assert.ok(seen.some((p) => p.endsWith("openclaw.json")));
  assert.ok(seen.some((p) => p.endsWith("sessions.json")));
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 4000);
});

test("state-dir falls back to agents/*/sessions/sessions.json", async () => {
  const dir = "/tmp/openclaw-agents";
  const files = {
    [`${dir}/openclaw.json`]: JSON.stringify({ models: { providers: SPARK_PROVIDERS } }),
    [`${dir}/agents/main/sessions/sessions.json`]: JSON.stringify({
      sessions: [session({ hasActiveRun: true })],
    }),
  };
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "state-dir", stateDir: dir },
    {
      readFile: async (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
      readDir: async (dirPath) => {
        assert.equal(dirPath, `${dir}/agents`);
        return ["main"];
      },
    }
  );
  assert.deepEqual(rows, [expectedRow({ midTurn: true })]);
});

test("mixed array-form and map-form agent stores are merged", async () => {
  const dir = "/tmp/openclaw-mixed-stores";
  const files = {
    [`${dir}/openclaw.json`]: JSON.stringify({ models: { providers: SPARK_PROVIDERS } }),
    [`${dir}/agents/main/sessions/sessions.json`]: JSON.stringify([
      session({ key: "array-sess", label: "FromArray", hasActiveRun: true }),
    ]),
    [`${dir}/agents/work/sessions/sessions.json`]: JSON.stringify({
      "map-sess": { modelProvider: "spark", label: "FromMap", hasActiveRun: false },
    }),
  };
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "state-dir", stateDir: dir },
    {
      readFile: async (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
      readDir: async (dirPath) => {
        assert.equal(dirPath, `${dir}/agents`);
        return ["main", "work"];
      },
    }
  );
  const byHandle = Object.fromEntries(rows.map((r) => [r.handle, r]));
  assert.equal(rows.length, 2);
  assert.equal(byHandle.FromArray.midTurn, true);
  assert.equal(byHandle.FromArray.id, "array-sess");
  assert.equal(byHandle.FromArray.agent, "main");
  assert.equal(byHandle.FromMap.midTurn, false);
  assert.equal(byHandle.FromMap.id, "map-sess");
  assert.equal(byHandle.FromMap.agent, "work");
});

test("missing state files return [] not throw", async () => {
  const rows = await collectOpenClawSessions(
    { enabled: true, mode: "state-dir", stateDir: "/no/such/openclaw" },
    {
      readFile: async () => {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    }
  );
  assert.deepEqual(rows, []);
});

test("diagnose reports missing OpenClaw state as error not empty ok", async () => {
  const result = await diagnoseOpenClawSessions(
    { enabled: true, mode: "state-dir", stateDir: "/no/such/openclaw" },
    {
      readFile: async () => {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    }
  );
  assert.equal(result.status, "error");
  assert.equal(result.error, "OpenClaw state not found");
});

test("disabled OpenClaw diagnose is disabled", async () => {
  const result = await diagnoseOpenClawSessions({ enabled: false, mode: "url", url: "http://127.0.0.1:18789" });
  assert.deepEqual(result, { status: "disabled", found: 0, mapped: 0, error: null });
});

test("module has no alphaclaw strings and no llmPorts HTTP", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/alphaclaw/i.test(src), false);
  assert.equal(/\bmama\b/i.test(src), false);
  assert.equal(/kalliope/i.test(src), false);
  assert.equal(/llmPorts/.test(src), false);
  assert.equal(/projectConversations/.test(src), false);
  assert.equal(/\/v1\/chat/.test(src), false);
  assert.equal(/\/v1\/models/.test(src), false);
});
