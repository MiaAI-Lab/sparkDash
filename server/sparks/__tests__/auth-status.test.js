import { test } from "node:test";
import assert from "node:assert/strict";
import { authStatus, authorizeUpgrade, createAuthMiddleware } from "../../auth.js";

const ENV_KEYS = ["SPARKDASH_TOKEN", "DASHBOARD_TOKEN", "BIND_HOST", "SPARKDASH_ALLOW_OPEN_REMOTE"];

function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) {
      if (env[k] == null) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function req({ bearer, query, method = "GET" } = {}) {
  return {
    method,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    query: query ? { token: query } : {},
  };
}

/** Run the real middleware and report whether it let the request through. */
function passesMiddleware(request) {
  let passed = false;
  const res = { status: () => ({ json: () => {} }) };
  createAuthMiddleware()(request, res, () => {
    passed = true;
  });
  return passed;
}

test("no token configured: nothing to ask for, on loopback or a remote bind", () => {
  for (const BIND_HOST of ["127.0.0.1", "0.0.0.0"]) {
    withEnv({ BIND_HOST }, () => {
      assert.deepEqual(authStatus(req()), { tokenRequired: false, authenticated: true });
    });
  }
});

test("token configured: required, and only the right token authenticates", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "0.0.0.0" }, () => {
    assert.deepEqual(authStatus(req()), { tokenRequired: true, authenticated: false });
    assert.deepEqual(authStatus(req({ bearer: "wrong" })), { tokenRequired: true, authenticated: false });
    assert.deepEqual(authStatus(req({ bearer: "s3cret" })), { tokenRequired: true, authenticated: true });
    // The WebSocket passes the token as ?token=, so the status must accept it too.
    assert.deepEqual(authStatus(req({ query: "s3cret" })), { tokenRequired: true, authenticated: true });
  });
});

test("DASHBOARD_TOKEN counts as a configured token", () => {
  withEnv({ DASHBOARD_TOKEN: "legacy" }, () => {
    assert.equal(authStatus(req()).tokenRequired, true);
    assert.equal(authStatus(req({ bearer: "legacy" })).authenticated, true);
  });
});

test("the response never echoes the configured or provided token", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret-value" }, () => {
    const body = JSON.stringify(authStatus(req({ bearer: "s3cret-value" })));
    assert.doesNotMatch(body, /s3cret-value/);
    assert.deepEqual(Object.keys(authStatus(req())).sort(), ["authenticated", "tokenRequired"]);
  });
});

test("the WebSocket upgrade accepts ?token= from the raw request URL", () => {
  // verifyClient receives an unparsed IncomingMessage: a url, headers, no req.query.
  const raw = (url) => ({ url, headers: {} });
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "127.0.0.1" }, () => {
    assert.equal(authorizeUpgrade(raw("/ws?token=s3cret")), true);
    assert.equal(authorizeUpgrade(raw("/ws?token=s3cr%65t")), true);
    assert.equal(authorizeUpgrade(raw("/ws?token=wrong")), false);
    assert.equal(authorizeUpgrade(raw("/ws")), false);
    assert.equal(authorizeUpgrade({ url: "/ws", headers: { authorization: "Bearer s3cret" } }), true);
  });
});

test("tokenRequired mirrors exactly when the WebSocket upgrade and mutations demand a token", () => {
  const combos = [];
  for (const SPARKDASH_TOKEN of [undefined, "s3cret"])
    for (const BIND_HOST of ["127.0.0.1", "0.0.0.0"])
      for (const SPARKDASH_ALLOW_OPEN_REMOTE of [undefined, "0"])
        combos.push({ SPARKDASH_TOKEN, BIND_HOST, SPARKDASH_ALLOW_OPEN_REMOTE });

  for (const env of combos) {
    withEnv(env, () => {
      const { tokenRequired } = authStatus(req());
      const label = JSON.stringify(env);
      // Without a token, the upgrade and a mutation are refused exactly when a token is required.
      assert.equal(!authorizeUpgrade(req()), tokenRequired, `ws upgrade ${label}`);
      assert.equal(!passesMiddleware(req({ method: "POST" })), tokenRequired, `mutation ${label}`);
      if (tokenRequired) {
        // ...and the configured token is what unlocks them.
        assert.equal(authorizeUpgrade(req({ query: "s3cret" })), true, `ws upgrade with token ${label}`);
        assert.equal(passesMiddleware(req({ method: "POST", bearer: "s3cret" })), true, `mutation with token ${label}`);
      }
    });
  }
});
