// Why: this policy decides whether a Spark that boots faster than Tailscale
// comes back with a live dashboard or with a process parked by `node --watch`
// forever (the old exit-on-first-bind-error path). The decision must be right
// for the transient case and unforgiving for real misconfigurations.
import test from "node:test";
import assert from "node:assert/strict";
import { LISTEN_RETRY_CODES, LISTEN_RETRY_DELAY_MS, LISTEN_RETRY_MAX_ATTEMPTS, planListenRetry } from "../listenRetry.js";

test("EADDRNOTAVAIL is retried with the fixed delay until the cap", () => {
  for (let attempt = 0; attempt < LISTEN_RETRY_MAX_ATTEMPTS; attempt++) {
    const plan = planListenRetry({ code: "EADDRNOTAVAIL", attempt });
    assert.equal(plan.retry, true, `attempt ${attempt} must retry`);
    assert.equal(plan.delayMs, LISTEN_RETRY_DELAY_MS);
    assert.equal(plan.attempt, attempt);
  }
});

test("the retry budget is capped at LISTEN_RETRY_MAX_ATTEMPTS", () => {
  assert.equal(planListenRetry({ code: "EADDRNOTAVAIL", attempt: LISTEN_RETRY_MAX_ATTEMPTS - 1 }).retry, true);
  assert.equal(planListenRetry({ code: "EADDRNOTAVAIL", attempt: LISTEN_RETRY_MAX_ATTEMPTS }).retry, false);
  assert.equal(planListenRetry({ code: "EADDRNOTAVAIL", attempt: LISTEN_RETRY_MAX_ATTEMPTS + 99 }).retry, false);
});

test("every other bind code fails fast — only EADDRNOTAVAIL is transient", () => {
  assert.deepEqual([...LISTEN_RETRY_CODES], ["EADDRNOTAVAIL"]);
  for (const code of ["EADDRINUSE", "EACCES", "EPERM", "ENOTFOUND", undefined, null, "", "nonsense"]) {
    assert.equal(planListenRetry({ code, attempt: 0 }).retry, false, `code ${String(code)} must not retry`);
  }
});

test("a non-numeric attempt count never retries", () => {
  for (const attempt of [NaN, undefined, null, "3"]) {
    assert.equal(planListenRetry({ code: "EADDRNOTAVAIL", attempt }).retry, false);
  }
});

/**
 * The retry wiring: the startup block must run exactly once however many binds failed.
 *
 * `server.listen(port, host, cb)` installs cb as a fresh `once("listening")` listener, and a
 * failed bind does not consume it, so passing the callback on every attempt accumulates one
 * listener per attempt. Node also warns about a leak at eleven — in the log of the very boot
 * this retry exists to rescue.
 */
import net from "node:net";

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("the startup block runs once, not once per failed bind attempt", async (t) => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let started = 0;
  let failures = 0;
  const onListening = () => {
    started += 1;
  };

  await new Promise((resolve) => {
    server.on("error", () => {
      failures += 1;
      // Free the port after a few failures, as tailscale0 coming up would.
      if (failures === 3) blocker.close();
      setTimeout(() => server.listen(port, "127.0.0.1"), 10);
    });
    // The shape server/index.js uses: register the success handler once, then retry bare.
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
    server.once("listening", () => setTimeout(resolve, 30));
  });

  assert.ok(failures >= 3, `expected the bind to fail first, got ${failures} failures`);
  assert.equal(started, 1, `startup ran ${started} times after ${failures} failed binds`);
  assert.equal(server.listeners("listening").length, 0, "no listening listeners left over");
});

test("server/index.js registers the startup handler once and retries without a callback", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const src = readFileSync(path.join(root, "server/index.js"), "utf8");
  assert.match(src, /server\.once\("listening", onListening\);/);
  // No attempt may pass the callback to listen(), or it is re-registered per attempt.
  assert.equal(/server\.listen\(PORT, BIND_HOST, /.test(src), false);
});
