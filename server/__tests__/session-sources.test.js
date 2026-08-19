/**
 * Session source attach config (U1).
 *
 * Uses temp dirs + env path injection so tests never touch the real config/ volume.
 * Run: node --test server/__tests__/session-sources.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-session-sources-"));
const sourcesPath = path.join(tmpDir, "session-sources.json");
const secretsPath = path.join(tmpDir, "sparks-secrets.json");
const keyPath = path.join(tmpDir, ".secrets-key");

process.env.SESSION_SOURCES_JSON_PATH = sourcesPath;
process.env.SPARKS_SECRETS_PATH = secretsPath;
process.env.SECRETS_KEY_PATH = keyPath;
process.env.SPARKDASH_SECRETS_KEY = "sparkdash-session-sources-test-key";
delete process.env.OPENCLAW_STATE_DIR;
delete process.env.HERMES_HOME;

const secretsStore = await import("../secretsStore.js");
const sessionSources = await import("../sessionSources.js");

const {
  loadSecrets,
  saveSecrets,
  resetSecretsKeyCache,
} = secretsStore;
const {
  getPublicSessionSources,
  updateSessionSources,
  loadSessionSources,
  SOURCE_IDS,
  conventionalStateDir,
} = sessionSources;

function first(list) {
  assert.ok(Array.isArray(list) && list.length > 0, "expected attach list");
  return list[0];
}

function resetFiles() {
  for (const filePath of [sourcesPath, secretsPath, keyPath]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* missing is fine */
    }
  }
  if (typeof resetSecretsKeyCache === "function") {
    resetSecretsKeyCache();
  }
}

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("U1 registry: OpenClaw, Hermes, and OpenCode; config iterates registry kinds", async () => {
  const registry = await import("../sessionSourceRegistry.js");
  assert.deepEqual(registry.sessionSourceIds(), ["openclaw", "hermes", "opencode", "omp", "dsh"]);
  assert.equal(registry.kindById("openclaw")?.label, "OpenClaw");
  assert.equal(registry.kindById("hermes")?.label, "Hermes Agent");
  assert.equal(registry.kindById("opencode")?.label, "OpenCode");
  assert.equal(registry.kindById("omp")?.label, "oh-my-pi");
  assert.equal(registry.kindById("dsh")?.label, "DeepSeek Harness");
  assert.deepEqual([...SOURCE_IDS], registry.sessionSourceIds());
  assert.equal(conventionalStateDir, registry.conventionalStateDir);

  const src = fs.readFileSync(fileURLToPath(new URL("../sessionSources.js", import.meta.url)), "utf8");
  assert.match(src, /sessionSourceRegistry/);
  assert.equal(/\[["']openclaw["']\s*,\s*["']hermes["']\]/.test(src), false);

  resetFiles();
  const loaded = loadSessionSources();
  const pub = getPublicSessionSources();
  for (const kind of registry.sessionSourceIds()) {
    assert.ok(Array.isArray(loaded[kind]), `expected ${kind} attach list`);
    assert.equal(first(loaded[kind]).enabled, false);
    assert.ok(Array.isArray(pub[kind]), `expected public ${kind} attach list`);
    assert.equal(first(pub[kind]).conventionalStateDir, registry.conventionalStateDir(kind));
  }
  assert.equal(conventionalStateDir("openclaw-2"), "");
  assert.equal(conventionalStateDir("opencode"), "~/.local/share/opencode");
  assert.equal(registry.conventionalConfigDir("opencode"), "~/.config/opencode");
  assert.equal(registry.conventionalConfigDir("openclaw"), "");
  assert.equal(first(pub.opencode).urlPlaceholder, "http://127.0.0.1:8788/occupancy");
  assert.equal(first(pub.opencode).kindLabel, "OpenCode");
  assert.equal(first(pub.hermes).kindLabel, "Hermes Agent");
  assert.equal(first(pub.hermes).usesUsername, true);
  assert.equal(first(pub.openclaw).usesUsername, undefined);
  assert.equal(
    conventionalStateDir("hermes", { HERMES_HOME: " /custom/hermes " }),
    "/custom/hermes"
  );
});

test("public GET and save only emit registry kinds; kindLabel is not persisted", () => {
  resetFiles();
  fs.writeFileSync(
    sourcesPath,
    JSON.stringify({
      openclaw: [{ id: "openclaw", enabled: false, mode: "local", url: "", stateDir: "" }],
      hermes: [{ id: "hermes", enabled: false, mode: "local", url: "", stateDir: "" }],
      leftover: [{ id: "leftover", enabled: true, mode: "local", url: "", stateDir: "" }],
    })
  );
  const pub = getPublicSessionSources();
  assert.deepEqual(Object.keys(pub).sort(), ["dsh", "hermes", "omp", "openclaw", "opencode"]);
  assert.equal("leftover" in pub, false);
  const next = updateSessionSources({ opencode: { id: "opencode", enabled: false } });
  assert.equal(first(next.opencode).kindLabel, "OpenCode");
  const disk = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.deepEqual(Object.keys(disk).sort(), ["dsh", "hermes", "omp", "openclaw", "opencode"]);
  assert.equal("kindLabel" in first(disk.opencode), false);
});

test("AE4 config: both sources disabled/absent is a valid normalized config", () => {
  resetFiles();
  const loaded = loadSessionSources();
  assert.equal(first(loaded.openclaw).enabled, false);
  assert.equal(first(loaded.hermes).enabled, false);
  const pub = getPublicSessionSources();
  assert.equal(first(pub.openclaw).enabled, false);
  assert.equal(first(pub.hermes).enabled, false);
  assert.equal(first(pub.openclaw).hasToken, false);
  assert.equal(first(pub.hermes).hasToken, false);
  assert.equal("token" in first(pub.openclaw), false);
  assert.equal("token" in first(pub.hermes), false);
});

test("AE5: URL attach persists and round-trips without leaking the token on GET", () => {
  resetFiles();
  const token = "super-secret-openclaw-token";
  const pub = updateSessionSources({
    openclaw: {
      enabled: true,
      mode: "url",
      url: "http://127.0.0.1:18789",
      token,
    },
  });

  assert.equal(first(pub.openclaw).enabled, true);
  assert.equal(first(pub.openclaw).mode, "url");
  assert.equal(first(pub.openclaw).url, "http://127.0.0.1:18789");
  assert.equal(first(pub.openclaw).hasToken, true);
  assert.equal("token" in first(pub.openclaw), false);
  assert.equal(JSON.stringify(pub).includes(token), false);

  const disk = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(first(disk.openclaw).enabled, true);
  assert.equal(first(disk.openclaw).mode, "url");
  assert.equal(first(disk.openclaw).url, "http://127.0.0.1:18789");
  assert.equal(JSON.stringify(disk).includes(token), false);
  assert.equal("token" in (first(disk.openclaw) || {}), false);

  const secretsRaw = fs.readFileSync(secretsPath, "utf8");
  assert.equal(secretsRaw.includes(token), false);

  const reloaded = getPublicSessionSources();
  assert.equal(first(reloaded.openclaw).enabled, true);
  assert.equal(first(reloaded.openclaw).mode, "url");
  assert.equal(first(reloaded.openclaw).url, "http://127.0.0.1:18789");
  assert.equal(first(reloaded.openclaw).hasToken, true);
  assert.equal("token" in first(reloaded.openclaw), false);
  assert.equal(JSON.stringify(reloaded).includes(token), false);
});

test("local mode saves conventional product paths, not this fleet", () => {
  resetFiles();
  const pub = updateSessionSources({
    openclaw: { enabled: true, mode: "local" },
    hermes: { enabled: true, mode: "local" },
  });

  assert.equal(first(pub.openclaw).mode, "local");
  assert.equal(first(pub.hermes).mode, "local");
  assert.equal(first(pub.openclaw).conventionalStateDir, "~/.openclaw");
  assert.equal(first(pub.hermes).conventionalStateDir, "~/.hermes");

  const dumped = `${JSON.stringify(pub)}\n${fs.readFileSync(sourcesPath, "utf8")}`;
  assert.equal(/alphaclaw/i.test(dumped), false);
  assert.equal(dumped.includes("/.local/state/alphaclaw"), false);
  assert.match(dumped, /~\/\.openclaw/);
  assert.match(dumped, /~\/\.hermes/);
});

test("documented attach fields and unknown extras survive save/reload", () => {
  resetFiles();
  fs.writeFileSync(
    sourcesPath,
    JSON.stringify(
      {
        openclaw: {
          enabled: true,
          mode: "state-dir",
          url: "http://127.0.0.1:18789",
          stateDir: "/tmp/openclaw-state",
          futureFlag: true,
        },
        hermes: {
          enabled: false,
          mode: "local",
          url: "",
          stateDir: "",
          extraReader: "v2",
        },
      },
      null,
      2
    ) + "\n"
  );

  const loaded = loadSessionSources();
  assert.equal(first(loaded.openclaw).enabled, true);
  assert.equal(first(loaded.openclaw).mode, "state-dir");
  assert.equal(first(loaded.openclaw).url, "http://127.0.0.1:18789");
  assert.equal(first(loaded.openclaw).stateDir, "/tmp/openclaw-state");
  assert.equal(first(loaded.openclaw).futureFlag, true);
  assert.equal(first(loaded.hermes).extraReader, "v2");

  updateSessionSources({ openclaw: { enabled: false } });
  const disk = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(first(disk.openclaw).enabled, false);
  assert.equal(first(disk.openclaw).mode, "state-dir");
  assert.equal(first(disk.openclaw).url, "http://127.0.0.1:18789");
  assert.equal(first(disk.openclaw).stateDir, "/tmp/openclaw-state");
  assert.equal(first(disk.openclaw).futureFlag, true);
  assert.equal(first(disk.hermes).extraReader, "v2");
});

test("omitted token on PATCH does not wipe; empty string clears", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(first(getPublicSessionSources().openclaw).hasToken, true);

  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789" },
  });
  assert.equal(first(getPublicSessionSources().openclaw).hasToken, true);

  updateSessionSources({
    openclaw: { token: "" },
  });
  assert.equal(first(getPublicSessionSources().openclaw).hasToken, false);
});

