/**
 * Hermes Agent conversation reader (U4): dashboard sessions → projector rows.
 *
 * Recency is_active is never mid-turn. Fixture JSON / injected loaders only.
 * Run: node --test server/collectors/__tests__/HermesSessions.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mapHermesSessions,
  collectHermesSessions,
  diagnoseHermesSessions,
  resetHermesAuthCache,
} from "../HermesSessions.js";

const MODULE_PATH = fileURLToPath(new URL("../HermesSessions.js", import.meta.url));

const PROFILE = { model: { base_url: "http://127.0.0.1:8888/v1" } };

function session(overrides = {}) {
  return {
    id: "sess-1",
    source: "cli",
    model: "local-model",
    title: "Coding session",
    is_active: true,
    billing_base_url: "http://127.0.0.1:8888/v1",
    preview: "user asked a secret question",
    ...overrides,
  };
}

function expectedRow(overrides = {}) {
  return {
    source: "hermes",
    id: "sess-1",
    handle: "Coding session",
    originHost: "127.0.0.1",
    originPort: 8888,
    midTurn: "unknown",
    ...overrides,
  };
}

test("updated_at is lastUsedAt; is_active is still not mid-turn", () => {
  const rows = mapHermesSessions([
    session({ is_active: true, updated_at: "2024-01-15T12:00:00.000Z" }),
  ]);
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(rows[0].lastUsedAt, Date.parse("2024-01-15T12:00:00.000Z"));
});

test("last_prompt_tokens is contextUsed; preview is never copied", () => {
  const rows = mapHermesSessions([
    session({ last_prompt_tokens: 42_000, input_tokens: 900_000, preview: "secret" }),
  ]);
  assert.equal(rows[0].contextUsed, 42000);
  assert.equal("contextWindow" in rows[0], false);
  assert.equal(JSON.stringify(rows).includes("secret"), false);
});

test("is_active true without a mid-turn field is midTurn unknown", () => {
  const rows = mapHermesSessions([session({ is_active: true })]);
  assert.deepEqual(rows, [expectedRow({ midTurn: "unknown" })]);
});

test("origin from billing_base_url is still emitted when midTurn is unknown", () => {
  const rows = mapHermesSessions([session({ is_active: true })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(rows[0].source, "hermes");
});

test("billing_base_url http://127.0.0.1:8888/v1 → origin 127.0.0.1:8888", () => {
  const rows = mapHermesSessions([
    session({ billing_base_url: "http://127.0.0.1:8888/v1" }),
  ]);
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
});

test("is_active true + status working is midTurn true", () => {
  const rows = mapHermesSessions([
    session({ is_active: true, status: "working" }),
  ]);
  assert.deepEqual(rows, [expectedRow({ midTurn: true })]);
});

test("status running is midTurn true; is_active is ignored", () => {
  const rows = mapHermesSessions([
    session({ is_active: false, status: "running" }),
  ]);
  assert.equal(rows[0].midTurn, true);
});

test("running true is midTurn true; is_active is still ignored", () => {
  const rows = mapHermesSessions([
    session({ is_active: false, running: true }),
  ]);
  assert.equal(rows[0].midTurn, true);
});

test("running false without status stays unknown, never stalled", () => {
  const rows = mapHermesSessions([
    session({ is_active: true, running: false }),
  ]);
  assert.equal(rows[0].midTurn, "unknown");
});

test("handle is title; preview is absent from the JSON row", () => {
  const rows = mapHermesSessions([
    session({
      title: "Topic A",
      preview: "secret transcript body",
    }),
  ]);
  assert.equal(rows[0].handle, "Topic A");
  const json = JSON.stringify(rows);
  assert.equal(json.includes("secret transcript body"), false);
  assert.equal(json.includes("preview"), false);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "handle",
    "id",
    "midTurn",
    "originHost",
    "originPort",
    "source",
  ]);
});

test("handle falls back to source, then id; preview is never the handle", () => {
  const noTitle = mapHermesSessions([
    session({ title: "", source: "telegram", preview: "sneaky preview" }),
  ]);
  assert.equal(noTitle[0].handle, "telegram");
  assert.equal(JSON.stringify(noTitle).includes("sneaky preview"), false);

  const idOnly = mapHermesSessions([
    session({ title: "  ", source: "", id: "abc-123", preview: "body" }),
  ]);
  assert.equal(idOnly[0].handle, "abc-123");
  assert.equal(JSON.stringify(idOnly).includes("body"), false);
});

test("profile model.base_url supplies origin when billing_base_url is absent", () => {
  const { billing_base_url: _omit, ...rest } = session();
  const rows = mapHermesSessions([rest], PROFILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
});

test("billing_base_url wins over profile model.base_url", () => {
  const rows = mapHermesSessions(
    [session({ billing_base_url: "http://10.0.0.2:4000/v1" })],
    { model: { base_url: "http://127.0.0.1:8888/v1" } }
  );
  assert.equal(rows[0].originHost, "10.0.0.2");
  assert.equal(rows[0].originPort, 4000);
});

test("session without origin URL is omitted", () => {
  const { billing_base_url: _omit, ...rest } = session();
  const rows = mapHermesSessions(
    [rest, session({ title: "kept" })],
    {}
  );
  assert.deepEqual(rows, [expectedRow({ handle: "kept" })]);
});

test("wrapped { sessions: [...] } list is accepted", () => {
  const rows = mapHermesSessions({ sessions: [session({ is_active: true })] });
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(rows[0].handle, "Coding session");
});

test("disabled attach returns [] and does not load", async () => {
  let loaded = false;
  const rows = await collectHermesSessions(
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
      listSessions: async () => {
        loaded = true;
        throw new Error("should not list");
      },
    }
  );
  assert.deepEqual(rows, []);
  assert.equal(loaded, false);
});

test("throwing fetch returns [] and does not throw", async () => {
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      fetchJson: async () => {
        throw new Error("ECONNREFUSED");
      },
    }
  );
  assert.deepEqual(rows, []);
});

test("url already pointing at /api/sessions still loads profile from the gateway origin", async () => {
  const seen = [];
  const { billing_base_url: _omit, ...rest } = session({ is_active: true });
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119/api/sessions" },
    {
      token: "from-deps",
      fetchJson: async (url) => {
        seen.push(String(url));
        if (String(url).includes("/api/sessions")) {
          return { sessions: [rest] };
        }
        if (String(url).includes("/api/config")) {
          return PROFILE;
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.ok(seen.some((u) => u.startsWith("http://127.0.0.1:9119/api/sessions")));
  assert.ok(seen.includes("http://127.0.0.1:9119/api/config"));
  assert.equal(
    seen.some((u) => u.includes("/api/sessions/api/")),
    false
  );
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
});

test("url mode GETs /api/sessions?limit=50 with Bearer token from deps", async () => {
  let seenUrl;
  let seenToken;
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      token: "from-deps",
      fetchJson: async (url, opts) => {
        if (String(url).includes("/api/sessions")) {
          seenUrl = url;
          seenToken = opts.token;
          return { sessions: [session({ is_active: true })] };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(seenUrl, "http://127.0.0.1:9119/api/sessions?limit=50&include_cli=1");
  assert.equal(seenToken, "from-deps");
  assert.deepEqual(rows, [expectedRow({ midTurn: "unknown" })]);
});

test("injected listSessions is mapped; throwing listSessions returns []", async () => {
  const listed = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      listSessions: async () => [session({ status: "working" })],
    }
  );
  assert.deepEqual(listed, [expectedRow({ midTurn: true })]);

  const failed = await collectHermesSessions(
    { enabled: true, mode: "local" },
    {
      listSessions: async () => {
        throw new Error("boom");
      },
    }
  );
  assert.deepEqual(failed, []);
});

test("state-dir reads sessions.json + optional config.json via injected readFile", async () => {
  const dir = "/tmp/hermes-fixture";
  const { billing_base_url: _omit, ...rest } = session({ is_active: true });
  const files = {
    [`${dir}/sessions.json`]: JSON.stringify({ sessions: [rest] }),
    [`${dir}/config.json`]: JSON.stringify(PROFILE),
  };
  const rows = await collectHermesSessions(
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
  assert.deepEqual(rows, [expectedRow({ midTurn: "unknown" })]);
});

test("local mode reads conventional state dir; profile.json supplies base_url", async () => {
  const dir = "/opt/hermes-home";
  const { billing_base_url: _omit, ...rest } = session();
  const files = {
    [`${dir}/sessions.json`]: JSON.stringify([rest]),
    [`${dir}/profile.json`]: JSON.stringify(PROFILE),
  };
  const seen = [];
  const rows = await collectHermesSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: dir,
      hostRoot: "",
      readFile: async (filePath) => {
        seen.push(filePath);
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
    }
  );
  assert.ok(seen.some((p) => p.endsWith("sessions.json")));
  assert.ok(seen.some((p) => p.endsWith("config.json") || p.endsWith("profile.json")));
  assert.equal(rows[0].midTurn, "unknown");
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
});

test("config.json without a base URL continues to profile.json", async () => {
  const dir = "/tmp/hermes-profile-fallback";
  const { billing_base_url: _omit, ...rest } = session();
  const files = {
    [`${dir}/sessions.json`]: JSON.stringify({ sessions: [rest] }),
    [`${dir}/config.json`]: JSON.stringify({ theme: "dark" }),
    [`${dir}/profile.json`]: JSON.stringify(PROFILE),
  };
  const rows = await collectHermesSessions(
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originHost, "127.0.0.1");
  assert.equal(rows[0].originPort, 8888);
});

test("url /api/config without a base URL continues to /api/profile", async () => {
  const { billing_base_url: _omit, ...rest } = session();
  const seen = [];
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      fetchJson: async (url) => {
        seen.push(String(url));
        if (String(url).includes("/api/sessions")) return { sessions: [rest] };
        if (String(url).includes("/api/config")) return { status: "ok" };
        if (String(url).includes("/api/profile")) return PROFILE;
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.ok(seen.includes("http://127.0.0.1:9119/api/config"));
  assert.ok(seen.includes("http://127.0.0.1:9119/api/profile"));
  assert.equal(rows[0].originPort, 8888);
});

test("missing state files return [] not throw", async () => {
  const rows = await collectHermesSessions(
    { enabled: true, mode: "state-dir", stateDir: "/no/such/hermes" },
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

test("url mode without fetchJson logs in then GETs sessions with Cookie", async () => {
  resetHermesAuthCache();
  const calls = [];
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119", username: "ops" },
    {
      token: "ui-password",
      fetchResponse: async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method ?? "GET", cookie: opts.cookie, body: opts.body });
        if (String(url).endsWith("/api/auth/providers")) {
          return {
            json: async () => ({
              providers: [{ name: "basic", supports_password: true }],
            }),
            headers: { getSetCookie: () => [], get: () => null },
          };
        }
        if (String(url).endsWith("/auth/password-login")) {
          const body = JSON.parse(opts.body);
          assert.equal(body.provider, "basic");
          assert.equal(body.username, "ops");
          assert.equal(body.password, "ui-password");
          return {
            json: async () => ({ ok: true }),
            headers: {
              getSetCookie: () => [
                "hermes_session_at=abc.def; HttpOnly; Path=/",
                "hermes_session_rt=rt.1; HttpOnly; Path=/",
                "hermes_session_provider=basic; Path=/",
              ],
              get: () => null,
            },
          };
        }
        if (String(url).includes("/api/sessions")) {
          assert.equal(
            opts.cookie,
            "hermes_session_at=abc.def; hermes_session_rt=rt.1; hermes_session_provider=basic"
          );
          return { json: async () => ({ sessions: [session({ is_active: true })] }) };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(calls[0].url, "http://127.0.0.1:9119/api/auth/providers");
  assert.equal(calls[1].url, "http://127.0.0.1:9119/auth/password-login");
  assert.equal(calls[1].method, "POST");
  assert.equal(
    calls.some((c) => String(c.url).includes("/api/auth/login")),
    false
  );
  assert.ok(calls.some((c) => c.url.includes("/api/sessions?limit=50&include_cli=1")));
  assert.equal(rows.length, 1);
});

test("providers 401 falls back to Bearer instead of treating the token as a password", async () => {
  resetHermesAuthCache();
  const calls = [];
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      token: "gateway-bearer",
      fetchResponse: async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method ?? "GET", token: opts.token, cookie: opts.cookie });
        if (String(url).endsWith("/api/auth/providers")) {
          const err = new Error("HTTP 401");
          err.status = 401;
          throw err;
        }
        if (String(url).endsWith("/api/auth/login")) {
          const err = new Error("HTTP 404");
          err.status = 404;
          throw err;
        }
        if (String(url).includes("/api/sessions")) {
          assert.equal(opts.token, "gateway-bearer");
          assert.equal(opts.cookie, undefined);
          return { json: async () => ({ sessions: [session({ is_active: true })] }) };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(calls[0].url, "http://127.0.0.1:9119/api/auth/providers");
  assert.equal(
    calls.some((c) => String(c.url).includes("/auth/password-login")),
    false
  );
  assert.equal(rows.length, 1);
});

test("gated providers still use password-only /api/auth/login", async () => {
  resetHermesAuthCache();
  const calls = [];
  const rows = await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:8787" },
    {
      token: "webui-password",
      fetchResponse: async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method ?? "GET", cookie: opts.cookie, body: opts.body });
        if (String(url).endsWith("/api/auth/providers")) {
          const err = new Error("HTTP 401");
          err.status = 401;
          throw err;
        }
        if (String(url).endsWith("/api/auth/login")) {
          assert.equal(JSON.parse(opts.body).password, "webui-password");
          return {
            json: async () => ({ ok: true }),
            headers: {
              getSetCookie: () => ["hermes_session=webui.cookie; HttpOnly; Path=/"],
              get: () => null,
            },
          };
        }
        if (String(url).includes("/api/sessions")) {
          assert.equal(opts.cookie, "hermes_session=webui.cookie");
          return { json: async () => ({ sessions: [session({ is_active: true })] }) };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(
    calls.some((c) => String(c.url).includes("/auth/password-login")),
    false
  );
  assert.ok(calls.some((c) => String(c.url).endsWith("/api/auth/login")));
  assert.equal(rows.length, 1);
});

test("password login defaults username to admin", async () => {
  resetHermesAuthCache();
  let loginBody;
  await collectHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      token: "ui-password",
      fetchResponse: async (url, opts = {}) => {
        if (String(url).endsWith("/api/auth/providers")) {
          return {
            json: async () => ({ providers: [{ name: "basic", supports_password: true }] }),
            headers: { getSetCookie: () => [], get: () => null },
          };
        }
        if (String(url).endsWith("/auth/password-login")) {
          loginBody = JSON.parse(opts.body);
          return {
            json: async () => ({ ok: true }),
            headers: {
              getSetCookie: () => ["hermes_session_at=tok; HttpOnly; Path=/"],
              get: () => null,
            },
          };
        }
        if (String(url).includes("/api/sessions")) {
          return { json: async () => ({ sessions: [] }) };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  assert.equal(loginBody.username, "admin");
});

test("diagnose reports HTTP 401 when Hermes login fails", async () => {
  resetHermesAuthCache();
  const result = await diagnoseHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      token: "wrong",
      fetchResponse: async () => {
        const err = new Error("HTTP 401");
        err.status = 401;
        throw err;
      },
    }
  );
  assert.equal(result.status, "error");
  assert.equal(result.error, "HTTP 401 (auth failed)");
  assert.equal(result.found, 0);
});

test("CLI billing_base_url hostname origin is mapped", () => {
  const rows = mapHermesSessions([
    {
      session_id: "cli-1",
      title: "Telegram chat",
      billing_base_url: "http://john:8888/v1",
      is_cli_session: true,
    },
  ]);
  assert.equal(rows[0].originHost, "john");
  assert.equal(rows[0].originPort, 8888);
  assert.equal(rows[0].handle, "Telegram chat");
});

test("diagnose JSON has counts only", async () => {
  const result = await diagnoseHermesSessions(
    { enabled: true, mode: "url", url: "http://127.0.0.1:9119" },
    {
      fetchJson: async (url) => {
        if (String(url).includes("/api/sessions")) {
          return { sessions: [session({ title: "Secret title", preview: "do not leak" })] };
        }
        const err = new Error("HTTP 404");
        err.status = 404;
        throw err;
      },
    }
  );
  const json = JSON.stringify(result);
  assert.equal(json.includes("Secret title"), false);
  assert.equal(json.includes("do not leak"), false);
  assert.equal(result.status, "ok");
  assert.equal(result.found, 1);
  assert.equal(result.mapped, 1);
});

test("profile fallback labels the Hermes lane", () => {
  const rows = mapHermesSessions([session()], PROFILE, "unleashed");
  assert.equal(rows[0].agent, "unleashed");
});

test("session profile wins over fallback", () => {
  const rows = mapHermesSessions([session({ profile: "planner" })], PROFILE, "unleashed");
  assert.equal(rows[0].agent, "planner");
});

test("profiles/<name> state dir labels that profile", async () => {
  const dir = "/tmp/hermes/profiles/unleashed";
  const files = {
    [`${dir}/sessions.json`]: JSON.stringify([session({ title: "FromUnleashed" })]),
    [`${dir}/profile.json`]: JSON.stringify(PROFILE),
  };
  const rows = await collectHermesSessions(
    { enabled: true, mode: "state-dir", stateDir: dir },
    {
      hostRoot: "",
      readFile: async (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
      readDir: async () => {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    }
  );
  assert.equal(rows[0].handle, "FromUnleashed");
  assert.equal(rows[0].agent, "unleashed");
});

test("local profiles/* are collected as separate lanes", async () => {
  const dir = "/tmp/hermes-root";
  const files = {
    [`${dir}/profiles/unleashed/sessions.json`]: JSON.stringify([
      session({ id: "u1", title: "Unleashed chat" }),
    ]),
    [`${dir}/profiles/unleashed/profile.json`]: JSON.stringify(PROFILE),
    [`${dir}/profiles/planner/sessions.json`]: JSON.stringify([
      session({
        id: "p1",
        title: "Planner chat",
        billing_base_url: "http://127.0.0.1:4000/v1",
      }),
    ]),
    [`${dir}/profiles/planner/profile.json`]: JSON.stringify({
      model: { base_url: "http://127.0.0.1:4000/v1" },
    }),
  };
  const rows = await collectHermesSessions(
    { enabled: true, mode: "local" },
    {
      conventionalStateDir: dir,
      hostRoot: "",
      readFile: async (filePath) => {
        if (!(filePath in files)) {
          const err = new Error(`ENOENT ${filePath}`);
          err.code = "ENOENT";
          throw err;
        }
        return files[filePath];
      },
      readDir: async (dirPath) => {
        if (dirPath === `${dir}/profiles`) return ["unleashed", "planner"];
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    }
  );
  const byHandle = Object.fromEntries(rows.map((r) => [r.handle, r]));
  assert.equal(rows.length, 2);
  assert.equal(byHandle["Unleashed chat"].agent, "unleashed");
  assert.equal(byHandle["Unleashed chat"].originPort, 8888);
  assert.equal(byHandle["Planner chat"].agent, "planner");
  assert.equal(byHandle["Planner chat"].originPort, 4000);
});

test("module has no CLI update probe, alphaclaw, or llmPorts HTTP", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  assert.equal(/hermes update/.test(src), false);
  assert.equal(/check\(/.test(src), false);
  assert.equal(/alphaclaw/i.test(src), false);
  assert.equal(/\bmama\b/i.test(src), false);
  assert.equal(/kalliope/i.test(src), false);
  assert.equal(/llmPorts/.test(src), false);
  assert.equal(/projectConversations/.test(src), false);
  assert.equal(/OpenClawSessions/.test(src), false);
  assert.equal(/HermesProbe/.test(src), false);
  assert.equal(/POLL_INTERVAL_HERMES/.test(src), false);
  assert.equal(/\/v1\/chat/.test(src), false);
  assert.equal(/\/v1\/models/.test(src), false);
});
