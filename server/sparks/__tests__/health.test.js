import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth } from "../../health.js";

test("loopback health is ok without a token", () => {
  const previous = process.env.SPARKDASH_TOKEN;
  delete process.env.SPARKDASH_TOKEN;
  try {
    const health = evaluateHealth({ bindHost: "127.0.0.1", configWritable: true, secretsKeyPresent: true, sshIdentityPresent: true });
    assert.equal(health.ok, true);
    assert.equal(health.authMode, "loopback-open");
  } finally {
    if (previous != null) process.env.SPARKDASH_TOKEN = previous;
  }
});

test("remote bind without a token is healthy by default", () => {
  const previousToken = process.env.SPARKDASH_TOKEN;
  const previousAllow = process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  delete process.env.SPARKDASH_TOKEN;
  delete process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  try {
    const health = evaluateHealth({ bindHost: "0.0.0.0", configWritable: true, secretsKeyPresent: true, sshIdentityPresent: true });
    assert.equal(health.ok, true);
  } finally {
    if (previousToken != null) process.env.SPARKDASH_TOKEN = previousToken;
    else delete process.env.SPARKDASH_TOKEN;
    if (previousAllow != null) process.env.SPARKDASH_ALLOW_OPEN_REMOTE = previousAllow;
    else delete process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  }
});

test("remote bind without a token is not healthy when open remote is disabled", () => {
  const previousToken = process.env.SPARKDASH_TOKEN;
  const previousAllow = process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  delete process.env.SPARKDASH_TOKEN;
  process.env.SPARKDASH_ALLOW_OPEN_REMOTE = "0";
  try {
    const health = evaluateHealth({ bindHost: "0.0.0.0", configWritable: true, secretsKeyPresent: true, sshIdentityPresent: true });
    assert.equal(health.ok, false);
    assert.match(health.errors.join(" "), /SPARKDASH_TOKEN/);
  } finally {
    if (previousToken != null) process.env.SPARKDASH_TOKEN = previousToken;
    else delete process.env.SPARKDASH_TOKEN;
    if (previousAllow != null) process.env.SPARKDASH_ALLOW_OPEN_REMOTE = previousAllow;
    else delete process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  }
});