test("url-only PATCH to a new origin clears the stored token", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(first(getPublicSessionSources().openclaw).hasToken, true);

  const pub = updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://192.168.4.10:18789" },
  });
  assert.equal(first(pub.openclaw).hasToken, false);
  assert.equal(first(pub.openclaw).url, "http://192.168.4.10:18789");
});

test("URL userinfo, non-http protocol, and NUL stateDir are rejected", () => {
  resetFiles();
  const userinfoUrl = new URL("http://127.0.0.1:18789");
  userinfoUrl.username = "review-user";
  userinfoUrl.password = "review-pass";
  assert.throws(
    () =>
      updateSessionSources({
        openclaw: { enabled: true, mode: "url", url: userinfoUrl.toString() },
      }),
    /userinfo/i
  );
  assert.throws(
    () =>
      updateSessionSources({
        hermes: { enabled: true, mode: "url", url: "file:///tmp/sessions.json" },
      }),
    /protocol/i
  );
  assert.throws(
    () =>
      updateSessionSources({
        openclaw: { enabled: true, mode: "state-dir", stateDir: "/tmp/openclaw\0evil" },
      }),
    /state dir/i
  );
});

test("disallowed URL host is rejected", () => {
  resetFiles();
  assert.throws(
    () =>
      updateSessionSources({
        openclaw: {
          enabled: true,
          mode: "url",
          url: "http://169.254.169.254:18789",
        },
      }),
    /disallowed host/i
  );
  assert.equal(fs.existsSync(sourcesPath), false);

  assert.throws(
    () =>
      updateSessionSources({
        hermes: {
          enabled: true,
          mode: "url",
          url: "http://169.254.1.1:9119",
        },
      }),
    /disallowed host/i
  );
});

