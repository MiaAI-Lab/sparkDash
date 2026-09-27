import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedTarget,
  createRateLimiter,
  DECODE_BENCH_WORK_LIMIT,
  validateDecodeBudget,
  validatePrefillBudget,
} from "../../validate.js";

test("target policy requires an allowlisted host and rejects forbidden DNS answers", async () => {
  const lookup = async (host) => {
    if (host === "fleet.example") return [{ address: "10.0.0.8", family: 4 }];
    if (host === "rebind.example") {
      return [
        { address: "10.0.0.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ];
    }
    return [{ address: "203.0.113.8", family: 4 }];
  };

  assert.deepEqual(
    await assertAllowedTarget("fleet.example", new Set(["fleet.example"]), { lookup }),
    ["10.0.0.8"]
  );
  await assert.rejects(
    assertAllowedTarget("other.example", new Set(["fleet.example"]), { lookup }),
    /not in the administrator allowlist/
  );
  await assert.rejects(
    assertAllowedTarget("rebind.example", new Set(["rebind.example"]), { lookup }),
    /forbidden address 169\.254\.169\.254/
  );
});

test("target policy handles IPv4 and IPv6 forbidden ranges", async () => {
  const allowed = new Set(["192.168.1.20", "fd00::20", "fe80::1", "ff02::1", "::"]);
  assert.deepEqual(await assertAllowedTarget("192.168.1.20", allowed), ["192.168.1.20"]);
  assert.deepEqual(await assertAllowedTarget("fd00::20", allowed), ["fd00::20"]);
  await assert.rejects(assertAllowedTarget("fe80::1", allowed), /forbidden address/);
  await assert.rejects(assertAllowedTarget("ff02::1", allowed), /forbidden address/);
  await assert.rejects(assertAllowedTarget("::", allowed), /forbidden address/);
});

test("rate limiter storage is TTL-bounded and enforces a global key ceiling", () => {
  let now = 1_000;
  const limit = createRateLimiter(2, 100, { maxKeys: 2, now: () => now });
  assert.equal(limit("a"), true);
  assert.equal(limit("b"), true);
  assert.equal(limit.size(), 2);
  assert.equal(limit("c"), false);
  now += 101;
  assert.equal(limit("c"), true);
  assert.equal(limit.size(), 1);
});

test("rate limiter peek does not consume a slot", () => {
  const limit = createRateLimiter(1, 10_000);
  assert.equal(limit("a", true), true);
  assert.equal(limit("a", true), true);
  assert.equal(limit.size(), 0);
  assert.equal(limit("a"), true);
  assert.equal(limit("a", true), false);
  assert.equal(limit("a"), false);
});

test("benchmark budgets cap total requested work", () => {
  assert.equal(validateDecodeBudget([1, 2, 4], 400, 3_000), 2_800);
  assert.throws(() => validateDecodeBudget([16, 32], 2_048, 50_000), /work budget/);
  // Full UI sweep (1–32) at maxTokens=2048 must fit the default cap — #93.
  const fullSweep = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32];
  assert.equal(validateDecodeBudget(fullSweep, 2048), 123 * 2048);
  assert.ok(123 * 2048 <= DECODE_BENCH_WORK_LIMIT);
  assert.equal(validatePrefillBudget([1_024, 8_192], 10_000), 9_216);
  assert.throws(() => validatePrefillBudget([128_000, 256_000, 300_000], 600_000), /work budget/);
});
