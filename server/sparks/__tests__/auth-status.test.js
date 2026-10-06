import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { authStatus, authorizeUpgrade, createAuthMiddleware, setTailscaleName } from "../../auth.js";

const ENV_KEYS = ["SPARKDASH_TOKEN", "DASHBOARD_TOKEN", "BIND_HOST", "SPARKDASH_ALLOW_OPEN_REMOTE", "SPARKDASH_ALLOWED_HOSTS"];

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

/** A browser's request: Host, plus Origin on an API call or WebSocket. */
function browser(host, { origin, method = "GET", bearer, accept } = {}) {
  const headers = { host };
  if (origin) headers.origin = origin;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (accept) headers.accept = accept;
  return { method, headers, query: {} };
}

test("a loopback bind keeps working with no setup and refuses cross-site and rebound requests", () => {
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    for (const host of ["localhost:5555", "127.0.0.1:5555", "[::1]:5555"]) {
      const origin = `http://${host}`;
      assert.equal(passesMiddleware(browser(host)), true, `page ${host}`);
      assert.equal(passesMiddleware(browser(host, { origin, method: "POST" })), true, `API ${host}`);
      assert.equal(authorizeUpgrade(browser(host, { origin })), true, `WebSocket ${host}`);
    }
    // Vite dev server opened on a LAN IP proxies with the browser's Host and Origin.
    const lan = "192.168.1.50:5173";
    assert.equal(passesMiddleware(browser(lan, { origin: `http://${lan}`, method: "POST" })), true);
    assert.equal(authorizeUpgrade(browser(lan, { origin: `http://${lan}` })), true);

    // Cross-site POST /api/sparks/wake-all and WebSocket.
    const evil = "https://evil.example";
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: evil, method: "POST" })), false);
    assert.equal(authorizeUpgrade(browser("127.0.0.1:5555", { origin: evil })), false);
    // A page served from a bare IP is another site too.
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: "http://203.0.113.7", method: "POST" })), false);
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: "null", method: "POST" })), false);

    // DNS rebinding: same-origin with the attacker's own name.
    const rebound = "rebound.example:5555";
    assert.equal(passesMiddleware(browser(rebound)), false);
    assert.equal(passesMiddleware(browser(rebound, { origin: `http://${rebound}`, method: "POST" })), false);
    assert.equal(authorizeUpgrade(browser(rebound, { origin: `http://${rebound}` })), false);
  });
});

test("the derived allowlist: IP literals, *.localhost, this machine's name and its Tailscale name", () => {
  const self = os.hostname().toLowerCase().replace(/\.local$/, "");
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    for (const host of ["10.0.0.5:5555", "[fe80::1]:5555", "dash.localhost:5555", `${self.toUpperCase()}:5555`, `${self}.local`]) {
      assert.equal(passesMiddleware(browser(host, { origin: `http://${host}`, method: "POST" })), true, host);
    }
    // Look-alikes are the attacker's names.
    for (const host of ["127.evil.example", "localhost.evil.example", `${self}.evil.example`]) {
      assert.equal(passesMiddleware(browser(host)), false, host);
    }

    const serve = "spark-1.tail1234.ts.net";
    assert.equal(passesMiddleware(browser(serve, { origin: `https://${serve}` })), false);
    try {
      setTailscaleName(`${serve}.`);
      assert.equal(passesMiddleware(browser(serve)), true);
      assert.equal(passesMiddleware(browser(serve, { origin: `https://${serve}`, method: "POST" })), true);
      assert.equal(authorizeUpgrade(browser(serve, { origin: `https://${serve}` })), true);
    } finally {
      setTailscaleName("");
    }
  });
});

test("SPARKDASH_ALLOWED_HOSTS admits a custom proxy domain, also as the Origin when the proxy rewrites Host", () => {
  const proxied = (origin) => browser("127.0.0.1:5555", { origin, method: "POST" });
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    assert.equal(passesMiddleware(browser("dash.example.com")), false);
    assert.equal(passesMiddleware(proxied("https://dash.example.com")), false);
  });
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_ALLOWED_HOSTS: " Dash.Example.com:443, other.example" }, () => {
    assert.equal(passesMiddleware(browser("dash.example.com")), true);
    assert.equal(passesMiddleware(proxied("https://dash.example.com")), true);
    assert.equal(authorizeUpgrade(browser("127.0.0.1:5555", { origin: "https://dash.example.com" })), true);
    assert.equal(passesMiddleware(proxied("https://evil.example")), false);
  });
});

test("a valid token skips the Host check; a wrong one does not", () => {
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, () => {
    const rebound = "rebound.example:5555";
    assert.equal(passesMiddleware(browser(rebound, { bearer: "s3cret" })), true);
    assert.equal(authorizeUpgrade({ url: "/ws?token=s3cret", headers: { host: rebound, origin: `http://${rebound}` } }), true);
    assert.equal(passesMiddleware(browser(rebound, { bearer: "wrong" })), false);
    assert.equal(authorizeUpgrade({ url: "/ws?token=wrong", headers: { host: rebound } }), false);
  });
});

test("a refused browser navigation gets a page naming the host; an API call gets JSON", () => {
  const refusal = (request) => {
    const sent = {};
    const res = {
      status(code) {
        sent.status = code;
        return this;
      },
      type(type) {
        sent.type = type;
        return this;
      },
      send(body) {
        sent.body = body;
      },
      json(body) {
        sent.json = body;
      },
    };
    createAuthMiddleware()(request, res, () => {});
    return sent;
  };
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    const page = refusal(browser("rebound.example:5555", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }));
    assert.equal(page.status, 403);
    assert.equal(page.type, "html");
    assert.match(page.body, /<b>rebound\.example<\/b>/);
    assert.match(page.body, /SPARKDASH_ALLOWED_HOSTS/);

    const api = refusal(browser("rebound.example:5555", { accept: "application/json" }));
    assert.equal(api.status, 403);
    assert.match(api.json.error, /rebound\.example.*SPARKDASH_ALLOWED_HOSTS/);
  });
});

test("a non-loopback bind is unaffected by Host and Origin", () => {
  withEnv({ BIND_HOST: "0.0.0.0" }, () => {
    assert.equal(passesMiddleware(browser("rebound.example:5555")), true);
    assert.equal(passesMiddleware(browser("10.0.0.5:5555", { origin: "https://evil.example", method: "POST" })), true);
    assert.equal(authorizeUpgrade(browser("10.0.0.5:5555", { origin: "https://evil.example" })), true);
  });
});