test("v1 sparks-secrets.json passwords still load after session-token field is added", () => {
  resetFiles();
  saveSecrets(new Map([["spark-a", "ssh-password-a"]]));
  const v2 = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  assert.equal(v2.version, 2);
  assert.ok(v2.secrets["spark-a"]);
  assert.equal(v2.sessionSourceTokens, undefined);
  assert.equal(loadSecrets().passwords.get("spark-a"), "ssh-password-a");

  updateSessionSources({ hermes: { token: "hermes-session-token" } });
  assert.equal(loadSecrets().passwords.get("spark-a"), "ssh-password-a");
  assert.equal(first(getPublicSessionSources().hermes).hasToken, true);

  saveSecrets(new Map([["spark-a", "ssh-password-a"], ["spark-b", "ssh-password-b"]]));
  assert.equal(loadSecrets().passwords.get("spark-a"), "ssh-password-a");
  assert.equal(loadSecrets().passwords.get("spark-b"), "ssh-password-b");
  assert.equal(first(getPublicSessionSources().hermes).hasToken, true);

  saveSecrets(new Map());
  assert.equal(loadSecrets().passwords.size, 0);
  assert.equal(first(getPublicSessionSources().hermes).hasToken, true);
});

test("enabled state-dir requires a non-empty path", () => {
  resetFiles();
  assert.throws(
    () =>
      updateSessionSources({
        openclaw: { enabled: true, mode: "state-dir", stateDir: "" },
      }),
    /state dir/i
  );
  const pub = updateSessionSources({
    openclaw: { enabled: false, mode: "state-dir", stateDir: "" },
  });
  assert.equal(first(pub.openclaw).enabled, false);
  assert.equal(first(pub.openclaw).mode, "state-dir");
  assert.equal(first(pub.openclaw).stateDir, "");
});

