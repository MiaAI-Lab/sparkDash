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
} = sessionSources;

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

test("AE4 config: both sources disabled/absent is a valid normalized config", () => {
  resetFiles();
  const loaded = loadSessionSources();
  assert.equal(loaded.openclaw.enabled, false);
  assert.equal(loaded.hermes.enabled, false);
  const pub = getPublicSessionSources();
  assert.equal(pub.openclaw.enabled, false);
  assert.equal(pub.hermes.enabled, false);
  assert.equal(pub.openclaw.hasToken, false);
  assert.equal(pub.hermes.hasToken, false);
  assert.equal("token" in pub.openclaw, false);
  assert.equal("token" in pub.hermes, false);
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

  assert.equal(pub.openclaw.enabled, true);
  assert.equal(pub.openclaw.mode, "url");
  assert.equal(pub.openclaw.url, "http://127.0.0.1:18789");
  assert.equal(pub.openclaw.hasToken, true);
  assert.equal("token" in pub.openclaw, false);
  assert.equal(JSON.stringify(pub).includes(token), false);

  const disk = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(disk.openclaw.enabled, true);
  assert.equal(disk.openclaw.mode, "url");
  assert.equal(disk.openclaw.url, "http://127.0.0.1:18789");
  assert.equal(JSON.stringify(disk).includes(token), false);
  assert.equal("token" in (disk.openclaw || {}), false);

  const secretsRaw = fs.readFileSync(secretsPath, "utf8");
  assert.equal(secretsRaw.includes(token), false);

  const reloaded = getPublicSessionSources();
  assert.equal(reloaded.openclaw.enabled, true);
  assert.equal(reloaded.openclaw.mode, "url");
  assert.equal(reloaded.openclaw.url, "http://127.0.0.1:18789");
  assert.equal(reloaded.openclaw.hasToken, true);
  assert.equal("token" in reloaded.openclaw, false);
  assert.equal(JSON.stringify(reloaded).includes(token), false);
});

test("local mode saves conventional product paths, not this fleet", () => {
  resetFiles();
  const pub = updateSessionSources({
    openclaw: { enabled: true, mode: "local" },
    hermes: { enabled: true, mode: "local" },
  });

  assert.equal(pub.openclaw.mode, "local");
  assert.equal(pub.hermes.mode, "local");
  assert.equal(pub.openclaw.conventionalStateDir, "~/.openclaw");
  assert.equal(pub.hermes.conventionalStateDir, "~/.hermes");

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
  assert.equal(loaded.openclaw.enabled, true);
  assert.equal(loaded.openclaw.mode, "state-dir");
  assert.equal(loaded.openclaw.url, "http://127.0.0.1:18789");
  assert.equal(loaded.openclaw.stateDir, "/tmp/openclaw-state");
  assert.equal(loaded.openclaw.futureFlag, true);
  assert.equal(loaded.hermes.extraReader, "v2");

  updateSessionSources({ openclaw: { enabled: false } });
  const disk = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(disk.openclaw.enabled, false);
  assert.equal(disk.openclaw.mode, "state-dir");
  assert.equal(disk.openclaw.url, "http://127.0.0.1:18789");
  assert.equal(disk.openclaw.stateDir, "/tmp/openclaw-state");
  assert.equal(disk.openclaw.futureFlag, true);
  assert.equal(disk.hermes.extraReader, "v2");
});

test("omitted token on PATCH does not wipe; empty string clears", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(getPublicSessionSources().openclaw.hasToken, true);

  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789" },
  });
  assert.equal(getPublicSessionSources().openclaw.hasToken, true);

  updateSessionSources({
    openclaw: { token: "" },
  });
  assert.equal(getPublicSessionSources().openclaw.hasToken, false);
});

test("url-only PATCH to a new origin clears the stored token", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(getPublicSessionSources().openclaw.hasToken, true);

  const pub = updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://192.168.4.10:18789" },
  });
  assert.equal(pub.openclaw.hasToken, false);
  assert.equal(pub.openclaw.url, "http://192.168.4.10:18789");
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
  const v1 = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  assert.equal(v1.version, 1);
  assert.ok(v1.secrets["spark-a"]);
  assert.equal(v1.sessionSourceTokens, undefined);
  assert.equal(loadSecrets().get("spark-a"), "ssh-password-a");

  updateSessionSources({ hermes: { token: "hermes-session-token" } });
  assert.equal(loadSecrets().get("spark-a"), "ssh-password-a");
  assert.equal(getPublicSessionSources().hermes.hasToken, true);

  saveSecrets(new Map([["spark-a", "ssh-password-a"], ["spark-b", "ssh-password-b"]]));
  assert.equal(loadSecrets().get("spark-a"), "ssh-password-a");
  assert.equal(loadSecrets().get("spark-b"), "ssh-password-b");
  assert.equal(getPublicSessionSources().hermes.hasToken, true);

  saveSecrets(new Map());
  assert.equal(loadSecrets().size, 0);
  assert.equal(getPublicSessionSources().hermes.hasToken, true);
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
  assert.equal(pub.openclaw.enabled, false);
  assert.equal(pub.openclaw.mode, "state-dir");
  assert.equal(pub.openclaw.stateDir, "");
});

test("token patch rolls back when session-sources.json cannot be saved", () => {
  resetFiles();
  updateSessionSources({
    openclaw: { enabled: true, mode: "url", url: "http://127.0.0.1:18789", token: "keep-me" },
  });
  assert.equal(getPublicSessionSources().openclaw.hasToken, true);
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
    assert.equal(getPublicSessionSources().openclaw.hasToken, true);
  } finally {
    fs.rmSync(sourcesPath, { recursive: true, force: true });
  }
});
