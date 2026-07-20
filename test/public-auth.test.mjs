import test from "node:test";
import assert from "node:assert/strict";
import {
  createSignedValue,
  readSignedValue,
  normalizeAllowlist,
  isAllowedEmail,
  safeReturnPath,
} from "../scripts/public-auth.mjs";

const secret = "0123456789abcdef0123456789abcdef";

test("signed sessions round-trip and reject tampering", () => {
  const token = createSignedValue({ email: "Chris@Example.com", exp: 9999999999 }, secret);
  assert.deepEqual(readSignedValue(token, secret), {
    email: "Chris@Example.com",
    exp: 9999999999,
  });
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(readSignedValue(tampered, secret), null);
});

test("email allowlist is exact and case-insensitive", () => {
  const allowed = normalizeAllowlist(" Chris@Example.com,haylie@example.com\n");
  assert.equal(isAllowedEmail("chris@example.com", allowed), true);
  assert.equal(isAllowedEmail("other@example.com", allowed), false);
  assert.equal(isAllowedEmail("chris@example.com.attacker.test", allowed), false);
});

test("return paths cannot redirect off-site", () => {
  assert.equal(safeReturnPath("/spark-02?tab=llm"), "/spark-02?tab=llm");
  assert.equal(safeReturnPath("https://evil.test/steal"), "/");
  assert.equal(safeReturnPath("//evil.test/steal"), "/");
});