test("token patch rolls back when session-sources.json cannot be saved", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(first(getPublicSessionSources().openclaw).hasToken, true);
  fs.unlinkSync(sourcesPath);
  fs.mkdirSync(sourcesPath);
  try {
    assert.throws(
      () =>
        updateSessionSources({
          openclaw: { enabled: true, mode: "url", url: "http://192.168.4.10:18789" },
        }),
      /Failed to write|EISDIR|ENOTDIR/i
    );
    assert.equal(first(getPublicSessionSources().openclaw).hasToken, true);
  } finally {
    fs.rmSync(sourcesPath, { recursive: true, force: true });
  }
});

test("two OpenClaw attaches persist distinct urls, labels, and tokens", () => {
  resetFiles();
  const pub = updateSessionSources({
    openclaw: [
      {
        id: "openclaw",
        enabled: true,
        mode: "url",
        url: "http://127.0.0.1:18789",
        label: "theshop",
        token: "token-a",
      },
      {
        id: "openclaw-2",
        enabled: true,
        mode: "url",
        url: "http://10.0.0.2:18789",
        label: "mama",
        token: "token-b",
      },
    ],
  });
  assert.equal(pub.openclaw.length, 2);
  assert.equal(pub.openclaw[0].url, "http://127.0.0.1:18789");
  assert.equal(pub.openclaw[0].label, "theshop");
  assert.equal(pub.openclaw[0].hasToken, true);
  assert.equal(pub.openclaw[1].id, "openclaw-2");
  assert.equal(pub.openclaw[1].url, "http://10.0.0.2:18789");
  assert.equal(pub.openclaw[1].hasToken, true);
  assert.equal(JSON.stringify(pub).includes("token-a"), false);
  assert.equal(JSON.stringify(pub).includes("token-b"), false);
});

test("wizard metadata: every kind has a non-empty description", () => {
  const pub = getPublicSessionSources();
  for (const kind of SOURCE_IDS) {
    const attaches = pub[kind];
    assert.ok(attaches.length > 0, `${kind} should have at least one attach`);
    const meta = attaches[0];
    assert.ok(
      typeof meta.description === "string" && meta.description.length > 0,
      `${kind} should have a non-empty description, got: ${meta.description}`
    );
  }
});

test("wizard metadata: dsh is remote-only, others are not", () => {
  const pub = getPublicSessionSources();
  assert.equal(pub.dsh[0].remoteOnly, true);
  for (const kind of ["openclaw", "hermes", "opencode", "omp"]) {
    assert.ok(
      !pub[kind][0].remoteOnly,
      `${kind} should not be remote-only`
    );
  }
});

test("wizard metadata: helper snippets present only for helper-backed kinds", () => {
  const pub = getPublicSessionSources();
  for (const kind of ["opencode", "omp", "dsh"]) {
    const meta = pub[kind][0];
    assert.ok(
      typeof meta.helperHuman === "string" && meta.helperHuman.length > 0,
      `${kind} should have helperHuman`
    );
    assert.ok(
      typeof meta.helperAgent === "string" && meta.helperAgent.length > 0,
      `${kind} should have helperAgent`
    );
  }
  for (const kind of ["openclaw", "hermes"]) {
    assert.ok(
      !pub[kind][0].helperHuman,
      `${kind} should not have helperHuman`
    );
    assert.ok(
      !pub[kind][0].helperAgent,
      `${kind} should not have helperAgent`
    );
  }
});

test("wizard metadata: helper snippets contain correct port and env prefix", () => {
  const pub = getPublicSessionSources();
  const expectations = {
    opencode: { port: "8788", prefix: "OPENCODE_OCCUPANCY_" },
    omp: { port: "8789", prefix: "OMP_OCCUPANCY_" },
    dsh: { port: "8791", prefix: "DSH_OCCUPANCY_" },
  };
  for (const [kind, { port, prefix }] of Object.entries(expectations)) {
    const meta = pub[kind][0];
    assert.ok(
      meta.helperHuman.includes(port),
      `${kind} helperHuman should contain port ${port}`
    );
    assert.ok(
      meta.helperHuman.includes(prefix),
      `${kind} helperHuman should contain env prefix ${prefix}`
    );
    assert.ok(
      meta.helperAgent.includes(port),
      `${kind} helperAgent should contain port ${port}`
    );
    assert.ok(
      meta.helperAgent.includes(prefix),
      `${kind} helperAgent should contain env prefix ${prefix}`
    );
  }
});
