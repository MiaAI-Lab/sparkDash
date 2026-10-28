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
